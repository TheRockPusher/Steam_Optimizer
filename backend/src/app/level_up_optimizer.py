"""Pure level-up swap recommendation domain and optimizer.

The module deliberately has no knowledge of HTTP, persistence, or Steam APIs.  The
server turns its cache rows into the small immutable values in this file and calls
:func:`optimize_level_up` with an explicit snapshot and an explicit UTC clock.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from math import isfinite, isqrt
from types import MappingProxyType
from typing import Literal

from app.market_fees import (
    MarketFeeContract,
)
from app.market_fees import (
    calculate_item_fees as _calculate_item_fees,
)
from app.market_fees import (
    decimal_to_minor as _decimal_to_minor,
)
from app.market_fees import (
    seller_receipt_from_buyer_total as _seller_receipt_from_buyer_total,
)

MIN_NORMAL_SET_SIZE = 5
MAX_NORMAL_SET_SIZE = 15
MAX_DESTINATION_SETS = 5
NORMAL_BADGE_XP = 100
MAX_APP_ID = 2_147_483_647
MAX_HASH_LENGTH = 512
MAX_CARD_NAME_LENGTH = 256
MAX_GAME_NAME_LENGTH = 256
MAX_QUOTE_LENGTH = 64
MAX_QUOTE_QUANTITY = 1_000_000_000
MAX_HOLDING_QUANTITY = 1_000_000
MAX_PLAYER_XP = 10**12
MAX_PLAYER_LEVEL = 100_000
MAX_CATALOG_SETS = 50_000
MAX_CATALOG_CARDS = 250_000

# The grouping grammar is intentionally ASCII for the AppID and exact suffix.
_NORMAL_CARD_RE = re.compile(r"^([1-9][0-9]*)-(.+) \(Trading Card\)$")
_DECIMAL_RE = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?")


class OptimizerInputError(ValueError):
    """A fail-closed input error, with a stable machine-readable reason."""

    def __init__(self, reason: str, message: str | None = None) -> None:
        self.reason = reason
        super().__init__(message or reason)


@dataclass(frozen=True, slots=True)
class CatalogCard:
    """One fully resolved normal-card catalog row.

    ``highest_buy`` and ``lowest_sell`` are provider decimal strings in the
    configured buyer-total basis.  A side may be absent; that side is then
    ineligible, while the other side can still be used.
    """

    market_hash_name: str
    app_id: int
    card_name: str
    highest_buy: str | None = None
    lowest_sell: str | None = None
    highest_buy_quantity: int | None = None
    lowest_sell_quantity: int | None = None
    observed_at: datetime | None = None
    highest_buy_observed_at: datetime | None = None
    lowest_sell_observed_at: datetime | None = None
    resolved: bool = True

    def __post_init__(self) -> None:
        if not isinstance(self.market_hash_name, str):
            raise OptimizerInputError(
                "catalog_card_invalid", "market_hash_name must be a string"
            )
        if (
            len(self.market_hash_name) == 0
            or len(self.market_hash_name) > MAX_HASH_LENGTH
        ):
            raise OptimizerInputError(
                "catalog_card_invalid", "market_hash_name is out of bounds"
            )
        parsed = parse_normal_card_hash(self.market_hash_name)
        if parsed is None:
            raise OptimizerInputError(
                "catalog_card_invalid", "not a normal trading-card hash"
            )
        parsed_app_id, parsed_name = parsed
        _require_app_id(self.app_id, "app_id")
        if self.app_id != parsed_app_id:
            raise OptimizerInputError(
                "catalog_card_invalid", "hash AppID does not match app_id"
            )
        _require_bounded_text(self.card_name, "card_name", MAX_CARD_NAME_LENGTH)
        if self.card_name != parsed_name:
            raise OptimizerInputError(
                "catalog_card_invalid", "card name does not match hash"
            )
        if not isinstance(self.resolved, bool):
            raise OptimizerInputError(
                "catalog_card_invalid", "resolved must be boolean"
            )
        for value, label in (
            (self.highest_buy, "highest_buy"),
            (self.lowest_sell, "lowest_sell"),
        ):
            if value is not None:
                _require_quote_text(value, label)
        for value, label in (
            (self.highest_buy_quantity, "highest_buy_quantity"),
            (self.lowest_sell_quantity, "lowest_sell_quantity"),
        ):
            _require_quote_quantity(value, label)
        for name, value in (
            ("observed_at", self.observed_at),
            ("highest_buy_observed_at", self.highest_buy_observed_at),
            ("lowest_sell_observed_at", self.lowest_sell_observed_at),
        ):
            if value is not None:
                object.__setattr__(self, name, _coerce_utc(value, name))


@dataclass(frozen=True, slots=True)
class CatalogSet:
    """A validated complete normal-card set for one game."""

    app_id: int
    game_name: str | None
    cards: tuple[CatalogCard, ...]
    set_size: int | None = None
    resolved: bool = True

    def __post_init__(self) -> None:
        _require_app_id(self.app_id, "app_id")
        if not isinstance(self.resolved, bool):
            raise OptimizerInputError("catalog_set_invalid", "resolved must be boolean")
        if self.game_name is None:
            if self.resolved:
                raise OptimizerInputError(
                    "catalog_set_invalid", "resolved sets need a game name"
                )
        else:
            _require_bounded_text(self.game_name, "game_name", MAX_GAME_NAME_LENGTH)
        if not isinstance(self.cards, tuple):
            raise OptimizerInputError("catalog_set_invalid", "cards must be a tuple")
        cards = self.cards
        if not self.resolved and not cards:
            object.__setattr__(self, "cards", cards)
            if self.set_size is not None:
                _require_set_size(self.set_size, "set_size")
            return
        if not cards:
            raise OptimizerInputError("catalog_set_invalid", "set must contain cards")
        normalized_cards: list[CatalogCard] = []
        seen: set[str] = set()
        for card in cards:
            if not isinstance(card, CatalogCard):
                raise OptimizerInputError(
                    "catalog_set_invalid", "cards must be CatalogCard values"
                )
            if not card.resolved and self.resolved:
                raise OptimizerInputError(
                    "catalog_set_invalid", "resolved set contains unresolved card"
                )
            if card.app_id != self.app_id:
                raise OptimizerInputError(
                    "catalog_set_invalid", "card AppID does not match set"
                )
            if card.market_hash_name in seen:
                raise OptimizerInputError("catalog_set_invalid", "duplicate card hash")
            seen.add(card.market_hash_name)
            normalized_cards.append(card)
        if not MIN_NORMAL_SET_SIZE <= len(normalized_cards) <= MAX_NORMAL_SET_SIZE:
            raise OptimizerInputError(
                "catalog_set_invalid", "set size is outside 5 through 15"
            )
        set_size = len(normalized_cards) if self.set_size is None else self.set_size
        _require_set_size(set_size, "set_size")
        if set_size != len(normalized_cards):
            raise OptimizerInputError(
                "catalog_set_invalid", "set_size does not match card count"
            )
        normalized_cards.sort(key=lambda value: value.market_hash_name)
        object.__setattr__(self, "cards", tuple(normalized_cards))
        object.__setattr__(self, "set_size", set_size)


@dataclass(frozen=True, slots=True)
class ResolvedCatalog:
    """The current generation of resolved sets.

    ``complete=False`` is an explicit warming state.  It is never silently
    interpreted as an empty catalog or as a no-opportunity result.
    """

    generation: int
    generated_at: datetime
    sets: tuple[CatalogSet, ...]
    complete: bool = True
    pending_app_ids: tuple[int, ...] = ()

    def __post_init__(self) -> None:
        if isinstance(self.generation, bool) or not isinstance(self.generation, int):
            raise OptimizerInputError(
                "price_generation_unavailable", "generation must be an integer"
            )
        if self.generation <= 0:
            raise OptimizerInputError(
                "price_generation_unavailable", "generation must be positive"
            )
        generated_at = _coerce_utc(self.generated_at, "generated_at")
        if not isinstance(self.complete, bool):
            raise OptimizerInputError("catalog_invalid", "complete must be boolean")
        if not isinstance(self.sets, tuple):
            raise OptimizerInputError("catalog_invalid", "sets must be a tuple")
        raw_sets = self.sets
        if len(raw_sets) > MAX_CATALOG_SETS:
            raise OptimizerInputError(
                "catalog_invalid", "catalog contains too many sets"
            )
        normalized_sets: list[CatalogSet] = []
        seen: set[int] = set()
        for value in raw_sets:
            if not isinstance(value, CatalogSet):
                raise OptimizerInputError(
                    "catalog_invalid", "sets must be CatalogSet values"
                )
            if value.app_id in seen:
                raise OptimizerInputError("catalog_invalid", "duplicate set AppID")
            seen.add(value.app_id)
            if self.complete and not value.resolved:
                raise OptimizerInputError(
                    "catalog_invalid", "complete catalog contains unresolved set"
                )
            normalized_sets.append(value)
        if sum(len(value.cards) for value in normalized_sets) > MAX_CATALOG_CARDS:
            raise OptimizerInputError(
                "catalog_invalid", "catalog contains too many cards"
            )
        if not isinstance(self.pending_app_ids, tuple):
            raise OptimizerInputError(
                "catalog_invalid", "pending_app_ids must be a tuple"
            )
        pending: list[int] = []
        for app_id in self.pending_app_ids:
            _require_app_id(app_id, "pending_app_id")
            if app_id not in pending:
                pending.append(app_id)
        if self.complete and pending:
            raise OptimizerInputError(
                "catalog_invalid", "complete catalog has pending sets"
            )
        if not self.complete:
            pending.extend(
                value.app_id for value in normalized_sets if not value.resolved
            )
            pending = list(dict.fromkeys(pending))
        object.__setattr__(self, "generated_at", generated_at)
        object.__setattr__(self, "sets", tuple(normalized_sets))
        object.__setattr__(self, "pending_app_ids", tuple(pending))

    @property
    def resolved_sets(self) -> tuple[CatalogSet, ...]:
        return tuple(value for value in self.sets if value.resolved)

    @property
    def total_sets(self) -> int:
        return len(self.sets)

    @property
    def resolved_set_count(self) -> int:
        return len(self.resolved_sets)


@dataclass(frozen=True, slots=True)
class Holding:
    """Aggregated ownership of one exact normal-card hash."""

    market_hash_name: str
    owned_quantity: int
    sellable_quantity: int

    def __post_init__(self) -> None:
        if not isinstance(self.market_hash_name, str) or not self.market_hash_name:
            raise OptimizerInputError("inventory_invalid", "holding hash is required")
        if len(self.market_hash_name) > MAX_HASH_LENGTH:
            raise OptimizerInputError("inventory_invalid", "holding hash is too long")
        if parse_normal_card_hash(self.market_hash_name) is None:
            raise OptimizerInputError(
                "inventory_invalid", "holding is not a normal trading card"
            )
        _require_bounded_int(
            self.owned_quantity, "owned_quantity", 1, MAX_HOLDING_QUANTITY
        )
        _require_bounded_int(
            self.sellable_quantity, "sellable_quantity", 0, MAX_HOLDING_QUANTITY
        )
        if self.sellable_quantity > self.owned_quantity:
            raise OptimizerInputError(
                "inventory_invalid", "sellable quantity exceeds owned quantity"
            )

    @property
    def owned(self) -> int:
        return self.owned_quantity

    @property
    def sellable(self) -> int:
        return self.sellable_quantity


@dataclass(frozen=True, slots=True)
class BadgeState:
    """Validated player XP/level and normal badge levels keyed by AppID."""

    player_xp: int
    player_level: int
    normal_badge_levels: Mapping[int, int]

    def __post_init__(self) -> None:
        _require_bounded_int(self.player_xp, "player_xp", 0, MAX_PLAYER_XP)
        _require_bounded_int(self.player_level, "player_level", 0, MAX_PLAYER_LEVEL)
        if level_for_xp(self.player_xp) != self.player_level:
            raise OptimizerInputError(
                "badge_data_unavailable", "player XP and level disagree"
            )
        if not isinstance(self.normal_badge_levels, Mapping):
            raise OptimizerInputError(
                "badge_data_unavailable", "badge levels must be a mapping"
            )
        raw_levels = self.normal_badge_levels.items()
        levels: dict[int, int] = {}
        for pair in raw_levels:
            if not isinstance(pair, Sequence) or len(pair) != 2:
                raise OptimizerInputError(
                    "badge_data_unavailable", "malformed badge level"
                )
            app_id, level = pair
            _require_app_id(app_id, "badge AppID")
            _require_bounded_int(level, "badge level", 0, 5)
            if app_id in levels:
                raise OptimizerInputError(
                    "badge_data_unavailable", "duplicate badge AppID"
                )
            levels[app_id] = level
        object.__setattr__(self, "normal_badge_levels", MappingProxyType(levels))

    def level_for_game(self, app_id: int) -> int:
        return self.normal_badge_levels.get(app_id, 0)


@dataclass(frozen=True, slots=True)
class SellRow:
    market_hash_name: str
    card_name: str
    quantity: int
    buyer_total: int
    steam_fee: int
    publisher_fee: int
    seller_receipt: int
    top_bid_quantity: int
    quote_timestamp: datetime


@dataclass(frozen=True, slots=True)
class BuyRow:
    market_hash_name: str
    card_name: str
    quantity: int
    buyer_total: int
    top_ask_quantity: int
    quote_timestamp: datetime


@dataclass(frozen=True, slots=True)
class SourcePlan:
    app_id: int
    game_name: str
    badge_level: int
    set_size: int
    rows: tuple[SellRow, ...]
    buyer_total: int
    steam_fee: int
    publisher_fee: int
    seller_receipt: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "rows", tuple(self.rows))


@dataclass(frozen=True, slots=True)
class DestinationPlan:
    app_id: int
    game_name: str
    badge_level_before: int
    badge_level_after: int
    set_size: int
    rows: tuple[BuyRow, ...]
    set_subtotal: int
    craft_xp: int = NORMAL_BADGE_XP

    def __post_init__(self) -> None:
        object.__setattr__(self, "rows", tuple(self.rows))


@dataclass(frozen=True, slots=True)
class PlayerProjection:
    current_xp: int
    current_level: int
    xp_to_next_level: int
    projected_xp: int
    projected_level: int
    projected_xp_to_next_level: int


@dataclass(frozen=True, slots=True)
class PlanTotals:
    source_buyer_total: int
    steam_fee_total: int
    publisher_fee_total: int
    seller_receipt_total: int
    purchase_total: int
    unspent_swap_proceeds: int
    direct_craft_xp: int
    swap_path_xp: int
    xp_advantage: int
    destination_count: int
    scope_limited: bool


@dataclass(frozen=True, slots=True)
class LevelUpOptimizationResponse:
    status: Literal["ready", "no_opportunity", "warming", "unavailable"]
    reason: str | None
    generated_at: datetime
    inventory_refreshed_at: datetime
    catalog_total_sets: int
    catalog_resolved_sets: int
    catalog_pending_sets: int
    currency_code: str | None = None
    minor_digits: int | None = None
    price_basis: str | None = None
    steam_fee_bps: int | None = None
    publisher_fee_bps: int | None = None
    min_fee_minor: int | None = None
    taxes_included: bool | None = None
    scope_limited: bool = False
    valid_until: datetime | None = None
    player: PlayerProjection | None = None
    source: SourcePlan | None = None
    destinations: tuple[DestinationPlan, ...] = ()
    totals: PlanTotals | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "destinations", tuple(self.destinations))

    def to_dict(self) -> dict[str, object]:
        """Return the exact flat wire shape consumed by the frontend."""
        return {
            "status": self.status,
            "reason": self.reason,
            "generated_at": _json_value(self.generated_at),
            "inventory_refreshed_at": _json_value(self.inventory_refreshed_at),
            "catalog_total_sets": self.catalog_total_sets,
            "catalog_resolved_sets": self.catalog_resolved_sets,
            "catalog_pending_sets": self.catalog_pending_sets,
            "currency_code": self.currency_code,
            "minor_digits": self.minor_digits,
            "price_basis": self.price_basis,
            "steam_fee_bps": self.steam_fee_bps,
            "publisher_fee_bps": self.publisher_fee_bps,
            "min_fee_minor": self.min_fee_minor,
            "taxes_included": self.taxes_included,
            "scope_limited": self.scope_limited,
            "valid_until": _json_value(self.valid_until),
            "player": _player_json(self.player),
            "source": _source_json(self.source),
            "destinations": [_destination_json(value) for value in self.destinations],
            "totals": _totals_json(self.totals),
        }


def _sell_row_json(row: SellRow) -> dict[str, object]:
    return {
        "market_hash_name": row.market_hash_name,
        "card_name": row.card_name,
        "quantity": row.quantity,
        "buyer_total": row.buyer_total,
        "steam_fee": row.steam_fee,
        "publisher_fee": row.publisher_fee,
        "seller_receipt": row.seller_receipt,
        "top_bid_quantity": row.top_bid_quantity,
        "quote_timestamp": _json_value(row.quote_timestamp),
    }


def _buy_row_json(row: BuyRow) -> dict[str, object]:
    return {
        "market_hash_name": row.market_hash_name,
        "card_name": row.card_name,
        "quantity": row.quantity,
        "buyer_total": row.buyer_total,
        "top_ask_quantity": row.top_ask_quantity,
        "quote_timestamp": _json_value(row.quote_timestamp),
    }


def _player_json(player: PlayerProjection | None) -> dict[str, object] | None:
    if player is None:
        return None
    return {
        "current_xp": player.current_xp,
        "current_level": player.current_level,
        "xp_to_next_level": player.xp_to_next_level,
        "projected_xp": player.projected_xp,
        "projected_level": player.projected_level,
        "projected_xp_to_next_level": player.projected_xp_to_next_level,
    }


def _source_json(source: SourcePlan | None) -> dict[str, object] | None:
    if source is None:
        return None
    return {
        "app_id": str(source.app_id),
        "game_name": source.game_name,
        "badge_level": source.badge_level,
        "set_size": source.set_size,
        "rows": [_sell_row_json(row) for row in source.rows],
    }


def _destination_json(destination: DestinationPlan) -> dict[str, object]:
    return {
        "app_id": str(destination.app_id),
        "game_name": destination.game_name,
        "badge_level_before": destination.badge_level_before,
        "badge_level_after": destination.badge_level_after,
        "set_size": destination.set_size,
        "rows": [_buy_row_json(row) for row in destination.rows],
        "set_subtotal": destination.set_subtotal,
        "craft_xp": destination.craft_xp,
    }


def _totals_json(totals: PlanTotals | None) -> dict[str, object] | None:
    if totals is None:
        return None
    return {
        "source_buyer_total": totals.source_buyer_total,
        "steam_fee_total": totals.steam_fee_total,
        "publisher_fee_total": totals.publisher_fee_total,
        "seller_receipt_total": totals.seller_receipt_total,
        "purchase_total": totals.purchase_total,
        "unspent_swap_proceeds": totals.unspent_swap_proceeds,
        "direct_craft_xp": totals.direct_craft_xp,
        "swap_path_xp": totals.swap_path_xp,
        "xp_advantage": totals.xp_advantage,
        "destination_count": totals.destination_count,
        "scope_limited": totals.scope_limited,
    }


@dataclass(frozen=True, slots=True)
class _SideQuote:
    price_minor: int
    quantity: int
    timestamp: datetime


@dataclass(frozen=True, slots=True)
class _SourceCandidate:
    source: SourcePlan
    destinations: tuple[DestinationPlan, ...]
    totals: PlanTotals
    oldest_quote: timedelta
    card_actions: int


@dataclass(frozen=True, slots=True)
class XPProjection:
    xp: int
    level: int
    xp_to_next_level: int

    @property
    def projected_xp(self) -> int:
        return self.xp

    @property
    def projected_level(self) -> int:
        return self.level

    @property
    def projected_xp_to_next_level(self) -> int:
        return self.xp_to_next_level


def parse_normal_card_hash(value: object) -> tuple[int, str] | None:
    """Parse a canonical strict normal-card market hash.

    Provider percent-encoding is decoded once at the provider/cache boundary.
    This domain parser deliberately never decodes its input again.
    """

    if not isinstance(value, str) or not value or len(value) > MAX_HASH_LENGTH:
        return None
    match = _NORMAL_CARD_RE.fullmatch(value)
    if match is None:
        return None
    app_id_text, card_name = match.groups()
    if len(card_name) == 0 or len(card_name) > MAX_CARD_NAME_LENGTH:
        return None
    try:
        app_id = int(app_id_text, 10)
    except ValueError:
        return None
    if not 0 < app_id <= MAX_APP_ID:
        return None
    return app_id, card_name


def is_normal_card_hash(value: object) -> bool:
    return parse_normal_card_hash(value) is not None


def minimum_xp(level: int) -> int:
    """Return the minimum total XP at the start of ``level``."""

    _require_bounded_int(level, "level", 0, MAX_PLAYER_LEVEL)
    decades, remainder = divmod(level, 10)
    return 500 * decades * (decades + 1) + 100 * (decades + 1) * remainder


def level_for_xp(xp: int) -> int:
    """Return the greatest level whose threshold is no greater than ``xp``."""

    _require_bounded_int(xp, "xp", 0, MAX_PLAYER_XP)
    # Find the decade threshold without a linear scan.  The decade D starts at
    # 500*D*(D+1), so a small correction around the integer square-root estimate
    # is sufficient and remains exact for every bounded integer input.
    decades = isqrt(1 + xp // 125) // 2
    while 500 * decades * (decades + 1) > xp:
        decades -= 1
    while 500 * (decades + 1) * (decades + 2) <= xp:
        decades += 1
    base = 500 * decades * (decades + 1)
    remainder = min(9, (xp - base) // (100 * (decades + 1)))
    level = decades * 10 + remainder
    if level > MAX_PLAYER_LEVEL:
        raise OptimizerInputError(
            "badge_data_unavailable", "derived level is out of bounds"
        )
    return level


def xp_to_next_level(xp: int, level: int | None = None) -> int:
    """Return the integer XP delta needed to reach the next level."""

    _require_bounded_int(xp, "xp", 0, MAX_PLAYER_XP)
    actual_level = level_for_xp(xp)
    if level is not None:
        _require_bounded_int(level, "level", 0, MAX_PLAYER_LEVEL)
        if level != actual_level:
            raise OptimizerInputError("badge_data_unavailable", "XP and level disagree")
    return minimum_xp(actual_level + 1) - xp


def project_xp(xp: int, added_xp: int) -> XPProjection:
    """Project a player's level after adding a non-negative integer XP amount."""

    _require_bounded_int(xp, "xp", 0, MAX_PLAYER_XP)
    _require_bounded_int(added_xp, "added_xp", 0, MAX_PLAYER_XP - xp)
    projected = xp + added_xp
    level = level_for_xp(projected)
    return XPProjection(
        xp=projected,
        level=level,
        xp_to_next_level=minimum_xp(level + 1) - projected,
    )


def optimize_level_up(
    catalog: ResolvedCatalog,
    holdings: Sequence[Holding] | Mapping[str, Holding],
    badges: BadgeState,
    inventory_refreshed_at: datetime | str | int,
    now: datetime | str | int,
    fee_contract: MarketFeeContract,
) -> LevelUpOptimizationResponse:
    """Calculate one deterministic, fully funded level-up recommendation.

    Missing or stale generation/inventory data raises :class:`OptimizerInputError`.
    Missing quote/depth on one side excludes that side. An explicitly incomplete
    catalog returns ``warming`` rather than a misleading no-opportunity result.
    """

    if not isinstance(catalog, ResolvedCatalog):
        raise OptimizerInputError("catalog_invalid", "catalog must be resolved")
    if not isinstance(badges, BadgeState):
        raise OptimizerInputError("badge_data_unavailable", "badges must be validated")
    _validate_fee_contract(fee_contract)
    catalog_value = catalog
    normalized_holdings = _normalize_holdings(holdings)
    normalized_badges = badges
    current = _coerce_utc(now, "now")
    inventory_time = _coerce_utc(inventory_refreshed_at, "inventory_refreshed_at")
    contract_value = fee_contract
    quote_window = contract_value.max_quote_age_seconds
    inventory_window = contract_value.max_inventory_age_seconds
    if current < inventory_time or current - inventory_time > timedelta(
        seconds=inventory_window
    ):
        raise OptimizerInputError(
            "inventory_snapshot_too_old", "inventory snapshot is stale or in the future"
        )
    if (
        current < catalog_value.generated_at
        or current - catalog_value.generated_at > timedelta(seconds=quote_window)
    ):
        reason = (
            "price_generation_stale"
            if current >= catalog_value.generated_at
            else "price_generation_unavailable"
        )
        raise OptimizerInputError(reason, "price generation is stale or in the future")

    if not catalog_value.complete:
        return LevelUpOptimizationResponse(
            status="warming",
            reason="catalog_warming",
            generated_at=current,
            inventory_refreshed_at=inventory_time,
            catalog_total_sets=catalog_value.total_sets,
            catalog_resolved_sets=catalog_value.resolved_set_count,
            catalog_pending_sets=len(catalog_value.pending_app_ids),
            currency_code=contract_value.currency_code,
            minor_digits=contract_value.minor_digits,
            price_basis="instant_top_of_book",
            steam_fee_bps=contract_value.steam_fee_bps,
            publisher_fee_bps=contract_value.publisher_fee_bps,
            min_fee_minor=contract_value.min_fee_minor,
            taxes_included=False,
        )

    holdings_by_hash = normalized_holdings
    sets = tuple(sorted(catalog_value.resolved_sets, key=lambda value: value.app_id))
    catalog_hashes = {
        card.market_hash_name for current_set in sets for card in current_set.cards
    }
    if any(
        market_hash_name not in catalog_hashes for market_hash_name in holdings_by_hash
    ):
        raise OptimizerInputError(
            "catalog_invalid",
            "inventory contains a normal card outside the resolved catalog",
        )
    candidates: list[_SourceCandidate] = []
    saw_source = False
    for source_set in sets:
        source_level = normalized_badges.level_for_game(source_set.app_id)
        if source_level >= 5:
            continue
        source_rows = _source_rows(
            source_set, holdings_by_hash, current, quote_window, contract_value
        )
        if source_rows is None:
            continue
        saw_source = True
        source = _build_source_plan(source_set, source_level, source_rows)
        destination_options = _destination_options(
            source_set,
            sets,
            holdings_by_hash,
            normalized_badges,
            current,
            quote_window,
            contract_value,
            source.seller_receipt,
        )
        selected = _select_destinations(destination_options, source.seller_receipt)
        if len(selected) < 2:
            continue
        purchase_total = sum(value.set_subtotal for value in selected)
        if purchase_total > source.seller_receipt:
            raise OptimizerInputError(
                "optimizer_internal_error", "selected destinations exceed proceeds"
            )
        scope_limited = (
            len(selected) == MAX_DESTINATION_SETS
            and len(destination_options) > MAX_DESTINATION_SETS
        )
        if scope_limited:
            sixth = destination_options[MAX_DESTINATION_SETS]
            scope_limited = purchase_total + sixth.set_subtotal <= source.seller_receipt
        destinations = tuple(selected)
        swap_xp = NORMAL_BADGE_XP * len(destinations)
        totals = PlanTotals(
            source_buyer_total=source.buyer_total,
            steam_fee_total=source.steam_fee,
            publisher_fee_total=source.publisher_fee,
            seller_receipt_total=source.seller_receipt,
            purchase_total=purchase_total,
            unspent_swap_proceeds=source.seller_receipt - purchase_total,
            direct_craft_xp=NORMAL_BADGE_XP,
            swap_path_xp=swap_xp,
            xp_advantage=swap_xp - NORMAL_BADGE_XP,
            destination_count=len(destinations),
            scope_limited=scope_limited,
        )
        all_quote_times = [row.quote_timestamp for row in source.rows] + [
            row.quote_timestamp
            for destination in destinations
            for row in destination.rows
        ]
        oldest_quote_age = max(current - value for value in all_quote_times)
        candidates.append(
            _SourceCandidate(
                source=source,
                destinations=destinations,
                totals=totals,
                oldest_quote=oldest_quote_age,
                card_actions=source.set_size
                + sum(value.set_size for value in destinations),
            )
        )

    if not candidates:
        reason = "no_complete_sellable_set" if not saw_source else "no_positive_xp_swap"
        return LevelUpOptimizationResponse(
            status="no_opportunity",
            reason=reason,
            generated_at=current,
            inventory_refreshed_at=inventory_time,
            catalog_total_sets=catalog_value.total_sets,
            catalog_resolved_sets=catalog_value.resolved_set_count,
            catalog_pending_sets=len(catalog_value.pending_app_ids),
            currency_code=contract_value.currency_code,
            minor_digits=contract_value.minor_digits,
            price_basis="instant_top_of_book",
            steam_fee_bps=contract_value.steam_fee_bps,
            publisher_fee_bps=contract_value.publisher_fee_bps,
            min_fee_minor=contract_value.min_fee_minor,
            taxes_included=False,
        )

    best = min(
        candidates,
        key=lambda value: (
            -value.totals.xp_advantage,
            -value.totals.unspent_swap_proceeds,
            value.oldest_quote,
            value.card_actions,
            value.source.app_id,
        ),
    )
    player = _player_projection(normalized_badges, best.totals.swap_path_xp)
    valid_until = min(
        inventory_time + timedelta(seconds=inventory_window),
        catalog_value.generated_at + timedelta(seconds=quote_window),
        *(
            row.quote_timestamp + timedelta(seconds=quote_window)
            for row in best.source.rows
        ),
        *(
            row.quote_timestamp + timedelta(seconds=quote_window)
            for destination in best.destinations
            for row in destination.rows
        ),
    )
    return LevelUpOptimizationResponse(
        status="ready",
        reason="ready",
        generated_at=current,
        inventory_refreshed_at=inventory_time,
        catalog_total_sets=catalog_value.total_sets,
        catalog_resolved_sets=catalog_value.resolved_set_count,
        catalog_pending_sets=len(catalog_value.pending_app_ids),
        scope_limited=best.totals.scope_limited,
        valid_until=valid_until,
        player=player,
        source=best.source,
        destinations=best.destinations,
        totals=best.totals,
        currency_code=contract_value.currency_code,
        minor_digits=contract_value.minor_digits,
        price_basis="instant_top_of_book",
        steam_fee_bps=contract_value.steam_fee_bps,
        publisher_fee_bps=contract_value.publisher_fee_bps,
        min_fee_minor=contract_value.min_fee_minor,
        taxes_included=False,
    )


def _source_rows(
    source_set: CatalogSet,
    holdings: Mapping[str, Holding],
    now: datetime,
    quote_window: int,
    contract: MarketFeeContract,
) -> tuple[SellRow, ...] | None:
    rows: list[SellRow] = []
    for card in source_set.cards:
        holding = holdings.get(card.market_hash_name)
        if (
            holding is None
            or holding.owned_quantity < 1
            or holding.sellable_quantity < 1
        ):
            return None
        quote = _side_quote(card, "buy", now, quote_window, contract)
        if quote is None:
            return None
        fees = _source_fee_breakdown(quote.price_minor, contract)
        if fees is None:
            return None
        rows.append(
            SellRow(
                market_hash_name=card.market_hash_name,
                card_name=card.card_name,
                quantity=1,
                buyer_total=quote.price_minor,
                steam_fee=fees[0],
                publisher_fee=fees[1],
                seller_receipt=fees[2],
                top_bid_quantity=quote.quantity,
                quote_timestamp=quote.timestamp,
            )
        )
    return tuple(rows)


def _build_source_plan(
    source_set: CatalogSet,
    badge_level: int,
    rows: tuple[SellRow, ...],
) -> SourcePlan:
    return SourcePlan(
        app_id=source_set.app_id,
        game_name=source_set.game_name or "",
        badge_level=badge_level,
        set_size=source_set.set_size or len(rows),
        rows=rows,
        buyer_total=sum(row.buyer_total for row in rows),
        steam_fee=sum(row.steam_fee for row in rows),
        publisher_fee=sum(row.publisher_fee for row in rows),
        seller_receipt=sum(row.seller_receipt for row in rows),
    )


def _destination_options(
    source_set: CatalogSet,
    sets: Sequence[CatalogSet],
    holdings: Mapping[str, Holding],
    badges: BadgeState,
    now: datetime,
    quote_window: int,
    contract: MarketFeeContract,
    proceeds: int,
) -> tuple[DestinationPlan, ...]:
    options: list[DestinationPlan] = []
    owned_games = {
        parsed[0]
        for market_hash_name in holdings
        if (parsed := parse_normal_card_hash(market_hash_name)) is not None
    }
    for destination_set in sets:
        if destination_set.app_id == source_set.app_id:
            continue
        if destination_set.app_id in owned_games:
            continue
        if badges.level_for_game(destination_set.app_id) >= 5:
            continue
        rows: list[BuyRow] = []
        valid = True
        for card in destination_set.cards:
            quote = _side_quote(card, "sell", now, quote_window, contract)
            if quote is None:
                valid = False
                break
            rows.append(
                BuyRow(
                    market_hash_name=card.market_hash_name,
                    card_name=card.card_name,
                    quantity=1,
                    buyer_total=quote.price_minor,
                    top_ask_quantity=quote.quantity,
                    quote_timestamp=quote.timestamp,
                )
            )
        if not valid:
            continue
        subtotal = sum(row.buyer_total for row in rows)
        if subtotal > proceeds:
            # A later option can be cheaper only if sorting says so; delaying
            # the check until after sorting preserves deterministic behavior.
            pass
        options.append(
            DestinationPlan(
                app_id=destination_set.app_id,
                game_name=destination_set.game_name or "",
                badge_level_before=badges.level_for_game(destination_set.app_id),
                badge_level_after=badges.level_for_game(destination_set.app_id) + 1,
                set_size=destination_set.set_size or len(rows),
                rows=tuple(rows),
                set_subtotal=subtotal,
            )
        )
    options.sort(
        key=lambda value: (
            value.set_subtotal,
            max(now - row.quote_timestamp for row in value.rows),
            value.set_size,
            value.app_id,
        )
    )
    return tuple(options)


def _select_destinations(
    options: Sequence[DestinationPlan],
    proceeds: int,
) -> tuple[DestinationPlan, ...]:
    selected: list[DestinationPlan] = []
    cumulative = 0
    for option in options:
        if len(selected) >= MAX_DESTINATION_SETS:
            break
        if cumulative + option.set_subtotal > proceeds:
            break
        selected.append(option)
        cumulative += option.set_subtotal
    return tuple(selected)


def _side_quote(
    card: CatalogCard,
    side: Literal["buy", "sell"],
    now: datetime,
    quote_window: int,
    contract: MarketFeeContract,
) -> _SideQuote | None:
    if side == "buy":
        price = card.highest_buy
        quantity = card.highest_buy_quantity
        timestamp_value = card.highest_buy_observed_at or card.observed_at
    else:
        price = card.lowest_sell
        quantity = card.lowest_sell_quantity
        timestamp_value = card.lowest_sell_observed_at or card.observed_at
    if (
        price is None
        or quantity is None
        or not isinstance(quantity, int)
        or isinstance(quantity, bool)
    ):
        return None
    if quantity < 1 or quantity > MAX_QUOTE_QUANTITY or timestamp_value is None:
        return None
    try:
        timestamp = _coerce_utc(timestamp_value, "quote timestamp")
    except OptimizerInputError:
        return None
    if timestamp > now or now - timestamp > timedelta(seconds=quote_window):
        return None
    try:
        price_minor = _money_to_minor(price, contract)
    except OptimizerInputError:
        return None
    if price_minor < 0:
        return None
    return _SideQuote(price_minor=price_minor, quantity=quantity, timestamp=timestamp)


def _source_fee_breakdown(
    price_minor: int, contract: MarketFeeContract
) -> tuple[int, int, int] | None:
    try:
        receipt = _seller_receipt_from_buyer_total(price_minor, contract)
        if receipt is None or receipt < 0:
            return None
        breakdown = _calculate_item_fees(receipt, contract)
    except (TypeError, ValueError, ArithmeticError):
        return None
    if (
        breakdown is None
        or breakdown.steam_fee_minor < 0
        or breakdown.publisher_fee_minor < 0
        or breakdown.buyer_total_minor != price_minor
        or (
            receipt + breakdown.steam_fee_minor + breakdown.publisher_fee_minor
            != price_minor
        )
    ):
        return None
    return (
        breakdown.steam_fee_minor,
        breakdown.publisher_fee_minor,
        receipt,
    )


def _money_to_minor(value: object, contract: MarketFeeContract) -> int:
    if not isinstance(value, str) or _DECIMAL_RE.fullmatch(value) is None:
        raise OptimizerInputError("quote_invalid", "quote is not an exact decimal")
    try:
        result = _decimal_to_minor(value, contract.minor_digits)
    except (TypeError, ValueError, InvalidOperation, ArithmeticError) as error:
        raise OptimizerInputError(
            "quote_invalid", "quote is not an exact decimal"
        ) from error
    if isinstance(result, bool) or not isinstance(result, int):
        raise OptimizerInputError("quote_invalid", "quote conversion failed")
    if result < 0 or result > 2**63 - 1:
        raise OptimizerInputError("quote_invalid", "quote is out of bounds")
    return result


def _player_projection(badges: BadgeState, added_xp: int) -> PlayerProjection:
    projected = project_xp(badges.player_xp, added_xp)
    return PlayerProjection(
        current_xp=badges.player_xp,
        current_level=badges.player_level,
        xp_to_next_level=xp_to_next_level(badges.player_xp, badges.player_level),
        projected_xp=projected.xp,
        projected_level=projected.level,
        projected_xp_to_next_level=projected.xp_to_next_level,
    )


def _normalize_holdings(
    value: Sequence[Holding] | Mapping[str, Holding],
) -> dict[str, Holding]:
    if isinstance(value, Mapping):
        raw_values = tuple(value.values())
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        raw_values = tuple(value)
    else:
        raise OptimizerInputError(
            "inventory_invalid", "holdings must be a sequence or mapping"
        )
    result: dict[str, Holding] = {}
    for holding in raw_values:
        if not isinstance(holding, Holding):
            raise OptimizerInputError("inventory_invalid", "holdings must be validated")
        if holding.market_hash_name in result:
            raise OptimizerInputError("inventory_invalid", "duplicate holding hash")
        result[holding.market_hash_name] = holding
    return result


def _validate_fee_contract(contract: MarketFeeContract) -> None:
    if not isinstance(contract, MarketFeeContract):
        raise OptimizerInputError(
            "currency_contract_missing", "validated fee contract is required"
        )


def _coerce_utc(value: object, label: str) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise OptimizerInputError(
                "timestamp_invalid", f"{label} must include UTC offset"
            )
        return value.astimezone(UTC)
    if isinstance(value, bool):
        raise OptimizerInputError("timestamp_invalid", f"{label} is invalid")
    if isinstance(value, int):
        try:
            # SteamApis supplies Unix milliseconds; normal cache timestamps use
            # seconds.  The magnitude check only chooses units, never rounds.
            if abs(value) >= 100_000_000_000:
                seconds, milliseconds = divmod(value, 1000)
                return datetime.fromtimestamp(seconds, UTC).replace(
                    microsecond=milliseconds * 1000
                )
            return datetime.fromtimestamp(value, UTC)
        except (OverflowError, OSError, ValueError) as error:
            raise OptimizerInputError(
                "timestamp_invalid", f"{label} is out of bounds"
            ) from error
    if isinstance(value, float):
        if not isfinite(value):
            raise OptimizerInputError("timestamp_invalid", f"{label} is invalid")
        try:
            micros_decimal = Decimal(str(value)) * 1_000_000
            if micros_decimal != micros_decimal.to_integral_value():
                raise OptimizerInputError(
                    "timestamp_invalid", f"{label} has sub-microsecond precision"
                )
            micros = int(micros_decimal)
            seconds, remainder = divmod(micros, 1_000_000)
            return datetime.fromtimestamp(seconds, UTC).replace(microsecond=remainder)
        except (OverflowError, OSError, ValueError, InvalidOperation) as error:
            raise OptimizerInputError(
                "timestamp_invalid", f"{label} is out of bounds"
            ) from error
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raise OptimizerInputError("timestamp_invalid", f"{label} is empty")
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError as error:
            raise OptimizerInputError(
                "timestamp_invalid", f"{label} is malformed"
            ) from error
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise OptimizerInputError(
                "timestamp_invalid", f"{label} must include UTC offset"
            )
        return parsed.astimezone(UTC)
    raise OptimizerInputError("timestamp_invalid", f"{label} is invalid")


def _require_app_id(value: object, label: str) -> None:
    _require_bounded_int(value, label, 1, MAX_APP_ID)


def _require_set_size(value: object, label: str) -> None:
    _require_bounded_int(value, label, MIN_NORMAL_SET_SIZE, MAX_NORMAL_SET_SIZE)


def _require_bounded_int(value: object, label: str, minimum: int, maximum: int) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise OptimizerInputError("input_invalid", f"{label} is out of bounds")


def _require_bounded_text(value: object, label: str, maximum: int) -> None:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise OptimizerInputError("input_invalid", f"{label} is out of bounds")


def _require_quote_text(value: object, label: str) -> None:
    if not isinstance(value, str) or not value or len(value) > MAX_QUOTE_LENGTH:
        raise OptimizerInputError("catalog_card_invalid", f"{label} is out of bounds")


def _require_quote_quantity(value: object, label: str) -> None:
    if value is None:
        return
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= MAX_QUOTE_QUANTITY
    ):
        raise OptimizerInputError("catalog_card_invalid", f"{label} is invalid")


def _json_value(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
