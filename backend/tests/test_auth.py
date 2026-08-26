from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from httpx2 import Response

from app.cookies import (
    InvalidCookieLifetimeError,
    InvalidCookiePayloadError,
    InvalidCookiePurposeError,
    SignedCookieCodec,
)
from app.main import create_app
from app.settings import Settings
from app.steam_gateway import (
    INVENTORY_ENDPOINT,
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
    async def check_profile(self, steam_id: str) -> ProfileCheck:
        del steam_id
        return ProfileCheck(
            status="public",
            message="profile ok",
            display_name="Ada",
            avatar_url="https://cdn.example/avatar.jpg",
        )

    async def check_inventory(self, steam_id: str) -> InventoryCheck:
        del steam_id
        return InventoryCheck(status="private", message="inventory private")


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
    verifier = FakeVerifier()
    app = create_app(
        settings,
        steam_gateway=FakeGateway(),
        openid_verifier=verifier,
        clock=lambda: NOW,
    )
    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(settings, return_to=return_to_from_start(start)),
            follow_redirects=False,
        )
        session = client.get("/api/auth/session")
        logout = client.post("/api/auth/logout")
        after_logout = client.get("/api/auth/session")

    assert callback.status_code == 302
    assert callback.headers["location"] == settings.frontend_url
    assert "SameSite=strict" in callback.headers["set-cookie"]
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
            "inventory": {"status": "private", "message": "inventory private"},
        },
    }
    assert logout.status_code == 204
    assert after_logout.json() == {"authenticated": False}


class FakeResponse:
    def __init__(self, status_code: int, payload: object) -> None:
        self.status_code = status_code
        self.payload = payload
        self.text = ""

    def json(self) -> object:
        return self.payload


class FakePostClient:
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
        self, url: str, *, params: Mapping[str, str] | None = None
    ) -> FakeResponse:
        del url, params
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


class FakeHttpClient:
    def __init__(self, responses: dict[str, FakeResponse]) -> None:
        self.responses = responses

    async def get(
        self, url: str, *, params: Mapping[str, str] | None = None
    ) -> FakeResponse:
        del params
        return self.responses[url]

    async def post(self, url: str, *, data: Mapping[str, str]) -> FakeResponse:
        del url, data
        raise AssertionError


class TrackingHTTPClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.closed = False

    async def post(self, url: str, *, data: Mapping[str, str]) -> FakeResponse:
        del data
        self.calls.append(("post", url))
        response = FakeResponse(200, {})
        response.text = "is_valid:true"
        return response

    async def get(
        self, url: str, *, params: Mapping[str, str] | None = None
    ) -> FakeResponse:
        del params
        self.calls.append(("get", url))
        if url == PROFILE_ENDPOINT:
            return FakeResponse(
                200,
                {"response": {"players": [{"communityvisibilitystate": 3}]}},
            )
        return FakeResponse(200, {"success": 1})

    async def aclose(self) -> None:
        self.closed = True


def test_default_steam_boundaries_share_and_close_lifespan_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(steam_web_api_key="key")
    shared_client = TrackingHTTPClient()
    monkeypatch.setattr(
        "app.main.httpx2.AsyncClient",
        lambda **_kwargs: shared_client,
    )
    app = create_app(settings, clock=lambda: NOW)

    with TestClient(app) as client:
        start = client.get("/api/auth/steam/start", follow_redirects=False)
        callback = client.get(
            "/api/auth/steam/callback?"
            + callback_query(settings, return_to=return_to_from_start(start)),
            follow_redirects=False,
        )
        session = client.get("/api/auth/session")

    assert callback.status_code == 302
    assert session.status_code == 200
    assert {method for method, _ in shared_client.calls} == {"get", "post"}
    assert {url for _, url in shared_client.calls} == {
        PROFILE_ENDPOINT,
        INVENTORY_ENDPOINT + "/76561198000000000/753/6",
        "https://steamcommunity.com/openid/login",
    }
    assert shared_client.closed


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


def test_empty_public_inventory_and_private_403_are_distinct() -> None:
    inventory_url = INVENTORY_ENDPOINT + "/76561198000000000/753/6"
    public_gateway = SteamGateway(
        make_settings(steam_web_api_key="key"),
        http_client=FakeHttpClient(
            {inventory_url: FakeResponse(200, {"success": 1, "assets": []})}
        ),
    )
    private_gateway = SteamGateway(
        make_settings(steam_web_api_key="key"),
        http_client=FakeHttpClient({inventory_url: FakeResponse(403, {})}),
    )

    public = asyncio.run(public_gateway.check_inventory("76561198000000000"))
    private = asyncio.run(private_gateway.check_inventory("76561198000000000"))

    assert public.status == "public"
    assert private.status == "private"


@pytest.mark.parametrize("status_code", [400, 404])
def test_inventory_recognizes_only_known_top_level_private_error(
    status_code: int,
) -> None:
    inventory_url = INVENTORY_ENDPOINT + "/76561198000000000/753/6"
    gateway = SteamGateway(
        make_settings(steam_web_api_key="key"),
        http_client=FakeHttpClient(
            {
                inventory_url: FakeResponse(
                    status_code,
                    {"success": 15, "Error": "This profile is private."},
                )
            }
        ),
    )

    result = asyncio.run(gateway.check_inventory("76561198000000000"))

    assert result.status == "private"


def test_inventory_does_not_recurse_or_substring_match_private_errors() -> None:
    inventory_url = INVENTORY_ENDPOINT + "/76561198000000000/753/6"
    payloads = [
        {"error": {"message": "This profile is private."}},
        {"Error": "Your profile is private because of another issue."},
    ]
    for payload in payloads:
        gateway = SteamGateway(
            make_settings(steam_web_api_key="key"),
            http_client=FakeHttpClient({inventory_url: FakeResponse(200, payload)}),
        )
        result = asyncio.run(gateway.check_inventory("76561198000000000"))
        assert result.status == "unavailable"


def test_inventory_rate_limit_and_server_failure_stay_unavailable() -> None:
    inventory_url = INVENTORY_ENDPOINT + "/76561198000000000/753/6"
    for status_code in (429, 500, 503):
        gateway = SteamGateway(
            make_settings(steam_web_api_key="key"),
            http_client=FakeHttpClient(
                {
                    inventory_url: FakeResponse(
                        status_code,
                        {"Error": "This profile is private."},
                    )
                }
            ),
        )
        result = asyncio.run(gateway.check_inventory("76561198000000000"))
        assert result.status == "unavailable"


def test_profile_key_absence_and_upstream_failure_are_unavailable() -> None:
    missing_key = SteamGateway(
        make_settings(steam_web_api_key=None),
        http_client=FakeHttpClient({}),
    )
    missing = asyncio.run(missing_key.check_profile("76561198000000000"))

    failing = SteamGateway(
        make_settings(steam_web_api_key="key"),
        http_client=FakeHttpClient({PROFILE_ENDPOINT: FakeResponse(503, {})}),
    )
    unavailable = asyncio.run(failing.check_profile("76561198000000000"))

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
