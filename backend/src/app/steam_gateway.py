from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Literal, Protocol
from urllib.parse import quote, unquote, urljoin, urlsplit

import httpx2
import ijson
from ijson.common import IncompleteJSONError, JSONError
from pydantic import BaseModel, Field, field_validator, model_validator

from app.gem_pricing import (
    SACK_OF_GEMS_MARKET_HASH_NAME,
    CardRarity,
    GemPricingService,
    GemScanResult,
    canonical_decimal,
    gem_cash_value,
    parse_card_metadata,
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
_CANONICAL_GEM_CASH_VALUE_ERROR = "Gem cash value must be a canonical decimal."
_INVALID_ITEM_GEM_METADATA_ERROR = "Inventory item gem metadata is inconsistent."

CheckStatus = Literal["public", "private", "unavailable"]
PriceStatus = Literal["complete", "partial", "unavailable"]
GemStatus = Literal["complete", "partial", "unavailable"]
InventoryItemType = Literal["trading_card", "other"]

_ASCII_DIGITS = re.compile(r"^[0-9]+$")
_PRIVATE_INVENTORY_MESSAGE = (
    "Could not retrieve user inventory. Make sure profile and inventory is public. "
    "(403) (403)"
)
MAX_RETRY_AFTER_SECONDS = 900

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
MAX_PRICE_STREAM_BYTES = 512 * 1024 * 1024
MAX_PRICE_STREAM_NESTING = 64
MAX_PRICE_STREAM_TOKENS = 100_000_000
MAX_PRICE_STREAM_SCALAR_LENGTH = 16_384
MAX_CONCURRENT_BULK_STREAMS = 1

STEAM_ICON_HOSTNAME = "community.cloudflare.steamstatic.com"
STEAMAPIS_BULK_HOST_SUFFIX = ".r2.cloudflarestorage.com"
_BULK_STREAM_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_BULK_STREAMS)
_MAX_OBSERVED_AT_DECIMAL = Decimal(MAX_OBSERVED_AT_MILLISECONDS)
_PRICE_STREAM_JSON_ERRORS = (IncompleteJSONError, JSONError)


class InvalidSteamApisPayloadError(ValueError):
    """Raised when SteamApis returns a malformed bounded payload."""


class CheckResult(BaseModel):
    status: CheckStatus
    message: str


class ProfileCheck(CheckResult):
    display_name: str | None = None
    avatar_url: str | None = None


class InventoryPrice(BaseModel):
    currency: Literal[None] = None
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
    observed_at: str | None = None


class GemCashContext(BaseModel):
    currency: Literal[None] = None
    basis: Literal["lowest_sell"] = "lowest_sell"
    market_hash_name: Literal["753-Sack of Gems"] = SACK_OF_GEMS_MARKET_HASH_NAME
    sack_gems: Literal[1000] = 1000
    sack_price: str = Field(
        pattern=r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$",
        max_length=MAX_PRICE_STREAM_SCALAR_LENGTH,
    )
    observed_at: str | None = None

    @field_validator("sack_price")
    @classmethod
    def require_canonical_sack_price(cls, value: str) -> str:
        if canonical_decimal(value) != value:
            raise ValueError(_CANONICAL_SACK_PRICE_ERROR)
        return value


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
    game_name: str | None = None
    card_rarity: CardRarity | None = None
    gem_yield: int | None = Field(default=None, ge=0)
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
        if self.item_type == "other":
            if any(
                value is not None
                for value in (
                    self.game_app_id,
                    self.game_name,
                    self.card_rarity,
                    self.gem_yield,
                    self.gem_cash_value,
                )
            ):
                raise ValueError(_INVALID_ITEM_GEM_METADATA_ERROR)
            return self
        if self.game_app_id is None:
            if any(
                value is not None
                for value in (
                    self.game_name,
                    self.card_rarity,
                    self.gem_yield,
                    self.gem_cash_value,
                )
            ):
                raise ValueError(_INVALID_ITEM_GEM_METADATA_ERROR)
            return self
        if self.card_rarity is None or (
            self.gem_cash_value is not None and self.gem_yield is None
        ):
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

    async def check_inventory(self, steam_id: str) -> InventoryCheck:
        """Fetch and price a Steam inventory."""
        ...

    async def refresh_gems(
        self,
        groups: Mapping[tuple[str, CardRarity], None],
    ) -> GemScanResult:
        """Read cached gem values without fetching a Steam inventory."""
        ...


def _text_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _is_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_private_inventory_error(value: Mapping[str, object]) -> bool:
    """Recognize only SteamApis' verified private-inventory response."""

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
    card_rarity: CardRarity | None


@dataclass(frozen=True, slots=True)
class _InventoryPage:
    assets: tuple[_Asset, ...]
    descriptions: tuple[_Description, ...]
    more_items: bool
    last_assetid: str | None


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
            or len(market_hash_name) > MAX_INVENTORY_TEXT_LENGTH
        ):
            return None
        marketable = _flag(raw_description.get("marketable"))
        tradable = _flag(raw_description.get("tradable"))
        if marketable is None or tradable is None:
            return None
        metadata = parse_card_metadata(raw_description.get("tags"))
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
                card_rarity=metadata.card_rarity,
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
    """Estimate decoded JSON size without serializing or recursing."""

    total = 0
    pending: list[tuple[object, int]] = [(value, 0)]
    while pending:
        current, depth = pending.pop()
        if depth > MAX_INVENTORY_NESTING:
            return None
        if isinstance(current, Mapping):
            total += 16 + len(current) * 8
            for key, child in current.items():
                pending.append((child, depth + 1))
                if isinstance(key, str):
                    total += len(key)
        elif isinstance(current, list):
            total += 16 + len(current) * 8
            pending.extend((child, depth + 1) for child in current)
        elif isinstance(current, (str, bytes, bytearray, memoryview)):
            total += len(current)
        else:
            total += 32
        if total > maximum:
            return None
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
    priceable_count = sum(item.item_type == "trading_card" for item in items)
    priced_count = sum(
        item.item_type == "trading_card" and item.gem_yield is not None
        for item in items
    )
    if priceable_count == 0:
        return (
            "complete",
            "No trading cards require gem prices.",
            priceable_count,
            priced_count,
        )
    if priced_count == priceable_count:
        message = "Gem prices are current for all trading cards."
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
            message = "Gem prices are unavailable for some trading cards."
    elif scan.pending_count:
        message = "Gem prices are pending for some trading cards."
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
    if price is None or price.lowest_sell is None:
        return None
    sack_price = canonical_decimal(price.lowest_sell)
    if sack_price is None:
        return None
    return GemCashContext(sack_price=sack_price, observed_at=price.observed_at)


def _gem_group_representatives(
    items: list[InventoryItem],
) -> dict[tuple[str, CardRarity], str | None]:
    groups: dict[tuple[str, CardRarity], str | None] = {}
    for item in items:
        if (
            item.item_type != "trading_card"
            or item.game_app_id is None
            or item.card_rarity is None
        ):
            continue
        key = (item.game_app_id, item.card_rarity)
        market_hash_name = item.market_hash_name
        existing = groups.get(key)
        if existing is None or (
            market_hash_name is not None and market_hash_name < existing
        ):
            groups[key] = market_hash_name
    return groups


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


@dataclass(frozen=True, slots=True)
class _PriceLookup:
    status: PriceStatus
    message: str
    prices: Mapping[str, InventoryPrice]
    priced_names: frozenset[str]


@dataclass(slots=True)
class _PriceFrame:
    parent_key: str | None
    pending_key: str | None = None
    market_hash_name: str | None = None
    highest_buy: object = None
    lowest_sell: object = None
    observed_at: object = None


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
    previous = prices.get(name)
    if previous is not None:
        price = InventoryPrice(
            highest_buy=(
                previous.highest_buy
                if previous.highest_buy is not None
                else price.highest_buy
            ),
            lowest_sell=(
                previous.lowest_sell
                if previous.lowest_sell is not None
                else price.lowest_sell
            ),
            observed_at=previous.observed_at or price.observed_at,
        )
    prices[name] = price
    priced_names.add(name)


async def _stream_prices(
    response: HTTPResponse,
    requested_names: frozenset[str],
) -> tuple[dict[str, InventoryPrice], set[str]]:
    prices: dict[str, InventoryPrice] = {}
    priced_names: set[str] = set()
    stack: list[_PriceFrame] = []
    nesting = 0
    token_count = 0

    async for _prefix, event, value in ijson.parse_async(
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
            if parent is not None:
                parent.pending_key = None
            stack.append(_PriceFrame(parent_key=parent_key))
            continue
        if event == "end_map":
            if not stack:
                raise InvalidSteamApisPayloadError
            frame = stack.pop()
            nesting -= 1
            if frame.parent_key == "orderBook" and stack:
                parent = stack[-1]
                if frame.highest_buy is not None:
                    parent.highest_buy = frame.highest_buy
                if frame.lowest_sell is not None:
                    parent.lowest_sell = frame.lowest_sell
            if frame.market_hash_name:
                raw_name = frame.market_hash_name
                decoded_name = unquote(raw_name)
                matches = (
                    (raw_name,)
                    if decoded_name == raw_name
                    else (raw_name, decoded_name)
                )
                matched_names = tuple(
                    candidate for candidate in matches if candidate in requested_names
                )
                # Do not parse numbers or allocate an InventoryPrice for the
                # hundreds of thousands of unrequested feed entries.
                if matched_names:
                    price = _price_from_frame(frame)
                    for candidate in matched_names:
                        _merge_price(prices, priced_names, candidate, price)
            continue
        if event == "map_key":
            if not stack or not isinstance(value, str):
                raise InvalidSteamApisPayloadError
            stack[-1].pending_key = value
            continue
        if event == "start_array":
            nesting += 1
            if nesting > MAX_PRICE_STREAM_NESTING:
                raise InvalidSteamApisPayloadError
            if stack:
                stack[-1].pending_key = None
            continue
        if event == "end_array":
            nesting -= 1
            if nesting < 0:
                raise InvalidSteamApisPayloadError
            continue
        if not stack:
            continue
        frame = stack[-1]
        key = frame.pending_key
        frame.pending_key = None
        if key in ("marketHashName", "market_hash_name") and event == "string":
            frame.market_hash_name = value
        elif key in ("highestBuy", "highest_buy") and frame.parent_key == "orderBook":
            frame.highest_buy = value
        elif key in ("lowestSell", "lowest_sell") and frame.parent_key == "orderBook":
            frame.lowest_sell = value
        elif key in ("updatedAt", "updated_at") and event in ("number", "string"):
            frame.observed_at = value

    if stack or nesting:
        raise InvalidSteamApisPayloadError
    return prices, priced_names


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
        self.gem_pricing = gem_pricing or GemPricingService(
            settings, http_client=http_client
        )

    async def start(self) -> None:
        await self.gem_pricing.start()

    async def stop(self) -> None:
        inventory_tasks = tuple(self._inventory_inflight.values())
        for task in inventory_tasks:
            if not task.done():
                task.cancel()
        if inventory_tasks:
            await asyncio.gather(*inventory_tasks, return_exceptions=True)
        self._inventory_inflight.clear()
        await self.gem_pricing.stop()

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
                card_rarity=description.card_rarity,
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
        if any(item.item_type == "trading_card" for item in items):
            # The sack is a reference price, not an inventory row and therefore
            # does not affect ordinary SteamApis coverage counts.
            priceable_names.add(SACK_OF_GEMS_MARKET_HASH_NAME)
        try:
            price_lookup = await self.fetch_prices(frozenset(priceable_names))
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
        for index, item in enumerate(items):
            if item.item_type != "trading_card":
                continue
            key = (
                (item.game_app_id, item.card_rarity)
                if item.game_app_id is not None and item.card_rarity is not None
                else None
            )
            resolution = gem_scan.values.get(key) if key is not None else None
            if resolution is None:
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
            if any(item.item_type == "trading_card" for item in items)
            else None,
            items=items,
        )

    async def fetch_prices(self, requested_names: frozenset[str]) -> _PriceLookup:
        if not requested_names:
            return _PriceLookup(
                status="complete",
                message="No marketable inventory items require prices.",
                prices={},
                priced_names=frozenset(),
            )
        headers = self._api_headers()
        if headers is None:
            return _unavailable_price_lookup()
        try:
            response = await self.http_client.get(
                STEAMAPIS_ITEMS_ENDPOINT,
                headers=headers,
                follow_redirects=False,
            )
        except (httpx2.HTTPError, OSError, TimeoutError, RuntimeError):
            return _unavailable_price_lookup()
        if response.status_code not in (301, 302, 303, 307, 308):
            return _unavailable_price_lookup()
        response_headers = getattr(response, "headers", None)
        if not isinstance(response_headers, Mapping):
            return _unavailable_price_lookup()
        location = _header(response_headers, "location")
        if not isinstance(location, str) or not location:
            return _unavailable_price_lookup()
        redirect = urljoin(STEAMAPIS_ITEMS_ENDPOINT, location)
        try:
            parsed = urlsplit(redirect)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            return _unavailable_price_lookup()
        api_key = self._api_key
        if (
            parsed.scheme.casefold() != "https"
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or hostname is None
            or not hostname.casefold().endswith(STEAMAPIS_BULK_HOST_SUFFIX)
            or port not in (None, 443)
            or api_key is None
            or api_key in redirect
            or api_key in unquote(redirect)
            or any(
                part.split("=", 1)[0].casefold() == "x-api-key"
                for part in unquote(parsed.query).split("&")
                if part
            )
        ):
            return _unavailable_price_lookup()
        try:
            async with (
                _BULK_STREAM_SEMAPHORE,
                self.bulk_http_client.stream(
                    "GET",
                    redirect,
                    follow_redirects=False,
                    timeout=self.bulk_timeout_seconds,
                ) as cdn_response,
            ):
                if not 200 <= cdn_response.status_code < 300:
                    return _unavailable_price_lookup()
                prices, priced_names = await _stream_prices(
                    cdn_response, requested_names
                )
        except _PRICE_STREAM_JSON_ERRORS:
            return _unavailable_price_lookup()
        except (
            httpx2.HTTPError,
            OSError,
            TimeoutError,
            TypeError,
            ValueError,
            ArithmeticError,
            RuntimeError,
        ):
            return _unavailable_price_lookup()

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
        )


class SteamGateway:
    """Read-only profile boundary plus SteamApis inventory access."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_client: AsyncHTTPClient,
        bulk_http_client: AsyncHTTPClient | None = None,
        bulk_timeout_seconds: float | None = None,
    ) -> None:
        self.settings = settings
        self.http_client = http_client

        self.steamapis = SteamApisClient(
            settings,
            http_client=http_client,
            bulk_http_client=bulk_http_client,
            bulk_timeout_seconds=bulk_timeout_seconds,
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

    async def refresh_gems(
        self,
        groups: Mapping[tuple[str, CardRarity], None],
    ) -> GemScanResult:
        return self.steamapis.gem_pricing.read_cached(groups)
