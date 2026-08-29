from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest
from pydantic import ValidationError

from app.settings import Settings

_BASE_SETTINGS: dict[str, object] = {
    "environment": "development",
    "signing_secret": "development-test-secret",
}


def configured_settings(**overrides: object) -> Settings:
    values = {
        **_BASE_SETTINGS,
        "level_up_currency_code": "USD",
        "level_up_currency_minor_digits": 2,
        "level_up_price_basis": "buyer_total",
        "level_up_steam_fee_bps": 500,
        "level_up_publisher_fee_bps": 1_000,
        "level_up_min_fee_minor": 1,
        "level_up_max_quote_age_seconds": 900,
        "level_up_max_inventory_age_seconds": 3_600,
    }
    values.update(overrides)
    return Settings.model_validate(values)


def test_complete_optimizer_configuration_exposes_one_immutable_contract() -> None:
    settings = configured_settings()
    money = settings.level_up_money_contract
    assert money is not None
    assert money.currency_code == "USD"
    assert money.minor_digits == 2
    assert money.price_basis == "buyer_total"
    assert money.steam_fee_bps == 500
    assert money.publisher_fee_bps == 1_000
    assert money.min_fee_minor == 1
    assert money.max_quote_age_seconds == 900
    assert money.max_inventory_age_seconds == 3_600
    with pytest.raises(FrozenInstanceError):
        money.min_fee_minor = 2  # type: ignore[misc]


def test_all_missing_configuration_keeps_settings_healthy() -> None:
    settings = Settings.model_validate(_BASE_SETTINGS)
    assert settings.level_up_money_contract is None


@pytest.mark.parametrize(
    "partial",
    [
        {"level_up_currency_code": "USD"},
        {
            "level_up_currency_code": "USD",
            "level_up_currency_minor_digits": 2,
            "level_up_price_basis": "buyer_total",
        },
        {"level_up_max_quote_age_seconds": 900},
        {"level_up_currency_code": "   "},
        {"level_up_currency_minor_digits": "not-an-integer"},
    ],
)
def test_partial_or_blank_configuration_disables_optimizer(
    partial: dict[str, object],
) -> None:
    values = dict(_BASE_SETTINGS)
    values.update(partial)
    settings = Settings.model_validate(values)
    assert settings.level_up_money_contract is None


@pytest.mark.parametrize(
    "field_value",
    [
        ("level_up_currency_code", "usd"),
        ("level_up_currency_code", "US1"),
        ("level_up_currency_code", "USDollar"),
        ("level_up_currency_minor_digits", -1),
        ("level_up_currency_minor_digits", 4),
        ("level_up_steam_fee_bps", -1),
        ("level_up_steam_fee_bps", 10_001),
        ("level_up_publisher_fee_bps", -1),
        ("level_up_publisher_fee_bps", 10_001),
        ("level_up_min_fee_minor", -1),
        ("level_up_min_fee_minor", 1_000_000_000_001),
        ("level_up_max_quote_age_seconds", 0),
        ("level_up_max_quote_age_seconds", 604_801),
        ("level_up_max_inventory_age_seconds", 0),
        ("level_up_max_inventory_age_seconds", 604_801),
    ],
)
def test_complete_configuration_rejects_invalid_bounds(
    field_value: tuple[str, object],
) -> None:
    field, value = field_value
    with pytest.raises(ValidationError):
        configured_settings(**{field: value})


def test_complete_configuration_rejects_invalid_price_basis() -> None:
    with pytest.raises(ValidationError):
        configured_settings(level_up_price_basis="lowest_sell")


def test_validation_errors_do_not_reveal_credentials_or_sensitive_inputs() -> None:
    signing_secret = "sensitive-signing-secret-" + str(object())
    steam_api_key = "sensitive-steam-web-api-key"
    values = {
        **_BASE_SETTINGS,
        "signing_secret": signing_secret,
        "steam_web_api_key": steam_api_key,
        "level_up_currency_code": "USD",
        "level_up_currency_minor_digits": 99,
        "level_up_price_basis": "buyer_total",
        "level_up_steam_fee_bps": 500,
        "level_up_publisher_fee_bps": 1_000,
        "level_up_min_fee_minor": 1,
        "level_up_max_quote_age_seconds": 900,
        "level_up_max_inventory_age_seconds": 3_600,
    }
    with pytest.raises(ValidationError) as error:
        Settings.model_validate(values)
    rendered = str(error.value)
    assert signing_secret not in rendered
    assert steam_api_key not in rendered
    assert "99" not in rendered
