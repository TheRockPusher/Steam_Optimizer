from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Protocol
from urllib.parse import urlencode, urlsplit

from app.cookies import utc_datetime

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from app.http_protocols import AsyncHTTPClient

STEAM_OPENID_PROVIDER_URL = "https://steamcommunity.com/openid/"
STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login"
STEAM_CLAIMED_ID_PREFIX = "/openid/id/"
OPENID_NAMESPACE = "http://specs.openid.net/auth/2.0"

_REQUIRED_CALLBACK_PARAMETERS = frozenset(
    {
        "openid.ns",
        "openid.mode",
        "openid.op_endpoint",
        "openid.return_to",
        "openid.response_nonce",
        "openid.signed",
        "openid.sig",
        "openid.identity",
        "openid.claimed_id",
        "openid.assoc_handle",
    }
)
_REQUIRED_SIGNED_FIELDS = frozenset(
    {
        "assoc_handle",
        "op_endpoint",
        "return_to",
        "response_nonce",
        "identity",
        "claimed_id",
    }
)
_ASCII_DIGITS = re.compile(r"^[0-9]+$")


class OpenIDValidationError(ValueError):
    """Raised when a Steam OpenID callback is not a valid assertion."""

    def __init__(self) -> None:
        super().__init__("Invalid Steam OpenID assertion.")


class OpenIDVerifierUnavailableError(RuntimeError):
    """Raised when Steam cannot answer a server-to-server verification request."""

    def __init__(self) -> None:
        super().__init__("Steam OpenID verification is unavailable.")


class SteamOpenIDVerifier(Protocol):
    async def verify(self, params: Mapping[str, str]) -> bool:
        """Verify an OpenID assertion with Steam."""
        ...


@dataclass(frozen=True, slots=True)
class ValidatedSteamAssertion:
    steam_id: str


def callback_url(public_backend_url: str) -> str:
    return f"{public_backend_url.rstrip('/')}/api/auth/steam/callback"


def callback_return_to(public_backend_url: str, state: str | None = None) -> str:
    base = callback_url(public_backend_url)
    if state is None:
        return base
    return f"{base}?{urlencode({'state': state})}"


def login_url(public_backend_url: str, *, state: str | None = None) -> str:
    """Build the fixed Steam OpenID login URL used by browser redirects."""

    return_to = callback_return_to(public_backend_url, state)
    return f"{STEAM_OPENID_ENDPOINT}?{
        urlencode(
            (
                ('openid.ns', OPENID_NAMESPACE),
                ('openid.mode', 'checkid_setup'),
                ('openid.return_to', return_to),
                ('openid.realm', f'{public_backend_url.rstrip("/")}/'),
                (
                    'openid.identity',
                    'http://specs.openid.net/auth/2.0/identifier_select',
                ),
                (
                    'openid.claimed_id',
                    'http://specs.openid.net/auth/2.0/identifier_select',
                ),
            )
        )
    }"


def collect_openid_parameters(
    pairs: Sequence[tuple[str, str]],
) -> dict[str, str]:
    """Normalize a callback query while rejecting repeated OpenID fields."""

    values: dict[str, str] = {}
    for key, value in pairs:
        if key.startswith("openid.") and key in values:
            raise OpenIDValidationError
        values[key] = value
    return {key: value for key, value in values.items() if key.startswith("openid.")}


def _parse_nonce(value: str) -> datetime:
    # Steam's response_nonce is an ISO-8601 UTC timestamp followed by a unique
    # provider suffix. Only the timestamp controls freshness.
    if len(value) < 20 or value[19] != "Z":
        raise OpenIDValidationError
    try:
        return datetime.strptime(value[:20], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError as error:
        raise OpenIDValidationError from error


def _validate_nonce(
    value: str,
    *,
    now: datetime,
    max_age_seconds: int,
    future_skew_seconds: int,
) -> None:
    nonce_time = _parse_nonce(value)
    current = utc_datetime(now)
    age = (current - nonce_time).total_seconds()
    if age > max_age_seconds or age < -future_skew_seconds:
        raise OpenIDValidationError


def _steam_id_from_claimed_id(claimed_id: str) -> str:
    try:
        parsed = urlsplit(claimed_id)
    except ValueError as error:
        raise OpenIDValidationError from error
    # Steam documents both http and https claimed-id URLs. Do not accept user
    # info, ports, query strings, fragments, or look-alike hosts.
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname != "steamcommunity.com"
        or parsed.netloc != "steamcommunity.com"
        or parsed.path.count("/") != 3
        or not parsed.path.startswith(STEAM_CLAIMED_ID_PREFIX)
        or parsed.query
        or parsed.fragment
    ):
        raise OpenIDValidationError
    steam_id = parsed.path.rsplit("/", 1)[-1]
    if not _ASCII_DIGITS.fullmatch(steam_id):
        raise OpenIDValidationError
    return steam_id


def _validate_unsigned_fields(
    params: Mapping[str, str],
    *,
    expected_return_to: str,
) -> None:
    missing = _REQUIRED_CALLBACK_PARAMETERS.difference(params)
    if missing:
        raise OpenIDValidationError
    if params["openid.ns"] != OPENID_NAMESPACE:
        raise OpenIDValidationError
    if params["openid.mode"] != "id_res":
        raise OpenIDValidationError
    if params["openid.op_endpoint"] != STEAM_OPENID_ENDPOINT:
        raise OpenIDValidationError
    if params["openid.return_to"] != expected_return_to:
        raise OpenIDValidationError
    signed_fields = {
        field.strip() for field in params["openid.signed"].split(",") if field.strip()
    }
    if not params["openid.sig"] or not _REQUIRED_SIGNED_FIELDS.issubset(signed_fields):
        raise OpenIDValidationError
    if not params["openid.identity"] or not params["openid.claimed_id"]:
        raise OpenIDValidationError


async def validate_openid_callback(
    params: Mapping[str, str],
    *,
    expected_return_to: str,
    verifier: SteamOpenIDVerifier,
    now: datetime,
    nonce_max_age_seconds: int,
    nonce_future_skew_seconds: int,
) -> ValidatedSteamAssertion:
    """Validate an assertion before turning its claimed ID into a SteamID."""

    _validate_unsigned_fields(params, expected_return_to=expected_return_to)
    _validate_nonce(
        params["openid.response_nonce"],
        now=now,
        max_age_seconds=nonce_max_age_seconds,
        future_skew_seconds=nonce_future_skew_seconds,
    )

    # Never parse or trust claimed_id until Steam has confirmed its signature.
    if await verifier.verify(params) is not True:
        raise OpenIDValidationError
    if params["openid.identity"] != params["openid.claimed_id"]:
        raise OpenIDValidationError
    return ValidatedSteamAssertion(
        steam_id=_steam_id_from_claimed_id(params["openid.claimed_id"])
    )


class SteamOpenIDClient:
    """Server-to-server OpenID check_authentication client."""

    def __init__(self, *, http_client: AsyncHTTPClient) -> None:
        self.http_client = http_client

    async def verify(self, params: Mapping[str, str]) -> bool:
        request_data = dict(params)
        request_data["openid.mode"] = "check_authentication"
        try:
            response = await self.http_client.post(
                STEAM_OPENID_ENDPOINT,
                data=request_data,
            )
            status_code = response.status_code
            text = response.text
        except Exception as error:
            raise OpenIDVerifierUnavailableError from error
        if not 200 <= status_code < 300:
            raise OpenIDVerifierUnavailableError
        match = re.search(r"(?m)^\s*is_valid\s*:\s*(true|false)\s*$", text)
        if match is None:
            raise OpenIDVerifierUnavailableError
        return match.group(1) == "true"
