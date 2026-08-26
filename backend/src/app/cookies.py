from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

_PURPOSE_CHARACTERS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
)


class InvalidCookieError(ValueError):
    """Raised when a signed application cookie cannot be trusted."""

    def __init__(self) -> None:
        super().__init__("Invalid signed cookie.")


class InvalidCookiePurposeError(ValueError):
    """Raised when a cookie purpose cannot provide domain separation."""

    def __init__(self) -> None:
        super().__init__("Cookie purpose must be a non-empty ASCII token.")


class InvalidCookieLifetimeError(ValueError):
    """Raised when cookie issuance and expiry are inconsistent."""

    def __init__(self) -> None:
        super().__init__("Cookie expiry must be later than issuance.")


class InvalidCookiePayloadError(ValueError):
    """Raised when a cookie payload cannot be encoded as JSON."""

    def __init__(self) -> None:
        super().__init__("Cookie payload must be JSON serializable.")


def utc_datetime(value: datetime) -> datetime:
    """Return a timezone-aware UTC datetime for clock values at the boundary."""

    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _base64_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _base64_decode(value: str) -> bytes:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_="
    if not value or any(character not in alphabet for character in value):
        raise InvalidCookieError
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error) as error:
        raise InvalidCookieError from error


@dataclass(frozen=True, slots=True)
class SignedCookieCodec:
    """Encode and verify compact, purpose-separated stateless cookies."""

    secret: str

    def _key(self, purpose: str) -> bytes:
        if not purpose or any(
            character not in _PURPOSE_CHARACTERS for character in purpose
        ):
            raise InvalidCookiePurposeError
        return hmac.new(
            self.secret.encode("utf-8"),
            b"steam-optimizer-cookie:" + purpose.encode("ascii"),
            hashlib.sha256,
        ).digest()

    def encode(
        self,
        purpose: str,
        payload: Mapping[str, object],
        *,
        issued_at: datetime,
        expires_at: datetime,
    ) -> str:
        issued_epoch = int(utc_datetime(issued_at).timestamp())
        expires_epoch = int(utc_datetime(expires_at).timestamp())
        if expires_epoch <= issued_epoch:
            raise InvalidCookieLifetimeError

        body: dict[str, object] = dict(payload)
        body.update({"exp": expires_epoch, "iat": issued_epoch, "purpose": purpose})
        try:
            encoded_body = json.dumps(
                body,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise InvalidCookiePayloadError from error

        body_token = _base64_encode(encoded_body)
        signature = hmac.new(
            self._key(purpose), body_token.encode("ascii"), hashlib.sha256
        ).digest()
        return f"{body_token}.{_base64_encode(signature)}"

    def decode(
        self,
        token: str,
        purpose: str,
        *,
        now: datetime,
        max_age_seconds: int,
    ) -> dict[str, object]:
        if not token or token.count(".") != 1:
            raise InvalidCookieError
        body_token, signature_token = token.split(".", 1)
        try:
            supplied_signature = _base64_decode(signature_token)
            expected_signature = hmac.new(
                self._key(purpose), body_token.encode("ascii"), hashlib.sha256
            ).digest()
        except (UnicodeEncodeError, InvalidCookieError) as error:
            raise InvalidCookieError from error
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise InvalidCookieError

        try:
            body = json.loads(_base64_decode(body_token))
        except (UnicodeDecodeError, json.JSONDecodeError, InvalidCookieError) as error:
            raise InvalidCookieError from error
        if not isinstance(body, dict):
            raise InvalidCookieError
        if body.get("purpose") != purpose:
            raise InvalidCookieError

        issued_epoch = body.get("iat")
        expires_epoch = body.get("exp")
        if (
            isinstance(issued_epoch, bool)
            or not isinstance(issued_epoch, int)
            or isinstance(expires_epoch, bool)
            or not isinstance(expires_epoch, int)
            or expires_epoch <= issued_epoch
        ):
            raise InvalidCookieError

        now_epoch = int(utc_datetime(now).timestamp())
        if expires_epoch <= now_epoch or issued_epoch > now_epoch:
            raise InvalidCookieError
        if expires_epoch - issued_epoch > max_age_seconds:
            raise InvalidCookieError
        return body
