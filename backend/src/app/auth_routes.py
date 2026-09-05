from __future__ import annotations

import asyncio
import hmac
import json
import re
import secrets
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Literal, cast

if TYPE_CHECKING:
    from app.settings import Settings
    from app.steam_gateway import SteamGatewayProtocol
    from app.steam_openid import SteamOpenIDVerifier
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    ValidationError,
    field_validator,
    model_validator,
)

from app.booster_pricing import (
    BoosterResolution,
    BoosterScanResult,
    derive_booster_gem_cost,
)
from app.cookies import InvalidCookieError, SignedCookieCodec, utc_datetime
from app.gem_pricing import GemBorderColor, GemKey
from app.json_parsing import DuplicateJSONKeyError, reject_duplicate_object_keys
from app.level_up_optimizer import (
    MAX_APP_ID,
    MAX_GAME_NAME_LENGTH,
    MAX_PLAYER_LEVEL,
    MAX_PLAYER_XP,
    BadgeState,
    Holding,
    LevelUpOptimizationResponse,
    OptimizerInputError,
    level_for_xp,
    parse_normal_card_hash,
)
from app.steam_gateway import BadgeCheck, InventoryCheck, ProfileCheck
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
MAX_BOOSTER_REFRESH_GROUPS = 10_000
_AUTHENTICATION_REQUIRED_MESSAGE = "Steam authentication is required."
_GEM_REFRESH_UNAVAILABLE_MESSAGE = "Gem value refresh is unavailable."
_DUPLICATE_GEM_REFRESH_GROUP_ERROR = "Gem refresh groups must be unique."
_DUPLICATE_BOOSTER_REFRESH_GROUP_ERROR = "Booster refresh game AppIDs must be unique."
_INVALID_BOOSTER_PAIR_ERROR = "Booster card set size and gem cost must be paired."
MAX_LEVEL_UP_REQUEST_BYTES = 2 * 1024 * 1024
MAX_LEVEL_UP_CARD_ROWS = 10_000
MAX_LEVEL_UP_HASH_LENGTH = 512
MAX_LEVEL_UP_CARD_QUANTITY = 1_000_000
MAX_LEVEL_UP_GAME_ROWS = 10_000
_LEVEL_UP_TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)
_LEVEL_UP_BODY_TOO_LARGE_MESSAGE = "Level-up request body is too large."
_LEVEL_UP_INVALID_JSON_MESSAGE = "Level-up request body is invalid JSON."
_LEVEL_UP_INVALID_REQUEST_MESSAGE = "Level-up request is invalid."
_INVALID_BOOSTER_COST_ERROR = "Booster gem cost does not match card set size."
_LEVEL_UP_SELLABLE_QUANTITY_ERROR = "sellable quantity exceeds owned quantity"
_LEVEL_UP_NORMAL_CARD_ERROR = "market hash is not a normal trading card"
_LEVEL_UP_TIMESTAMP_ERROR = "inventory timestamp is invalid"
_LEVEL_UP_DUPLICATE_HASH_ERROR = "card hashes must be unique"
_LEVEL_UP_GAME_NAME_ERROR = "game name is required"
_LEVEL_UP_GAME_APP_ID_ERROR = "game AppID is invalid"
_LEVEL_UP_PLAYER_LEVEL_ERROR = "player XP and level disagree"
_LEVEL_UP_DUPLICATE_GAME_ERROR = "game IDs must be unique"
_LEVEL_UP_GAME_CARD_MATCH_ERROR = "game IDs must match normal-card AppIDs"

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
    badges: BadgeCheck


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

BoosterGameAppId = Annotated[
    str,
    Field(pattern=r"^(?:0|[1-9][0-9]*)$", max_length=20),
]


class GemRefreshGroup(BaseModel):
    app_id: str = Field(pattern=r"^(?:0|[1-9][0-9]*)$", max_length=20)
    item_type: StrictInt = Field(ge=0, le=1_000_000_000)
    border_color: StrictInt = Field(ge=0, le=1)


class GemRefreshRequest(BaseModel):
    groups: list[GemRefreshGroup] = Field(max_length=MAX_GEM_REFRESH_GROUPS)
    booster_game_app_ids: list[BoosterGameAppId] = Field(
        default_factory=list,
        max_length=MAX_BOOSTER_REFRESH_GROUPS,
    )

    @model_validator(mode="after")
    def require_unique_groups(self) -> GemRefreshRequest:
        gem_keys = {
            (group.app_id, group.item_type, group.border_color) for group in self.groups
        }
        if len(gem_keys) != len(self.groups):
            raise ValueError(_DUPLICATE_GEM_REFRESH_GROUP_ERROR)
        if len(set(self.booster_game_app_ids)) != len(self.booster_game_app_ids):
            raise ValueError(_DUPLICATE_BOOSTER_REFRESH_GROUP_ERROR)
        return self


class GemRefreshValue(GemRefreshGroup):
    gem_yield: StrictInt = Field(ge=0)


class BoosterRefreshValue(BaseModel):
    game_app_id: str = Field(pattern=r"^[0-9]+$", max_length=20)
    card_set_size: int | None = Field(default=None, ge=5, le=15)
    gem_cost: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_derived_cost(self) -> BoosterRefreshValue:
        if (self.card_set_size is None) != (self.gem_cost is None):
            raise ValueError(_INVALID_BOOSTER_PAIR_ERROR)
        if self.card_set_size is not None and self.gem_cost != derive_booster_gem_cost(
            self.card_set_size
        ):
            raise ValueError(_INVALID_BOOSTER_COST_ERROR)
        return self


def _valid_level_up_timestamp(value: object) -> bool:
    if (
        not isinstance(value, str)
        or len(value) > 64
        or _LEVEL_UP_TIMESTAMP_RE.fullmatch(value) is None
    ):
        return False
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


class LevelUpCardOwnership(BaseModel):
    model_config = ConfigDict(extra="forbid")

    market_hash_name: StrictStr = Field(
        min_length=1,
        max_length=MAX_LEVEL_UP_HASH_LENGTH,
    )
    owned_quantity: StrictInt = Field(
        ge=1,
        le=MAX_LEVEL_UP_CARD_QUANTITY,
    )
    sellable_quantity: StrictInt = Field(
        ge=0,
        le=MAX_LEVEL_UP_CARD_QUANTITY,
    )

    @model_validator(mode="after")
    def validate_sellable_quantity(self) -> LevelUpCardOwnership:
        if self.sellable_quantity > self.owned_quantity:
            raise ValueError(_LEVEL_UP_SELLABLE_QUANTITY_ERROR)
        if parse_normal_card_hash(self.market_hash_name) is None:
            raise ValueError(_LEVEL_UP_NORMAL_CARD_ERROR)
        return self


class LevelUpGame(BaseModel):
    model_config = ConfigDict(extra="forbid")

    app_id: StrictStr = Field(pattern=r"^[1-9][0-9]*$", max_length=20)
    game_name: StrictStr = Field(
        min_length=1,
        max_length=MAX_GAME_NAME_LENGTH,
    )
    card_set_size: StrictInt | None = Field(ge=5, le=15)
    badge_level: StrictInt = Field(ge=0, le=5)

    @field_validator("game_name", mode="before")
    @classmethod
    def normalize_game_name(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip()
            if not value:
                raise ValueError(_LEVEL_UP_GAME_NAME_ERROR)
        return value

    @model_validator(mode="after")
    def validate_app_id(self) -> LevelUpGame:
        try:
            app_id = int(self.app_id)
        except TypeError, ValueError:
            raise ValueError(_LEVEL_UP_GAME_APP_ID_ERROR) from None
        if not 0 < app_id <= MAX_APP_ID:
            raise ValueError(_LEVEL_UP_GAME_APP_ID_ERROR)
        return self


class LevelUpRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inventory_refreshed_at: StrictStr = Field(min_length=1, max_length=64)
    badge_refreshed_at: StrictStr = Field(min_length=1, max_length=64)
    player_xp: StrictInt = Field(ge=0, le=MAX_PLAYER_XP)
    player_level: StrictInt = Field(ge=0, le=MAX_PLAYER_LEVEL)
    games: list[LevelUpGame] = Field(max_length=MAX_LEVEL_UP_GAME_ROWS)
    cards: list[LevelUpCardOwnership] = Field(max_length=MAX_LEVEL_UP_CARD_ROWS)

    @model_validator(mode="after")
    def validate_request(self) -> LevelUpRequest:
        if not _valid_level_up_timestamp(self.inventory_refreshed_at):
            raise ValueError(_LEVEL_UP_TIMESTAMP_ERROR)
        if not _valid_level_up_timestamp(self.badge_refreshed_at):
            raise ValueError(_LEVEL_UP_TIMESTAMP_ERROR)
        if level_for_xp(self.player_xp) != self.player_level:
            raise ValueError(_LEVEL_UP_PLAYER_LEVEL_ERROR)
        hashes = {card.market_hash_name for card in self.cards}
        if len(hashes) != len(self.cards):
            raise ValueError(_LEVEL_UP_DUPLICATE_HASH_ERROR)
        card_app_ids: set[int] = set()
        for card in self.cards:
            parsed = parse_normal_card_hash(card.market_hash_name)
            if parsed is None:
                raise ValueError(_LEVEL_UP_NORMAL_CARD_ERROR)
            card_app_ids.add(parsed[0])
        game_app_ids = {int(game.app_id) for game in self.games}
        if len(game_app_ids) != len(self.games):
            raise ValueError(_LEVEL_UP_DUPLICATE_GAME_ERROR)
        if game_app_ids != card_app_ids:
            raise ValueError(_LEVEL_UP_GAME_CARD_MATCH_ERROR)
        return self


class GemRefreshResponse(BaseModel):
    values: list[GemRefreshValue]
    pending_group_count: int = Field(ge=0)
    gem_rate_limited: bool
    gem_retry_after_seconds: int | None = Field(
        default=None,
        ge=0,
        le=900,
    )
    boosters: list[BoosterRefreshValue] = Field(default_factory=list)
    pending_booster_count: int = Field(default=0, ge=0)


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _cookie_path(purpose: str) -> str:
    if purpose == STATE_PURPOSE:
        return "/api/auth/steam"
    return "/"


class _RequestBodyTooLargeError(ValueError):
    pass


async def _read_level_up_json(request: Request) -> object:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        normalized = content_length.strip()
        significant = normalized.lstrip("0")
        if (
            not normalized.isascii()
            or not normalized
            or not normalized.isdecimal()
            or len(significant) > len(str(MAX_LEVEL_UP_REQUEST_BYTES))
            or (significant and int(significant) > MAX_LEVEL_UP_REQUEST_BYTES)
        ):
            raise _RequestBodyTooLargeError
    body = bytearray()
    async for chunk in request.stream():
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise TypeError
        chunk_size = chunk.nbytes if isinstance(chunk, memoryview) else len(chunk)
        if len(body) + chunk_size > MAX_LEVEL_UP_REQUEST_BYTES:
            raise _RequestBodyTooLargeError
        body.extend(chunk)
    try:
        return json.loads(
            body.decode("utf-8"),
            object_pairs_hook=reject_duplicate_object_keys,
        )
    except (
        DuplicateJSONKeyError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
    ):
        raise ValueError from None


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
        httponly=True,
        secure=settings.cookie_secure,
        samesite=_cookie_samesite(settings, purpose),
        path=_cookie_path(purpose),
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


def _unavailable_badges() -> BadgeCheck:
    return BadgeCheck(
        status="unavailable",
        message="Steam badge check is unavailable.",
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
    badges: BadgeCheck,
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
            badges=badges,
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


def _level_up_unavailable_response(
    settings: Settings,
    *,
    now: datetime,
    inventory_refreshed_at: str,
    reason: str,
) -> LevelUpOptimizationResponse:
    try:
        text = (
            inventory_refreshed_at[:-1] + "+00:00"
            if inventory_refreshed_at.endswith("Z")
            else inventory_refreshed_at
        )
        inventory_time = datetime.fromisoformat(text).astimezone(UTC)
    except TypeError, ValueError, AttributeError, OverflowError:
        inventory_time = now
    contract = None
    with suppress(AttributeError, TypeError, ValueError):
        contract = settings.level_up_money_contract
    return LevelUpOptimizationResponse(
        status="unavailable",
        reason=reason,
        generated_at=now,
        inventory_refreshed_at=inventory_time,
        currency_code=getattr(contract, "currency_code", None),
        minor_digits=getattr(contract, "minor_digits", None),
        price_basis="instant_top_of_book" if contract is not None else None,
        steam_fee_bps=getattr(contract, "steam_fee_bps", None),
        publisher_fee_bps=getattr(contract, "publisher_fee_bps", None),
        min_fee_minor=getattr(contract, "min_fee_minor", None),
        taxes_included=False if contract is not None else None,
    )


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
        except InvalidCookieError, OpenIDValidationError, ValueError:
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
        except InvalidCookieError, ValueError:
            return UnauthenticatedSessionResponse()
        try:
            profile_result, badge_result = await asyncio.gather(
                steam_gateway.check_profile(steam_id),
                steam_gateway.check_badges(steam_id),
                return_exceptions=True,
            )
        except Exception:  # noqa: BLE001 - preserve independent fallback states
            profile_result = _unavailable_profile()
            badge_result = _unavailable_badges()
        profile = (
            profile_result
            if isinstance(profile_result, ProfileCheck)
            else _unavailable_profile()
        )
        badges = (
            badge_result
            if isinstance(badge_result, BadgeCheck)
            else _unavailable_badges()
        )
        return _session_response(steam_id, profile, badges)

    @router.post(
        "/api/auth/inventory",
        response_model=InventoryCheck,
        responses={401: {"model": ErrorResponse}},
    )
    async def auth_inventory(request: Request, response: Response) -> InventoryCheck:
        response.headers["Cache-Control"] = "no-store"
        token = request.cookies.get(settings.session_cookie_name)
        if not token:
            raise HTTPException(
                status_code=401,
                detail=_AUTHENTICATION_REQUIRED_MESSAGE,
                headers={"Cache-Control": "no-store"},
            )
        try:
            steam_id = _session_steam_id(
                token,
                settings,
                codec,
                now=current_time(),
            )
        except (InvalidCookieError, ValueError) as error:
            raise HTTPException(
                status_code=401,
                detail=_AUTHENTICATION_REQUIRED_MESSAGE,
                headers={"Cache-Control": "no-store"},
            ) from error
        expected_steam_id = request.headers.get("x-expected-steam-id")
        if expected_steam_id != steam_id:
            raise HTTPException(
                status_code=401,
                detail=_AUTHENTICATION_REQUIRED_MESSAGE,
                headers={"Cache-Control": "no-store"},
            )
        try:
            return await steam_gateway.check_inventory(steam_id)
        except Exception:  # noqa: BLE001 - map gateway failures to unavailable
            return _unavailable_inventory()

    @router.post(
        "/api/auth/level-up",
        responses={401: {"model": ErrorResponse}},
    )
    async def auth_level_up(request: Request, response: Response) -> Response:
        response.headers["Cache-Control"] = "no-store"
        token = request.cookies.get(settings.session_cookie_name)
        if not token:
            raise HTTPException(
                status_code=401,
                detail=_AUTHENTICATION_REQUIRED_MESSAGE,
                headers={"Cache-Control": "no-store"},
            )
        try:
            steam_id = _session_steam_id(
                token,
                settings,
                codec,
                now=current_time(),
            )
        except (InvalidCookieError, ValueError) as error:
            raise HTTPException(
                status_code=401,
                detail=_AUTHENTICATION_REQUIRED_MESSAGE,
                headers={"Cache-Control": "no-store"},
            ) from error
        if request.headers.get("x-expected-steam-id") != steam_id:
            raise HTTPException(
                status_code=401,
                detail=_AUTHENTICATION_REQUIRED_MESSAGE,
                headers={"Cache-Control": "no-store"},
            )
        try:
            raw_payload = await _read_level_up_json(request)
        except _RequestBodyTooLargeError as error:
            raise HTTPException(
                status_code=413,
                detail=_LEVEL_UP_BODY_TOO_LARGE_MESSAGE,
                headers={"Cache-Control": "no-store"},
            ) from error
        except (TypeError, ValueError, UnicodeError) as error:
            raise HTTPException(
                status_code=422,
                detail=_LEVEL_UP_INVALID_JSON_MESSAGE,
                headers={"Cache-Control": "no-store"},
            ) from error
        try:
            payload = LevelUpRequest.model_validate(raw_payload)
        except (TypeError, ValidationError, ValueError) as error:
            raise HTTPException(
                status_code=422,
                detail=_LEVEL_UP_INVALID_REQUEST_MESSAGE,
                headers={"Cache-Control": "no-store"},
            ) from error
        try:
            holdings = tuple(
                Holding(
                    market_hash_name=card.market_hash_name,
                    owned_quantity=card.owned_quantity,
                    sellable_quantity=card.sellable_quantity,
                )
                for card in payload.cards
            )
        except (TypeError, ValueError, OptimizerInputError) as error:
            raise HTTPException(
                status_code=422,
                detail=_LEVEL_UP_INVALID_REQUEST_MESSAGE,
                headers={"Cache-Control": "no-store"},
            ) from error
        try:
            game_metadata = {
                int(game.app_id): (game.game_name, game.card_set_size)
                for game in payload.games
            }
            badge_state = BadgeState(
                player_xp=payload.player_xp,
                player_level=payload.player_level,
                normal_badge_levels={
                    int(game.app_id): game.badge_level for game in payload.games
                },
            )
        except (TypeError, ValueError, OptimizerInputError) as error:
            raise HTTPException(
                status_code=422,
                detail=_LEVEL_UP_INVALID_REQUEST_MESSAGE,
                headers={"Cache-Control": "no-store"},
            ) from error
        try:
            result = await steam_gateway.check_level_up(
                holdings,
                game_metadata,
                badge_state,
                inventory_refreshed_at=payload.inventory_refreshed_at,
                badge_refreshed_at=payload.badge_refreshed_at,
            )
        except Exception:  # noqa: BLE001 - recommendation failures are isolated
            fallback_now = current_time()
            result = _level_up_unavailable_response(
                settings,
                now=fallback_now,
                inventory_refreshed_at=payload.inventory_refreshed_at,
                reason="badge_data_unavailable",
            )
        if not isinstance(result, LevelUpOptimizationResponse):
            fallback_now = current_time()
            result = _level_up_unavailable_response(
                settings,
                now=fallback_now,
                inventory_refreshed_at=payload.inventory_refreshed_at,
                reason="badge_data_unavailable",
            )
        return JSONResponse(
            content=result.to_dict(),
            headers={"Cache-Control": "no-store"},
        )

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
        keys = sorted(
            {
                GemKey(
                    app_id=group.app_id,
                    item_type=group.item_type,
                    border_color=cast("GemBorderColor", group.border_color),
                )
                for group in payload.groups
            },
            key=lambda key: (int(key.app_id), key.item_type, key.border_color),
        )
        try:
            scan = await steam_gateway.refresh_gems(keys)
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
        requested_booster_ids = tuple(
            sorted(
                set(payload.booster_game_app_ids),
                key=lambda value: (len(value), value),
            )
        )
        booster_pending_count = len(requested_booster_ids)
        booster_scan = BoosterScanResult(
            values={},
            pending_count=booster_pending_count,
        )
        if requested_booster_ids:
            try:
                candidate_booster_scan = await steam_gateway.refresh_boosters(
                    requested_booster_ids
                )
                if isinstance(candidate_booster_scan, BoosterScanResult):
                    booster_scan = candidate_booster_scan
                    booster_pending_count = min(
                        len(requested_booster_ids),
                        max(0, candidate_booster_scan.pending_count),
                    )
            except (
                AttributeError,
                OSError,
                TimeoutError,
                TypeError,
                ValueError,
                ArithmeticError,
                RuntimeError,
            ):
                # Booster refresh is independent; unknown values remain null.
                booster_scan = BoosterScanResult(
                    values={},
                    pending_count=booster_pending_count,
                )

        requested_keys = set(keys)
        gem_values = [
            GemRefreshValue(
                app_id=key.app_id,
                item_type=key.item_type,
                border_color=key.border_color,
                gem_yield=resolution.gem_yield,
            )
            for key, resolution in sorted(
                scan.values.items(),
                key=lambda entry: (
                    int(entry[0].app_id),
                    entry[0].item_type,
                    entry[0].border_color,
                ),
            )
            if key in requested_keys and getattr(resolution, "key", None) == key
        ]

        booster_values = []
        for game_app_id in requested_booster_ids:
            resolution = (
                booster_scan.values.get(game_app_id)
                if isinstance(booster_scan.values, Mapping)
                else None
            )
            if not isinstance(resolution, BoosterResolution):
                resolution = None
            try:
                booster_values.append(
                    BoosterRefreshValue(
                        game_app_id=game_app_id,
                        card_set_size=(
                            resolution.card_set_size if resolution is not None else None
                        ),
                        gem_cost=(
                            resolution.gem_cost if resolution is not None else None
                        ),
                    )
                )
            except TypeError, ValueError:
                booster_values.append(
                    BoosterRefreshValue(
                        game_app_id=game_app_id,
                        card_set_size=None,
                        gem_cost=None,
                    )
                )
        return GemRefreshResponse(
            values=gem_values,
            pending_group_count=min(len(keys), max(0, scan.pending_count)),
            gem_rate_limited=scan.rate_limited,
            gem_retry_after_seconds=scan.retry_after_seconds,
            boosters=booster_values,
            pending_booster_count=booster_pending_count,
        )

    @router.post("/api/auth/logout", status_code=204)
    async def auth_logout() -> Response:
        response = Response(status_code=204)
        _delete_cookie(response, settings, SESSION_PURPOSE)
        return response

    return router
