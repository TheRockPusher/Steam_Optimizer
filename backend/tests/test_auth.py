from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterable, Mapping

    from httpx2 import Response

from app.booster_pricing import BoosterResolution, BoosterScanResult
from app.cookies import (
    InvalidCookieLifetimeError,
    InvalidCookiePayloadError,
    InvalidCookiePurposeError,
    SignedCookieCodec,
)
from app.gem_pricing import GemKey, GemResolution, GemScanResult
from app.level_up_optimizer import LevelUpOptimizationResponse
from app.main import create_app
from app.settings import Settings
from app.steam_gateway import (
    PROFILE_ENDPOINT,
    InventoryCheck,
    ProfileCheck,
    SteamGateway,
)
from app.steam_openid import (
    OpenIDVerifierUnavailableError,
    SteamOpenIDClient,
)

NOW = datetime(2026, 8, 26, 12, 0, tzinfo=UTC)
AUTHENTICATED_STEAM_ID = "76561198000000000"


class FakeVerifier:
    def __init__(self, *, valid: bool = True) -> None:
        self.valid = valid
        self.calls: list[Mapping[str, str]] = []

    async def verify(self, params: Mapping[str, str]) -> bool:
        self.calls.append(params)
        return self.valid


class UnavailableVerifier:
    async def verify(self, params: Mapping[str, str]) -> bool:
        del params
        raise OpenIDVerifierUnavailableError


class FakeGateway:
    def __init__(
        self,
        *,
        inventory_retry_after_seconds: int | None = None,
        inventory_error: Exception | None = None,
        level_up_result: LevelUpOptimizationResponse | None = None,
        level_up_error: Exception | None = None,
    ) -> None:
        self.inventory_retry_after_seconds = inventory_retry_after_seconds
        self.inventory_error = inventory_error
        self.level_up_result = level_up_result
        self.level_up_error = level_up_error
        self.profile_calls = 0
        self.inventory_calls = 0
        self.level_up_calls: list[tuple[str, object, object, object]] = []
        self.gem_refresh_calls: list[list[GemKey]] = []
        self.booster_refresh_calls: list[tuple[str, ...]] = []

    async def check_profile(self, steam_id: str) -> ProfileCheck:
        self.profile_calls += 1
        del steam_id
        return ProfileCheck(
            status="public",
            message="profile ok",
            display_name="Ada",
            avatar_url="https://cdn.example/avatar.jpg",
        )

    async def check_inventory(self, steam_id: str) -> InventoryCheck:
        self.inventory_calls += 1
        del steam_id
        if self.inventory_error is not None:
            raise self.inventory_error
        return InventoryCheck(
            status="private",
            message="inventory private",
            retry_after_seconds=self.inventory_retry_after_seconds,
        )

    async def check_level_up(
        self,
        steam_id: str,
        holdings: object,
        inventory_refreshed_at: object,
        *,
        now: object = None,
    ) -> LevelUpOptimizationResponse:
        self.level_up_calls.append((steam_id, holdings, inventory_refreshed_at, now))
        if self.level_up_error is not None:
            raise self.level_up_error
        if self.level_up_result is not None:
            return self.level_up_result
        return LevelUpOptimizationResponse(
            status="unavailable",
            reason="badge_data_unavailable",
            generated_at=NOW,
            inventory_refreshed_at=NOW,
            catalog_total_sets=0,
            catalog_resolved_sets=0,
            catalog_pending_sets=0,
        )

    async def refresh_gems(
        self,
        keys: Iterable[GemKey],
    ) -> GemScanResult:
        requested = list(keys)
        self.gem_refresh_calls.append(requested)
        return GemScanResult(
            values={
                key: GemResolution(
                    key=key,
                    representative_hash="cached",
                    gem_yield=42,
                    observed_at="2026-08-28T00:00:00Z",
                )
                for key in requested
            }
        )

    async def refresh_boosters(
        self,
        game_app_ids: Iterable[str],
    ) -> BoosterScanResult:
        game_app_ids = tuple(game_app_ids)
        self.booster_refresh_calls.append(game_app_ids)
        return BoosterScanResult(
            values={
                game_app_id: BoosterResolution(card_set_size=10, gem_cost=600)
                for game_app_id in game_app_ids
            }
        )


def make_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "development",
        "frontend_url": "http://frontend.example",
        "public_backend_url": "http://backend.example",
        "allowed_origins": ["http://frontend.example"],
        "signing_secret": "test-signing-secret",
        "cookie_secure": False,
    }
    values.update(overrides)
    return Settings.model_validate(values)


def callback_query(
    settings: Settings,
    *,
    return_to: str | None = None,
    nonce: str | None = None,
    callback_state: str | None = None,
) -> str:
    identity = "https://steamcommunity.com/openid/id/76561198000000000"
    return_to = return_to or settings.callback_url
    params = {
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "id_res",
        "openid.op_endpoint": "https://steamcommunity.com/openid/login",
        "openid.return_to": return_to,
        "openid.response_nonce": nonce or "2026-08-26T12:00:00Z-test",
        "openid.assoc_handle": "handle",
        "openid.signed": (
            "ns,op_endpoint,return_to,response_nonce,assoc_handle,identity,claimed_id"
        ),
        "openid.sig": "signature",
        "openid.identity": identity,
        "openid.claimed_id": identity,
    }
    query = urlencode(params)
    state_values = parse_qs(urlsplit(return_to).query).get("state", [])
    if not state_values:
        return query
    state_value = callback_state if callback_state is not None else state_values[0]
    return query + f"&{urlencode({'state': state_value})}"


def return_to_from_start(response: Response) -> str:
    location = response.headers["location"]
    return parse_qs(urlsplit(location).query)["openid.return_to"][0]


def _authenticate(client: TestClient, settings: Settings) -> None:
    start = client.get("/api/auth/steam/start", follow_redirects=False)
    callback = client.get(
        "/api/auth/steam/callback?"
        + callback_query(settings, return_to=return_to_from_start(start)),
        follow_redirects=False,
    )
    assert callback.status_code == 302


def test_development_generates_ephemeral_signing_secret() -> None:
    first = Settings(environment="development", signing_secret="")
    second = Settings(environment="development", signing_secret="")
    assert len(first.signing_secret) >= 32
    assert first.signing_secret != second.signing_secret


def test_cookie_encoding_errors_explain_invalid_input() -> None:
    codec = SignedCookieCodec("test-signing-secret")
    expires_at = NOW + timedelta(minutes=5)

    for purpose in ("", "bad purpose", "bad/purpose", "bad.purpose", "sessiön"):
        with pytest.raises(InvalidCookiePurposeError, match="ASCII token"):
            codec.encode(purpose, {}, issued_at=NOW, expires_at=expires_at)
    with pytest.raises(InvalidCookieLifetimeError, match="expiry"):
        codec.encode("session", {}, issued_at=NOW, expires_at=NOW)
    with pytest.raises(InvalidCookiePayloadError, match="JSON serializable"):
        codec.encode(
            "session",
            {"unsupported": object()},
            issued_at=NOW,
            expires_at=expires_at,
        )


@pytest.mark.parametrize(
    "secret",
    [None, "", "development-only-change-this-signing-secret", "short"],
)
def test_non_development_requires_strong_non_placeholder_secret(
    secret: str | None,
) -> None:
    with pytest.raises(ValidationError):
        Settings.model_validate({"environment": "production", "signing_secret": secret})


def test_credentialed_cors_rejects_wildcard_origin() -> None:
    with pytest.raises(ValidationError):
        Settings(allowed_origins=["*"])


def test_none_cookie_samesite_requires_secure_cookie() -> None:
    with pytest.raises(ValidationError):
        Settings(cookie_samesite="none", cookie_secure=False)
    assert (
        Settings(cookie_samesite="none", cookie_secure=True).cookie_samesite == "none"
    )


def test_validation_errors_hide_sensitive_inputs() -> None:
    signing_value = "sensitive-signing-value-0123456789abcdef"
    steam_key = "sensitive-steam-api-key"

    with pytest.raises(ValidationError) as error:
        Settings.model_validate(
            {
                "environment": "production",
                "signing_secret": signing_value,
                "steam_web_api_key": steam_key,
                "cookie_samesite": "none",
                "cookie_secure": False,
            }
        )

    error_text = str(error.value)
    assert signing_value not in error_text
    assert steam_key not in error_text


def test_start_redirects_to_steam_and_login_state_cookie_is_lax() -> None:
    settings = make_settings(cookie_secure=True, cookie_samesite="strict")
    app = create_app(settings, clock=lambda: NOW)
    with TestClient(app) as client:
        response = client.get("/api/auth/steam/start", follow_redirects=False)
    assert response.status_code == 302
    location = response.headers["location"]
    assert urlsplit(location).netloc == "steamcommunity.com"
    query = parse_qs(urlsplit(location).query)
    assert query["openid.mode"] == ["checkid_setup"]
    assert query["openid.return_to"][0].startswith(settings.callback_url + "?state=")
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie
    assert "Secure" in cookie
    assert "SameSite=lax" in cookie


def test_callback_rejects_invalid_assertion_and_clears_state() -> None:
    settings = make_settings()
    verifier = FakeVerifier(valid=False)
    app = create_app(settings, openid_verifier=verifier, clock=lambda: NOW)
    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(settings, return_to=return_to_from_start(start)),
            follow_redirects=False,
        )

    assert start.status_code == 302
    assert callback.status_code == 400
    assert verifier.calls
    assert "openid.mode" in verifier.calls[0]
    assert "Max-Age=0" in callback.headers["set-cookie"]


def test_callback_maps_verifier_outage_to_service_unavailable() -> None:
    settings = make_settings()
    app = create_app(settings, openid_verifier=UnavailableVerifier(), clock=lambda: NOW)
    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(settings, return_to=return_to_from_start(start)),
            follow_redirects=False,
        )

    assert callback.status_code == 503
    assert callback.json() == {"detail": "Steam authentication is unavailable."}


def test_session_and_logout_use_signed_session_cookie() -> None:
    settings = make_settings(cookie_samesite="strict")
    gateway = FakeGateway(inventory_retry_after_seconds=17)
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )
    with TestClient(app) as client:
        _authenticate(client, settings)
        session = client.get("/api/auth/session")
        logout = client.post("/api/auth/logout")
        after_logout = client.get("/api/auth/session")

    assert session.status_code == 200
    assert session.json() == {
        "authenticated": True,
        "user": {
            "steam_id": "76561198000000000",
            "display_name": "Ada",
            "avatar_url": "https://cdn.example/avatar.jpg",
        },
        "checks": {
            "profile": {"status": "public", "message": "profile ok"},
        },
    }
    assert session.headers["cache-control"] == "no-store"
    assert gateway.profile_calls == 1
    assert gateway.inventory_calls == 0
    assert logout.status_code == 204
    assert after_logout.json() == {"authenticated": False}


@pytest.mark.parametrize("session_cookie", [None, "invalid-session-cookie"])
def test_inventory_requires_authenticated_session(
    session_cookie: str | None,
) -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        if session_cookie is not None:
            client.cookies.set(settings.session_cookie_name, session_cookie)
        response = client.post("/api/auth/inventory")

    assert response.status_code == 401
    assert response.json() == {"detail": "Steam authentication is required."}
    assert response.headers["cache-control"] == "no-store"
    assert gateway.profile_calls == 0
    assert gateway.inventory_calls == 0


def test_inventory_rejects_session_account_mismatch() -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        _authenticate(client, settings)
        response = client.post(
            "/api/auth/inventory",
            headers={"X-Expected-Steam-ID": "76561198000000001"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Steam authentication is required."}
    assert response.headers["cache-control"] == "no-store"
    assert gateway.inventory_calls == 0


def test_inventory_returns_raw_result_with_retry_metadata() -> None:
    settings = make_settings()
    gateway = FakeGateway(inventory_retry_after_seconds=17)
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        _authenticate(client, settings)
        response = client.post(
            "/api/auth/inventory",
            headers={"X-Expected-Steam-ID": AUTHENTICATED_STEAM_ID},
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "status": "private",
        "message": "inventory private",
        "retry_after_seconds": 17,
        "rate_limited": False,
        "total_asset_count": 0,
        "unique_item_count": 0,
        "priceable_item_count": 0,
        "priced_item_count": 0,
        "price_status": "unavailable",
        "price_message": "Steam item prices are unavailable.",
        "items": [],
        "boosters": [],
        "gem_status": "unavailable",
        "gem_message": "Gem prices are unavailable.",
        "gem_priceable_item_count": 0,
        "gem_priced_item_count": 0,
        "gem_rate_limited": False,
        "gem_retry_after_seconds": None,
        "gem_cash_context": None,
    }
    assert gateway.profile_calls == 0
    assert gateway.inventory_calls == 1


def test_inventory_gateway_exception_returns_unavailable_result() -> None:
    settings = make_settings()
    gateway = FakeGateway(inventory_error=RuntimeError("gateway unavailable"))
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        _authenticate(client, settings)
        response = client.post(
            "/api/auth/inventory",
            headers={"X-Expected-Steam-ID": AUTHENTICATED_STEAM_ID},
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "status": "unavailable",
        "message": "Steam inventory check is unavailable.",
        "retry_after_seconds": None,
        "rate_limited": False,
        "total_asset_count": 0,
        "unique_item_count": 0,
        "priceable_item_count": 0,
        "priced_item_count": 0,
        "price_status": "unavailable",
        "price_message": "Steam item prices are unavailable.",
        "items": [],
        "boosters": [],
        "gem_status": "unavailable",
        "gem_message": "Gem prices are unavailable.",
        "gem_priceable_item_count": 0,
        "gem_priced_item_count": 0,
        "gem_rate_limited": False,
        "gem_retry_after_seconds": None,
        "gem_cash_context": None,
    }
    assert gateway.profile_calls == 0
    assert gateway.inventory_calls == 1


def _valid_level_up_payload() -> dict[str, object]:
    return {
        "inventory_refreshed_at": NOW.isoformat().replace("+00:00", "Z"),
        "cards": [
            {
                "market_hash_name": "440-Test Card (Trading Card)",
                "owned_quantity": 2,
                "sellable_quantity": 1,
            }
        ],
    }


def test_level_up_requires_session_and_matching_expected_account() -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        unauthenticated = client.post(
            "/api/auth/level-up",
            headers={"X-Expected-Steam-ID": AUTHENTICATED_STEAM_ID},
            json=_valid_level_up_payload(),
        )
        _authenticate(client, settings)
        mismatched = client.post(
            "/api/auth/level-up",
            headers={"X-Expected-Steam-ID": "76561198000000001"},
            json=_valid_level_up_payload(),
        )

    assert unauthenticated.status_code == 401
    assert mismatched.status_code == 401
    assert unauthenticated.headers["cache-control"] == "no-store"
    assert mismatched.headers["cache-control"] == "no-store"
    assert gateway.level_up_calls == []
    assert gateway.inventory_calls == 0


def test_level_up_forwards_one_bounded_snapshot_without_inventory_fetch() -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        _authenticate(client, settings)
        response = client.post(
            "/api/auth/level-up",
            headers={"X-Expected-Steam-ID": AUTHENTICATED_STEAM_ID},
            json=_valid_level_up_payload(),
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["status"] == "unavailable"
    assert response.json()["reason"] == "badge_data_unavailable"
    assert len(gateway.level_up_calls) == 1
    steam_id, holdings, refreshed_at, called_at = gateway.level_up_calls[0]
    assert steam_id == AUTHENTICATED_STEAM_ID
    assert refreshed_at == "2026-08-26T12:00:00Z"
    assert called_at is None
    assert len(holdings) == 1
    assert holdings[0].market_hash_name == "440-Test Card (Trading Card)"
    assert holdings[0].owned_quantity == 2
    assert holdings[0].sellable_quantity == 1
    assert gateway.inventory_calls == 0


@pytest.mark.parametrize(
    "payload",
    [
        {
            "inventory_refreshed_at": "2026-08-26T12:00:00Z",
            "cards": [
                {
                    "market_hash_name": "440-Test Card (Trading Card)",
                    "owned_quantity": 1,
                    "sellable_quantity": 1,
                },
                {
                    "market_hash_name": "440-Test Card (Trading Card)",
                    "owned_quantity": 1,
                    "sellable_quantity": 1,
                },
            ],
        },
        {
            "inventory_refreshed_at": "2026-08-26T12:00:00Z",
            "cards": [
                {
                    "market_hash_name": "440-Test Card (Trading Card)",
                    "owned_quantity": True,
                    "sellable_quantity": 1,
                }
            ],
        },
        {
            "inventory_refreshed_at": "2026-08-26T12:00:00Z",
            "cards": [
                {
                    "market_hash_name": "440-Test Card (Trading Card)",
                    "owned_quantity": 1,
                    "sellable_quantity": 2,
                }
            ],
        },
        {
            "inventory_refreshed_at": "not-a-timestamp",
            "cards": [],
        },
        {
            "inventory_refreshed_at": "2026-08-26T12:00:00Z",
            "cards": [],
            "unknown": True,
        },
        {
            "inventory_refreshed_at": "2026-08-26T12:00:00Z",
            "cards": [
                {
                    "market_hash_name": "440-Test Card (Trading Card)",
                    "owned_quantity": 1,
                    "sellable_quantity": 1,
                    "unknown": True,
                }
            ],
        },
    ],
)
def test_level_up_rejects_invalid_snapshot_contract(
    payload: dict[str, object],
) -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        _authenticate(client, settings)
        response = client.post(
            "/api/auth/level-up",
            headers={"X-Expected-Steam-ID": AUTHENTICATED_STEAM_ID},
            json=payload,
        )

    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert gateway.level_up_calls == []
    assert gateway.inventory_calls == 0


def test_level_up_rejects_oversize_and_excessively_nested_json() -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )
    nested = "[" * 1100 + "0" + "]" * 1100

    with TestClient(app) as client:
        _authenticate(client, settings)
        too_large = client.post(
            "/api/auth/level-up",
            headers={
                "Content-Type": "application/json",
                "X-Expected-Steam-ID": AUTHENTICATED_STEAM_ID,
            },
            content=" " * (2 * 1024 * 1024 + 1),
        )
        too_deep = client.post(
            "/api/auth/level-up",
            headers={
                "Content-Type": "application/json",
                "X-Expected-Steam-ID": AUTHENTICATED_STEAM_ID,
            },
            content=nested,
        )

    assert too_large.status_code == 413
    assert too_deep.status_code == 422
    assert too_large.headers["cache-control"] == "no-store"
    assert too_deep.headers["cache-control"] == "no-store"
    assert gateway.level_up_calls == []
    assert gateway.inventory_calls == 0


def test_level_up_gateway_type_error_is_isolated_without_retry() -> None:
    settings = make_settings()
    gateway = FakeGateway(level_up_error=TypeError("implementation failure"))
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        _authenticate(client, settings)
        response = client.post(
            "/api/auth/level-up",
            headers={"X-Expected-Steam-ID": AUTHENTICATED_STEAM_ID},
            json=_valid_level_up_payload(),
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["status"] == "unavailable"
    assert len(gateway.level_up_calls) == 1
    assert gateway.inventory_calls == 0


def test_gem_refresh_requires_authenticated_session() -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/auth/gems",
            json={"groups": [{"app_id": "440", "item_type": 5, "border_color": 0}]},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Steam authentication is required."}
    assert gateway.gem_refresh_calls == []


def test_gem_refresh_reads_cache_without_profile_or_inventory_checks() -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(settings, return_to=return_to_from_start(start)),
            follow_redirects=False,
        )
        response = client.post(
            "/api/auth/gems",
            json={
                "groups": [
                    {"app_id": "440", "item_type": 5, "border_color": 0},
                    {"app_id": "440", "item_type": 5, "border_color": 1},
                ],
                "booster_game_app_ids": ["440"],
            },
        )

    assert callback.status_code == 302
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "values": [
            {
                "app_id": "440",
                "item_type": 5,
                "border_color": 0,
                "gem_yield": 42,
            },
            {
                "app_id": "440",
                "item_type": 5,
                "border_color": 1,
                "gem_yield": 42,
            },
        ],
        "pending_group_count": 0,
        "gem_rate_limited": False,
        "gem_retry_after_seconds": None,
        "boosters": [
            {
                "game_app_id": "440",
                "card_set_size": 10,
                "gem_cost": 600,
            }
        ],
        "pending_booster_count": 0,
    }
    assert gateway.profile_calls == 0
    assert gateway.inventory_calls == 0
    assert gateway.gem_refresh_calls == [
        [
            GemKey(app_id="440", item_type=5, border_color=0),
            GemKey(app_id="440", item_type=5, border_color=1),
        ]
    ]
    assert gateway.booster_refresh_calls == [("440",)]


def test_gem_refresh_sorts_full_gem_keys() -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )
    groups = [
        {"app_id": "44", "item_type": 7, "border_color": 1},
        {"app_id": "2", "item_type": 99, "border_color": 0},
        {"app_id": "10", "item_type": 9, "border_color": 0},
        {"app_id": "10", "item_type": 5, "border_color": 1},
    ]

    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(settings, return_to=return_to_from_start(start)),
            follow_redirects=False,
        )
        response = client.post("/api/auth/gems", json={"groups": groups})

    assert callback.status_code == 302
    assert response.status_code == 200
    assert [
        (value["app_id"], value["item_type"], value["border_color"])
        for value in response.json()["values"]
    ] == [("2", 99, 0), ("10", 5, 1), ("10", 9, 0), ("44", 7, 1)]
    assert gateway.gem_refresh_calls == [
        [
            GemKey(app_id="2", item_type=99, border_color=0),
            GemKey(app_id="10", item_type=5, border_color=1),
            GemKey(app_id="10", item_type=9, border_color=0),
            GemKey(app_id="44", item_type=7, border_color=1),
        ]
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {
            "groups": [
                {"app_id": "440", "item_type": 5, "border_color": 0},
                {"app_id": "440", "item_type": 5, "border_color": 0},
            ]
        },
        {
            "groups": [],
            "booster_game_app_ids": ["440", "440"],
        },
    ],
)
def test_gem_refresh_rejects_duplicate_refresh_identities(
    payload: dict[str, object],
) -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        _authenticate(client, settings)
        response = client.post("/api/auth/gems", json=payload)

    assert response.status_code == 422
    assert gateway.gem_refresh_calls == []
    assert gateway.booster_refresh_calls == []


def test_gem_refresh_rejects_non_integer_border_colors() -> None:
    settings = make_settings()
    gateway = FakeGateway()
    app = create_app(
        settings,
        steam_gateway=gateway,
        openid_verifier=FakeVerifier(),
        clock=lambda: NOW,
    )

    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(settings, return_to=return_to_from_start(start)),
            follow_redirects=False,
        )
        responses = [
            client.post(
                "/api/auth/gems",
                json={
                    "groups": [
                        {
                            "app_id": "440",
                            "item_type": 5,
                            "border_color": invalid_border_color,
                        }
                    ]
                },
            )
            for invalid_border_color in (True, False, 0.0, 1.0)
        ]

    assert callback.status_code == 302
    assert all(response.status_code == 422 for response in responses)
    assert gateway.gem_refresh_calls == []


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: object,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self.payload = payload
        self.headers = dict(headers or {})
        self.text = ""

    def json(self) -> object:
        return self.payload

    def aiter_bytes(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        del chunk_size

        async def chunks() -> AsyncIterator[bytes]:
            yield b""

        return chunks()


class FakeStreamMixin:
    @asynccontextmanager
    async def stream(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> AsyncIterator[FakeResponse]:
        del method, url, params, headers, follow_redirects, timeout
        yield FakeResponse(500, {})


class FakeHttpClient(FakeStreamMixin):
    def __init__(self, responses: dict[str, FakeResponse]) -> None:
        self.responses = responses

    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> FakeResponse:
        del params, headers, follow_redirects, timeout
        return self.responses[url]

    async def post(
        self,
        url: str,
        *,
        data: Mapping[str, str],
    ) -> FakeResponse:
        del url, data
        raise AssertionError


class FakePostClient(FakeStreamMixin):
    def __init__(self) -> None:
        self.url = ""
        self.data: Mapping[str, str] = {}

    async def post(self, url: str, *, data: Mapping[str, str]) -> FakeResponse:
        self.url = url
        self.data = data
        response = FakeResponse(200, {})
        response.text = "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n"
        return response

    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> FakeResponse:
        del url, params, headers, follow_redirects, timeout
        raise AssertionError


def test_openid_verifier_posts_check_authentication_to_fixed_endpoint() -> None:
    client = FakePostClient()
    verifier = SteamOpenIDClient(http_client=client)

    valid = asyncio.run(
        verifier.verify(
            {
                "openid.mode": "id_res",
                "openid.sig": "sig",
            }
        )
    )

    assert valid is True
    assert client.url == "https://steamcommunity.com/openid/login"
    assert client.data["openid.mode"] == "check_authentication"


def test_profile_visibility_maps_public_private_and_unknown_states() -> None:
    profile_url = PROFILE_ENDPOINT

    def gateway(visibility: object) -> SteamGateway:
        return SteamGateway(
            make_settings(steam_web_api_key="key"),
            http_client=FakeHttpClient(
                {
                    profile_url: FakeResponse(
                        200,
                        {
                            "response": {
                                "players": [
                                    {
                                        "communityvisibilitystate": visibility,
                                        "personaname": "Ada",
                                        "avatarfull": "avatar",
                                    }
                                ]
                            }
                        },
                    )
                }
            ),
        )

    public = asyncio.run(gateway(3).check_profile("76561198000000000"))
    private = asyncio.run(gateway(1).check_profile("76561198000000000"))
    private_two = asyncio.run(gateway(2).check_profile("76561198000000000"))
    unknown = asyncio.run(gateway(4).check_profile("76561198000000000"))

    assert public.status == "public"
    assert public.display_name == "Ada"
    assert private.status == "private"
    assert private_two.status == "private"
    assert unknown.status == "unavailable"


def test_profile_key_absence_and_upstream_failure_are_unavailable() -> None:
    missing_gateway = SteamGateway(
        make_settings(steam_web_api_key=None),
        http_client=FakeHttpClient({}),
    )
    missing = asyncio.run(missing_gateway.check_profile("76561198000000000"))

    failing_gateway = SteamGateway(
        make_settings(steam_web_api_key="key"),
        http_client=FakeHttpClient({PROFILE_ENDPOINT: FakeResponse(503, {})}),
    )
    unavailable = asyncio.run(failing_gateway.check_profile("76561198000000000"))

    assert missing.status == "unavailable"
    assert unavailable.status == "unavailable"


def test_callback_rejects_stale_nonce() -> None:
    settings = make_settings()
    verifier = FakeVerifier()
    app = create_app(settings, openid_verifier=verifier, clock=lambda: NOW)
    stale = (NOW - timedelta(seconds=settings.nonce_max_age_seconds + 1)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(
                settings, return_to=return_to_from_start(start), nonce=stale
            ),
            follow_redirects=False,
        )

    assert callback.status_code == 400
    assert verifier.calls == []


def test_callback_rejects_duplicate_openid_parameter() -> None:
    settings = make_settings()
    verifier = FakeVerifier()
    app = create_app(settings, openid_verifier=verifier, clock=lambda: NOW)
    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(settings, return_to=return_to_from_start(start))
            + "&openid.mode=id_res",
            follow_redirects=False,
        )

    assert callback.status_code == 400
    assert verifier.calls == []


def test_callback_rejects_state_mismatch_before_openid_verification() -> None:
    settings = make_settings()
    verifier = FakeVerifier()
    app = create_app(settings, openid_verifier=verifier, clock=lambda: NOW)
    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        return_to = return_to_from_start(start)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(
                settings,
                return_to=return_to,
                callback_state="wrong",
            ),
            follow_redirects=False,
        )

    assert callback.status_code == 400
    assert verifier.calls == []


def test_callback_without_login_state_is_rejected() -> None:
    settings = make_settings()
    app = create_app(settings, openid_verifier=FakeVerifier(), clock=lambda: NOW)
    with TestClient(app) as client:
        callback = client.get(
            "/api/auth/steam/callback?" + callback_query(settings),
            follow_redirects=False,
        )

    assert callback.status_code == 400
    assert "Max-Age=0" in callback.headers["set-cookie"]
