"""Pure badge dashboard and goal/budget planner domain.

Scope is explicitly ``inventory_normal_badges``: only normal game badges whose
cards are represented by the request inventory (or the request game rows)
appear in the dashboard, and only those games are ever planned.  The module is
read-only with respect to Steam: it prices hypothetical purchases from the
resolved catalog's top asks and never folds projected sale receipts into the
wallet budget.

The dashboard shows every known game row, including unresolved, maxed,
reserved and excluded games, and never treats an absent or stale quote as a
zero price.  Ready owned sets do not depend on monetary prices: a complete set
whose available (post-protection) copies cover a craft is craftable with zero
spend even when no quote is usable.

Planning returns three comparable deterministic policies over the same
constraint envelope (budget, badge cap of five, protections, and cumulative
top-ask depth):

* ``cheapest`` pops the globally cheapest marginal craft first.  Because the
  per-game marginal craft costs are nondecreasing (each additional copy of a
  card comes from the same ascending ask curve), the prefix heap yields the
  exact minimum spend for any craft count and the exact maximum number of
  crafts under a budget.  No per-wallet-cent dynamic programming is used.
* ``fewest_purchases`` prefers marginal crafts that need fewer purchased
  copies, then cheaper ones.  It is an explicit preference heuristic, not an
  optimality claim.
* ``preserve_cards`` prefers marginal crafts that consume fewer owned copies,
  then cheaper ones, so intact owned sets are left unspent when the budget
  allows buying replacements.  It is likewise a heuristic.

``plan_badges`` raises :class:`OptimizerInputError` only for malformed
requests (bad option references, duplicate holdings, unusable timestamps).
Data-freshness problems never raise: they produce ``status="unavailable"``
responses with a stable reason and no plans, while the dashboard rows stay
visible.  Per-quote staleness is handled per card: an unusable ask simply
cannot be purchased and is reported as ``null`` pricing, never as zero.
When every purchase-only candidate's next craft is blocked by unusable
quote data and no owned-only craft or budget-blocked route exists, the
response becomes ``status="unavailable"`` with ``price_generation_stale``
(stale per-item timestamps, even when the generation looks current) or
``quote_depth_unavailable`` (no usable ask data) instead of a misleading
``no_opportunity``.
"""

from __future__ import annotations

import heapq
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from app.level_up_optimizer import (
    MAX_APP_ID,
    MAX_HASH_LENGTH,
    MAX_HOLDING_QUANTITY,
    MAX_NORMAL_SET_SIZE,
    MAX_PLAYER_LEVEL,
    MAX_QUOTE_QUANTITY,
    MIN_NORMAL_SET_SIZE,
    NORMAL_BADGE_XP,
    BadgeState,
    CatalogCard,
    CatalogSet,
    Holding,
    OptimizerInputError,
    ResolvedCatalog,
    minimum_xp,
    parse_normal_card_hash,
    project_xp,
)
from app.market_fees import MarketFeeContract
from app.market_fees import (
    decimal_to_minor as _decimal_to_minor,
)

DEFAULT_MAX_QUOTE_AGE_SECONDS = 900
DEFAULT_MAX_INVENTORY_AGE_SECONDS = 3_600
MAX_BUDGET_MINOR = 1_000_000_000
_MAX_PRICE_MINOR = (2**53 - 1) // MAX_NORMAL_SET_SIZE
_MAX_CRAFTS_PER_BADGE = 5

_PLANNING_SCOPE = "inventory_normal_badges"
GameStatus = Literal[
    "craftable",
    "incomplete",
    "maxed",
    "reserved",
    "excluded",
    "unavailable",
]
PlanStrategy = Literal["cheapest", "fewest_purchases", "preserve_cards"]
PlanStatus = Literal["ready", "partial", "no_opportunity"]
PlanningStatus = Literal["ready", "unavailable"]
Composition = Literal["full", "size_only", "unknown"]
_QuoteState = Literal["valid", "stale", "missing"]


_APP_ID_TEXT_RE = re.compile(r"^[1-9][0-9]*\Z")
_OPTIONS_INVALID = "options_invalid"
_INVENTORY_INVALID = "inventory_invalid"
_METADATA_INVALID = "game_metadata_invalid"
_TIMESTAMP_INVALID = "timestamp_invalid"
_PROTECTION_UNKNOWN_CARD = "protection_unknown_card"
_PROTECTION_KEEP_EXCEEDS_OWNED = "protection_keep_exceeds_owned"
_EXCLUDED_APP_UNKNOWN = "excluded_app_unknown"
_DUPLICATE_PROTECTION_ERROR = "protections must reference each holding once"
_EXCLUDED_APP_ERROR = "excluded_app_ids entries must be positive app IDs"
_DUPLICATE_EXCLUSION_ERROR = "excluded_app_ids entries must be unique"
_TARGET_REQUIRED_ERROR = "target_level is required for mode 'target'"
_TARGET_BUDGET_ERROR = "target_level must be null for mode 'budget'"
_PRICE_AVAILABILITY_REASONS = frozenset(
    {
        "price_generation_unavailable",
        "price_generation_refreshing",
        "price_generation_stale",
        "currency_contract_missing",
        "steamapi_key_missing",
        "quote_depth_unavailable",
    }
)


# ---------------------------------------------------------------------------
# Request options


class BadgeProtectionOptions(BaseModel):
    """One protected holding: copies kept out of crafting, selling and gemming."""

    model_config = ConfigDict(extra="forbid")

    market_hash_name: StrictStr = Field(min_length=1, max_length=MAX_HASH_LENGTH)
    keep_quantity: StrictInt = Field(ge=0, le=MAX_HOLDING_QUANTITY)
    never_sell: StrictBool


class BadgePlanningOptions(BaseModel):
    """Strict planner options validated at the domain boundary.

    ``budget_minor`` is the real available Steam Wallet spending ceiling in
    minor units for both modes; projected sale receipts are never part of it.
    ``target_level`` is required for ``mode="target"`` and must stay ``None``
    for ``mode="budget"``.
    """

    model_config = ConfigDict(extra="forbid")

    mode: Literal["target", "budget"]
    target_level: StrictInt | None = Field(default=None, ge=0, le=MAX_PLAYER_LEVEL)
    budget_minor: StrictInt = Field(ge=0, le=MAX_BUDGET_MINOR)
    excluded_app_ids: list[Annotated[StrictStr, Field(max_length=20)]] = Field(
        default_factory=list, max_length=10_000
    )
    protections: list[BadgeProtectionOptions] = Field(
        default_factory=list, max_length=10_000
    )

    @field_validator("protections")
    @classmethod
    def validate_unique_protections(
        cls, value: list[BadgeProtectionOptions]
    ) -> list[BadgeProtectionOptions]:
        seen: set[str] = set()
        for protection in value:
            if protection.market_hash_name in seen:
                raise ValueError(_DUPLICATE_PROTECTION_ERROR)
            seen.add(protection.market_hash_name)
        return value

    @field_validator("excluded_app_ids")
    @classmethod
    def validate_excluded_app_ids(cls, value: list[str]) -> list[str]:
        seen: set[int] = set()
        for item in value:
            if _APP_ID_TEXT_RE.fullmatch(item) is None:
                raise ValueError(_EXCLUDED_APP_ERROR)
            app_id = int(item)
            if app_id > MAX_APP_ID:
                raise ValueError(_EXCLUDED_APP_ERROR)
            if app_id in seen:
                raise ValueError(_DUPLICATE_EXCLUSION_ERROR)
            seen.add(app_id)
        return value

    @model_validator(mode="after")
    def validate_mode(self) -> BadgePlanningOptions:
        if self.mode == "target":
            if self.target_level is None:
                raise ValueError(_TARGET_REQUIRED_ERROR)
        elif self.target_level is not None:
            raise ValueError(_TARGET_BUDGET_ERROR)
        return self


# ---------------------------------------------------------------------------
# Response schemas


class BadgeCard(BaseModel):
    """One normal card row with ownership, protection and top-ask pricing."""

    model_config = ConfigDict(extra="forbid")

    market_hash_name: StrictStr
    card_name: StrictStr
    owned_quantity: StrictInt = Field(ge=0)
    keep_quantity: StrictInt = Field(ge=0)
    never_sell: StrictBool
    available_quantity: StrictInt = Field(ge=0)
    buy_price_minor: StrictInt | None = Field(default=None, ge=1)
    buy_quantity: StrictInt | None = Field(default=None, ge=1)
    quote_timestamp: StrictStr | None = None


class BadgeGame(BaseModel):
    """Dashboard row for one game's normal badge."""

    model_config = ConfigDict(extra="forbid")

    app_id: StrictStr
    game_name: StrictStr
    badge_level: StrictInt = Field(ge=0, le=5)
    set_size: StrictInt | None = Field(default=None, ge=5, le=15)
    owned_unique: StrictInt = Field(ge=0)
    owned_cards: StrictInt = Field(ge=0)
    available_unique: StrictInt = Field(ge=0)
    craftable_count: StrictInt = Field(ge=0, le=5)
    missing_count: StrictInt | None = Field(default=None, ge=0)
    completion_cost_minor: StrictInt | None = Field(default=None, ge=0)
    status: GameStatus
    reason: StrictStr
    cards: list[BadgeCard]


class BadgePurchase(BaseModel):
    """One card's aggregated purchases inside a plan step."""

    model_config = ConfigDict(extra="forbid")

    market_hash_name: StrictStr
    card_name: StrictStr
    quantity: StrictInt = Field(ge=1)
    unit_price_minor: StrictInt = Field(ge=1)
    total_minor: StrictInt = Field(ge=1)
    quote_timestamp: StrictStr


class BadgeStep(BaseModel):
    """Repeated crafts for one game grouped into a single step."""

    model_config = ConfigDict(extra="forbid")

    app_id: StrictStr
    game_name: StrictStr
    badge_level_before: StrictInt = Field(ge=0, le=5)
    badge_level_after: StrictInt = Field(ge=0, le=5)
    craft_count: StrictInt = Field(ge=1)
    xp_gain: StrictInt = Field(ge=1)
    spend_minor: StrictInt = Field(ge=0)
    owned_cards_used: StrictInt = Field(ge=0)
    purchases: list[BadgePurchase]


class BadgePlan(BaseModel):
    """One deterministic policy outcome under the shared constraint envelope."""

    model_config = ConfigDict(extra="forbid")

    strategy: PlanStrategy
    status: PlanStatus
    reason: StrictStr
    target_level: StrictInt | None = None
    target_reached: StrictBool
    craft_count: StrictInt = Field(ge=0)
    xp_gain: StrictInt = Field(ge=0)
    projected_xp: StrictInt = Field(ge=0)
    projected_level: StrictInt = Field(ge=0)
    shortfall_xp: StrictInt = Field(ge=0)
    spend_minor: StrictInt = Field(ge=0)
    remaining_budget_minor: StrictInt = Field(ge=0)
    purchase_count: StrictInt = Field(ge=0)
    owned_cards_used: StrictInt = Field(ge=0)
    steps: list[BadgeStep]


class BadgePlanningResponse(BaseModel):
    """Full badge dashboard plus the three comparable plans."""

    model_config = ConfigDict(extra="forbid")

    status: PlanningStatus
    reason: StrictStr
    generated_at: StrictStr
    valid_until: StrictStr | None = None
    currency_code: StrictStr | None = None
    minor_digits: StrictInt | None = Field(default=None, ge=0)
    inventory_refreshed_at: StrictStr
    badge_refreshed_at: StrictStr
    player_xp: StrictInt = Field(ge=0)
    player_level: StrictInt = Field(ge=0)
    scope: Literal["inventory_normal_badges"]
    games: list[BadgeGame]
    plans: list[BadgePlan]


# ---------------------------------------------------------------------------
# Internal planning model


@dataclass(frozen=True, slots=True)
class _PricingContext:
    """Request-wide pricing clock and quote window."""

    now: datetime
    quote_window: timedelta
    contract: MarketFeeContract | None


@dataclass(frozen=True, slots=True)
class _CardStock:
    """Display and planning state for one normal card of one game."""

    market_hash_name: str
    card_name: str
    owned_quantity: int
    keep_quantity: int
    never_sell: bool
    available_quantity: int
    buy_price_minor: int | None
    buy_quantity: int | None
    quote_timestamp: datetime | None
    quote_state: _QuoteState | None = None


@dataclass(frozen=True, slots=True)
class _GameStock:
    """Dashboard and planning state for one game's normal badge."""

    app_id: int
    game_name: str
    badge_level: int
    set_size: int | None
    composition: Composition
    unknown_reason: str
    excluded: bool
    cards: tuple[_CardStock, ...]

    @property
    def owned_unique(self) -> int:
        return sum(1 for card in self.cards if card.owned_quantity > 0)

    @property
    def owned_cards(self) -> int:
        return sum(card.owned_quantity for card in self.cards)

    @property
    def available_unique(self) -> int:
        return sum(1 for card in self.cards if card.available_quantity > 0)


@dataclass(frozen=True, slots=True)
class _Marginal:
    """Cost profile of the next craft of one game.

    ``spend_minor`` is the exact buyer-total cost in minor units;
    ``purchase_copies`` counts purchased card copies and ``owned_cards_used``
    counts owned copies consumed by that single craft.
    """

    spend_minor: int
    purchase_copies: int
    owned_cards_used: int


@dataclass(frozen=True, slots=True)
class _GameMarginals:
    """Per-game sequence of marginal crafts, cheapest-first is implied by j."""

    app_id: int
    marginals: tuple[_Marginal, ...]


@dataclass(frozen=True, slots=True)
class _StrategyRun:
    """Result of one policy pass over the marginal-craft heap."""

    executed: Mapping[int, int]
    spend_minor: int
    budget_blocked: bool


# ---------------------------------------------------------------------------
# Input normalization helpers


def _as_utc(value: object, label: str) -> datetime:
    """Coerce an aware datetime to UTC; naive or non-datetime input raises."""
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise OptimizerInputError(
                _TIMESTAMP_INVALID, f"{label} must include UTC offset"
            )
        return value.astimezone(UTC)
    raise OptimizerInputError(_TIMESTAMP_INVALID, f"{label} is invalid")


def _iso_utc(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _validate_optional_contract(
    fee_contract: MarketFeeContract | None,
) -> MarketFeeContract | None:
    if fee_contract is None:
        return None
    if not isinstance(fee_contract, MarketFeeContract):
        raise OptimizerInputError(
            "fee_contract_invalid", "fee contract must be a MarketFeeContract"
        )
    return fee_contract


def _validate_optional_catalog(
    catalog: ResolvedCatalog | None,
) -> ResolvedCatalog | None:
    if catalog is None:
        return None
    if not isinstance(catalog, ResolvedCatalog):
        raise OptimizerInputError("catalog_invalid", "catalog must be resolved")
    return catalog


def _normalize_holdings(value: Sequence[Holding]) -> dict[str, Holding]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise OptimizerInputError(_INVENTORY_INVALID, "holdings must be a sequence")
    holdings: dict[str, Holding] = {}
    for holding in value:
        if not isinstance(holding, Holding):
            raise OptimizerInputError(
                _INVENTORY_INVALID, "holdings must be Holding rows"
            )
        if holding.market_hash_name in holdings:
            raise OptimizerInputError(
                _INVENTORY_INVALID, "duplicate holding market hash"
            )
        holdings[holding.market_hash_name] = holding
    return holdings


def _normalize_game_metadata(
    value: Mapping[int, tuple[str, int | None]],
) -> dict[int, tuple[str | None, int | None]]:
    """Validate metadata structure strictly; tolerate value-level staleness.

    A malformed mapping, key, or entry shape is a programming error and
    raises.  A stale display name or an out-of-range set size is a data
    quality issue and degrades to ``None`` so the row stays visible without
    inventing composition knowledge.
    """
    if not isinstance(value, Mapping):
        raise OptimizerInputError(_METADATA_INVALID, "game metadata must be a mapping")
    metadata: dict[int, tuple[str | None, int | None]] = {}
    for app_id, entry in value.items():
        if isinstance(app_id, bool) or not isinstance(app_id, int):
            raise OptimizerInputError(
                _METADATA_INVALID, "game metadata AppID must be an integer"
            )
        if not 1 <= app_id <= MAX_APP_ID:
            raise OptimizerInputError(
                _METADATA_INVALID, "game metadata AppID is out of bounds"
            )
        if isinstance(entry, (str, bytes)) or not isinstance(entry, Sequence):
            raise OptimizerInputError(
                _METADATA_INVALID, "game metadata entry must be a pair"
            )
        if len(entry) != 2:
            raise OptimizerInputError(
                _METADATA_INVALID, "game metadata entry must be a pair"
            )
        name, set_size = entry
        normalized_name = name if isinstance(name, str) and name else None
        normalized_size: int | None = None
        if (
            isinstance(set_size, int)
            and not isinstance(set_size, bool)
            and MIN_NORMAL_SET_SIZE <= set_size <= MAX_NORMAL_SET_SIZE
        ):
            normalized_size = set_size
        metadata[app_id] = (normalized_name, normalized_size)
    return metadata


def _normalize_protections(
    protections: Sequence[BadgeProtectionOptions],
    holdings_by_hash: Mapping[str, Holding],
) -> dict[str, tuple[int, bool]]:
    normalized: dict[str, tuple[int, bool]] = {}
    for protection in protections:
        market_hash_name = protection.market_hash_name
        holding = holdings_by_hash.get(market_hash_name)
        if holding is None:
            raise OptimizerInputError(
                _PROTECTION_UNKNOWN_CARD,
                "protection references a card outside the inventory",
            )
        if protection.keep_quantity > holding.owned_quantity:
            raise OptimizerInputError(
                _PROTECTION_KEEP_EXCEEDS_OWNED,
                "keep_quantity exceeds the owned quantity",
            )
        normalized[market_hash_name] = (
            protection.keep_quantity,
            protection.never_sell,
        )
    return normalized


def _validated_excluded_app_ids(
    excluded_app_ids: Sequence[str],
    known_app_ids: Mapping[int, object],
) -> frozenset[int]:
    excluded: set[int] = set()
    for text in excluded_app_ids:
        if _APP_ID_TEXT_RE.fullmatch(text) is None:
            raise OptimizerInputError(
                _EXCLUDED_APP_UNKNOWN, "excluded app ID is invalid"
            )
        app_id = int(text)
        if app_id not in known_app_ids:
            raise OptimizerInputError(
                _EXCLUDED_APP_UNKNOWN, "excluded app ID is not a known game"
            )
        excluded.add(app_id)
    return frozenset(excluded)


# ---------------------------------------------------------------------------
# Quote validation


def _validated_ask(
    card: CatalogCard, context: _PricingContext
) -> tuple[tuple[int, int, datetime] | None, _QuoteState]:
    """Return the validated top-ask quote plus why it is unusable otherwise.

    The ask is the exact buyer total, so no fee conversion is applied again.
    Stale, future, missing, or nonpositive quotes are rejected; they are
    never coerced into a zero price.  ``stale`` marks ask data whose quote
    timestamp left the freshness window or sits in the future; ``missing``
    marks absent or invalid ask data.  Only ``valid`` yields a quote.
    """
    contract = context.contract
    if contract is None:
        return None, "missing"
    price_text = card.lowest_sell
    quantity = card.lowest_sell_quantity
    timestamp_value = card.lowest_sell_observed_at or card.observed_at
    if price_text is None or quantity is None or timestamp_value is None:
        return None, "missing"
    if isinstance(quantity, bool) or not isinstance(quantity, int):
        return None, "missing"
    if quantity < 1 or quantity > MAX_QUOTE_QUANTITY:
        return None, "missing"
    if not isinstance(timestamp_value, datetime):
        return None, "missing"
    if timestamp_value.tzinfo is None or timestamp_value.utcoffset() is None:
        return None, "missing"
    timestamp = timestamp_value.astimezone(UTC)
    if timestamp > context.now or context.now - timestamp > context.quote_window:
        return None, "stale"
    price_minor = _decimal_to_minor(price_text, contract.minor_digits)
    if isinstance(price_minor, bool) or not isinstance(price_minor, int):
        return None, "missing"
    if price_minor <= 0 or price_minor > _MAX_PRICE_MINOR:
        return None, "missing"
    return (price_minor, quantity, timestamp), "valid"


# ---------------------------------------------------------------------------
# Game assembly


def _build_card_stocks(
    context: _PricingContext,
    catalog_set: CatalogSet | None,
    holdings_by_hash: Mapping[str, Holding],
    game_hashes: Sequence[str],
    protections: Mapping[str, tuple[int, bool]],
) -> tuple[_CardStock, ...]:
    cards_by_hash: dict[str, CatalogCard] = {}
    if catalog_set is not None:
        for card in catalog_set.cards:
            cards_by_hash[card.market_hash_name] = card
    stocks: list[_CardStock] = []
    for market_hash_name in sorted(set(cards_by_hash) | set(game_hashes)):
        catalog_card = cards_by_hash.get(market_hash_name)
        holding = holdings_by_hash.get(market_hash_name)
        if catalog_card is not None:
            card_name = catalog_card.card_name
        else:
            parsed = parse_normal_card_hash(market_hash_name)
            card_name = parsed[1] if parsed is not None else market_hash_name
        owned_quantity = holding.owned_quantity if holding is not None else 0
        keep_quantity, never_sell = protections.get(market_hash_name, (0, False))
        keep_quantity = min(keep_quantity, owned_quantity)
        quote, quote_state = (
            _validated_ask(catalog_card, context)
            if catalog_card is not None
            else (None, None)
        )
        stocks.append(
            _CardStock(
                market_hash_name=market_hash_name,
                card_name=card_name,
                owned_quantity=owned_quantity,
                keep_quantity=keep_quantity,
                never_sell=never_sell,
                available_quantity=max(0, owned_quantity - keep_quantity),
                buy_price_minor=quote[0] if quote is not None else None,
                buy_quantity=quote[1] if quote is not None else None,
                quote_timestamp=quote[2] if quote is not None else None,
                quote_state=quote_state,
            )
        )
    return tuple(stocks)


def _build_games(
    context: _PricingContext,
    catalog: ResolvedCatalog | None,
    holdings_by_hash: Mapping[str, Holding],
    metadata: Mapping[int, tuple[str | None, int | None]],
    excluded_app_ids: frozenset[int],
    protections: Mapping[str, tuple[int, bool]],
    badges: BadgeState,
) -> list[_GameStock]:
    sets_by_app: dict[int, CatalogSet] = {}
    if catalog is not None:
        for catalog_set in catalog.sets:
            sets_by_app[catalog_set.app_id] = catalog_set
    hashes_by_app: dict[int, list[str]] = {}
    for market_hash_name in holdings_by_hash:
        parsed = parse_normal_card_hash(market_hash_name)
        if parsed is None:
            # Holding construction already guarantees parseable hashes.
            continue
        hashes_by_app.setdefault(parsed[0], []).append(market_hash_name)
    known_app_ids = sorted(set(metadata) | set(hashes_by_app))
    games: list[_GameStock] = []
    for app_id in known_app_ids:
        metadata_name, metadata_size = metadata.get(app_id, (None, None))
        catalog_set = sets_by_app.get(app_id)
        game_hashes = hashes_by_app.get(app_id, [])
        game_name = metadata_name or (
            catalog_set.game_name if catalog_set is not None else f"App {app_id}"
        )
        if catalog_set is not None:
            set_size: int | None = catalog_set.set_size
            catalog_hashes = {card.market_hash_name for card in catalog_set.cards}
            if set(game_hashes) <= catalog_hashes:
                composition: Composition = "full"
                unknown_reason = ""
            else:
                composition = "unknown"
                unknown_reason = "set_composition_inconsistent"
        elif metadata_size is not None:
            set_size = metadata_size
            if len(game_hashes) == set_size:
                composition = "full"
                unknown_reason = ""
            elif len(game_hashes) > set_size:
                composition = "unknown"
                unknown_reason = "set_composition_inconsistent"
            else:
                composition = "size_only"
                unknown_reason = ""
        else:
            set_size = None
            composition = "unknown"
            unknown_reason = "set_composition_unknown"
        games.append(
            _GameStock(
                app_id=app_id,
                game_name=game_name,
                badge_level=badges.level_for_game(app_id),
                set_size=set_size,
                composition=composition,
                unknown_reason=unknown_reason,
                excluded=app_id in excluded_app_ids,
                cards=_build_card_stocks(
                    context, catalog_set, holdings_by_hash, game_hashes, protections
                ),
            )
        )
    return games


def _craftable_count(stock: _GameStock) -> int:
    """Factual crafts possible right now from post-protection availability."""
    if stock.composition != "full" or stock.badge_level >= _MAX_CRAFTS_PER_BADGE:
        return 0
    minimum_available = min(card.available_quantity for card in stock.cards)
    return min(_MAX_CRAFTS_PER_BADGE - stock.badge_level, minimum_available)


def _missing_count(stock: _GameStock) -> int | None:
    """Distinct cards still needed for the next craft after reserves."""
    if stock.badge_level >= _MAX_CRAFTS_PER_BADGE:
        return None
    if stock.composition == "full":
        return sum(1 for card in stock.cards if card.available_quantity == 0)
    if stock.composition == "size_only" and stock.set_size is not None:
        return max(0, stock.set_size - stock.available_unique)
    return None


def _completion_cost_minor(stock: _GameStock) -> int | None:
    """Exact cost of buying the next craft's missing cards, or ``None``.

    Requires known composition and a fresh valid quote for every missing
    card; an absent quote is never treated as zero.
    """
    if stock.composition != "full" or stock.badge_level >= _MAX_CRAFTS_PER_BADGE:
        return None
    total = 0
    for card in stock.cards:
        if card.available_quantity > 0:
            continue
        if card.buy_price_minor is None:
            return None
        total += card.buy_price_minor
    return total


def _game_status(stock: _GameStock) -> tuple[GameStatus, str]:
    if stock.badge_level >= _MAX_CRAFTS_PER_BADGE:
        return ("maxed", "badge_level_maxed")
    if stock.excluded:
        return ("excluded", "excluded_by_options")
    if stock.composition == "unknown":
        return ("unavailable", stock.unknown_reason)
    craftable = _craftable_count(stock)
    if stock.composition == "size_only":
        return ("incomplete", "set_incomplete")
    if craftable == 0:
        unprotected = min(card.owned_quantity for card in stock.cards)
        if unprotected >= 1:
            return ("reserved", "next_craft_blocked_by_protections")
        return ("incomplete", "set_incomplete")
    return ("craftable", "owned_set_ready")


def _game_row(stock: _GameStock) -> BadgeGame:
    status, reason = _game_status(stock)
    return BadgeGame(
        app_id=str(stock.app_id),
        game_name=stock.game_name,
        badge_level=stock.badge_level,
        set_size=stock.set_size,
        owned_unique=stock.owned_unique,
        owned_cards=stock.owned_cards,
        available_unique=stock.available_unique,
        craftable_count=_craftable_count(stock),
        missing_count=_missing_count(stock),
        completion_cost_minor=_completion_cost_minor(stock),
        status=status,
        reason=reason,
        cards=[
            BadgeCard(
                market_hash_name=card.market_hash_name,
                card_name=card.card_name,
                owned_quantity=card.owned_quantity,
                keep_quantity=card.keep_quantity,
                never_sell=card.never_sell,
                available_quantity=card.available_quantity,
                buy_price_minor=card.buy_price_minor,
                buy_quantity=card.buy_quantity,
                quote_timestamp=(
                    _iso_utc(card.quote_timestamp)
                    if card.quote_timestamp is not None
                    else None
                ),
            )
            for card in stock.cards
        ],
    )


# ---------------------------------------------------------------------------
# Marginal craft planning


def _game_marginals(stock: _GameStock) -> _GameMarginals | None:
    """Build the exact nondecreasing marginal-craft sequence for one game.

    Craft ``j`` consumes the ``j``-th copy of every card in the set: an
    available (post-protection) owned copy when one exists, otherwise a
    purchase from the cumulative top-ask depth.  Per-game marginal costs are
    therefore nondecreasing in ``j``, which makes the shared prefix heap
    exact for the ``cheapest`` policy.
    """
    if stock.excluded or stock.composition != "full":
        return None
    if stock.badge_level >= _MAX_CRAFTS_PER_BADGE or not stock.cards:
        return None
    caps: list[int] = []
    for card in stock.cards:
        depth = card.buy_quantity or 0
        caps.append(card.available_quantity + depth)
    total = min(_MAX_CRAFTS_PER_BADGE - stock.badge_level, *caps)
    if total <= 0:
        return None
    marginals: list[_Marginal] = []
    for craft_index in range(1, total + 1):
        spend = 0
        purchase_copies = 0
        owned_cards_used = 0
        for card in stock.cards:
            if craft_index <= card.available_quantity:
                owned_cards_used += 1
                continue
            price = card.buy_price_minor
            if price is None:
                # Unreachable: the per-card cap guarantees ask capacity here.
                return None
            purchase_copies += 1
            spend += price
        marginals.append(
            _Marginal(
                spend_minor=spend,
                purchase_copies=purchase_copies,
                owned_cards_used=owned_cards_used,
            )
        )
    return _GameMarginals(app_id=stock.app_id, marginals=tuple(marginals))


def _marginal_priority(strategy: PlanStrategy, marginal: _Marginal) -> tuple[int, ...]:
    if strategy == "cheapest":
        return (marginal.spend_minor,)
    if strategy == "fewest_purchases":
        return (marginal.purchase_copies, marginal.spend_minor)
    return (marginal.owned_cards_used, marginal.spend_minor)


def _run_strategy(
    strategy: PlanStrategy,
    marginals_by_app: Mapping[int, _GameMarginals],
    *,
    crafts_needed: int | None,
    budget_minor: int,
) -> _StrategyRun:
    """Execute one policy over the prerequisite heap of marginal crafts.

    Game ``g``'s craft ``j+1`` is pushed only after craft ``j`` executes, so
    a craft discarded for budget permanently closes that game's sequence;
    remaining budget can never grow, which keeps the pass deterministic and
    constraint-compliant for every policy.
    """
    heap: list[tuple[tuple[int, ...], int, int]] = []
    for app_id, game_marginals in marginals_by_app.items():
        if game_marginals.marginals:
            initial = game_marginals.marginals[0]
            heap.append((_marginal_priority(strategy, initial), app_id, 0))
    heapq.heapify(heap)
    executed: dict[int, int] = {}
    spend = 0
    budget_blocked = False
    total_executed = 0
    while heap and (crafts_needed is None or total_executed < crafts_needed):
        _, app_id, index = heapq.heappop(heap)
        game_marginals = marginals_by_app[app_id]
        marginal = game_marginals.marginals[index]
        if spend + marginal.spend_minor > budget_minor:
            budget_blocked = True
            continue
        executed[app_id] = index + 1
        spend += marginal.spend_minor
        total_executed += 1
        next_index = index + 1
        if next_index < len(game_marginals.marginals):
            next_marginal = game_marginals.marginals[next_index]
            heapq.heappush(
                heap,
                (_marginal_priority(strategy, next_marginal), app_id, next_index),
            )
    return _StrategyRun(
        executed=executed,
        spend_minor=spend,
        budget_blocked=budget_blocked,
    )


def _plan_steps(
    run: _StrategyRun,
    stocks_by_app: Mapping[int, _GameStock],
) -> tuple[BadgeStep, ...]:
    steps: list[BadgeStep] = []
    for app_id in sorted(run.executed):
        stock = stocks_by_app[app_id]
        craft_count = run.executed[app_id]
        purchases: list[BadgePurchase] = []
        spend = 0
        owned_cards_used = 0
        for card in stock.cards:
            purchased = max(0, craft_count - card.available_quantity)
            owned_cards_used += min(card.available_quantity, craft_count)
            if purchased == 0:
                continue
            price = card.buy_price_minor
            if price is None or card.quote_timestamp is None:
                # Unreachable: marginals guarantee priced depth for purchases.
                continue
            total = purchased * price
            spend += total
            purchases.append(
                BadgePurchase(
                    market_hash_name=card.market_hash_name,
                    card_name=card.card_name,
                    quantity=purchased,
                    unit_price_minor=price,
                    total_minor=total,
                    quote_timestamp=_iso_utc(card.quote_timestamp),
                )
            )
        steps.append(
            BadgeStep(
                app_id=str(stock.app_id),
                game_name=stock.game_name,
                badge_level_before=stock.badge_level,
                badge_level_after=stock.badge_level + craft_count,
                craft_count=craft_count,
                xp_gain=NORMAL_BADGE_XP * craft_count,
                spend_minor=spend,
                owned_cards_used=owned_cards_used,
                purchases=purchases,
            )
        )
    return tuple(steps)


def _build_plan(
    strategy: PlanStrategy,
    run: _StrategyRun,
    stocks_by_app: Mapping[int, _GameStock],
    *,
    badges: BadgeState,
    target_level: int | None,
    budget_minor: int,
) -> BadgePlan:
    steps = _plan_steps(run, stocks_by_app)
    craft_count = sum(step.craft_count for step in steps)
    xp_gain = NORMAL_BADGE_XP * craft_count
    projection = project_xp(badges.player_xp, xp_gain)
    spend = run.spend_minor
    purchase_count = sum(
        purchase.quantity for step in steps for purchase in step.purchases
    )
    if target_level is None:
        # Budget mode maximizes craft XP under the wallet ceiling; there is
        # no target threshold, so shortfall stays zero and the plan is ready
        # whenever at least one craft fits.
        target_reached = False
        shortfall = 0
        if craft_count == 0:
            status: PlanStatus = "no_opportunity"
            reason = "no_crafts_available"
        else:
            status = "ready"
            reason = "xp_maximized"
    else:
        threshold = minimum_xp(target_level)
        needed = -(-(threshold - badges.player_xp) // NORMAL_BADGE_XP)
        target_reached = projection.xp >= threshold
        shortfall = max(0, threshold - projection.xp)
        if needed <= 0:
            status = "no_opportunity"
            reason = "target_already_met"
        elif craft_count >= needed:
            status = "ready"
            reason = "target_reached"
        elif craft_count > 0:
            status = "partial"
            reason = (
                "budget_insufficient"
                if run.budget_blocked
                else "craft_depth_insufficient"
            )
        else:
            status = "no_opportunity"
            reason = (
                "budget_insufficient" if run.budget_blocked else "no_crafts_available"
            )
    return BadgePlan(
        strategy=strategy,
        status=status,
        reason=reason,
        target_level=target_level,
        target_reached=target_reached,
        craft_count=craft_count,
        xp_gain=xp_gain,
        projected_xp=projection.xp,
        projected_level=projection.level,
        shortfall_xp=shortfall,
        spend_minor=spend,
        remaining_budget_minor=budget_minor - spend,
        purchase_count=purchase_count,
        owned_cards_used=sum(step.owned_cards_used for step in steps),
        steps=list(steps),
    )


def _build_plans(
    games: Sequence[_GameStock],
    *,
    badges: BadgeState,
    options: BadgePlanningOptions,
) -> list[BadgePlan]:
    marginals_by_app: dict[int, _GameMarginals] = {}
    stocks_by_app: dict[int, _GameStock] = {}
    for stock in games:
        game_marginals = _game_marginals(stock)
        if game_marginals is not None and game_marginals.marginals:
            marginals_by_app[stock.app_id] = game_marginals
            stocks_by_app[stock.app_id] = stock
    target_level = options.target_level if options.mode == "target" else None
    crafts_needed: int | None = None
    if target_level is not None:
        threshold = minimum_xp(target_level)
        crafts_needed = max(0, -(-(threshold - badges.player_xp) // NORMAL_BADGE_XP))
    plans: list[BadgePlan] = []
    strategies: tuple[PlanStrategy, ...] = (
        "cheapest",
        "fewest_purchases",
        "preserve_cards",
    )
    for strategy in strategies:
        run = _run_strategy(
            strategy,
            marginals_by_app,
            crafts_needed=crafts_needed,
            budget_minor=options.budget_minor,
        )
        plans.append(
            _build_plan(
                strategy,
                run,
                stocks_by_app,
                badges=badges,
                target_level=target_level,
                budget_minor=options.budget_minor,
            )
        )
    return plans


# ---------------------------------------------------------------------------
# Entry point


def _unavailable_reason(
    *,
    current: datetime,
    inventory_time: datetime,
    badge_time: datetime,
    inventory_window: timedelta,
) -> str | None:
    if current < inventory_time:
        return "inventory_snapshot_in_future"
    if current - inventory_time > inventory_window:
        return "inventory_snapshot_stale"
    if current < badge_time:
        return "badge_snapshot_in_future"
    if current - badge_time > inventory_window:
        return "badge_snapshot_stale"
    return None


def _unavailable_response(
    reason: str,
    *,
    current: datetime,
    inventory_time: datetime,
    badge_time: datetime,
    badges: BadgeState,
    contract: MarketFeeContract | None,
    games: list[BadgeGame],
) -> BadgePlanningResponse:
    return BadgePlanningResponse(
        status="unavailable",
        reason=reason,
        generated_at=_iso_utc(current),
        valid_until=None,
        currency_code=contract.currency_code if contract is not None else None,
        minor_digits=contract.minor_digits if contract is not None else None,
        inventory_refreshed_at=_iso_utc(inventory_time),
        badge_refreshed_at=_iso_utc(badge_time),
        player_xp=badges.player_xp,
        player_level=badges.player_level,
        scope=_PLANNING_SCOPE,
        games=games,
        plans=[],
    )


def _purchase_quote_block_reason(
    games: Sequence[_GameStock],
) -> str | None:
    """Diagnose plans whose purchase path could not be evaluated at all.

    Returns an existing availability reason when at least one non-maxed,
    non-excluded, fully composed game needs purchases for its next craft,
    every such game is blocked by unusable quote data, and no owned-only
    craft or budget-blocked route with real costs exists.  A stale quote
    timestamp wins over entirely missing ask data because it names the
    provider-side condition: the feed rows exist but left the freshness
    window, even when the generation timestamp itself looks current.
    """

    saw_purchase_candidate = False
    saw_stale_quote = False
    for stock in games:
        if (
            stock.excluded
            or stock.composition != "full"
            or stock.badge_level >= _MAX_CRAFTS_PER_BADGE
        ):
            continue
        missing_cards = [card for card in stock.cards if card.available_quantity == 0]
        if not missing_cards:
            continue
        states = [card.quote_state for card in missing_cards]
        if all(state == "valid" for state in states):
            # Usable asks exist for the next craft: zero crafts then means the
            # budget genuinely blocked every route, which is factual as-is.
            return None
        saw_purchase_candidate = True
        saw_stale_quote = saw_stale_quote or any(state == "stale" for state in states)
    if not saw_purchase_candidate:
        return None
    return "price_generation_stale" if saw_stale_quote else "quote_depth_unavailable"


def plan_badges(
    *,
    catalog: ResolvedCatalog | None,
    holdings: Sequence[Holding],
    game_metadata: Mapping[int, tuple[str, int | None]],
    badges: BadgeState,
    inventory_refreshed_at: datetime,
    badge_refreshed_at: datetime,
    now: datetime,
    fee_contract: MarketFeeContract | None,
    options: BadgePlanningOptions,
    availability_reason: str | None = None,
) -> BadgePlanningResponse:
    """Build the badge dashboard and the three comparable policy plans.

    Raises :class:`OptimizerInputError` only for malformed requests.  Stale
    or future snapshots and explicit provider unavailability return a
    ``status="unavailable"`` response whose dashboard rows stay visible but
    whose plans are empty, so stale data never creates actionable plans.
    """
    contract = _validate_optional_contract(fee_contract)
    resolved_catalog = _validate_optional_catalog(catalog)
    if not isinstance(options, BadgePlanningOptions):
        raise OptimizerInputError(_OPTIONS_INVALID, "options must be validated")
    if not isinstance(badges, BadgeState):
        raise OptimizerInputError(
            "badge_data_unavailable", "badges must be a validated BadgeState"
        )
    holdings_by_hash = _normalize_holdings(holdings)
    metadata = _normalize_game_metadata(game_metadata)
    current = _as_utc(now, "now")
    inventory_time = _as_utc(inventory_refreshed_at, "inventory_refreshed_at")
    badge_time = _as_utc(badge_refreshed_at, "badge_refreshed_at")

    inventory_window = timedelta(
        seconds=(
            contract.max_inventory_age_seconds
            if contract is not None
            else DEFAULT_MAX_INVENTORY_AGE_SECONDS
        )
    )
    quote_window = timedelta(
        seconds=(
            contract.max_quote_age_seconds
            if contract is not None
            else DEFAULT_MAX_QUOTE_AGE_SECONDS
        )
    )
    pricing_issue = availability_reason in _PRICE_AVAILABILITY_REASONS
    catalog_is_fresh = resolved_catalog is not None and (
        timedelta(0) <= current - resolved_catalog.generated_at < quote_window
    )
    context = _PricingContext(
        now=current,
        quote_window=quote_window,
        contract=contract if catalog_is_fresh and not pricing_issue else None,
    )

    known_app_ids: dict[int, None] = {}
    for holding in holdings_by_hash.values():
        parsed = parse_normal_card_hash(holding.market_hash_name)
        if parsed is not None:
            known_app_ids.setdefault(parsed[0], None)
    for app_id in metadata:
        known_app_ids.setdefault(app_id, None)
    excluded_app_ids = _validated_excluded_app_ids(
        options.excluded_app_ids, known_app_ids
    )
    protections = _normalize_protections(options.protections, holdings_by_hash)

    games = _build_games(
        context,
        resolved_catalog,
        holdings_by_hash,
        metadata,
        excluded_app_ids,
        protections,
        badges,
    )
    game_rows = [_game_row(stock) for stock in games]

    unavailable_reason = _unavailable_reason(
        current=current,
        inventory_time=inventory_time,
        badge_time=badge_time,
        inventory_window=inventory_window,
    )
    if unavailable_reason is None and not pricing_issue:
        unavailable_reason = availability_reason
    if unavailable_reason is not None:
        return _unavailable_response(
            unavailable_reason,
            current=current,
            inventory_time=inventory_time,
            badge_time=badge_time,
            badges=badges,
            contract=contract,
            games=game_rows,
        )

    plans = _build_plans(games, badges=badges, options=options)
    if all(plan.craft_count == 0 for plan in plans):
        target_needed = (
            None
            if options.mode == "budget" or options.target_level is None
            else max(
                0,
                -(
                    -(minimum_xp(options.target_level) - badges.player_xp)
                    // NORMAL_BADGE_XP
                ),
            )
        )
        if target_needed != 0:
            quote_block = _purchase_quote_block_reason(games)
            if quote_block is not None:
                if contract is None:
                    quote_block = "currency_contract_missing"
                elif resolved_catalog is not None and not catalog_is_fresh:
                    quote_block = "price_generation_stale"
                # A purchase-only plan could not be evaluated: name the quote
                # condition instead of a misleading no_opportunity.  A known
                # pricing reason (stale generation, missing contract) stays
                # the more precise cause.
                return _unavailable_response(
                    availability_reason
                    if pricing_issue and availability_reason is not None
                    else quote_block,
                    current=current,
                    inventory_time=inventory_time,
                    badge_time=badge_time,
                    badges=badges,
                    contract=contract,
                    games=game_rows,
                )
    quote_times = [
        card.quote_timestamp
        for stock in games
        for card in stock.cards
        if card.quote_timestamp is not None
    ]
    valid_until = min(
        inventory_time + inventory_window,
        badge_time + inventory_window,
        *(timestamp + quote_window for timestamp in quote_times),
    )
    if quote_times and resolved_catalog is not None:
        valid_until = min(valid_until, resolved_catalog.generated_at + quote_window)
    return BadgePlanningResponse(
        status="ready",
        reason=availability_reason
        or ("currency_contract_missing" if contract is None else "ready"),
        generated_at=_iso_utc(current),
        valid_until=_iso_utc(valid_until),
        currency_code=contract.currency_code if contract is not None else None,
        minor_digits=contract.minor_digits if contract is not None else None,
        inventory_refreshed_at=_iso_utc(inventory_time),
        badge_refreshed_at=_iso_utc(badge_time),
        player_xp=badges.player_xp,
        player_level=badges.player_level,
        scope=_PLANNING_SCOPE,
        games=game_rows,
        plans=plans,
    )
