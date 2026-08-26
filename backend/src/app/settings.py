from __future__ import annotations

from collections.abc import Mapping
from functools import lru_cache
from secrets import token_urlsafe
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.steam_openid import callback_url

_MIN_SIGNING_SECRET_LENGTH = 32
_PLACEHOLDER_SECRET_MARKERS = (
    "change-me",
    "change-this",
    "changeme",
    "default",
    "development-only",
    "dummy",
    "example",
    "placeholder",
    "replace-me",
    "replace-this",
    "replace-with",
    "secret-here",
    "set-this",
    "test-signing-secret",
    "use-a",
    "your-secret",
)

_WILDCARD_ORIGIN_ERROR = "Credentialed CORS origins cannot include '*'."
_EXPIRY_ERROR = "Expiry settings must be positive."
_TIMEOUT_ERROR = "Steam request timeout must be positive."
_MISSING_SIGNING_MESSAGE = "SIGNING_SECRET must be configured outside development."
_WEAK_SIGNING_MESSAGE = (
    "SIGNING_SECRET must be a non-placeholder value of at least 32 characters "
    "outside development."
)
_INSECURE_NONE_COOKIE_ERROR = "COOKIE_SAMESITE=none requires COOKIE_SECURE=true."


def _looks_like_placeholder(secret: str) -> bool:
    normalized = "".join(
        character.casefold() if character.isalnum() else "-" for character in secret
    ).strip("-")
    return any(marker in normalized for marker in _PLACEHOLDER_SECRET_MARKERS)


class Settings(BaseSettings):
    app: str = "Steam Optimizer API"
    environment: str = "development"
    allowed_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173"]
    )

    frontend_url: str = "http://localhost:5173"
    public_backend_url: str = "http://localhost:8000"
    signing_secret: str
    steam_web_api_key: str | None = None

    cookie_secure: bool = False
    cookie_samesite: Literal["lax", "strict", "none"] = "lax"
    login_state_cookie_name: str = "steam_login_state"
    session_cookie_name: str = "steam_session"
    login_state_ttl_seconds: int = 600
    session_ttl_seconds: int = 86_400

    nonce_max_age_seconds: int = 600
    nonce_future_skew_seconds: int = 60
    steam_request_timeout_seconds: float = 10.0

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        hide_input_in_errors=True,
    )

    @field_validator("allowed_origins")
    @classmethod
    def reject_wildcard_origins(cls, value: list[str]) -> list[str]:
        if any(origin.strip() == "*" for origin in value):
            raise ValueError(_WILDCARD_ORIGIN_ERROR)
        return value

    @field_validator("cookie_samesite", mode="before")
    @classmethod
    def normalize_cookie_samesite(cls, value: object) -> object:
        return value.lower() if isinstance(value, str) else value

    @field_validator(
        "login_state_ttl_seconds",
        "session_ttl_seconds",
        "nonce_max_age_seconds",
        "nonce_future_skew_seconds",
    )
    @classmethod
    def positive_or_zero_seconds(cls, value: int) -> int:
        if value <= 0:
            raise ValueError(_EXPIRY_ERROR)
        return value

    @field_validator("steam_request_timeout_seconds")
    @classmethod
    def positive_timeout(cls, value: float) -> float:
        if value <= 0:
            raise ValueError(_TIMEOUT_ERROR)
        return value

    @model_validator(mode="before")
    @classmethod
    def generate_development_secret(cls, data: object) -> object:
        if not isinstance(data, Mapping):
            return data
        values = dict(data)
        environment = values.get("environment", "development")
        secret = values.get("signing_secret")
        if secret is None or (isinstance(secret, str) and not secret.strip()):
            if (
                isinstance(environment, str)
                and environment.strip().casefold() == "development"
            ):
                values["signing_secret"] = token_urlsafe(32)
            else:
                raise ValueError(_MISSING_SIGNING_MESSAGE)
        return values

    @model_validator(mode="after")
    def validate_security_settings(self) -> Settings:
        if self.environment.strip().casefold() != "development":
            secret = self.signing_secret.strip()
            if len(secret) < _MIN_SIGNING_SECRET_LENGTH or _looks_like_placeholder(
                secret
            ):
                raise ValueError(_WEAK_SIGNING_MESSAGE)
        if self.cookie_samesite == "none" and not self.cookie_secure:
            raise ValueError(_INSECURE_NONE_COOKIE_ERROR)
        return self

    @property
    def callback_url(self) -> str:
        return callback_url(self.public_backend_url)


@lru_cache
def get_settings() -> Settings:
    return Settings()
