from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from collections.abc import (
    AsyncIterator,
    Callable,
    Collection,
    Iterable,
    Iterator,
    Mapping,
    Sequence,
)
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol
from urllib.parse import quote, unquote, urljoin, urlsplit

import httpx2
import ijson
from ijson.common import IncompleteJSONError, JSONError
from pydantic import BaseModel, Field, StrictInt, field_validator, model_validator

from app.booster_pricing import (
    BoosterMetadataState,
    BoosterPricingService,
    BoosterResolution,
    BoosterScanResult,
    derive_booster_gem_cost,
)
from app.gem_pricing import (
    SACK_OF_GEMS_MARKET_HASH_NAME,
    GemKey,
    GemPricingService,
    GemScanResult,
    ItemType,
    SteamCommunityLimiter,
    canonical_decimal,
    gem_cash_value,
    parse_item_metadata,
)
from app.json_parsing import reject_duplicate_object_keys
from app.level_up_optimizer import (
    MAX_APP_ID,
    MAX_NORMAL_SET_SIZE,
    MAX_QUOTE_QUANTITY,
    MIN_NORMAL_SET_SIZE,
    BadgeState,
    CatalogCard,
    CatalogSet,
    Holding,
    LevelUpOptimizationResponse,
    OptimizerInputError,
    ResolvedCatalog,
    level_for_xp,
    optimize_level_up,
    parse_normal_card_hash,
)
from app.market_fees import (
    MarketFeeContract,
    decimal_to_minor,
    seller_receipt_from_buyer_total,
)
from app.steamapis_price_cache import (
    CachedPrice,
    NormalCardCatalogRead,
    PriceCacheRead,
    SteamApisPriceCache,
    SteamApisPriceRefresh,
)

if TYPE_CHECKING:
    from app.http_protocols import AsyncHTTPClient, HTTPResponse
    from app.settings import Settings

PROFILE_ENDPOINT = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/"
STEAMAPIS_BASE_URL = "https://api.steamapis.com"
STEAMAPIS_INVENTORY_ENDPOINT = (
    f"{STEAMAPIS_BASE_URL}/v2/steam/users/{{steam_id}}/inventory/753/6"
)
STEAMAPIS_ITEMS_ENDPOINT = f"{STEAMAPIS_BASE_URL}/v2/steam/items/753/list"
STEAM_ICON_BASE_URL = "https://community.cloudflare.steamstatic.com/economy/image/"
STEAM_OPTIMIZER_USER_AGENT = (
    "SteamOptimizer/0.1.1 (+https://github.com/TheRockPusher/Steam_Optimizer)"
)
_CANONICAL_SACK_PRICE_ERROR = "Sack price must be a canonical decimal."
_GEM_CASH_CONTEXT_QUOTE_ERROR = "At least one sack price quote is required."
_CANONICAL_GEM_CASH_VALUE_ERROR = "Gem cash value must be a canonical decimal."
_INVALID_ITEM_GEM_METADATA_ERROR = "Inventory item gem metadata is inconsistent."
_INVALID_BOOSTER_PAIR_ERROR = "Booster card set size and gem cost must be paired."
_INVALID_BOOSTER_COST_ERROR = "Booster gem cost does not match card set size."
_PUBLIC_BADGE_FIELDS_ERROR = "Public badge checks require XP and level."
_PUBLIC_BADGE_CONSISTENCY_ERROR = "Public badge XP and level must agree."
_UNAVAILABLE_BADGE_FIELDS_ERROR = "Unavailable badge checks cannot include XP or level."

CheckStatus = Literal["public", "private", "unavailable"]
BadgeStatus = Literal["public", "unavailable"]
PriceStatus = Literal["complete", "partial", "unavailable"]
GemStatus = Literal["complete", "partial", "unavailable"]
InventoryItemType = ItemType
CardBorder = Literal["normal", "foil"]

_ASCII_DIGITS = re.compile(r"^[0-9]+$")
_PRIVATE_INVENTORY_MESSAGE = (
    "Could not retrieve user inventory. Make sure profile and inventory is public. "
    "(403) (403)"
)
MAX_RETRY_AFTER_SECONDS = 900
BOOSTER_CARD_COUNT = 3

STEAMAPIS_BADGES_ENDPOINT = f"{STEAMAPIS_BASE_URL}/v2/steam/users/{{steam_id}}/badges"
LEVEL_UP_PRICE_MAX_AGE_SECONDS = 15 * 60
MAX_BADGE_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_BADGE_DECODED_SIZE = 16 * 1024 * 1024
MAX_BADGE_PREFLIGHT_CHARGE = 32 * 1024 * 1024
MAX_BADGE_RECORDS = 25_000
MAX_BADGE_JSON_TOKENS = 1_000_000
_BADGE_JSON_CONTAINER_START_EVENTS = frozenset({"start_map", "start_array"})
_BADGE_JSON_CONTAINER_END_EVENTS = frozenset({"end_map", "end_array"})
_BADGE_JSON_SCALAR_EVENTS = frozenset(
    {"null", "boolean", "integer", "double", "number"}
)
_BADGE_JSON_VALUE_EVENTS = (
    _BADGE_JSON_CONTAINER_START_EVENTS | _BADGE_JSON_SCALAR_EVENTS | {"string"}
)
MAX_LEVEL_UP_CATALOG_ROWS = 250_000
MAX_LEVEL_UP_METADATA_APPS = 128

# Inventory pages are normally 2,000 assets.  These bounds leave room for
# unusually large inventories while stopping provider-controlled amplification.
MAX_INVENTORY_PAGES = 32
MAX_INVENTORY_CURSOR_LENGTH = 256
MAX_INVENTORY_ASSETS_PER_PAGE = 10_000
MAX_INVENTORY_DESCRIPTIONS_PER_PAGE = 10_000
MAX_INVENTORY_ASSETS = 100_000
MAX_INVENTORY_DESCRIPTIONS = 100_000
MAX_INVENTORY_TOTAL_QUANTITY = 1_000_000_000_000
MAX_INVENTORY_PAGE_BYTES = 16 * 1024 * 1024
MAX_INVENTORY_BYTES = 128 * 1024 * 1024
MAX_INVENTORY_NESTING = 64
MAX_INVENTORY_TEXT_LENGTH = 8_192
MAX_ICON_URL_LENGTH = 2_048
MAX_INVENTORY_QUANTITY = 1_000_000_000

MAX_PRICE_AMOUNT = Decimal(10000000000)
MAX_PRICE_DECIMAL_DIGITS = 64
MAX_OBSERVED_AT_MILLISECONDS = 253_402_300_799_999
MAX_PRICE_QUANTITY = MAX_QUOTE_QUANTITY
MAX_PRICE_DEPTH_ROWS = 10
MAX_PRICE_DEPTH_TOTAL_QUANTITY = MAX_PRICE_QUANTITY
MAX_PRICE_STREAM_BYTES = 512 * 1024 * 1024
MAX_PRICE_STREAM_NESTING = 64
MAX_PRICE_STREAM_TOKENS = 100_000_000
MAX_PRICE_STREAM_SCALAR_LENGTH = 16_384
MAX_CONCURRENT_BULK_STREAMS = 1

STEAM_ICON_HOSTNAME = "community.cloudflare.steamstatic.com"
STEAMAPIS_BULK_HOST_SUFFIX = ".r2.cloudflarestorage.com"
_BULK_STREAM_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_BULK_STREAMS)
_PRICE_REFRESH_LOCKS: dict[str, asyncio.Lock] = {}
_MAX_OBSERVED_AT_DECIMAL = Decimal(MAX_OBSERVED_AT_MILLISECONDS)
_PRICE_STREAM_JSON_ERRORS = (IncompleteJSONError, JSONError)
_PRICE_STREAM_SEMANTIC_KEYS = {
    "marketHashName": "market_hash_name",
    "market_hash_name": "market_hash_name",
    "highestBuy": "highest_buy",
    "highest_buy": "highest_buy",
    "lowestSell": "lowest_sell",
    "lowest_sell": "lowest_sell",
    "updatedAt": "updated_at",
    "updated_at": "updated_at",
    "buyOrdersTop10": "buy_orders_top10",
    "buy_orders_top10": "buy_orders_top10",
    "sellOrdersTop10": "sell_orders_top10",
    "sell_orders_top10": "sell_orders_top10",
}


class InvalidSteamApisPayloadError(ValueError):
    """Raised when SteamApis returns a malformed bounded payload."""


class CheckResult(BaseModel):
    status: CheckStatus
    message: str


class ProfileCheck(CheckResult):
    display_name: str | None = None
    avatar_url: str | None = None


class BadgeCheck(BaseModel):
    status: BadgeStatus
    message: str
    player_xp: StrictInt | None = Field(default=None, ge=0, le=10**12)
    player_level: StrictInt | None = Field(default=None, ge=0, le=100_000)

    @model_validator(mode="after")
    def validate_status_fields(self) -> BadgeCheck:
        if self.status == "public":
            if self.player_xp is None or self.player_level is None:
                raise ValueError(_PUBLIC_BADGE_FIELDS_ERROR)
            if level_for_xp(self.player_xp) != self.player_level:
                raise ValueError(_PUBLIC_BADGE_CONSISTENCY_ERROR)
        elif self.player_xp is not None or self.player_level is not None:
            raise ValueError(_UNAVAILABLE_BADGE_FIELDS_ERROR)
        return self


class InventoryPrice(BaseModel):
    currency: Literal["USD"] = "USD"
    highest_buy: str | None = Field(
        default=None,
        max_length=MAX_PRICE_STREAM_SCALAR_LENGTH,
        pattern=r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$",
    )
    lowest_sell: str | None = Field(
        default=None,
        max_length=MAX_PRICE_STREAM_SCALAR_LENGTH,
        pattern=r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$",
    )
    highest_buy_quantity: StrictInt | None = Field(
        default=None,
        ge=0,
        le=MAX_PRICE_QUANTITY,
    )
    lowest_sell_quantity: StrictInt | None = Field(
        default=None,
        ge=0,
        le=MAX_PRICE_QUANTITY,
    )
    observed_at: str | None = None


class BoosterInfo(BaseModel):
    game_app_id: str = Field(pattern=r"^[0-9]+$", max_length=20)
    game_name: str | None = Field(default=None, max_length=MAX_INVENTORY_TEXT_LENGTH)
    market_hash_name: str | None = Field(
        default=None, max_length=MAX_PRICE_STREAM_SCALAR_LENGTH
    )
    card_count: Literal[3] = BOOSTER_CARD_COUNT
    card_set_size: int | None = Field(default=None, ge=5, le=15)
    gem_cost: int | None = Field(default=None, ge=0)
    price: InventoryPrice | None = None

    @model_validator(mode="after")
    def validate_derived_cost(self) -> BoosterInfo:
        if (self.card_set_size is None) != (self.gem_cost is None):
            raise ValueError(_INVALID_BOOSTER_PAIR_ERROR)
        if self.card_set_size is not None and self.gem_cost != derive_booster_gem_cost(
            self.card_set_size
        ):
            raise ValueError(_INVALID_BOOSTER_COST_ERROR)
        return self


class GemCashContext(BaseModel):
    currency: Literal["USD"] = "USD"
    basis: Literal["lowest_sell"] = "lowest_sell"
    market_hash_name: Literal["753-Sack of Gems"] = SACK_OF_GEMS_MARKET_HASH_NAME
    sack_gems: Literal[1000] = 1000
    sack_price: str | None = Field(
        default=None,
        pattern=r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$",
        max_length=MAX_PRICE_STREAM_SCALAR_LENGTH,
    )
    highest_buy: str | None = Field(
        default=None,
        pattern=r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$",
        max_length=MAX_PRICE_STREAM_SCALAR_LENGTH,
    )
    observed_at: str | None = None

    @field_validator("sack_price", "highest_buy")
    @classmethod
    def require_canonical_sack_price(cls, value: str | None) -> str | None:
        if value is not None and canonical_decimal(value) != value:
            raise ValueError(_CANONICAL_SACK_PRICE_ERROR)
        return value

    @model_validator(mode="after")
    def require_sack_price_quote(self) -> GemCashContext:
        if self.sack_price is None and self.highest_buy is None:
            raise ValueError(_GEM_CASH_CONTEXT_QUOTE_ERROR)
        return self


class InventoryItem(BaseModel):
    class_id: str = Field(pattern=r"^[0-9]+$")
    instance_id: str = Field(pattern=r"^[0-9]+$")
    name: str
    market_hash_name: str | None = None
    quantity: int = Field(gt=0)
    icon_url: str | None = None
    marketable: bool
    tradable: bool
    item_type: InventoryItemType = "other"
    game_app_id: str | None = Field(default=None, pattern=r"^[0-9]+$")
    game_name: str | None = Field(default=None, max_length=MAX_INVENTORY_TEXT_LENGTH)
    rarity: str | None = Field(default=None, max_length=MAX_INVENTORY_TEXT_LENGTH)
    card_border: CardBorder | None = None
    gem_key: GemKey | None = None
    gem_yield: StrictInt | None = Field(default=None, ge=0)
    gem_cash_value: str | None = Field(
        default=None,
        max_length=MAX_PRICE_STREAM_SCALAR_LENGTH,
        pattern=r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$",
    )
    price: InventoryPrice | None = None

    @field_validator("gem_cash_value")
    @classmethod
    def require_canonical_gem_cash_value(cls, value: str | None) -> str | None:
        if value is not None and canonical_decimal(value) != value:
            raise ValueError(_CANONICAL_GEM_CASH_VALUE_ERROR)
        return value

    @model_validator(mode="after")
    def validate_gem_metadata(self) -> InventoryItem:
        if self.gem_key is None and (
            self.gem_yield is not None or self.gem_cash_value is not None
        ):
            raise ValueError(_INVALID_ITEM_GEM_METADATA_ERROR)
        if self.gem_cash_value is not None and self.gem_yield is None:
            raise ValueError(_INVALID_ITEM_GEM_METADATA_ERROR)
        return self


class InventoryCheck(CheckResult):
    retry_after_seconds: int | None = Field(
        default=None,
        ge=0,
        le=MAX_RETRY_AFTER_SECONDS,
    )
    rate_limited: bool = False
    total_asset_count: int = Field(default=0, ge=0)
    unique_item_count: int = Field(default=0, ge=0)
    priceable_item_count: int = Field(default=0, ge=0)
    priced_item_count: int = Field(default=0, ge=0)
    price_status: PriceStatus = "unavailable"
    price_message: str = "Steam item prices are unavailable."
    items: list[InventoryItem] = Field(default_factory=list)
    boosters: list[BoosterInfo] = Field(default_factory=list)

    gem_status: GemStatus = "unavailable"
    gem_message: str = "Gem prices are unavailable."
    gem_priceable_item_count: int = Field(default=0, ge=0)
    gem_priced_item_count: int = Field(default=0, ge=0)
    gem_rate_limited: bool = False
    gem_retry_after_seconds: int | None = Field(
        default=None,
        ge=0,
        le=MAX_RETRY_AFTER_SECONDS,
    )
    gem_cash_context: GemCashContext | None = None


class SteamGatewayProtocol(Protocol):
    async def check_profile(self, steam_id: str) -> ProfileCheck:
        """Check whether a Steam profile is publicly visible."""
        ...

    async def check_badges(self, steam_id: str) -> BadgeCheck:
        """Check whether Steam badge XP and level are publicly available."""
        ...

    async def check_inventory(self, steam_id: str) -> InventoryCheck:
        """Fetch and price a Steam inventory."""
        ...

    async def check_level_up(
        self,
        steam_id: str,
        holdings: Sequence[Holding],
        inventory_refreshed_at: datetime | str | int,
        *,
        now: datetime | str | int | None = None,
    ) -> LevelUpOptimizationResponse:
        """Calculate a read-only level-up recommendation without inventory I/O."""
        ...

    async def refresh_gems(
        self,
        keys: Iterable[GemKey],
    ) -> GemScanResult:
        """Read cached gem values without fetching a Steam inventory."""
        ...

    async def refresh_boosters(
        self,
        game_app_ids: Iterable[str],
    ) -> BoosterScanResult:
        """Read cached booster card-set sizes without fetching an inventory."""
        ...


def _text_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _canonical_market_hash_name(value: object) -> str | None:
    """Decode one provider market hash and return its canonical spelling."""

    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_PRICE_STREAM_SCALAR_LENGTH
        or "\x00" in value
    ):
        return None
    try:
        decoded = unquote(value, errors="strict")
    except UnicodeDecodeError:
        return None
    if (
        not decoded
        or len(decoded) > MAX_PRICE_STREAM_SCALAR_LENGTH
        or "\x00" in decoded
    ):
        return None
    return decoded


def _is_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_private_inventory_error(value: Mapping[str, object]) -> bool:
    error = value.get("error")
    return isinstance(error, str) and error.strip() == _PRIVATE_INVENTORY_MESSAGE


def _is_success_flag(value: object) -> bool:
    return value is True or (_is_integer(value) and value == 1)


def _decimal_string(value: object) -> str | None:
    if (
        not isinstance(value, str)
        or len(value) > MAX_INVENTORY_TEXT_LENGTH
        or not _ASCII_DIGITS.fullmatch(value)
    ):
        return None
    return value


def _quantity(value: object) -> int | None:
    if not isinstance(value, str) or not _ASCII_DIGITS.fullmatch(value):
        return None
    normalized = value.lstrip("0")
    if not normalized or len(normalized) > len(str(MAX_INVENTORY_QUANTITY)):
        return None
    parsed = int(normalized)
    return parsed if parsed <= MAX_INVENTORY_QUANTITY else None


def _flag(value: object, *, default: bool = False) -> bool | None:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if _is_integer(value) and value in (0, 1):
        return bool(value)
    return None


def _icon_url(value: object) -> str | None:
    if not isinstance(value, str) or not value or len(value) > MAX_ICON_URL_LENGTH:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme:
            if (
                parsed.scheme.casefold() != "https"
                or not parsed.netloc
                or parsed.username is not None
                or parsed.password is not None
                or parsed.hostname is None
                or parsed.hostname.casefold() != STEAM_ICON_HOSTNAME
                or parsed.port not in (None, 443)
                or not parsed.path.startswith("/economy/image/")
            ):
                return None
            return value
    except ValueError:
        return None
    return urljoin(STEAM_ICON_BASE_URL, value.lstrip("/"))


@dataclass(frozen=True, slots=True)
class _Asset:
    class_id: str
    instance_id: str
    quantity: int


@dataclass(frozen=True, slots=True)
class _Description:
    class_id: str
    instance_id: str
    name: str
    market_hash_name: str | None
    icon_url: str | None
    marketable: bool
    tradable: bool
    item_type: InventoryItemType
    game_app_id: str | None
    game_name: str | None
    rarity: str | None
    card_border: CardBorder | None
    gem_key: GemKey | None


@dataclass(frozen=True, slots=True)
class _InventoryPage:
    assets: tuple[_Asset, ...]
    descriptions: tuple[_Description, ...]
    more_items: bool
    last_assetid: str | None


def _owner_actions_for_description(description: Mapping[str, object]) -> object:
    """Collect action sources while preserving malformed input for rejection."""

    has_owner_actions = "owner_actions" in description
    has_provider_actions = "actions" in description
    if has_owner_actions and has_provider_actions:
        owner_actions = description["owner_actions"]
        provider_actions = description["actions"]
        if not isinstance(owner_actions, list) or not isinstance(
            provider_actions, list
        ):
            # A non-list sentinel prevents fallback to another gem identity source.
            return False
        return owner_actions + provider_actions
    if has_owner_actions:
        return description["owner_actions"]
    if has_provider_actions:
        return description["actions"]
    return None


def _parse_inventory_page(payload: object) -> _InventoryPage | None:
    if not isinstance(payload, Mapping):
        return None

    # Live v2 responses put the Steam payload at the top level with success=1;
    # the documented shape wraps that payload in result and uses success=true.
    if not _is_success_flag(payload.get("success")):
        return None
    if "result" in payload:
        body = payload["result"]
        if not isinstance(body, Mapping):
            return None
    else:
        body = payload
    if not isinstance(body, Mapping):
        return None

    # A successful response must carry both collections.  Treating omitted
    # collections as empty would turn a provider schema failure into a false
    # empty public inventory.
    if "assets" not in body or "descriptions" not in body:
        return None
    raw_assets = body["assets"]
    raw_descriptions = body["descriptions"]
    if (
        not isinstance(raw_assets, list)
        or not isinstance(raw_descriptions, list)
        or len(raw_assets) > MAX_INVENTORY_ASSETS_PER_PAGE
        or len(raw_descriptions) > MAX_INVENTORY_DESCRIPTIONS_PER_PAGE
    ):
        return None

    assets: list[_Asset] = []
    for raw_asset in raw_assets:
        if not isinstance(raw_asset, Mapping):
            return None
        class_id = _decimal_string(raw_asset.get("classid"))
        instance_id = _decimal_string(raw_asset.get("instanceid"))
        amount = _quantity(raw_asset.get("amount"))
        if class_id is None or instance_id is None or amount is None:
            return None
        assets.append(_Asset(class_id, instance_id, amount))

    descriptions: list[_Description] = []
    for raw_description in raw_descriptions:
        if not isinstance(raw_description, Mapping):
            return None
        class_id = _decimal_string(raw_description.get("classid"))
        instance_id = _decimal_string(raw_description.get("instanceid"))
        name = raw_description.get("name")
        if (
            class_id is None
            or instance_id is None
            or not isinstance(name, str)
            or len(name) > MAX_INVENTORY_TEXT_LENGTH
        ):
            return None
        market_hash_name = raw_description.get("marketHashName")
        if market_hash_name is None:
            market_hash_name = raw_description.get("market_hash_name")
        if market_hash_name is not None and (
            not isinstance(market_hash_name, str)
            or not market_hash_name
            or len(market_hash_name) > MAX_PRICE_STREAM_SCALAR_LENGTH
            or "\x00" in market_hash_name
        ):
            return None
        marketable = _flag(raw_description.get("marketable"))
        tradable = _flag(raw_description.get("tradable"))
        if marketable is None or tradable is None:
            return None
        metadata = parse_item_metadata(
            raw_description.get("tags"),
            _owner_actions_for_description(raw_description),
            raw_description.get("market_bucket_id"),
        )
        descriptions.append(
            _Description(
                class_id=class_id,
                instance_id=instance_id,
                name=name,
                market_hash_name=market_hash_name or None,
                icon_url=_icon_url(raw_description.get("icon_url")),
                marketable=marketable,
                tradable=tradable,
                item_type=metadata.item_type,
                game_app_id=metadata.game_app_id,
                game_name=metadata.game_name,
                rarity=metadata.rarity,
                card_border=metadata.card_border,
                gem_key=metadata.gem_key,
            )
        )

    more_items = _flag(body.get("more_items"))
    if more_items is None:
        return None
    last_assetid = body.get("last_assetid")
    if last_assetid is not None and (
        not isinstance(last_assetid, str)
        or not last_assetid
        or len(last_assetid) > MAX_INVENTORY_CURSOR_LENGTH
    ):
        return None
    return _InventoryPage(
        assets=tuple(assets),
        descriptions=tuple(descriptions),
        more_items=more_items,
        last_assetid=last_assetid,
    )


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if isinstance(key, str) and key.casefold() == name.casefold():
            return value if isinstance(value, str) else None
    return None


def _retry_after_seconds(response: HTTPResponse) -> int | None:
    headers = getattr(response, "headers", None)
    if not isinstance(headers, Mapping):
        return None
    value = _header(headers, "retry-after")
    if value is None:
        return None
    stripped = value.strip()
    if not _ASCII_DIGITS.fullmatch(stripped):
        return None
    normalized = stripped.lstrip("0")
    if not normalized:
        return 0
    if len(normalized) > len(str(MAX_RETRY_AFTER_SECONDS)):
        return MAX_RETRY_AFTER_SECONDS
    return min(int(normalized), MAX_RETRY_AFTER_SECONDS)


def _bounded_json_size(value: object, maximum: int) -> int | None:
    """Estimate decoded JSON size with depth-bounded traversal state."""

    total = 0
    pending: list[tuple[Iterator[object], int]] = [(iter((value,)), 0)]
    while pending:
        children, depth = pending[-1]
        try:
            current = next(children)
        except StopIteration:
            pending.pop()
            continue
        if depth > MAX_INVENTORY_NESTING:
            return None
        if isinstance(current, (Mapping, list)):
            total += 16 + len(current) * 8
        elif isinstance(current, (str, bytes, bytearray, memoryview)):
            total += len(current)
        else:
            total += 32
        if total > maximum:
            return None
        if isinstance(current, Mapping):
            pending.append(
                (
                    (child for pair in current.items() for child in pair),
                    depth + 1,
                )
            )
        elif isinstance(current, list):
            pending.append((iter(current), depth + 1))
    return total


def _response_content_length_within(
    response: HTTPResponse,
    maximum: int,
) -> bool:
    headers = getattr(response, "headers", None)
    if not isinstance(headers, Mapping):
        return True
    value = _header(headers, "content-length")
    if value is None:
        return True
    stripped = value.strip()
    if not _ASCII_DIGITS.fullmatch(stripped):
        return False
    normalized = stripped.lstrip("0")
    if not normalized:
        return True
    maximum_digits = len(str(maximum))
    if len(normalized) > maximum_digits:
        return False
    return int(normalized) <= maximum


def _response_content_is_identity(response: HTTPResponse) -> bool:
    headers = getattr(response, "headers", None)
    if not isinstance(headers, Mapping):
        return True
    value = _header(headers, "content-encoding")
    return value is None or value.strip().casefold() == "identity"


def _append_bounded_bytes(
    body: bytearray,
    chunk: object,
    maximum: int,
) -> None:
    if not isinstance(chunk, (bytes, bytearray, memoryview)):
        raise InvalidSteamApisPayloadError
    view = memoryview(chunk)
    if len(body) + len(view) > maximum:
        raise InvalidSteamApisPayloadError
    body.extend(view)


def _level_up_timestamp(value: object) -> datetime | None:
    """Parse one bounded timestamp used by the optimizer boundary."""

    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            return None
        return value.astimezone(UTC)
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        try:
            if abs(value) >= 100_000_000_000:
                seconds, milliseconds = divmod(value, 1000)
                return datetime.fromtimestamp(seconds, UTC).replace(
                    microsecond=milliseconds * 1000
                )
            return datetime.fromtimestamp(value, UTC)
        except (OverflowError, OSError, ValueError):
            return None
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_INVENTORY_TEXT_LENGTH
    ):
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(UTC)


def _badge_integer(value: object, *, minimum: int, maximum: int) -> int | None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or value > maximum
    ):
        return None
    return value


def _steamapis_badge_value(
    payload: Mapping[str, object],
    current_name: str,
    documented_name: str,
) -> object:
    """Read one unambiguous field across SteamApis' live and documented schemas."""

    if current_name in payload:
        if documented_name in payload:
            raise InvalidSteamApisPayloadError
        return payload[current_name]
    return payload.get(documented_name)


def _badge_json_events(body: bytes) -> Iterator[tuple[str, str, object]]:
    try:
        yield from ijson.parse(BytesIO(body))
    except (
        IncompleteJSONError,
        JSONError,
        TypeError,
        UnicodeDecodeError,
        ValueError,
        OverflowError,
    ) as error:
        raise InvalidSteamApisPayloadError from error


def _preflight_badge_json_body(body: bytes) -> None:
    """Reject amplified JSON before materializing its Python object graph."""

    decoded_size = 0
    depth = 0
    record_count = 0
    token_count = 0
    for prefix, event, value in _badge_json_events(body):
        token_count += 1
        if token_count > MAX_BADGE_JSON_TOKENS:
            raise InvalidSteamApisPayloadError
        if prefix == "result.badges.item" and event in _BADGE_JSON_VALUE_EVENTS:
            record_count += 1
            if record_count > MAX_BADGE_RECORDS:
                raise InvalidSteamApisPayloadError
        if event in _BADGE_JSON_CONTAINER_START_EVENTS:
            depth += 1
            if depth > MAX_INVENTORY_NESTING:
                raise InvalidSteamApisPayloadError
            decoded_size += 72
        elif event in _BADGE_JSON_CONTAINER_END_EVENTS:
            depth -= 1
            if depth < 0:
                raise InvalidSteamApisPayloadError
            continue
        elif event == "map_key":
            if not isinstance(value, str):
                raise InvalidSteamApisPayloadError
            decoded_size += 96 + len(value)
        elif event == "string":
            if not isinstance(value, str):
                raise InvalidSteamApisPayloadError
            decoded_size += 64 + len(value)
        elif event in _BADGE_JSON_SCALAR_EVENTS:
            decoded_size += 40
        else:
            raise InvalidSteamApisPayloadError
        if decoded_size > MAX_BADGE_PREFLIGHT_CHARGE:
            raise InvalidSteamApisPayloadError
    if depth != 0:
        raise InvalidSteamApisPayloadError


def _parse_badges_payload(
    payload: object,
    relevant_app_ids: Collection[int],
) -> BadgeState:
    """Parse relevant normal-card badge levels from one bounded SteamApis response."""

    if not isinstance(payload, Mapping) or not _is_success_flag(payload.get("success")):
        raise InvalidSteamApisPayloadError
    result = payload.get("result")
    if not isinstance(result, Mapping):
        raise InvalidSteamApisPayloadError
    records = result.get("badges")
    if not isinstance(records, list) or len(records) > MAX_BADGE_RECORDS:
        raise InvalidSteamApisPayloadError
    if _bounded_json_size(payload, MAX_BADGE_DECODED_SIZE) is None:
        raise InvalidSteamApisPayloadError
    player_xp = _badge_integer(
        _steamapis_badge_value(result, "xp", "player_xp"),
        minimum=0,
        maximum=10**12,
    )
    player_level = _badge_integer(
        _steamapis_badge_value(result, "level", "player_level"),
        minimum=0,
        maximum=100_000,
    )
    if player_xp is None or player_level is None:
        raise InvalidSteamApisPayloadError
    levels: dict[int, int] = {}
    for record in records:
        if not isinstance(record, Mapping):
            raise InvalidSteamApisPayloadError
        raw_app_id = _steamapis_badge_value(record, "appID", "appid")
        if raw_app_id is None:
            continue
        if isinstance(raw_app_id, bool) or not isinstance(raw_app_id, int):
            raise InvalidSteamApisPayloadError
        if raw_app_id == 0:
            continue
        app_id = _badge_integer(raw_app_id, minimum=1, maximum=MAX_APP_ID)
        if app_id is None:
            raise InvalidSteamApisPayloadError
        if app_id not in relevant_app_ids:
            continue
        border_color = _badge_integer(
            _steamapis_badge_value(record, "borderColor", "border_color"),
            minimum=0,
            maximum=1,
        )
        if border_color is None:
            raise InvalidSteamApisPayloadError
        # Foil records do not affect normal-card badge progress.
        if border_color != 0:
            continue
        level = _badge_integer(record.get("level"), minimum=0, maximum=5)
        if level is None or app_id in levels:
            raise InvalidSteamApisPayloadError
        levels[app_id] = level
    try:
        return BadgeState(
            player_xp=player_xp,
            player_level=player_level,
            normal_badge_levels=levels,
        )
    except (OptimizerInputError, TypeError, ValueError, ArithmeticError) as error:
        raise InvalidSteamApisPayloadError from error


def _catalog_groups(
    catalog_read: NormalCardCatalogRead,
) -> dict[int, tuple[CatalogCard, ...]]:
    """Turn cache rows into strict, unique normal-card groups."""

    groups: dict[int, tuple[CatalogCard, ...]] = {}
    for raw_app_id, entries in sorted(catalog_read.groups.items()):
        if (
            isinstance(raw_app_id, bool)
            or not isinstance(raw_app_id, int)
            or not 0 < raw_app_id <= MAX_APP_ID
            or not isinstance(entries, Sequence)
            or not entries
        ):
            continue
        cards: list[CatalogCard] = []
        seen: set[str] = set()
        valid = True
        for entry in entries:
            if not isinstance(entry, CachedPrice):
                valid = False
                break
            parsed = parse_normal_card_hash(entry.market_hash_name)
            if (
                parsed is None
                or parsed[0] != raw_app_id
                or entry.normal_card_app_id != raw_app_id
                or entry.normal_card_name != parsed[1]
            ):
                valid = False
                break
            observed_at = _level_up_timestamp(entry.observed_at)
            if entry.observed_at is not None and observed_at is None:
                valid = False
                break
            try:
                card = CatalogCard(
                    market_hash_name=entry.market_hash_name,
                    app_id=raw_app_id,
                    card_name=parsed[1],
                    highest_buy=entry.highest_buy,
                    lowest_sell=entry.lowest_sell,
                    highest_buy_quantity=entry.highest_buy_quantity,
                    lowest_sell_quantity=entry.lowest_sell_quantity,
                    observed_at=observed_at,
                )
            except (OptimizerInputError, TypeError, ValueError, ArithmeticError):
                valid = False
                break
            if card.market_hash_name in seen:
                valid = False
                break
            seen.add(card.market_hash_name)
            cards.append(card)
        if valid and MIN_NORMAL_SET_SIZE <= len(cards) <= MAX_NORMAL_SET_SIZE:
            cards.sort(key=lambda card: card.market_hash_name)
            groups[raw_app_id] = tuple(cards)
    return groups


def _level_up_quote_amount(
    card: CatalogCard,
    *,
    side: Literal["buy", "sell"],
    now: datetime,
    quote_window: int,
    contract: MarketFeeContract,
    require_depth: bool = False,
) -> int | None:
    """Return one fresh exact quote amount for local candidate prefiltering."""

    if side == "buy":
        price = card.highest_buy
        quantity = card.highest_buy_quantity
        timestamp_value = card.highest_buy_observed_at or card.observed_at
    else:
        price = card.lowest_sell
        quantity = card.lowest_sell_quantity
        timestamp_value = card.lowest_sell_observed_at or card.observed_at
    if price is None:
        return None
    timestamp = _level_up_timestamp(timestamp_value)
    if timestamp is None:
        return None
    try:
        if timestamp > now or now - timestamp > timedelta(seconds=quote_window):
            return None
    except (OverflowError, TypeError, ValueError, ArithmeticError):
        return None
    if require_depth and (
        isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 1
    ):
        return None
    amount = decimal_to_minor(price, contract.minor_digits)
    if amount is None:
        return None
    if side == "buy" and seller_receipt_from_buyer_total(amount, contract) is None:
        return None
    return amount


def _level_up_snapshot_issue(
    *,
    current: datetime,
    inventory_time: datetime,
    generated_at: datetime,
    inventory_limit: int,
    quote_limit: int,
) -> str | None:
    try:
        if current < inventory_time or current - inventory_time > timedelta(
            seconds=inventory_limit
        ):
            return "inventory_snapshot_too_old"
        if current < generated_at:
            return "price_generation_unavailable"
        if current - generated_at > timedelta(seconds=quote_limit):
            return "price_generation_stale"
    except (OverflowError, TypeError, ValueError, ArithmeticError):
        return "price_generation_unavailable"
    return None


def _level_up_response(
    *,
    status: Literal["unavailable", "warming", "no_opportunity"],
    reason: str,
    now: datetime,
    inventory_time: datetime,
    contract: MarketFeeContract | None,
    total_sets: int = 0,
    resolved_sets: int = 0,
    pending_sets: int = 0,
) -> LevelUpOptimizationResponse:
    currency_code = contract.currency_code if contract is not None else None
    minor_digits = contract.minor_digits if contract is not None else None
    price_basis = "instant_top_of_book" if contract is not None else None
    steam_fee_bps = contract.steam_fee_bps if contract is not None else None
    publisher_fee_bps = contract.publisher_fee_bps if contract is not None else None
    min_fee_minor = contract.min_fee_minor if contract is not None else None
    taxes_included = False if contract is not None else None
    bounded_total = max(0, total_sets)
    bounded_pending = max(0, min(pending_sets, bounded_total))
    bounded_resolved = max(0, min(resolved_sets, bounded_total))
    if bounded_pending == 0 and bounded_resolved < bounded_total:
        bounded_pending = bounded_total - bounded_resolved
    else:
        bounded_resolved = bounded_total - bounded_pending
    return LevelUpOptimizationResponse(
        status=status,
        reason=reason,
        generated_at=now,
        inventory_refreshed_at=inventory_time,
        catalog_total_sets=bounded_total,
        catalog_resolved_sets=bounded_resolved,
        catalog_pending_sets=bounded_pending,
        scope_limited=False,
        valid_until=None,
        player=None,
        source=None,
        destinations=(),
        totals=None,
        currency_code=currency_code,
        minor_digits=minor_digits,
        price_basis=price_basis,
        steam_fee_bps=steam_fee_bps,
        publisher_fee_bps=publisher_fee_bps,
        min_fee_minor=min_fee_minor,
        taxes_included=taxes_included,
    )


def _validated_bulk_redirect(response: HTTPResponse, api_key: str) -> str:
    if response.status_code not in (301, 302, 303, 307, 308):
        raise InvalidSteamApisPayloadError
    response_headers = getattr(response, "headers", None)
    if not isinstance(response_headers, Mapping):
        raise InvalidSteamApisPayloadError
    location = _header(response_headers, "location")
    if not isinstance(location, str) or not location:
        raise InvalidSteamApisPayloadError
    redirect = urljoin(STEAMAPIS_ITEMS_ENDPOINT, location)
    try:
        parsed = urlsplit(redirect)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise InvalidSteamApisPayloadError from error
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or hostname is None
        or not hostname.casefold().endswith(STEAMAPIS_BULK_HOST_SUFFIX)
        or port not in (None, 443)
        or api_key in redirect
        or api_key in unquote(redirect)
        or any(
            part.split("=", 1)[0].casefold() == "x-api-key"
            for part in unquote(parsed.query).split("&")
            if part
        )
    ):
        raise InvalidSteamApisPayloadError
    return redirect


def _validate_bulk_response(response: HTTPResponse) -> None:
    if not 200 <= response.status_code < 300 or not _response_content_length_within(
        response, MAX_PRICE_STREAM_BYTES
    ):
        raise InvalidSteamApisPayloadError


def _validate_price_generation(
    refresh: SteamApisPriceRefresh,
    summary: _PriceStreamSummary,
) -> None:
    if (
        refresh.accepted_count == 0
        or refresh.accepted_count != summary.parsed_item_count
        or not summary.complete
    ):
        raise InvalidSteamApisPayloadError


def _unavailable_price_lookup() -> _PriceLookup:
    return _PriceLookup(
        status="unavailable",
        message="Steam item prices are unavailable.",
        prices={},
        priced_names=frozenset(),
    )


def _price_status_for_items(
    items: list[InventoryItem],
) -> tuple[PriceStatus, str, int, int]:
    priceable_count = sum(1 for item in items if item.marketable)
    priced_count = sum(
        1 for item in items if item.marketable and item.price is not None
    )
    if priceable_count == 0:
        return (
            "complete",
            "No marketable inventory items require prices.",
            priceable_count,
            priced_count,
        )
    if priced_count == priceable_count:
        return (
            "complete",
            "Prices are current for all marketable inventory items.",
            priceable_count,
            priced_count,
        )
    if priced_count:
        return (
            "partial",
            "Prices are unavailable for some marketable inventory items.",
            priceable_count,
            priced_count,
        )
    return (
        "unavailable",
        "Steam item prices are unavailable.",
        priceable_count,
        priced_count,
    )


def _gem_status_for_items(
    items: list[InventoryItem],
    scan: GemScanResult,
) -> tuple[GemStatus, str, int, int]:
    priceable_count = sum(item.gem_key is not None for item in items)
    priced_count = sum(
        item.gem_key is not None and item.gem_yield is not None for item in items
    )
    if priceable_count == 0:
        return (
            "complete",
            "No gem-convertible items require gem prices.",
            priceable_count,
            priced_count,
        )
    if priced_count == priceable_count:
        message = "Gem prices are current for all gem-convertible items."
        if scan.used_stale_cache:
            message = "Gem prices are complete using a cached fallback."
        if scan.rate_limited:
            message += " Steam Community access is temporarily rate limited."
        return "complete", message, priceable_count, priced_count
    if priced_count:
        if scan.pending_count:
            message = (
                "Gem prices are partially available; remaining values are pending."
            )
        else:
            message = "Gem prices are unavailable for some gem-convertible items."
    elif scan.pending_count:
        message = "Gem prices are pending for some gem-convertible items."
    else:
        message = "Gem prices are unavailable."
    if scan.rate_limited:
        message += " Steam Community access is temporarily rate limited."
    return (
        "partial" if priced_count else "unavailable",
        message,
        priceable_count,
        priced_count,
    )


def _gem_cash_context(price: InventoryPrice | None) -> GemCashContext | None:
    if price is None:
        return None
    sack_price = (
        canonical_decimal(price.lowest_sell) if price.lowest_sell is not None else None
    )
    highest_buy = (
        canonical_decimal(price.highest_buy) if price.highest_buy is not None else None
    )
    if sack_price is None and highest_buy is None:
        return None
    return GemCashContext(
        sack_price=sack_price,
        highest_buy=highest_buy,
        observed_at=price.observed_at,
    )


def _gem_group_representatives(
    items: list[InventoryItem],
) -> dict[GemKey, str | None]:
    groups: dict[GemKey, str | None] = {}
    for item in items:
        key = item.gem_key
        if key is None:
            continue
        market_hash_name = item.market_hash_name
        existing = groups.get(key)
        if key not in groups or (
            market_hash_name is not None
            and (existing is None or market_hash_name < existing)
        ):
            groups[key] = market_hash_name
    return groups


def _booster_market_hash_name(game_app_id: str, game_name: str) -> str:
    return f"{game_app_id}-{game_name} Booster Pack"


def _booster_games(items: list[InventoryItem]) -> list[tuple[str, str | None]]:
    games: dict[str, str | None] = {}
    for item in items:
        if item.item_type != "trading_card" or item.game_app_id is None:
            continue
        game_name = item.game_name.strip() if item.game_name is not None else None
        if game_name == "":
            game_name = None
        existing = games.get(item.game_app_id)
        if item.game_app_id not in games or (
            game_name is not None
            and (
                existing is None
                or (game_name.casefold(), game_name) < (existing.casefold(), existing)
            )
        ):
            games[item.game_app_id] = game_name
    return sorted(
        games.items(),
        key=lambda entry: (
            (entry[1] or "").casefold(),
            len(entry[0]),
            entry[0],
        ),
    )


def _booster_infos(
    games: list[tuple[str, str | None]],
    prices: Mapping[str, InventoryPrice],
    resolutions: Mapping[str, BoosterResolution] | None = None,
) -> list[BoosterInfo]:
    resolved = resolutions or {}
    boosters: list[BoosterInfo] = []
    for game_app_id, game_name in games:
        resolution = resolved.get(game_app_id)
        try:
            is_valid_resolution = isinstance(
                resolution, BoosterResolution
            ) and resolution.gem_cost == derive_booster_gem_cost(
                resolution.card_set_size
            )
        except (TypeError, ValueError):
            is_valid_resolution = False
        if not is_valid_resolution:
            resolution = None
        candidate_game_name = (
            resolution.game_name
            if resolution is not None
            and isinstance(resolution.game_name, str)
            and resolution.game_name.strip()
            and len(resolution.game_name) <= MAX_INVENTORY_TEXT_LENGTH
            and "\x00" not in resolution.game_name
            else None
        )
        # Existing inventory metadata owns the ordinary booster identity and
        # its price join.  Optimizer metadata supplies a name only when the
        # inventory row did not provide one.
        resolved_game_name = game_name or candidate_game_name
        market_hash_name = (
            _booster_market_hash_name(game_app_id, resolved_game_name)
            if resolved_game_name is not None
            else None
        )
        boosters.append(
            BoosterInfo(
                game_app_id=game_app_id,
                game_name=resolved_game_name,
                market_hash_name=market_hash_name,
                card_count=BOOSTER_CARD_COUNT,
                card_set_size=resolution.card_set_size if resolution else None,
                gem_cost=resolution.gem_cost if resolution else None,
                price=prices.get(market_hash_name)
                if market_hash_name is not None
                else None,
            )
        )
    return boosters


def _unavailable_inventory(
    message: str = "Steam inventory is unavailable.",
    *,
    retry_after_seconds: int | None = None,
    rate_limited: bool = False,
) -> InventoryCheck:
    return InventoryCheck(
        status="unavailable",
        message=message,
        retry_after_seconds=retry_after_seconds,
        rate_limited=rate_limited,
        price_status="unavailable",
        price_message="Steam item prices are unavailable.",
    )


def _private_inventory() -> InventoryCheck:
    return InventoryCheck(status="private", message="Steam inventory is private.")


def _unavailable_profile() -> ProfileCheck:
    return ProfileCheck(
        status="unavailable",
        message="Steam profile API is unavailable.",
    )


def _unavailable_badges() -> BadgeCheck:
    return BadgeCheck(
        status="unavailable",
        message="Steam badge check is unavailable.",
    )


@dataclass(frozen=True, slots=True)
class _PriceLookup:
    status: PriceStatus
    message: str
    prices: Mapping[str, InventoryPrice]
    priced_names: frozenset[str]
    used_stale_cache: bool = False


@dataclass(frozen=True, slots=True)
class _PriceStreamSummary:
    app_id: int | None
    declared_item_count: int | None
    parsed_item_count: int

    @property
    def complete(self) -> bool:
        return (
            self.app_id == 753
            and self.declared_item_count is not None
            and self.declared_item_count == self.parsed_item_count
        )


@dataclass(slots=True)
class _PriceFrame:
    parent_key: str | None
    pending_key: str | None = None
    seen_keys: set[str] = field(default_factory=set)
    market_hash_name: str | None = None
    highest_buy: object = None
    lowest_sell: object = None
    observed_at: object = None
    highest_buy_quantity: int | None = None
    market_hash_seen: bool = False
    lowest_sell_quantity: int | None = None
    depth_kind: Literal["buy", "sell"] | None = None
    depth_price: object = None
    depth_quantity: object = None
    depth_invalid: bool = False
    buy_depth_present: bool = False
    sell_depth_present: bool = False
    buy_depth_invalid: bool = False
    sell_depth_invalid: bool = False
    buy_depth_rows: int = 0
    sell_depth_rows: int = 0
    buy_depth_totals: dict[str, int] = field(default_factory=dict)
    sell_depth_totals: dict[str, int] = field(default_factory=dict)


class _AsyncByteReader:
    """Adapt an async byte iterator to ijson's bounded async read interface."""

    __slots__ = (
        "_buffer",
        "_decoded_bytes",
        "_done",
        "_iterator",
        "_max_decoded_bytes",
        "_pending",
    )

    def __init__(
        self,
        iterator: AsyncIterator[bytes],
        *,
        max_decoded_bytes: int = MAX_PRICE_STREAM_BYTES,
    ) -> None:
        self._iterator = iterator
        self._buffer = bytearray()
        self._pending: memoryview | None = None
        self._done = False
        self._decoded_bytes = 0
        self._max_decoded_bytes = max_decoded_bytes

    async def read(self, size: int = -1) -> bytes:
        # ijson requests 64 KiB reads. Keep a finite fallback even if a
        # different backend asks for read(-1), so a provider body is never
        # joined into one decoded allocation.
        target = 65_536 if size < 0 else min(size, 65_536)
        if target <= 0:
            return b""
        while len(self._buffer) < target:
            if self._pending is not None:
                needed = target - len(self._buffer)
                take = min(needed, len(self._pending))
                self._buffer.extend(self._pending[:take])
                self._pending = self._pending[take:] or None
                continue
            if self._done:
                break
            try:
                chunk = await self._iterator.__anext__()
            except StopAsyncIteration:
                self._done = True
                break
            if not isinstance(chunk, (bytes, bytearray, memoryview)):
                raise TypeError
            view = memoryview(chunk)
            if self._decoded_bytes + len(view) > self._max_decoded_bytes:
                raise InvalidSteamApisPayloadError
            self._decoded_bytes += len(view)
            if not self._buffer and len(view) >= target:
                result = bytes(view[:target])
                self._pending = view[target:] or None
                return result
            self._buffer.extend(view)
        if not self._buffer:
            return b""
        result = bytes(self._buffer)
        self._buffer.clear()
        return result


def _provider_amount(value: object) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        decimal = value if isinstance(value, Decimal) else Decimal(str(value))
        if not decimal.is_finite() or decimal.is_signed() or decimal > MAX_PRICE_AMOUNT:
            return None
        decimal_tuple = decimal.as_tuple()
        if len(decimal_tuple.digits) > MAX_PRICE_DECIMAL_DIGITS:
            return None
        exponent = decimal_tuple.exponent
        if not isinstance(exponent, int):
            return None
        if exponent >= 0:
            fixed_length = len(decimal_tuple.digits) + exponent
        else:
            adjusted = len(decimal_tuple.digits) + exponent - 1
            fixed_length = (
                len(decimal_tuple.digits) + 1
                if adjusted >= 0
                else len(decimal_tuple.digits) + 1 - adjusted
            )
        if fixed_length > MAX_PRICE_STREAM_SCALAR_LENGTH:
            return None
        fixed = format(decimal, "f")
    except (ArithmeticError, ValueError, TypeError):
        return None
    return fixed if len(fixed) <= MAX_PRICE_STREAM_SCALAR_LENGTH else None


def _provider_quantity(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        quantity = value
    elif isinstance(value, str) and _ASCII_DIGITS.fullmatch(value):
        try:
            quantity = int(value)
        except ValueError:
            return None
    else:
        return None
    return quantity if 0 <= quantity <= MAX_PRICE_QUANTITY else None


def _depth_kind_for_prefix(prefix: str) -> Literal["buy", "sell"] | None:
    parts = prefix.split(".")
    if len(parts) < 2 or parts[-1] != "item":
        return None
    if parts[-2] in ("buyOrdersTop10", "buy_orders_top10"):
        return "buy"
    if parts[-2] in ("sellOrdersTop10", "sell_orders_top10"):
        return "sell"
    return None


def _depth_kind_for_key(value: object) -> Literal["buy", "sell"] | None:
    if value in ("buyOrdersTop10", "buy_orders_top10"):
        return "buy"
    if value in ("sellOrdersTop10", "sell_orders_top10"):
        return "sell"
    return None


def _depth_price_key(value: object) -> str | None:
    normalized = _provider_amount(value)
    if normalized is None:
        return None
    try:
        return format(Decimal(normalized).normalize(), "f")
    except (ArithmeticError, ValueError, TypeError):
        return None


def _mark_depth_invalid(
    frame: _PriceFrame,
    kind: Literal["buy", "sell"],
) -> None:
    if kind == "buy":
        frame.buy_depth_invalid = True
    else:
        frame.sell_depth_invalid = True


def _start_depth_array(
    frame: _PriceFrame,
    kind: Literal["buy", "sell"],
) -> None:
    if kind == "buy":
        if frame.buy_depth_present:
            frame.buy_depth_invalid = True
        frame.buy_depth_present = True
    else:
        if frame.sell_depth_present:
            frame.sell_depth_invalid = True
        frame.sell_depth_present = True


def _record_depth_row(
    order_book: _PriceFrame,
    row: _PriceFrame,
) -> None:
    kind = row.depth_kind
    if kind is None:
        return
    if row.depth_invalid:
        _mark_depth_invalid(order_book, kind)
        return
    price = _depth_price_key(row.depth_price)
    quantity = _provider_quantity(row.depth_quantity)
    if price is None or quantity is None:
        _mark_depth_invalid(order_book, kind)
        return
    if kind == "buy":
        order_book.buy_depth_rows += 1
        if order_book.buy_depth_rows > MAX_PRICE_DEPTH_ROWS:
            order_book.buy_depth_invalid = True
            return
        totals = order_book.buy_depth_totals
    else:
        order_book.sell_depth_rows += 1
        if order_book.sell_depth_rows > MAX_PRICE_DEPTH_ROWS:
            order_book.sell_depth_invalid = True
            return
        totals = order_book.sell_depth_totals
    previous = totals.get(price, 0)
    total = previous + quantity
    if total > MAX_PRICE_DEPTH_TOTAL_QUANTITY:
        _mark_depth_invalid(order_book, kind)
        return
    totals[price] = total


def _depth_extreme_price(
    totals: Mapping[str, int],
    *,
    kind: Literal["buy", "sell"],
) -> str | None:
    if not totals:
        return None
    try:
        prices = (Decimal(value) for value in totals)
        extreme = max(prices) if kind == "buy" else min(prices)
        return format(extreme.normalize(), "f")
    except (ArithmeticError, TypeError, ValueError):
        return None


def _finish_depth(order_book: _PriceFrame) -> None:
    if order_book.buy_depth_present and not order_book.buy_depth_invalid:
        top_price = _depth_price_key(order_book.highest_buy)
        if top_price is not None and top_price == _depth_extreme_price(
            order_book.buy_depth_totals,
            kind="buy",
        ):
            order_book.highest_buy_quantity = order_book.buy_depth_totals.get(top_price)
        else:
            order_book.buy_depth_invalid = True
    if order_book.sell_depth_present and not order_book.sell_depth_invalid:
        top_price = _depth_price_key(order_book.lowest_sell)
        if top_price is not None and top_price == _depth_extreme_price(
            order_book.sell_depth_totals,
            kind="sell",
        ):
            order_book.lowest_sell_quantity = order_book.sell_depth_totals.get(
                top_price
            )
        else:
            order_book.sell_depth_invalid = True


def _observed_at(value: object) -> str | None:
    if isinstance(value, str):
        if len(value) > MAX_INVENTORY_TEXT_LENGTH:
            return None
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if value is None or isinstance(value, bool):
        return None
    try:
        milliseconds = value if isinstance(value, Decimal) else Decimal(str(value))
        if len(milliseconds.as_tuple().digits) > MAX_PRICE_DECIMAL_DIGITS:
            return None
        if (
            not milliseconds.is_finite()
            or milliseconds < 0
            or milliseconds > _MAX_OBSERVED_AT_DECIMAL
            or milliseconds != milliseconds.to_integral_value()
        ):
            return None
        bounded_milliseconds = int(milliseconds)
        seconds, remainder = divmod(bounded_milliseconds, 1000)
        observed = datetime.fromtimestamp(seconds, UTC) + timedelta(
            milliseconds=remainder
        )
    except (ArithmeticError, ValueError, TypeError, OSError):
        return None
    return observed.isoformat().replace("+00:00", "Z")


def _price_from_frame(frame: _PriceFrame) -> InventoryPrice:
    return InventoryPrice(
        highest_buy=_provider_amount(frame.highest_buy),
        lowest_sell=_provider_amount(frame.lowest_sell),
        highest_buy_quantity=frame.highest_buy_quantity,
        lowest_sell_quantity=frame.lowest_sell_quantity,
        observed_at=_observed_at(frame.observed_at),
    )


def _merge_price(
    prices: dict[str, InventoryPrice],
    priced_names: set[str],
    name: str,
    price: InventoryPrice,
) -> None:
    if price.highest_buy is None and price.lowest_sell is None:
        return
    prices[name] = price
    priced_names.add(name)


def _price_lookup_from_cache(
    cache_read: PriceCacheRead,
    requested_names: frozenset[str],
) -> _PriceLookup:
    prices: dict[str, InventoryPrice] = {}
    priced_names: set[str] = set()
    for requested_name in requested_names:
        if not isinstance(requested_name, str):
            continue
        entry: CachedPrice | None = cache_read.prices.get(requested_name)
        if entry is None:
            continue
        prices[requested_name] = InventoryPrice(
            highest_buy=entry.highest_buy,
            lowest_sell=entry.lowest_sell,
            highest_buy_quantity=entry.highest_buy_quantity,
            lowest_sell_quantity=entry.lowest_sell_quantity,
            observed_at=entry.observed_at,
        )
        priced_names.add(requested_name)
    priced = frozenset(priced_names)
    if len(priced) == len(requested_names):
        status: PriceStatus = "complete"
        message = "Prices are current for all marketable inventory items."
    elif priced:
        status = "partial"
        message = "Prices are unavailable for some marketable inventory items."
    else:
        status = "unavailable"
        message = "Steam item prices are unavailable."
    return _PriceLookup(
        status=status,
        message=message,
        prices=prices,
        priced_names=priced,
        used_stale_cache=cache_read.has_generation and not cache_read.fresh,
    )


def _price_refresh_lock(cache: SteamApisPriceCache) -> asyncio.Lock:
    if cache.path == ":memory:":
        key = f":memory:{id(cache)}"
    else:
        key = str(Path(cache.path).expanduser().absolute())
    lock = _PRICE_REFRESH_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _PRICE_REFRESH_LOCKS[key] = lock
    return lock


async def _stream_prices(
    response: HTTPResponse,
    requested_names: frozenset[str],
    on_price: Callable[[str, InventoryPrice], None] | None = None,
) -> tuple[dict[str, InventoryPrice], set[str], _PriceStreamSummary]:
    prices: dict[str, InventoryPrice] = {}
    priced_names: set[str] = set()
    stack: list[_PriceFrame] = []
    nesting = 0
    token_count = 0
    saw_items_array = False
    metadata_app_id: int | None = None
    declared_item_count: int | None = None
    parsed_item_count = 0
    seen_item_hashes: set[str] = set()

    async for prefix, event, value in ijson.parse_async(
        _AsyncByteReader(
            response.aiter_bytes(),
            max_decoded_bytes=MAX_PRICE_STREAM_BYTES,
        ),
        use_float=False,
    ):
        token_count += 1
        if token_count > MAX_PRICE_STREAM_TOKENS:
            raise InvalidSteamApisPayloadError
        if isinstance(value, str) and len(value) > MAX_PRICE_STREAM_SCALAR_LENGTH:
            raise InvalidSteamApisPayloadError
        if event == "start_map":
            nesting += 1
            if nesting > MAX_PRICE_STREAM_NESTING:
                raise InvalidSteamApisPayloadError
            parent = stack[-1] if stack else None
            parent_key = parent.pending_key if parent is not None else None
            malformed_depth = (
                _depth_kind_for_key(parent_key)
                if parent is not None and parent.parent_key in ("orderBook", None)
                else None
            )
            if parent is not None:
                parent.pending_key = None
                if malformed_depth is not None:
                    _start_depth_array(parent, malformed_depth)
                    _mark_depth_invalid(parent, malformed_depth)
            stack.append(
                _PriceFrame(
                    parent_key=parent_key,
                    depth_kind=_depth_kind_for_prefix(prefix),
                )
            )
            continue
        if event == "end_map":
            if not stack:
                raise InvalidSteamApisPayloadError
            frame = stack.pop()
            nesting -= 1
            if frame.depth_kind is not None:
                if not stack:
                    raise InvalidSteamApisPayloadError
                _record_depth_row(stack[-1], frame)
            elif frame.parent_key == "orderBook" and stack:
                parent = stack[-1]
                _finish_depth(frame)
                if frame.highest_buy is not None:
                    parent.highest_buy = frame.highest_buy
                if frame.lowest_sell is not None:
                    parent.lowest_sell = frame.lowest_sell
                if frame.highest_buy_quantity is not None:
                    parent.highest_buy_quantity = frame.highest_buy_quantity
                if frame.lowest_sell_quantity is not None:
                    parent.lowest_sell_quantity = frame.lowest_sell_quantity
                if frame.observed_at is not None:
                    parent.observed_at = frame.observed_at
            if prefix == "items.item":
                _finish_depth(frame)
                decoded_name = _canonical_market_hash_name(frame.market_hash_name)
                if decoded_name is None or decoded_name in seen_item_hashes:
                    raise InvalidSteamApisPayloadError
                seen_item_hashes.add(decoded_name)
                parsed_item_count += 1
                matched_names = (
                    (decoded_name,) if decoded_name in requested_names else ()
                )
                price: InventoryPrice | None = None
                if on_price is not None:
                    price = _price_from_frame(frame)
                    on_price(decoded_name, price)
                # Do not parse numbers or allocate an InventoryPrice for the
                # hundreds of thousands of unrequested feed entries unless a
                # cache refresh is actively persisting this complete feed.
                if matched_names:
                    if price is None:
                        price = _price_from_frame(frame)
                    for candidate in matched_names:
                        _merge_price(prices, priced_names, candidate, price)
            continue
        if event == "map_key":
            if not stack or not isinstance(value, str):
                raise InvalidSteamApisPayloadError
            frame = stack[-1]
            semantic_key = _PRICE_STREAM_SEMANTIC_KEYS.get(value, value)
            if semantic_key in frame.seen_keys:
                raise InvalidSteamApisPayloadError
            frame.seen_keys.add(semantic_key)
            frame.pending_key = value
            continue
        if event == "start_array":
            if prefix == "items.item":
                raise InvalidSteamApisPayloadError
            if prefix == "items":
                saw_items_array = True
            malformed_depth_kind = _depth_kind_for_prefix(prefix)
            if malformed_depth_kind is not None:
                if not stack:
                    raise InvalidSteamApisPayloadError
                _mark_depth_invalid(stack[-1], malformed_depth_kind)
            nesting += 1
            if nesting > MAX_PRICE_STREAM_NESTING:
                raise InvalidSteamApisPayloadError
            if stack:
                frame = stack[-1]
                if frame.parent_key in ("orderBook", None):
                    depth_kind = _depth_kind_for_key(frame.pending_key)
                    if depth_kind is not None:
                        _start_depth_array(frame, depth_kind)
                frame.pending_key = None
            continue
        if event == "end_array":
            nesting -= 1
            if nesting < 0:
                raise InvalidSteamApisPayloadError
            continue
        if prefix == "items.item":
            raise InvalidSteamApisPayloadError
        if not stack:
            continue
        frame = stack[-1]
        key = frame.pending_key
        frame.pending_key = None
        depth_kind = _depth_kind_for_prefix(prefix)
        if frame.depth_kind is not None:
            if key == "price" and event in ("number", "string"):
                if frame.depth_price is not None:
                    frame.depth_invalid = True
                frame.depth_price = value
            elif key == "quantity" and event in ("number", "string"):
                if frame.depth_quantity is not None:
                    frame.depth_invalid = True
                frame.depth_quantity = value
            elif key in ("price", "quantity"):
                frame.depth_invalid = True
        elif depth_kind is not None:
            # A scalar member in a top-ten array is not a verified row.
            _mark_depth_invalid(frame, depth_kind)
        elif prefix == "metadata.appId" and event == "number":
            if metadata_app_id is not None or not _is_integer(value):
                raise InvalidSteamApisPayloadError
            metadata_app_id = value
        elif prefix == "metadata.itemCount" and event == "number":
            if (
                declared_item_count is not None
                or not _is_integer(value)
                or value < 0
                or value > MAX_PRICE_STREAM_TOKENS
            ):
                raise InvalidSteamApisPayloadError
            declared_item_count = value
        elif key in ("marketHashName", "market_hash_name"):
            if frame.market_hash_seen or event != "string":
                raise InvalidSteamApisPayloadError
            frame.market_hash_seen = True
            frame.market_hash_name = value
        elif key in ("highestBuy", "highest_buy") and frame.parent_key == "orderBook":
            frame.highest_buy = value
        elif key in ("lowestSell", "lowest_sell") and frame.parent_key == "orderBook":
            frame.lowest_sell = value
        elif key in ("updatedAt", "updated_at") and event in ("number", "string"):
            frame.observed_at = value
        elif (
            frame.parent_key in ("orderBook", None)
            and _depth_kind_for_key(key) is not None
        ):
            malformed_kind = _depth_kind_for_key(key)
            if malformed_kind is not None:
                _start_depth_array(frame, malformed_kind)
                _mark_depth_invalid(frame, malformed_kind)

    if not token_count or not saw_items_array or stack or nesting:
        raise InvalidSteamApisPayloadError
    return (
        prices,
        priced_names,
        _PriceStreamSummary(
            app_id=metadata_app_id,
            declared_item_count=declared_item_count,
            parsed_item_count=parsed_item_count,
        ),
    )


class SteamApisClient:
    """Small SteamApis v2 client with an explicit bulk CDN boundary."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_client: AsyncHTTPClient,
        bulk_http_client: AsyncHTTPClient | None = None,
        bulk_timeout_seconds: float | None = None,
        gem_pricing: GemPricingService | None = None,
        price_cache: SteamApisPriceCache | None = None,
        booster_pricing: BoosterPricingService | None = None,
        limiter: SteamCommunityLimiter | None = None,
    ) -> None:
        self.settings = settings
        self.http_client = http_client
        self.bulk_http_client = bulk_http_client or http_client
        self.bulk_timeout_seconds = (
            bulk_timeout_seconds
            if bulk_timeout_seconds is not None
            else settings.steam_bulk_timeout_seconds
        )
        self._inventory_inflight: dict[str, asyncio.Task[InventoryCheck]] = {}
        self._price_refresh_task: asyncio.Task[bool] | None = None
        self.price_cache = price_cache or SteamApisPriceCache(
            settings.steamapis_price_cache_path
        )
        shared_limiter = limiter
        if shared_limiter is None and gem_pricing is not None:
            candidate_limiter = getattr(gem_pricing, "limiter", None)
            if isinstance(candidate_limiter, SteamCommunityLimiter):
                shared_limiter = candidate_limiter
        if shared_limiter is None and booster_pricing is not None:
            candidate_limiter = getattr(booster_pricing, "limiter", None)
            if isinstance(candidate_limiter, SteamCommunityLimiter):
                shared_limiter = candidate_limiter
        self.community_limiter = shared_limiter or SteamCommunityLimiter()
        self.gem_pricing = gem_pricing or GemPricingService(
            settings,
            http_client=http_client,
            limiter=self.community_limiter,
        )
        self.booster_pricing = booster_pricing or BoosterPricingService(
            settings,
            http_client=http_client,
            limiter=self.community_limiter,
        )

    async def start(self) -> None:
        self.price_cache.initialize()
        await self.gem_pricing.start()
        await self.booster_pricing.start()

    async def stop(self) -> None:
        inventory_tasks = tuple(self._inventory_inflight.values())
        for task in inventory_tasks:
            if not task.done():
                task.cancel()
        if inventory_tasks:
            await asyncio.gather(*inventory_tasks, return_exceptions=True)
        self._inventory_inflight.clear()

        price_task = self._price_refresh_task
        if price_task is not None and not price_task.done():
            price_task.cancel()
        if price_task is not None:
            await asyncio.gather(price_task, return_exceptions=True)
        self._price_refresh_task = None

        try:
            await self.booster_pricing.stop()
        finally:
            try:
                await self.gem_pricing.stop()
            finally:
                self.price_cache.close()

    @property
    def _api_key(self) -> str | None:
        key = self.settings.steamapi_key
        return key.strip() if isinstance(key, str) and key.strip() else None

    def _api_headers(self) -> dict[str, str] | None:
        key = self._api_key
        if key is None:
            return None
        return {"x-api-key": key, "User-Agent": STEAM_OPTIMIZER_USER_AGENT}

    async def fetch_inventory(self, steam_id: str) -> InventoryCheck:
        task = self._inventory_inflight.get(steam_id)
        if task is None:
            task = asyncio.create_task(self._fetch_inventory_uncached(steam_id))
            self._inventory_inflight[steam_id] = task
            task.add_done_callback(
                lambda completed: self._discard_inventory_task(steam_id, completed)
            )
        try:
            return await asyncio.shield(task)
        finally:
            self._discard_inventory_task(steam_id, task)

    def _discard_inventory_task(
        self,
        steam_id: str,
        task: asyncio.Future[InventoryCheck],
    ) -> None:
        if task.done() and self._inventory_inflight.get(steam_id) is task:
            self._inventory_inflight.pop(steam_id, None)

    async def _fetch_inventory_uncached(self, steam_id: str) -> InventoryCheck:
        headers = self._api_headers()
        if headers is None:
            return _unavailable_inventory(
                "Steam inventory is unavailable because no SteamApis API key "
                "is configured."
            )

        url = STEAMAPIS_INVENTORY_ENDPOINT.format(steam_id=quote(steam_id, safe=""))
        cursor: str | None = None
        seen_cursors: set[str] = set()
        assets: list[_Asset] = []
        descriptions: dict[tuple[str, str], _Description] = {}
        pages_fetched = 0
        description_count = 0
        total_quantity = 0
        decoded_inventory_bytes = 0

        while True:
            if pages_fetched >= MAX_INVENTORY_PAGES:
                return _unavailable_inventory()
            pages_fetched += 1
            if cursor is not None:
                if (
                    not cursor
                    or len(cursor) > MAX_INVENTORY_CURSOR_LENGTH
                    or cursor in seen_cursors
                ):
                    return _unavailable_inventory()
                seen_cursors.add(cursor)
            try:
                if cursor is None:
                    response = await self.http_client.get(
                        url,
                        headers=headers,
                        follow_redirects=False,
                    )
                else:
                    response = await self.http_client.get(
                        url,
                        params={"start_assetid": cursor},
                        headers=headers,
                        follow_redirects=False,
                    )
            except (
                httpx2.HTTPError,
                OSError,
                TimeoutError,
                RuntimeError,
            ):
                return _unavailable_inventory()
            status_code = response.status_code
            if status_code == 403:
                try:
                    payload = response.json()
                except (TypeError, ValueError):
                    payload = None
                except _PRICE_STREAM_JSON_ERRORS:
                    payload = None
                if isinstance(payload, Mapping) and _is_private_inventory_error(
                    payload
                ):
                    return _private_inventory()
                return _unavailable_inventory()
            if status_code == 429:
                return _unavailable_inventory(
                    "Steam inventory requests are temporarily rate limited.",
                    retry_after_seconds=_retry_after_seconds(response),
                    rate_limited=True,
                )
            if not 200 <= status_code < 300:
                return _unavailable_inventory()
            if not _response_content_length_within(response, MAX_INVENTORY_PAGE_BYTES):
                return _unavailable_inventory()
            try:
                payload = response.json()
            except (TypeError, ValueError):
                return _unavailable_inventory()
            except _PRICE_STREAM_JSON_ERRORS:
                return _unavailable_inventory()
            page_bytes = _bounded_json_size(payload, MAX_INVENTORY_PAGE_BYTES)
            if page_bytes is None:
                return _unavailable_inventory()
            decoded_inventory_bytes += page_bytes
            if decoded_inventory_bytes > MAX_INVENTORY_BYTES:
                return _unavailable_inventory()
            page = _parse_inventory_page(payload)
            if page is None:
                return _unavailable_inventory()
            if (
                len(assets) + len(page.assets) > MAX_INVENTORY_ASSETS
                or description_count + len(page.descriptions)
                > MAX_INVENTORY_DESCRIPTIONS
            ):
                return _unavailable_inventory()
            page_quantity = sum(asset.quantity for asset in page.assets)
            if total_quantity + page_quantity > MAX_INVENTORY_TOTAL_QUANTITY:
                return _unavailable_inventory()
            assets.extend(page.assets)
            total_quantity += page_quantity
            description_count += len(page.descriptions)
            for description in page.descriptions:
                descriptions.setdefault(
                    (description.class_id, description.instance_id), description
                )

            if not page.more_items:
                break
            next_cursor = page.last_assetid
            if (
                not next_cursor
                or len(next_cursor) > MAX_INVENTORY_CURSOR_LENGTH
                or next_cursor in seen_cursors
            ):
                return _unavailable_inventory()
            cursor = next_cursor

        quantities: dict[tuple[str, str], int] = {}
        for asset in assets:
            key = (asset.class_id, asset.instance_id)
            quantity = quantities.get(key, 0) + asset.quantity
            if quantity > MAX_INVENTORY_TOTAL_QUANTITY:
                return _unavailable_inventory()
            quantities[key] = quantity
        if any(key not in descriptions for key in quantities):
            return _unavailable_inventory()

        items = [
            InventoryItem(
                class_id=description.class_id,
                instance_id=description.instance_id,
                name=description.name,
                market_hash_name=description.market_hash_name,
                quantity=quantities[(description.class_id, description.instance_id)],
                icon_url=description.icon_url,
                marketable=description.marketable,
                tradable=description.tradable,
                item_type=description.item_type,
                game_app_id=description.game_app_id,
                game_name=description.game_name,
                rarity=description.rarity,
                card_border=description.card_border,
                gem_key=description.gem_key,
            )
            for description in descriptions.values()
            if (description.class_id, description.instance_id) in quantities
        ]
        items.sort(
            key=lambda item: (item.name.casefold(), item.class_id, item.instance_id)
        )
        priceable_names = {
            item.market_hash_name
            for item in items
            if item.marketable and item.market_hash_name
        }
        if any(item.gem_key is not None for item in items):
            # The sack is a reference price, not an inventory row and therefore
            # does not affect ordinary SteamApis coverage counts.
            priceable_names.add(SACK_OF_GEMS_MARKET_HASH_NAME)
        booster_games = _booster_games(items)
        booster_names = {
            _booster_market_hash_name(game_app_id, game_name)
            for game_app_id, game_name in booster_games
            if game_name is not None
        }
        try:
            price_lookup = await self.fetch_prices(
                frozenset(priceable_names | booster_names)
            )
        except _PRICE_STREAM_JSON_ERRORS:
            price_lookup = _unavailable_price_lookup()
        except (
            httpx2.HTTPError,
            OSError,
            TimeoutError,
            TypeError,
            ValueError,
            ArithmeticError,
            RuntimeError,
        ):
            price_lookup = _unavailable_price_lookup()

        booster_scan = BoosterScanResult(values={})
        if booster_games:
            try:
                candidate_booster_scan = await self.booster_pricing.resolve(
                    game_app_id for game_app_id, _ in booster_games
                )
                if isinstance(candidate_booster_scan, BoosterScanResult):
                    booster_scan = candidate_booster_scan
            except (
                AttributeError,
                OSError,
                TimeoutError,
                TypeError,
                ValueError,
                ArithmeticError,
                RuntimeError,
            ):
                # Booster lookup failures must never affect inventory or gem data.
                booster_scan = BoosterScanResult(values={})
        boosters = _booster_infos(
            booster_games,
            price_lookup.prices,
            booster_scan.values,
        )
        for index, item in enumerate(items):
            if not item.marketable or item.market_hash_name is None:
                continue
            price = price_lookup.prices.get(item.market_hash_name)
            if price is not None:
                items[index] = item.model_copy(update={"price": price})

        (
            price_status,
            price_message,
            priceable_item_count,
            priced_item_count,
        ) = _price_status_for_items(items)

        gem_groups = _gem_group_representatives(items)
        gem_scan = GemScanResult(values={})
        if gem_groups:
            try:
                gem_scan = await self.gem_pricing.resolve(gem_groups)
            except (
                AttributeError,
                OSError,
                TimeoutError,
                TypeError,
                ValueError,
                ArithmeticError,
                RuntimeError,
            ):
                # Gem failures must never turn an otherwise public inventory
                # into an unavailable response.
                gem_scan = GemScanResult(values={})

        sack_price = price_lookup.prices.get(SACK_OF_GEMS_MARKET_HASH_NAME)
        auxiliary_price_exposed = any(
            booster.price is not None for booster in boosters
        ) or (
            sack_price is not None
            and any(item.item_type == "trading_card" for item in items)
        )
        if price_lookup.used_stale_cache and (
            priced_item_count or auxiliary_price_exposed
        ):
            if priced_item_count and price_status == "complete":
                price_message = "Prices are complete using a cached fallback."
            elif priced_item_count:
                price_message = (
                    "Available prices use a cached fallback; prices are unavailable "
                    "for some marketable inventory items."
                )
            elif priceable_item_count:
                price_message = (
                    "Inventory item prices are unavailable; displayed booster or "
                    "gem market context uses a cached fallback."
                )
            else:
                price_message = (
                    "Displayed booster or gem market context uses a cached fallback."
                )
        for index, item in enumerate(items):
            key = item.gem_key
            if key is None:
                continue
            resolution = gem_scan.values.get(key)
            if resolution is None or getattr(resolution, "key", None) != key:
                continue
            items[index] = item.model_copy(
                update={
                    "gem_yield": resolution.gem_yield,
                    "gem_cash_value": gem_cash_value(
                        resolution.gem_yield,
                        sack_price.lowest_sell if sack_price is not None else None,
                    ),
                }
            )

        (
            gem_status,
            gem_message,
            gem_priceable_item_count,
            gem_priced_item_count,
        ) = _gem_status_for_items(items, gem_scan)
        return InventoryCheck(
            status="public",
            message="Steam inventory is public.",
            total_asset_count=total_quantity,
            unique_item_count=len(items),
            priceable_item_count=priceable_item_count,
            priced_item_count=priced_item_count,
            price_status=price_status,
            price_message=price_message,
            gem_status=gem_status,
            gem_message=gem_message,
            gem_priceable_item_count=gem_priceable_item_count,
            gem_priced_item_count=gem_priced_item_count,
            gem_rate_limited=gem_scan.rate_limited,
            gem_retry_after_seconds=gem_scan.retry_after_seconds,
            gem_cash_context=_gem_cash_context(sack_price)
            if any(item.gem_key is not None for item in items)
            else None,
            items=items,
            boosters=boosters,
        )

    async def fetch_prices(self, requested_names: frozenset[str]) -> _PriceLookup:
        if not requested_names:
            return _PriceLookup(
                status="complete",
                message="No marketable inventory items require prices.",
                prices={},
                priced_names=frozenset(),
            )

        cache_names: set[str] = set(requested_names)
        cache_read = self.price_cache.read(cache_names)
        if self._api_headers() is None:
            return _price_lookup_from_cache(cache_read, requested_names)
        if cache_read.fresh or cache_read.retry_suppressed:
            return _price_lookup_from_cache(cache_read, requested_names)

        task = self._price_refresh_task
        if task is None:
            task = asyncio.create_task(self._refresh_prices())
            self._price_refresh_task = task
            task.add_done_callback(self._discard_price_refresh_task)
        try:
            await asyncio.shield(task)
        finally:
            self._discard_price_refresh_task(task)

        cache_read = self.price_cache.read(cache_names)
        return _price_lookup_from_cache(cache_read, requested_names)

    def read_price_catalog(
        self,
        *,
        max_rows: int | None = None,
    ) -> NormalCardCatalogRead:
        if max_rows is None:
            return self.price_cache.read_catalog()
        return self.price_cache.read_catalog(max_rows=max_rows)

    async def ensure_price_catalog_fresh(
        self,
        *,
        max_age_seconds: int = LEVEL_UP_PRICE_MAX_AGE_SECONDS,
    ) -> bool:
        """Ensure the global generation is fresh under a caller's contract."""

        if (
            isinstance(max_age_seconds, bool)
            or not isinstance(max_age_seconds, int)
            or max_age_seconds <= 0
        ):
            return False
        for _ in range(2):
            cache_read = self.price_cache.read()
            if (
                cache_read.has_generation
                and cache_read.generation_age_seconds is not None
                and cache_read.generation_age_seconds <= max_age_seconds
            ):
                return True
            if self._api_headers() is None or cache_read.retry_suppressed:
                return False
            task = self._price_refresh_task
            if task is None:
                task = asyncio.create_task(
                    self._refresh_prices(max_age_seconds=max_age_seconds)
                )
                self._price_refresh_task = task
                task.add_done_callback(self._discard_price_refresh_task)
            try:
                await asyncio.shield(task)
            finally:
                self._discard_price_refresh_task(task)
        refreshed = self.price_cache.read()
        return (
            refreshed.has_generation
            and refreshed.generation_age_seconds is not None
            and refreshed.generation_age_seconds <= max_age_seconds
        )

    def _discard_price_refresh_task(
        self,
        task: asyncio.Future[bool],
    ) -> None:
        if task.done() and self._price_refresh_task is task:
            self._price_refresh_task = None

    async def _refresh_prices(
        self,
        *,
        max_age_seconds: int = 86_400,
    ) -> bool:
        lock = _price_refresh_lock(self.price_cache)
        async with lock:
            cache_read = self.price_cache.read()
            if (
                cache_read.has_generation
                and cache_read.generation_age_seconds is not None
                and cache_read.generation_age_seconds <= max_age_seconds
            ):
                return True
            if cache_read.retry_suppressed:
                return True
            return await self._refresh_prices_uncached()

    async def _refresh_prices_uncached(self) -> bool:
        headers = self._api_headers()
        api_key = self._api_key
        if headers is None or api_key is None:
            return False
        refresh: SteamApisPriceRefresh | None = None
        try:
            response = await self.http_client.get(
                STEAMAPIS_ITEMS_ENDPOINT,
                headers=headers,
                follow_redirects=False,
            )
            redirect = _validated_bulk_redirect(response, api_key)

            async with (
                _BULK_STREAM_SEMAPHORE,
                self.bulk_http_client.stream(
                    "GET",
                    redirect,
                    follow_redirects=False,
                    timeout=self.bulk_timeout_seconds,
                ) as cdn_response,
            ):
                _validate_bulk_response(cdn_response)
                refresh_session = self.price_cache.begin_refresh()
                refresh = refresh_session
                _, _, stream_summary = await _stream_prices(
                    cdn_response,
                    frozenset(),
                    on_price=lambda name, price: refresh_session.add(
                        name,
                        price.highest_buy,
                        price.lowest_sell,
                        price.observed_at,
                        price.highest_buy_quantity,
                        price.lowest_sell_quantity,
                    ),
                )
            _validate_price_generation(refresh_session, stream_summary)
            refresh_session.commit(optimizer_complete=True)
        except _PRICE_STREAM_JSON_ERRORS:
            pass
        except (
            httpx2.HTTPError,
            OSError,
            TimeoutError,
            TypeError,
            ValueError,
            ArithmeticError,
            RuntimeError,
            AttributeError,
            sqlite3.Error,
        ):
            pass
        except BaseException:
            if refresh is not None:
                refresh.abort()
            raise
        else:
            refresh = None
            return True
        if refresh is not None:
            refresh.abort()
        self.price_cache.record_refresh_failure()
        return False


class SteamGateway:
    """Read-only profile boundary plus SteamApis inventory access."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_client: AsyncHTTPClient,
        bulk_http_client: AsyncHTTPClient | None = None,
        bulk_timeout_seconds: float | None = None,
        price_cache: SteamApisPriceCache | None = None,
        gem_pricing: GemPricingService | None = None,
        booster_pricing: BoosterPricingService | None = None,
        limiter: SteamCommunityLimiter | None = None,
    ) -> None:
        self.settings = settings
        self.http_client = http_client

        self.steamapis = SteamApisClient(
            settings,
            http_client=http_client,
            bulk_http_client=bulk_http_client,
            bulk_timeout_seconds=bulk_timeout_seconds,
            price_cache=price_cache,
            gem_pricing=gem_pricing,
            booster_pricing=booster_pricing,
            limiter=limiter,
        )

    async def start(self) -> None:
        await self.steamapis.start()

    async def stop(self) -> None:
        await self.steamapis.stop()

    async def check_profile(self, steam_id: str) -> ProfileCheck:
        api_key = self.settings.steam_web_api_key
        if not api_key or not api_key.strip():
            return ProfileCheck(
                status="unavailable",
                message=(
                    "Steam profile API is unavailable because no API key is configured."
                ),
            )
        try:
            response = await self.http_client.get(
                PROFILE_ENDPOINT,
                params={"key": api_key, "steamids": steam_id},
            )
        except httpx2.HTTPError:
            return _unavailable_profile()
        if not 200 <= response.status_code < 300:
            return ProfileCheck(
                status="unavailable",
                message="Steam profile API returned an unavailable response.",
            )
        try:
            payload = response.json()
        except ValueError:
            return ProfileCheck(
                status="unavailable",
                message="Steam profile data is unavailable.",
            )
        response_data = (
            payload.get("response") if isinstance(payload, Mapping) else None
        )
        players = (
            response_data.get("players") if isinstance(response_data, Mapping) else None
        )
        if (
            not isinstance(players, list)
            or not players
            or not isinstance(players[0], Mapping)
        ):
            return ProfileCheck(
                status="unavailable",
                message="Steam profile data is unavailable.",
            )
        player = players[0]
        display_name = _text_or_none(player.get("personaname"))
        avatar_url = _text_or_none(player.get("avatarfull"))
        visibility = player.get("communityvisibilitystate")
        if not _is_integer(visibility):
            return ProfileCheck(
                status="unavailable",
                message="Steam profile visibility data is unavailable.",
                display_name=display_name,
                avatar_url=avatar_url,
            )
        if visibility == 3:
            return ProfileCheck(
                status="public",
                message="Steam profile is public.",
                display_name=display_name,
                avatar_url=avatar_url,
            )
        if visibility in (1, 2):
            return ProfileCheck(
                status="private",
                message="Steam profile is not public.",
                display_name=display_name,
                avatar_url=avatar_url,
            )
        return ProfileCheck(
            status="unavailable",
            message="Steam profile visibility data is unavailable.",
            display_name=display_name,
            avatar_url=avatar_url,
        )

    async def check_inventory(self, steam_id: str) -> InventoryCheck:
        return await self.steamapis.fetch_inventory(steam_id)

    async def check_badges(self, steam_id: str) -> BadgeCheck:
        try:
            badge_state = await self._fetch_badge_state(steam_id, ())
            if not isinstance(badge_state, BadgeState):
                return _unavailable_badges()
            return BadgeCheck(
                status="public",
                message="Steam badge data is available.",
                player_xp=badge_state.player_xp,
                player_level=badge_state.player_level,
            )
        except Exception:  # noqa: BLE001 - map badge failures to unavailable
            return _unavailable_badges()

    async def _fetch_badge_state(
        self,
        steam_id: str,
        relevant_app_ids: Collection[int],
    ) -> BadgeState:
        headers = self.steamapis._api_headers()
        if headers is None:
            raise InvalidSteamApisPayloadError
        headers["Accept-Encoding"] = "identity"
        if (
            not isinstance(steam_id, str)
            or not steam_id
            or len(steam_id) > 20
            or not _ASCII_DIGITS.fullmatch(steam_id)
        ):
            raise InvalidSteamApisPayloadError
        url = STEAMAPIS_BADGES_ENDPOINT.format(
            steam_id=quote(steam_id, safe=""),
        )
        async with self.http_client.stream(
            "GET",
            url,
            headers=headers,
            follow_redirects=False,
        ) as response:
            if (
                not 200 <= response.status_code < 300
                or not _response_content_is_identity(response)
                or not _response_content_length_within(
                    response, MAX_BADGE_RESPONSE_BYTES
                )
            ):
                raise InvalidSteamApisPayloadError
            body = bytearray()
            try:
                async for chunk in response.aiter_bytes():
                    _append_bounded_bytes(body, chunk, MAX_BADGE_RESPONSE_BYTES)
            except InvalidSteamApisPayloadError:
                raise
            except (TypeError, ValueError, OSError, RuntimeError) as error:
                raise InvalidSteamApisPayloadError from error
        raw_body = bytes(body)
        _preflight_badge_json_body(raw_body)
        try:
            payload = json.loads(
                raw_body.decode("utf-8"),
                object_pairs_hook=reject_duplicate_object_keys,
            )
        except (TypeError, UnicodeDecodeError, ValueError, RecursionError):
            raise InvalidSteamApisPayloadError from None
        return _parse_badges_payload(payload, relevant_app_ids)

    async def check_level_up(
        self,
        steam_id: str,
        holdings: Sequence[Holding],
        inventory_refreshed_at: datetime | str | int,
        *,
        now: datetime | str | int | None = None,
    ) -> LevelUpOptimizationResponse:
        """Return one read-only recommendation without touching inventory APIs."""

        current = _level_up_timestamp(now) if now is not None else datetime.now(UTC)
        if current is None:
            current = datetime.now(UTC)
        inventory_time = _level_up_timestamp(inventory_refreshed_at)
        safe_inventory_time = inventory_time or current
        try:
            contract = self.settings.level_up_money_contract
        except (AttributeError, TypeError, ValueError, ArithmeticError):
            contract = None
        if contract is None:
            return _level_up_response(
                status="unavailable",
                reason="currency_contract_missing",
                now=current,
                inventory_time=safe_inventory_time,
                contract=None,
            )
        api_key = self.settings.steamapi_key
        if not isinstance(api_key, str) or not api_key.strip():
            return _level_up_response(
                status="unavailable",
                reason="steamapi_key_missing",
                now=current,
                inventory_time=safe_inventory_time,
                contract=contract,
            )
        if inventory_time is None or current < inventory_time:
            return _level_up_response(
                status="unavailable",
                reason="inventory_snapshot_too_old",
                now=current,
                inventory_time=safe_inventory_time,
                contract=contract,
            )
        try:
            inventory_age = current - inventory_time
            inventory_limit = contract.max_inventory_age_seconds
            inventory_valid = inventory_age <= timedelta(seconds=inventory_limit)
        except (AttributeError, TypeError, ValueError, OverflowError):
            inventory_valid = False
        if not inventory_valid:
            return _level_up_response(
                status="unavailable",
                reason="inventory_snapshot_too_old",
                now=current,
                inventory_time=safe_inventory_time,
                contract=contract,
            )
        quote_limit = getattr(contract, "max_quote_age_seconds", None)
        if (
            isinstance(quote_limit, bool)
            or not isinstance(quote_limit, int)
            or quote_limit <= 0
        ):
            return _level_up_response(
                status="unavailable",
                reason="price_generation_unavailable",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
            )

        try:
            price_ready = await self.steamapis.ensure_price_catalog_fresh(
                max_age_seconds=quote_limit
            )
            catalog_read = self.steamapis.read_price_catalog(
                max_rows=MAX_LEVEL_UP_CATALOG_ROWS
            )
        except (
            OSError,
            TimeoutError,
            TypeError,
            ValueError,
            ArithmeticError,
            RuntimeError,
            sqlite3.Error,
        ):
            price_ready = False
            catalog_read = NormalCardCatalogRead(0, None, {})
        if now is None:
            current = datetime.now(UTC)
        if not price_ready:
            reason = (
                "price_generation_stale"
                if catalog_read.has_generation
                else "price_generation_unavailable"
            )
            return _level_up_response(
                status="unavailable",
                reason=reason,
                now=current,
                inventory_time=inventory_time,
                contract=contract,
            )
        if (
            catalog_read.generation <= 0
            or catalog_read.refreshed_at is None
            or catalog_read.truncated
            or not catalog_read.optimizer_complete
        ):
            return _level_up_response(
                status="unavailable",
                reason="price_generation_unavailable",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
            )
        try:
            generated_at = datetime.fromtimestamp(catalog_read.refreshed_at, UTC)
        except (OverflowError, OSError, ValueError, TypeError):
            return _level_up_response(
                status="unavailable",
                reason="price_generation_unavailable",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
            )
        freshness_issue = _level_up_snapshot_issue(
            current=current,
            inventory_time=inventory_time,
            generated_at=generated_at,
            inventory_limit=contract.max_inventory_age_seconds,
            quote_limit=quote_limit,
        )
        if freshness_issue is not None:
            return _level_up_response(
                status="unavailable",
                reason=freshness_issue,
                now=current,
                inventory_time=inventory_time,
                contract=contract,
            )
        if not holdings:
            return _level_up_response(
                status="no_opportunity",
                reason="no_sellable_card",
                now=current,
                inventory_time=safe_inventory_time,
                contract=contract,
            )

        groups = _catalog_groups(catalog_read)
        if not groups:
            return _level_up_response(
                status="no_opportunity",
                reason="no_sellable_card",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
            )

        # Validate the caller-owned snapshot before constructing any maps.  In
        # particular, silently overwriting a duplicate hash could change which
        # quantity is sold and would make the recommendation non-deterministic.
        normalized_holdings: list[Holding] = []
        seen_holding_hashes: set[str] = set()
        for holding in holdings:
            if not isinstance(holding, Holding):
                return _level_up_response(
                    status="unavailable",
                    reason="quote_depth_unavailable",
                    now=current,
                    inventory_time=inventory_time,
                    contract=contract,
                    total_sets=len(groups),
                    resolved_sets=len(groups),
                )
            if holding.market_hash_name in seen_holding_hashes:
                return _level_up_response(
                    status="unavailable",
                    reason="quote_depth_unavailable",
                    now=current,
                    inventory_time=inventory_time,
                    contract=contract,
                    total_sets=len(groups),
                    resolved_sets=len(groups),
                )
            seen_holding_hashes.add(holding.market_hash_name)
            normalized_holdings.append(holding)
        holdings_by_hash = {
            holding.market_hash_name: holding for holding in normalized_holdings
        }

        # Source discovery is intentionally card-granular and does not consult
        # badge level.  A maxed source game can still provide a sellable card
        # that funds a badge in another (or the same) game.
        source_app_ids = tuple(
            app_id
            for app_id, cards in groups.items()
            if any(
                (
                    (holding := holdings_by_hash.get(card.market_hash_name)) is not None
                    and holding.owned_quantity >= 1
                    and holding.sellable_quantity >= 1
                )
                for card in cards
            )
        )
        if not source_app_ids:
            return _level_up_response(
                status="no_opportunity",
                reason="no_sellable_card",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
                total_sets=len(groups),
                resolved_sets=len(groups),
            )

        # The badge request remains bounded to one response, but its relevance
        # covers every catalog group so an omitted normal badge correctly
        # defaults to level zero and cannot make an eligible destination look
        # maxed (or vice versa).
        try:
            badge_state = await self._fetch_badge_state(steam_id, groups)
        except (
            InvalidSteamApisPayloadError,
            httpx2.HTTPError,
            OSError,
            TimeoutError,
            TypeError,
            ValueError,
            ArithmeticError,
            RuntimeError,
        ):
            return _level_up_response(
                status="unavailable",
                reason="badge_data_unavailable",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
            )
        if now is None:
            current = datetime.now(UTC)
        freshness_issue = _level_up_snapshot_issue(
            current=current,
            inventory_time=inventory_time,
            generated_at=generated_at,
            inventory_limit=contract.max_inventory_age_seconds,
            quote_limit=quote_limit,
        )
        if freshness_issue is not None:
            return _level_up_response(
                status="unavailable",
                reason=freshness_issue,
                now=current,
                inventory_time=inventory_time,
                contract=contract,
            )

        provider = self.steamapis.booster_pricing

        async def resolve_metadata(
            candidate_ids: tuple[str, ...],
        ) -> tuple[dict[str, BoosterResolution], tuple[str, ...]]:
            """Read metadata and warm at most one bounded pending shortlist."""

            candidate_ids = tuple(dict.fromkeys(candidate_ids))
            if not candidate_ids:
                return {}, ()

            def read_metadata_state() -> tuple[
                dict[str, BoosterResolution], tuple[str, ...]
            ]:
                state = provider.read_metadata_state(candidate_ids)
                if not isinstance(state, BoosterMetadataState):
                    return {}, candidate_ids
                candidate_set = set(candidate_ids)
                values: dict[str, BoosterResolution] = {}
                for key, value in state.values.items():
                    key_text = str(key)
                    if (
                        key_text in candidate_set
                        and isinstance(value, BoosterResolution)
                        and value.game_name is not None
                    ):
                        values[key_text] = value
                pending: list[str] = []
                for value in state.pending_app_ids:
                    if value in candidate_set and value not in pending:
                        pending.append(value)
                rejected = {
                    value for value in state.rejected_app_ids if value in candidate_set
                }
                # A malformed/incomplete state must warm rather than being
                # treated as a deliberately rejected game.
                for value in candidate_ids:
                    if (
                        value not in values
                        and value not in rejected
                        and value not in pending
                    ):
                        pending.append(value)
                return values, tuple(pending)

            try:
                fresh_values, pending_ids = read_metadata_state()
            except (
                AttributeError,
                OSError,
                TypeError,
                ValueError,
                ArithmeticError,
                RuntimeError,
                sqlite3.Error,
            ):
                fresh_values, pending_ids = {}, candidate_ids
            if pending_ids:
                shortlist = pending_ids[:MAX_LEVEL_UP_METADATA_APPS]
                with suppress(
                    AttributeError,
                    OSError,
                    TimeoutError,
                    TypeError,
                    ValueError,
                    ArithmeticError,
                    RuntimeError,
                    sqlite3.Error,
                ):
                    await provider.resolve(
                        shortlist,
                        require_game_name=True,
                    )
                try:
                    fresh_values, pending_ids = read_metadata_state()
                except (
                    AttributeError,
                    OSError,
                    TypeError,
                    ValueError,
                    ArithmeticError,
                    RuntimeError,
                    sqlite3.Error,
                ):
                    fresh_values, pending_ids = {}, candidate_ids
            return fresh_values, pending_ids

        def qualified_resolution(
            app_id: int,
            values: Mapping[str, BoosterResolution],
        ) -> BoosterResolution | None:
            resolution = values.get(str(app_id))
            if not isinstance(resolution, BoosterResolution):
                return None
            cards = groups.get(app_id)
            game_name = resolution.game_name
            if (
                cards is None
                or resolution.card_set_size != len(cards)
                or not isinstance(game_name, str)
                or not game_name.strip()
            ):
                return None
            return resolution

        source_candidate_ids = tuple(str(app_id) for app_id in source_app_ids)
        source_values, pending_ids = await resolve_metadata(source_candidate_ids)
        if now is None:
            current = datetime.now(UTC)
        freshness_issue = _level_up_snapshot_issue(
            current=current,
            inventory_time=inventory_time,
            generated_at=generated_at,
            inventory_limit=contract.max_inventory_age_seconds,
            quote_limit=quote_limit,
        )
        if freshness_issue is not None:
            return _level_up_response(
                status="unavailable",
                reason=freshness_issue,
                now=current,
                inventory_time=inventory_time,
                contract=contract,
                total_sets=len(source_candidate_ids),
                resolved_sets=len(source_values),
            )
        if pending_ids:
            total_sets = len(source_candidate_ids)
            return _level_up_response(
                status="warming",
                reason="catalog_warming",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
                total_sets=total_sets,
                resolved_sets=max(0, total_sets - len(pending_ids)),
                pending_sets=len(pending_ids),
            )
        qualified_source_resolutions = {
            app_id: resolution
            for app_id in source_app_ids
            if (resolution := qualified_resolution(app_id, source_values)) is not None
        }
        if not qualified_source_resolutions:
            return _level_up_response(
                status="no_opportunity",
                reason="no_sellable_card",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
                total_sets=len(source_candidate_ids),
                resolved_sets=len(source_candidate_ids),
            )

        # Build a safe destination metadata shortlist.  The pure optimizer
        # performs the authoritative side quote/depth/fee checks; this pass
        # only avoids warming destinations whose original missing-card subtotal
        # cannot fit under any individually sellable source receipt.  Source
        # apps are retained even when selling the only copy creates a new
        # missing card, so same-app routes remain visible to the optimizer.
        max_receipt: int | None = None
        for app_id in qualified_source_resolutions:
            for card in groups[app_id]:
                holding = holdings_by_hash.get(card.market_hash_name)
                if (
                    holding is None
                    or holding.owned_quantity < 1
                    or holding.sellable_quantity < 1
                ):
                    continue
                buyer_total = _level_up_quote_amount(
                    card,
                    side="buy",
                    now=current,
                    quote_window=quote_limit,
                    contract=contract,
                    require_depth=True,
                )
                if buyer_total is None:
                    continue
                receipt = seller_receipt_from_buyer_total(buyer_total, contract)
                if receipt is not None and (
                    max_receipt is None or receipt > max_receipt
                ):
                    max_receipt = receipt
        if max_receipt is None:
            return _level_up_response(
                status="no_opportunity",
                reason="no_sellable_card",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
                total_sets=len(source_candidate_ids),
                resolved_sets=len(qualified_source_resolutions),
            )

        destination_app_ids: list[int] = []
        qualified_source_ids = frozenset(qualified_source_resolutions)
        for app_id, cards in groups.items():
            if badge_state.level_for_game(app_id) >= 5:
                continue
            if app_id in qualified_source_ids:
                destination_app_ids.append(app_id)
                continue
            missing_cards = tuple(
                card
                for card in cards
                if (
                    holdings_by_hash.get(card.market_hash_name) is None
                    or holdings_by_hash[card.market_hash_name].owned_quantity < 1
                )
            )
            if not missing_cards:
                continue
            subtotal = 0
            valid = True
            for card in missing_cards:
                amount = _level_up_quote_amount(
                    card,
                    side="sell",
                    now=current,
                    quote_window=quote_limit,
                    contract=contract,
                    require_depth=True,
                )
                if amount is None:
                    valid = False
                    break
                subtotal += amount
                if subtotal > 2**63 - 1:
                    valid = False
                    break
            if valid and subtotal <= max_receipt:
                destination_app_ids.append(app_id)
        destination_app_ids = sorted(set(destination_app_ids))
        destination_ids = tuple(str(app_id) for app_id in destination_app_ids)
        destination_values, pending_ids = await resolve_metadata(destination_ids)
        if now is None:
            current = datetime.now(UTC)
        freshness_issue = _level_up_snapshot_issue(
            current=current,
            inventory_time=inventory_time,
            generated_at=generated_at,
            inventory_limit=contract.max_inventory_age_seconds,
            quote_limit=quote_limit,
        )
        if freshness_issue is not None:
            return _level_up_response(
                status="unavailable",
                reason=freshness_issue,
                now=current,
                inventory_time=inventory_time,
                contract=contract,
                total_sets=len(destination_ids),
                resolved_sets=len(destination_values),
            )
        if pending_ids:
            total_sets = len(destination_ids)
            return _level_up_response(
                status="warming",
                reason="catalog_warming",
                now=current,
                inventory_time=inventory_time,
                contract=contract,
                total_sets=total_sets,
                resolved_sets=max(0, total_sets - len(pending_ids)),
                pending_sets=len(pending_ids),
            )

        all_resolutions: dict[int, BoosterResolution] = dict(
            qualified_source_resolutions
        )
        for app_id in destination_app_ids:
            resolution = qualified_resolution(app_id, destination_values)
            if resolution is not None:
                all_resolutions[app_id] = resolution

        resolved_sets: list[CatalogSet] = []
        for app_id, resolution in sorted(all_resolutions.items()):
            game_name = resolution.game_name
            if not isinstance(game_name, str) or not game_name.strip():
                continue
            try:
                resolved_sets.append(
                    CatalogSet(
                        app_id=app_id,
                        game_name=game_name.strip(),
                        cards=groups[app_id],
                        set_size=resolution.card_set_size,
                        resolved=True,
                    )
                )
            except (OptimizerInputError, TypeError, ValueError, ArithmeticError):
                continue
        complete_catalog = ResolvedCatalog(
            generation=catalog_read.generation,
            generated_at=generated_at,
            sets=tuple(resolved_sets),
            complete=True,
        )
        catalog_hashes = {
            card.market_hash_name
            for current_set in complete_catalog.sets
            for card in current_set.cards
        }
        filtered_holdings = tuple(
            holding
            for holding in normalized_holdings
            if holding.market_hash_name in catalog_hashes
        )
        try:
            return optimize_level_up(
                complete_catalog,
                filtered_holdings,
                badge_state,
                inventory_time,
                current,
                contract,
            )
        except OptimizerInputError as error:
            reason = error.reason
            if reason not in {
                "inventory_snapshot_too_old",
                "price_generation_unavailable",
                "price_generation_stale",
                "quote_depth_unavailable",
                "badge_data_unavailable",
                "currency_contract_missing",
            }:
                reason = "quote_depth_unavailable"
            return _level_up_response(
                status="unavailable",
                reason=reason,
                now=current,
                inventory_time=inventory_time,
                contract=contract,
                total_sets=len(groups),
                resolved_sets=len(resolved_sets),
            )

    async def refresh_gems(
        self,
        keys: Iterable[GemKey],
    ) -> GemScanResult:
        return self.steamapis.gem_pricing.read_cached(keys)

    async def refresh_boosters(
        self,
        game_app_ids: Iterable[str],
    ) -> BoosterScanResult:
        return self.steamapis.booster_pricing.read_cached(game_app_ids)
