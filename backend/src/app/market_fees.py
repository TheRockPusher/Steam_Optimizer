from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

# The optimizer deals in integer minor units.  Keep a finite amount bound so a
# malformed provider value cannot make the inverse search unreasonably large.
MAX_MINOR_UNITS = 1_000_000_000_000
MIN_MINOR_DIGITS = 0
MAX_MINOR_DIGITS = 3
MIN_FEE_BPS = 0
MAX_FEE_BPS = 10_000
MIN_FEE_MINOR = 0
MAX_FEE_MINOR = MAX_MINOR_UNITS
MIN_FRESHNESS_SECONDS = 1
MAX_FRESHNESS_SECONDS = 604_800  # one week

PRICE_BASIS = Literal["buyer_total"]

_FIXED_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z")
_CURRENCY_CODE = re.compile(r"[A-Z]{3}\Z")
MAX_DECIMAL_TEXT_LENGTH = 64
_CURRENCY_CODE_ERROR = "currency_code must be three uppercase letters"
_MINOR_DIGITS_ERROR = "minor_digits is outside the supported range"
_PRICE_BASIS_ERROR = "price_basis must be buyer_total"
_STEAM_FEE_BPS_ERROR = "steam_fee_bps is outside the supported range"
_PUBLISHER_FEE_BPS_ERROR = "publisher_fee_bps is outside the supported range"
_MIN_FEE_MINOR_ERROR = "min_fee_minor is outside the supported range"
_QUOTE_AGE_ERROR = "max_quote_age_seconds is outside the supported range"
_INVENTORY_AGE_ERROR = "max_inventory_age_seconds is outside the supported range"
_BREAKDOWN_AMOUNT_ERROR = "fee amounts are outside the supported range"
_BREAKDOWN_RECOMPOSITION_ERROR = "fee breakdown does not recompose buyer total"


class MarketFeeError(ValueError):
    """Raised when a fee contract or exact fee quote is invalid."""


@dataclass(frozen=True, slots=True)
class MarketFeeContract:
    """Immutable, explicitly configured market-money contract.

    Prices in this contract are buyer totals.  Both fee components are
    calculated from the seller receipt, floored independently, and then
    raised to the configured per-component minimum where necessary.
    """

    currency_code: str
    minor_digits: int
    price_basis: PRICE_BASIS
    steam_fee_bps: int
    publisher_fee_bps: int
    min_fee_minor: int
    max_quote_age_seconds: int = 900
    max_inventory_age_seconds: int = 3_600

    def __post_init__(self) -> None:
        if not isinstance(self.currency_code, str) or not _CURRENCY_CODE.fullmatch(
            self.currency_code
        ):
            raise MarketFeeError(_CURRENCY_CODE_ERROR)
        if not _bounded_int(self.minor_digits, MIN_MINOR_DIGITS, MAX_MINOR_DIGITS):
            raise MarketFeeError(_MINOR_DIGITS_ERROR)
        if self.price_basis != "buyer_total":
            raise MarketFeeError(_PRICE_BASIS_ERROR)
        if not _bounded_int(self.steam_fee_bps, MIN_FEE_BPS, MAX_FEE_BPS):
            raise MarketFeeError(_STEAM_FEE_BPS_ERROR)
        if not _bounded_int(self.publisher_fee_bps, MIN_FEE_BPS, MAX_FEE_BPS):
            raise MarketFeeError(_PUBLISHER_FEE_BPS_ERROR)
        if not _bounded_int(self.min_fee_minor, MIN_FEE_MINOR, MAX_FEE_MINOR):
            raise MarketFeeError(_MIN_FEE_MINOR_ERROR)
        if not _bounded_int(
            self.max_quote_age_seconds,
            MIN_FRESHNESS_SECONDS,
            MAX_FRESHNESS_SECONDS,
        ):
            raise MarketFeeError(_QUOTE_AGE_ERROR)
        if not _bounded_int(
            self.max_inventory_age_seconds,
            MIN_FRESHNESS_SECONDS,
            MAX_FRESHNESS_SECONDS,
        ):
            raise MarketFeeError(_INVENTORY_AGE_ERROR)


@dataclass(frozen=True, slots=True)
class MarketFeeBreakdown:
    """Per-item exact fee decomposition in integer minor units."""

    seller_receipt_minor: int
    steam_fee_minor: int
    publisher_fee_minor: int
    buyer_total_minor: int

    def __post_init__(self) -> None:
        values = (
            self.seller_receipt_minor,
            self.steam_fee_minor,
            self.publisher_fee_minor,
            self.buyer_total_minor,
        )
        if any(not _bounded_int(value, 0, MAX_MINOR_UNITS) for value in values):
            raise MarketFeeError(_BREAKDOWN_AMOUNT_ERROR)
        if (
            self.buyer_total_minor
            != self.seller_receipt_minor
            + self.steam_fee_minor
            + self.publisher_fee_minor
        ):
            raise MarketFeeError(_BREAKDOWN_RECOMPOSITION_ERROR)

    @property
    def total_fee_minor(self) -> int:
        return self.steam_fee_minor + self.publisher_fee_minor


def _bounded_int(value: object, minimum: int, maximum: int) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def decimal_to_minor(value: str, minor_digits: int) -> int | None:
    """Convert an exact fixed-point decimal string to integer minor units.

    Exponent notation, signs, leading zeroes, non-finite values, and values
    with non-zero digits beyond the configured precision are rejected. Extra
    trailing zeroes are exact and therefore accepted. Invalid values return
    ``None`` so an optimizer can fail closed without catching broad exceptions.
    """

    if not _bounded_int(minor_digits, MIN_MINOR_DIGITS, MAX_MINOR_DIGITS):
        return None
    if (
        not isinstance(value, str)
        or len(value) > MAX_DECIMAL_TEXT_LENGTH
        or not _FIXED_DECIMAL.fullmatch(value)
    ):
        return None

    integer_text, separator, fraction_text = value.partition(".")
    fraction_text = fraction_text if separator else ""
    if len(fraction_text) > minor_digits and any(
        digit != "0" for digit in fraction_text[minor_digits:]
    ):
        return None

    try:
        integer_part = int(integer_text)
        fraction_part = int(fraction_text[:minor_digits] or "0")
    except ValueError:
        return None

    scale = 10**minor_digits
    amount = integer_part * scale + fraction_part * 10 ** (
        minor_digits - len(fraction_text[:minor_digits])
    )
    if amount < 0 or amount > MAX_MINOR_UNITS:
        return None
    return amount


def _component_fee(seller_receipt_minor: int, fee_bps: int, minimum: int) -> int:
    return max((seller_receipt_minor * fee_bps) // 10_000, minimum)


def _raw_buyer_total(
    seller_receipt_minor: int,
    contract: MarketFeeContract,
) -> int:
    steam_fee_minor = _component_fee(
        seller_receipt_minor, contract.steam_fee_bps, contract.min_fee_minor
    )
    publisher_fee_minor = _component_fee(
        seller_receipt_minor,
        contract.publisher_fee_bps,
        contract.min_fee_minor,
    )
    return seller_receipt_minor + steam_fee_minor + publisher_fee_minor


def calculate_item_fees(
    seller_receipt_minor: int,
    contract: MarketFeeContract,
) -> MarketFeeBreakdown | None:
    """Calculate both fee components for one seller receipt.

    Steam's minimum is applied independently to each component.  Callers must
    invoke this once per market item, rather than on a set subtotal.
    """

    if not _bounded_int(seller_receipt_minor, 0, MAX_MINOR_UNITS):
        return None
    if not isinstance(contract, MarketFeeContract):
        return None
    steam_fee_minor = _component_fee(
        seller_receipt_minor,
        contract.steam_fee_bps,
        contract.min_fee_minor,
    )
    publisher_fee_minor = _component_fee(
        seller_receipt_minor,
        contract.publisher_fee_bps,
        contract.min_fee_minor,
    )
    buyer_total_minor = seller_receipt_minor + steam_fee_minor + publisher_fee_minor
    if buyer_total_minor > MAX_MINOR_UNITS:
        return None
    return MarketFeeBreakdown(
        seller_receipt_minor=seller_receipt_minor,
        steam_fee_minor=steam_fee_minor,
        publisher_fee_minor=publisher_fee_minor,
        buyer_total_minor=buyer_total_minor,
    )


def seller_receipt_from_buyer_total(
    buyer_total_minor: int,
    contract: MarketFeeContract,
) -> int | None:
    """Return the exact seller receipt for a buyer total, or ``None``.

    The fee function is monotonic and the receipt is never greater than the
    buyer total, so a bounded binary search finds the only possible inverse.
    The final recomposition check deliberately rejects buyer totals skipped by
    component flooring or minimum fees.
    """

    if not _bounded_int(buyer_total_minor, 0, MAX_MINOR_UNITS):
        return None
    if not isinstance(contract, MarketFeeContract):
        return None

    low = 0
    high = buyer_total_minor
    while low < high:
        candidate = (low + high) // 2
        total = _raw_buyer_total(candidate, contract)
        if total < buyer_total_minor:
            low = candidate + 1
        else:
            high = candidate

    receipt = low
    breakdown = calculate_item_fees(receipt, contract)
    if breakdown is None or breakdown.buyer_total_minor != buyer_total_minor:
        return None
    return receipt
