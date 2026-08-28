from __future__ import annotations

import asyncio
import hmac
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Literal

if TYPE_CHECKING:
    from app.settings import Settings
    from app.steam_gateway import SteamGatewayProtocol
    from app.steam_openid import SteamOpenIDVerifier

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field, model_validator

from app.cookies import InvalidCookieError, SignedCookieCodec, utc_datetime
from app.steam_gateway import InventoryCheck, ProfileCheck
from app.steam_openid import (
    OpenIDValidationError,
    OpenIDVerifierUnavailableError,
    callback_return_to,
    collect_openid_parameters,
    login_url,
    validate_openid_callback,
)

STATE_PURPOSE = "login-state"
SESSION_PURPOSE = "session"
MAX_GEM_REFRESH_GROUPS = 10_000
_DUPLICATE_GEM_REFRESH_GROUP_ERROR = "Gem refresh groups must be unique."
_AUTHENTICATION_REQUIRED_MESSAGE = "Steam authentication is required."
_GEM_REFRESH_UNAVAILABLE_MESSAGE = "Gem value refresh is unavailable."

Clock = Callable[[], datetime]


class SessionUser(BaseModel):
    steam_id: str
    display_name: str | None = None
    avatar_url: str | None = None


class SessionCheck(BaseModel):
    status: Literal["public", "private", "unavailable"]
    message: str


class SessionChecks(BaseModel):
    profile: SessionCheck
    inventory: InventoryCheck


class AuthenticatedSessionResponse(BaseModel):
    authenticated: Literal[True] = True
    user: SessionUser
    checks: SessionChecks


class UnauthenticatedSessionResponse(BaseModel):
    authenticated: Literal[False] = False


class ErrorResponse(BaseModel):
    detail: str


SessionResponse = Annotated[
    AuthenticatedSessionResponse | UnauthenticatedSessionResponse,
    Field(discriminator="authenticated"),
]


class GemRefreshGroup(BaseModel):
    game_app_id: str = Field(pattern=r"^[0-9]+$", max_length=20)
    card_rarity: Literal["normal", "foil"]


class GemRefreshRequest(BaseModel):
    groups: list[GemRefreshGroup] = Field(max_length=MAX_GEM_REFRESH_GROUPS)

    @model_validator(mode="after")
    def require_unique_groups(self) -> GemRefreshRequest:
        keys = {(group.game_app_id, group.card_rarity) for group in self.groups}
        if len(keys) != len(self.groups):
            raise ValueError(_DUPLICATE_GEM_REFRESH_GROUP_ERROR)
        return self


class GemRefreshValue(GemRefreshGroup):
    gem_yield: int = Field(ge=0)


class GemRefreshResponse(BaseModel):
    values: list[GemRefreshValue]
    pending_group_count: int = Field(ge=0)
    gem_rate_limited: bool
    gem_retry_after_seconds: int | None = Field(
        default=None,
        ge=0,
        le=900,
    )


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _cookie_path(purpose: str) -> str:
    if purpose == STATE_PURPOSE:
        return "/api/auth/steam"
    return "/"


def _cookie_name(settings: Settings, purpose: str) -> str:
    return (
        settings.login_state_cookie_name
        if purpose == STATE_PURPOSE
        else settings.session_cookie_name
    )


def _cookie_samesite(
    settings: Settings, purpose: str
) -> Literal["lax", "strict", "none"]:
    if purpose == STATE_PURPOSE:
        return "lax"
    return settings.cookie_samesite


def _delete_cookie(response: Response, settings: Settings, purpose: str) -> None:
    response.delete_cookie(
        _cookie_name(settings, purpose),
        path=_cookie_path(purpose),
        domain=None,
        secure=settings.cookie_secure,
        httponly=True,
        samesite=_cookie_samesite(settings, purpose),
    )


def _set_cookie(
    response: Response,
    settings: Settings,
    *,
    purpose: str,
    value: str,
    max_age: int,
) -> None:
    response.set_cookie(
        _cookie_name(settings, purpose),
        value,
        max_age=max_age,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=_cookie_samesite(settings, purpose),
        path=_cookie_path(purpose),
    )


def _unavailable_profile() -> ProfileCheck:
    return ProfileCheck(
        status="unavailable",
        message="Steam profile check is unavailable.",
    )


def _unavailable_inventory() -> InventoryCheck:
    return InventoryCheck(
        status="unavailable",
        message="Steam inventory check is unavailable.",
        price_message="Steam item prices are unavailable.",
    )


def _session_response(
    steam_id: str,
    profile: ProfileCheck,
    inventory: InventoryCheck,
) -> AuthenticatedSessionResponse:
    return AuthenticatedSessionResponse(
        user=SessionUser(
            steam_id=steam_id,
            display_name=profile.display_name,
            avatar_url=profile.avatar_url,
        ),
        checks=SessionChecks(
            profile=SessionCheck(
                status=profile.status,
                message=profile.message,
            ),
            inventory=inventory,
        ),
    )


def _callback_state(
    request: Request,
    settings: Settings,
    codec: SignedCookieCodec,
    *,
    now: datetime,
) -> tuple[str, list[tuple[str, str]]]:
    state_token = request.cookies.get(settings.login_state_cookie_name)
    if not state_token:
        raise OpenIDValidationError
    state_payload = codec.decode(
        state_token,
        STATE_PURPOSE,
        now=now,
        max_age_seconds=settings.login_state_ttl_seconds,
    )
    expected_state = state_payload.get("state")
    if (
        not isinstance(expected_state, str)
        or not expected_state.isascii()
        or not expected_state
    ):
        raise OpenIDValidationError

    pairs = list(request.query_params.multi_items())
    state_values = [value for key, value in pairs if key == "state"]
    if len(state_values) != 1 or not state_values[0].isascii():
        raise OpenIDValidationError
    state_value = state_values[0]
    if not hmac.compare_digest(state_value, expected_state):
        raise OpenIDValidationError
    return state_value, pairs


def _session_steam_id(
    token: str,
    settings: Settings,
    codec: SignedCookieCodec,
    *,
    now: datetime,
) -> str:
    payload = codec.decode(
        token,
        SESSION_PURPOSE,
        now=now,
        max_age_seconds=settings.session_ttl_seconds,
    )
    steam_id = payload.get("steam_id")
    if (
        not isinstance(steam_id, str)
        or not steam_id.isascii()
        or not steam_id.isdigit()
    ):
        raise InvalidCookieError
    return steam_id


def create_auth_router(
    settings: Settings,
    *,
    steam_gateway: SteamGatewayProtocol,
    openid_verifier: SteamOpenIDVerifier,
    clock: Clock | None = None,
) -> APIRouter:
    """Build auth routes with all external boundaries injected."""

    router = APIRouter()
    codec = SignedCookieCodec(settings.signing_secret)
    current_clock = clock or _utc_now

    def current_time() -> datetime:
        return utc_datetime(current_clock())

    @router.get(
        "/api/auth/steam/start",
        response_class=RedirectResponse,
        status_code=302,
    )
    async def steam_start() -> Response:
        issued_at = current_time()
        expires_at = issued_at + timedelta(seconds=settings.login_state_ttl_seconds)
        state_value = secrets.token_urlsafe(32)
        state = codec.encode(
            STATE_PURPOSE,
            {"state": state_value},
            issued_at=issued_at,
            expires_at=expires_at,
        )
        response = RedirectResponse(
            login_url(settings.public_backend_url, state=state_value),
            status_code=302,
        )
        _set_cookie(
            response,
            settings,
            purpose=STATE_PURPOSE,
            value=state,
            max_age=settings.login_state_ttl_seconds,
        )
        return response

    @router.get(
        "/api/auth/steam/callback",
        response_class=RedirectResponse,
        status_code=302,
        responses={
            400: {"model": ErrorResponse},
            503: {"model": ErrorResponse},
        },
    )
    async def steam_callback(request: Request) -> Response:
        try:
            callback_now = current_time()
            state_value, pairs = _callback_state(
                request,
                settings,
                codec,
                now=callback_now,
            )
            params = collect_openid_parameters(pairs)
            assertion = await validate_openid_callback(
                params,
                expected_return_to=callback_return_to(
                    settings.public_backend_url, state_value
                ),
                verifier=openid_verifier,
                now=callback_now,
                nonce_max_age_seconds=settings.nonce_max_age_seconds,
                nonce_future_skew_seconds=settings.nonce_future_skew_seconds,
            )
            issued_at = callback_now
            session = codec.encode(
                SESSION_PURPOSE,
                {"steam_id": assertion.steam_id},
                issued_at=issued_at,
                expires_at=issued_at + timedelta(seconds=settings.session_ttl_seconds),
            )
            response = RedirectResponse(settings.frontend_url, status_code=302)
            _set_cookie(
                response,
                settings,
                purpose=SESSION_PURPOSE,
                value=session,
                max_age=settings.session_ttl_seconds,
            )
            _delete_cookie(response, settings, STATE_PURPOSE)
        except OpenIDVerifierUnavailableError:
            response = JSONResponse(
                {"detail": "Steam authentication is unavailable."}, status_code=503
            )
            _delete_cookie(response, settings, STATE_PURPOSE)
            return response
        except (InvalidCookieError, OpenIDValidationError, ValueError):
            response = JSONResponse(
                {"detail": "Invalid Steam authentication callback."}, status_code=400
            )
            _delete_cookie(response, settings, STATE_PURPOSE)
            return response
        else:
            return response

    @router.get("/api/auth/session", response_model=SessionResponse)
    async def auth_session(request: Request, response: Response) -> SessionResponse:
        response.headers["Cache-Control"] = "no-store"
        token = request.cookies.get(settings.session_cookie_name)
        if not token:
            return UnauthenticatedSessionResponse()
        try:
            steam_id = _session_steam_id(
                token,
                settings,
                codec,
                now=current_time(),
            )
        except (InvalidCookieError, ValueError):
            return UnauthenticatedSessionResponse()
        profile_result, inventory_result = await asyncio.gather(
            steam_gateway.check_profile(steam_id),
            steam_gateway.check_inventory(steam_id),
            return_exceptions=True,
        )
        profile = (
            _unavailable_profile()
            if isinstance(profile_result, BaseException)
            else profile_result
            if isinstance(profile_result, ProfileCheck)
            else _unavailable_profile()
        )
        inventory = (
            _unavailable_inventory()
            if isinstance(inventory_result, BaseException)
            else inventory_result
            if isinstance(inventory_result, InventoryCheck)
            else _unavailable_inventory()
        )
        return _session_response(steam_id, profile, inventory)

    @router.post(
        "/api/auth/gems",
        response_model=GemRefreshResponse,
        responses={
            401: {"model": ErrorResponse},
            503: {"model": ErrorResponse},
        },
    )
    async def refresh_gems(
        payload: GemRefreshRequest,
        request: Request,
        response: Response,
    ) -> GemRefreshResponse:
        response.headers["Cache-Control"] = "no-store"
        token = request.cookies.get(settings.session_cookie_name)
        if not token:
            raise HTTPException(
                status_code=401,
                detail=_AUTHENTICATION_REQUIRED_MESSAGE,
            )
        try:
            _session_steam_id(
                token,
                settings,
                codec,
                now=current_time(),
            )
        except (InvalidCookieError, ValueError) as error:
            raise HTTPException(
                status_code=401,
                detail=_AUTHENTICATION_REQUIRED_MESSAGE,
            ) from error
        groups = {
            (group.game_app_id, group.card_rarity): None for group in payload.groups
        }
        try:
            scan = await steam_gateway.refresh_gems(groups)
        except (
            AttributeError,
            OSError,
            TimeoutError,
            TypeError,
            ValueError,
            ArithmeticError,
            RuntimeError,
        ) as error:
            raise HTTPException(
                status_code=503,
                detail=_GEM_REFRESH_UNAVAILABLE_MESSAGE,
            ) from error
        return GemRefreshResponse(
            values=[
                GemRefreshValue(
                    game_app_id=key[0],
                    card_rarity=key[1],
                    gem_yield=resolution.gem_yield,
                )
                for key, resolution in sorted(scan.values.items())
            ],
            pending_group_count=scan.pending_count,
            gem_rate_limited=scan.rate_limited,
            gem_retry_after_seconds=scan.retry_after_seconds,
        )

    @router.post("/api/auth/logout", status_code=204)
    async def auth_logout() -> Response:
        response = Response(status_code=204)
        _delete_cookie(response, settings, SESSION_PURPOSE)
        return response

    return router
