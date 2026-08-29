from __future__ import annotations

from dataclasses import FrozenInstanceError
from typing import Literal, cast

import pytest

from app.market_fees import (
    MAX_MINOR_UNITS,
    MarketFeeContract,
    MarketFeeError,
    calculate_item_fees,
    decimal_to_minor,
    seller_receipt_from_buyer_total,
)


def contract(**overrides: str | int) -> MarketFeeContract:
    values: dict[str, str | int] = {
        "currency_code": "USD",
        "minor_digits": 2,
        "price_basis": "buyer_total",
        "steam_fee_bps": 5_00,
        "publisher_fee_bps": 10_00,
        "min_fee_minor": 1,
        "max_quote_age_seconds": 900,
        "max_inventory_age_seconds": 3_600,
    }
    values.update(overrides)
    return MarketFeeContract(
        currency_code=cast("str", values["currency_code"]),
        minor_digits=cast("int", values["minor_digits"]),
        price_basis=cast('Literal["buyer_total"]', values["price_basis"]),
        steam_fee_bps=cast("int", values["steam_fee_bps"]),
        publisher_fee_bps=cast("int", values["publisher_fee_bps"]),
        min_fee_minor=cast("int", values["min_fee_minor"]),
        max_quote_age_seconds=cast("int", values["max_quote_age_seconds"]),
        max_inventory_age_seconds=cast(
            "int",
            values["max_inventory_age_seconds"],
        ),
    )


@pytest.mark.parametrize(
    ("value", "minor_digits", "expected"),
    [
        ("0", 0, 0),
        ("12", 0, 12),
        ("12.0", 0, 12),
        ("12.00", 2, 1_200),
        ("0.15", 2, 15),
        ("1.2", 2, 120),
        ("1.234", 3, 1_234),
        ("0.001", 3, 1),
    ],
)
def test_decimal_to_minor_is_exact_for_supported_precisions(
    value: str,
    minor_digits: int,
    expected: int,
) -> None:
    assert decimal_to_minor(value, minor_digits) == expected


@pytest.mark.parametrize(
    ("value", "minor_digits"),
    [
        ("0.001", 2),
        ("1.2341", 3),
        ("1e2", 2),
        ("+1.00", 2),
        ("-1.00", 2),
        ("01.00", 2),
        ("1.", 2),
        (".10", 2),
        ("NaN", 2),
        ("Infinity", 2),
    ],
)
def test_decimal_to_minor_rejects_noncanonical_or_overprecise_values(
    value: str,
    minor_digits: int,
) -> None:
    assert decimal_to_minor(value, minor_digits) is None


def test_fee_minimum_and_floor_boundaries_are_per_component() -> None:
    configured = contract(steam_fee_bps=5_00, publisher_fee_bps=10_00, min_fee_minor=1)

    # 5% and 10% remain below one cent until their respective flooring points.
    first = calculate_item_fees(13, configured)
    assert first is not None
    assert (first.steam_fee_minor, first.publisher_fee_minor) == (1, 1)
    assert first.buyer_total_minor == 15

    immediately_below_steam_change = calculate_item_fees(39, configured)
    assert immediately_below_steam_change is not None
    assert immediately_below_steam_change.steam_fee_minor == 1
    at_steam_change = calculate_item_fees(40, configured)
    assert at_steam_change is not None
    assert at_steam_change.steam_fee_minor == 2
    immediately_above_steam_change = calculate_item_fees(41, configured)
    assert immediately_above_steam_change is not None
    assert immediately_above_steam_change.steam_fee_minor == 2

    immediately_below_publisher_change = calculate_item_fees(99, configured)
    assert immediately_below_publisher_change is not None
    assert immediately_below_publisher_change.publisher_fee_minor == 9
    at_publisher_change = calculate_item_fees(100, configured)
    assert at_publisher_change is not None
    assert at_publisher_change.publisher_fee_minor == 10
    immediately_above_publisher_change = calculate_item_fees(101, configured)
    assert immediately_above_publisher_change is not None
    assert immediately_above_publisher_change.publisher_fee_minor == 10


def test_fee_components_are_separate_and_recompose_exactly() -> None:
    configured = contract(steam_fee_bps=1_250, publisher_fee_bps=2_500, min_fee_minor=0)
    fees = calculate_item_fees(400, configured)
    assert fees is not None
    assert fees.steam_fee_minor == 50
    assert fees.publisher_fee_minor == 100
    assert fees.total_fee_minor == 150
    assert fees.buyer_total_minor == 550


def test_plan_example_uses_per_card_inverse_and_exact_recomposition() -> None:
    configured = contract()
    cards = [seller_receipt_from_buyer_total(15, configured) for _ in range(5)]
    assert cards == [13, 13, 13, 13, 13]
    receipts = [receipt for receipt in cards if receipt is not None]

    breakdowns = [calculate_item_fees(receipt, configured) for receipt in receipts]
    assert all(breakdown is not None for breakdown in breakdowns)
    assert sum(breakdown.steam_fee_minor for breakdown in breakdowns if breakdown) == 5
    assert (
        sum(breakdown.publisher_fee_minor for breakdown in breakdowns if breakdown) == 5
    )
    assert (
        sum(breakdown.seller_receipt_minor for breakdown in breakdowns if breakdown)
        == 65
    )
    assert (
        sum(breakdown.buyer_total_minor for breakdown in breakdowns if breakdown) == 75
    )

    # Applying fees once to a set total is observably different and forbidden.
    set_total = seller_receipt_from_buyer_total(75, configured)
    assert set_total == 66
    assert set_total != sum(receipts)


def test_inverse_rejects_unrepresentable_buyer_totals_and_recomposes() -> None:
    configured = contract()
    assert seller_receipt_from_buyer_total(15, configured) == 13
    assert seller_receipt_from_buyer_total(14, configured) == 12
    assert seller_receipt_from_buyer_total(16, configured) == 14

    # A high-rate contract creates gaps due to independent component flooring.
    gapped = contract(steam_fee_bps=5_000, publisher_fee_bps=5_000, min_fee_minor=0)
    assert seller_receipt_from_buyer_total(2, gapped) is None
    for buyer_total in range(1, 1_000):
        receipt = seller_receipt_from_buyer_total(buyer_total, gapped)
        if receipt is not None:
            fees = calculate_item_fees(receipt, gapped)
            assert fees is not None
            assert fees.buyer_total_minor == buyer_total


def test_inverse_invariant_is_exhaustive_over_practical_range() -> None:
    configured = contract()
    for seller_receipt in range(10_000):
        fees = calculate_item_fees(seller_receipt, configured)
        assert fees is not None
        recovered = seller_receipt_from_buyer_total(fees.buyer_total_minor, configured)
        assert recovered == seller_receipt


def test_contract_is_immutable_and_bounds_are_practical() -> None:
    configured = contract()
    with pytest.raises(FrozenInstanceError):
        configured.min_fee_minor = 2  # type: ignore[misc]
    with pytest.raises(MarketFeeError):
        contract(minor_digits=4)
    with pytest.raises(MarketFeeError):
        contract(min_fee_minor=MAX_MINOR_UNITS + 1)
    with pytest.raises(MarketFeeError):
        contract(max_quote_age_seconds=0)
    with pytest.raises(MarketFeeError):
        contract(price_basis="lowest_sell")
