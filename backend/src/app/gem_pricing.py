from __future__ import annotations

import asyncio
import math
import re
import sqlite3
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol
from urllib.parse import quote

import httpx2
from ijson.common import IncompleteJSONError, JSONError

if TYPE_CHECKING:
    from app.http_protocols import AsyncHTTPClient, HTTPResponse
    from app.settings import Settings


STEAM_COMMUNITY_BASE_URL = "https://steamcommunity.com"
STEAM_MARKET_LISTING_RENDER_ENDPOINT = (
    f"{STEAM_COMMUNITY_BASE_URL}/market/listings/753/{{market_hash_name}}/render/"
)
STEAM_GOO_VALUE_ENDPOINT = (
    f"{STEAM_COMMUNITY_BASE_URL}/auction/ajaxgetgoovalueforitemtype/"
)
STEAM_COMMUNITY_REFERER = f"{STEAM_COMMUNITY_BASE_URL}/market/"
STEAM_COMMUNITY_COOKIE = "bMarketOptOut=1"
STEAM_OPTIMIZER_USER_AGENT = (
    "SteamOptimizer/0.1.1 (+https://github.com/TheRockPusher/Steam_Optimizer)"
)
SACK_OF_GEMS_MARKET_HASH_NAME: Literal["753-Sack of Gems"] = "753-Sack of Gems"
SACK_OF_GEMS_GEM_COUNT = 1000
GEM_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
GEM_NEGATIVE_CACHE_TTL_SECONDS = 5 * 60
MAX_GEM_YIELD = 1_000_000_000
MAX_GEM_ITEM_TYPE = 1_000_000_000
MAX_GEM_APP_ID_LENGTH = 20
MAX_GEM_MARKET_HASH_NAME_LENGTH = 8192
MAX_GEM_PRICE_DECIMAL_DIGITS = 64
MAX_GEM_LISTING_BYTES = 8 * 1024 * 1024
MAX_GEM_LISTING_NESTING = 32
MAX_GEM_LISTING_SCALAR_LENGTH = 16 * 1024
MAX_RETRY_AFTER_SECONDS = 900
MIN_CIRCUIT_OPEN_SECONDS = 60
_GEM_HTTP_CLIENT_ERROR = "http_client is required without a gem provider."


CardRarity = Literal["normal", "foil"]

_ASCII_DIGITS = re.compile(r"[0-9]+")
_APP_TAG = re.compile(r"app_([0-9]+)")

_GOO_VALUE_ACTION = re.compile(
    r"^\s*javascript\s*:\s*GetGooValue\s*\(\s*"
    r"((?:%[A-Za-z0-9_]+%|'[^'(),]{1,256}'|\"[^\"(),]{1,256}\"|[0-9]+))"
    r"\s*,\s*"
    r"((?:%[A-Za-z0-9_]+%|'[^'(),]{1,256}'|\"[^\"(),]{1,256}\"|[0-9]+))"
    r"\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*"
    r"\)\s*;?\s*$",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class CardMetadata:
    """Strict metadata extracted from an inventory trading-card description."""

    item_type: Literal["trading_card", "other"]
    game_app_id: str | None = None
    game_name: str | None = None
    card_rarity: CardRarity | None = None


@dataclass(frozen=True, slots=True)
class GemResolution:
    """A validated value for one semantic game/rarity group."""

    item_type: int
    border_color: int
    representative_hash: str
    gem_yield: int
    observed_at: str


@dataclass(frozen=True, slots=True)
class GemCacheEntry:
    game_app_id: str
    card_rarity: CardRarity
    status: Literal["positive", "negative"]
    item_type: int | None
    border_color: int | None
    representative_hash: str | None
    gem_yield: int | None
    observed_at: str | None
    created_at: float
    expires_at: float

    @property
    def expired(self) -> bool:
        return self.expires_at <= time.time()

    def resolution(self) -> GemResolution | None:
        if (
            self.status != "positive"
            or self.item_type is None
            or self.border_color is None
            or self.representative_hash is None
            or self.gem_yield is None
            or self.observed_at is None
        ):
            return None
        return GemResolution(
            item_type=self.item_type,
            border_color=self.border_color,
            representative_hash=self.representative_hash,
            gem_yield=self.gem_yield,
            observed_at=self.observed_at,
        )


@dataclass(frozen=True, slots=True)
class CommunityLookup:
    resolution: GemResolution | None = None
    rate_limited: bool = False
    retry_after_seconds: int | None = None
    failure: str | None = None


@dataclass(frozen=True, slots=True)
class GemScanResult:
    values: Mapping[tuple[str, CardRarity], GemResolution]
    pending_count: int = 0
    rate_limited: bool = False
    retry_after_seconds: int | None = None
    used_stale_cache: bool = False


class GemProviderProtocol(Protocol):
    async def lookup(
        self,
        market_hash_name: str,
        *,
        game_app_id: str,
        card_rarity: CardRarity,
    ) -> CommunityLookup:
        """Resolve one market representative into a gem value."""
        ...


def _bounded_retry_after(response: HTTPResponse) -> int | None:
    headers = getattr(response, "headers", None)
    if not isinstance(headers, Mapping):
        return None
    value: object = None
    for key, candidate in headers.items():
        if isinstance(key, str) and key.casefold() == "retry-after":
            value = candidate
            break
    if not isinstance(value, str):
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


def _is_success(value: object) -> bool:
    return value is True or (
        isinstance(value, int) and not isinstance(value, bool) and value == 1
    )


def _bounded_json_size(value: object, maximum: int) -> int | None:
    total = 0
    pending: list[tuple[object, int]] = [(value, 0)]
    while pending:
        current, depth = pending.pop()
        if depth > MAX_GEM_LISTING_NESTING:
            return None
        if isinstance(current, Mapping):
            total += 16 + len(current) * 8
            for key, child in current.items():
                if isinstance(key, str):
                    total += len(key)
                pending.append((child, depth + 1))
        elif isinstance(current, list):
            total += 16 + len(current) * 8
            pending.extend((child, depth + 1) for child in current)
        elif isinstance(current, (str, bytes, bytearray, memoryview)):
            if len(current) > MAX_GEM_LISTING_SCALAR_LENGTH:
                return None
            total += len(current)
        else:
            total += 32
        if total > maximum:
            return None
    return total


def _response_content_length_within(response: HTTPResponse, maximum: int) -> bool:
    headers = getattr(response, "headers", None)
    if not isinstance(headers, Mapping):
        return True
    value: object = None
    for key, candidate in headers.items():
        if isinstance(key, str) and key.casefold() == "content-length":
            value = candidate
            break
    if value is None:
        return True
    if not isinstance(value, str) or not _ASCII_DIGITS.fullmatch(value.strip()):
        return False
    normalized = value.strip().lstrip("0")
    return not normalized or (
        len(normalized) <= len(str(maximum)) and int(normalized) <= maximum
    )


def _valid_text(
    value: object, *, maximum: int = MAX_GEM_LISTING_SCALAR_LENGTH
) -> str | None:
    if not isinstance(value, str) or not value or len(value) > maximum:
        return None
    return value


def parse_card_metadata(tags: object) -> CardMetadata:
    """Parse only the canonical Steam tag tuple for a trading card.

    A valid ``item_class/item_class_2`` tag is the sole card discriminator.  We
    never infer a card from its name, app tag, or market hash name.
    """

    if not isinstance(tags, list):
        return CardMetadata(item_type="other")

    is_card = False
    malformed = False
    app_candidates: list[tuple[str, str | None]] = []
    rarity_candidates: list[CardRarity] = []
    for raw_tag in tags:
        if not isinstance(raw_tag, Mapping):
            malformed = True
            continue
        category = raw_tag.get("category")
        internal_name = raw_tag.get("internal_name")
        if not isinstance(category, str) or not isinstance(internal_name, str):
            malformed = True
            continue
        if category == "item_class" and internal_name == "item_class_2":
            is_card = True
            continue
        if category == "Game":
            match = _APP_TAG.fullmatch(internal_name)
            if match is not None:
                app_id = match.group(1)
                if len(app_id) <= MAX_GEM_APP_ID_LENGTH:
                    game_name_value = raw_tag.get("localized_tag_name")
                    game_name = _valid_text(game_name_value, maximum=8192)
                    if game_name_value is not None and game_name is None:
                        malformed = True
                    app_candidates.append((app_id, game_name))
                else:
                    malformed = True
            else:
                malformed = True
            continue
        if category == "cardborder":
            if internal_name == "cardborder_0":
                rarity_candidates.append("normal")
            elif internal_name == "cardborder_1":
                rarity_candidates.append("foil")
            else:
                malformed = True
    if not is_card:
        return CardMetadata(item_type="other")
    if malformed:
        return CardMetadata(item_type="trading_card")

    if len(app_candidates) != 1 or len(rarity_candidates) != 1:
        return CardMetadata(item_type="trading_card")

    game_app_id, game_name = app_candidates[0]
    card_rarity: CardRarity = rarity_candidates[0]

    return CardMetadata(
        item_type="trading_card",
        game_app_id=game_app_id,
        game_name=game_name,
        card_rarity=card_rarity,
    )


def parse_get_goo_value_action(action: object) -> tuple[int, int, int] | None:
    """Parse Steam's static action tuple without executing JavaScript."""

    if not isinstance(action, str):
        return None
    match = _GOO_VALUE_ACTION.fullmatch(action)
    if match is None:
        return None
    # The first two tuple members are context/asset placeholders.  Requiring
    # non-empty bounded tokens keeps this a parser, never a JS evaluator.
    if not match.group(1).strip() or not match.group(2).strip():
        return None
    try:
        app_id = int(match.group(3))
        item_type = int(match.group(4))
        border_color = int(match.group(5))
    except ValueError:
        return None
    if (
        app_id < 0
        or item_type < 0
        or border_color < 0
        or item_type > MAX_GEM_ITEM_TYPE
        or app_id > 10**MAX_GEM_APP_ID_LENGTH - 1
        or border_color > 1
    ):
        return None
    return app_id, item_type, border_color


def canonical_decimal(value: str | Decimal) -> str | None:
    """Return a nonnegative fixed-point decimal with no redundant zeroes."""

    try:
        decimal = value if isinstance(value, Decimal) else Decimal(value)
    except (ArithmeticError, TypeError, ValueError):
        return None
    if not decimal.is_finite() or decimal.is_signed():
        return None
    normalized = format(decimal, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    if not normalized:
        return "0"
    if normalized.startswith("0") and len(normalized) > 1 and normalized[1] != ".":
        normalized = normalized.lstrip("0") or "0"
    return normalized


def gem_cash_value(gem_yield: int, sack_price: str | Decimal | None) -> str | None:
    if not isinstance(gem_yield, int) or isinstance(gem_yield, bool) or gem_yield < 0:
        return None
    canonical_price = canonical_decimal(sack_price) if sack_price is not None else None
    if canonical_price is None:
        return None
    integer, _, fraction = canonical_price.partition(".")
    price_digits = f"{integer}{fraction}"
    if len(price_digits) > MAX_GEM_PRICE_DECIMAL_DIGITS:
        return None
    try:
        product = int(price_digits) * gem_yield
    except (TypeError, ValueError):
        return None
    scale = len(fraction) + 3
    padded = str(product).rjust(scale + 1, "0")
    fixed = f"{padded[:-scale]}.{padded[-scale:]}"
    return canonical_decimal(fixed)


class GemPriceCache:
    """Small persistent SQLite cache keyed by semantic game and rarity."""

    def __init__(self, path: str | Path) -> None:
        self.path = path
        self._memory_connection: sqlite3.Connection | None = None

    def _connect(self) -> sqlite3.Connection:
        in_memory = self.path == ":memory:"
        if in_memory and self._memory_connection is not None:
            return self._memory_connection
        path = Path(self.path).expanduser()
        if not in_memory:
            path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            ":memory:" if in_memory else path,
            timeout=2.0,
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS gem_price_cache (
                game_app_id TEXT NOT NULL,
                card_rarity TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('positive', 'negative')),
                item_type INTEGER,
                border_color INTEGER,
                representative_hash TEXT,
                gem_yield INTEGER,
                observed_at TEXT,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                PRIMARY KEY (game_app_id, card_rarity)
            )
            """
        )
        connection.commit()
        if in_memory:
            self._memory_connection = connection
        return connection

    def _close(self, connection: sqlite3.Connection) -> None:
        if self.path != ":memory:":
            connection.close()

    def get(self, game_app_id: str, card_rarity: CardRarity) -> GemCacheEntry | None:
        connection: sqlite3.Connection | None = None
        try:
            connection = self._connect()
            row = connection.execute(
                """
                SELECT game_app_id, card_rarity, status, item_type, border_color,
                       representative_hash, gem_yield, observed_at, created_at,
                       expires_at
                  FROM gem_price_cache
                 WHERE game_app_id = ? AND card_rarity = ?
                """,
                (game_app_id, card_rarity),
            ).fetchone()
            if row is None:
                return None
            return GemCacheEntry(
                game_app_id=row[0],
                card_rarity=row[1],
                status=row[2],
                item_type=row[3],
                border_color=row[4],
                representative_hash=row[5],
                gem_yield=row[6],
                observed_at=row[7],
                created_at=row[8],
                expires_at=row[9],
            )
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return None
        finally:
            if connection is not None:
                self._close(connection)

    def get_many(
        self,
        keys: Iterable[tuple[str, CardRarity]],
    ) -> dict[tuple[str, CardRarity], GemCacheEntry]:
        unique_keys = tuple(dict.fromkeys(keys))
        if not unique_keys:
            return {}
        connection: sqlite3.Connection | None = None
        results: dict[tuple[str, CardRarity], GemCacheEntry] = {}
        try:
            connection = self._connect()
            for game_app_id, card_rarity in unique_keys:
                row = connection.execute(
                    """
                    SELECT game_app_id, card_rarity, status, item_type,
                           border_color, representative_hash, gem_yield,
                           observed_at, created_at, expires_at
                      FROM gem_price_cache
                     WHERE game_app_id = ? AND card_rarity = ?
                    """,
                    (game_app_id, card_rarity),
                ).fetchone()
                if row is None:
                    continue
                results[(game_app_id, card_rarity)] = GemCacheEntry(
                    game_app_id=row[0],
                    card_rarity=row[1],
                    status=row[2],
                    item_type=row[3],
                    border_color=row[4],
                    representative_hash=row[5],
                    gem_yield=row[6],
                    observed_at=row[7],
                    created_at=row[8],
                    expires_at=row[9],
                )
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return {}
        finally:
            if connection is not None:
                self._close(connection)
        return results

    def put_positive(
        self,
        game_app_id: str,
        card_rarity: CardRarity,
        resolution: GemResolution,
        *,
        now: float | None = None,
    ) -> None:
        timestamp = time.time() if now is None else now
        connection: sqlite3.Connection | None = None
        try:
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO gem_price_cache (
                    game_app_id, card_rarity, status, item_type, border_color,
                    representative_hash, gem_yield, observed_at, created_at,
                    expires_at
                ) VALUES (?, ?, 'positive', ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(game_app_id, card_rarity) DO UPDATE SET
                    status = excluded.status,
                    item_type = excluded.item_type,
                    border_color = excluded.border_color,
                    representative_hash = excluded.representative_hash,
                    gem_yield = excluded.gem_yield,
                    observed_at = excluded.observed_at,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at
                """,
                (
                    game_app_id,
                    card_rarity,
                    resolution.item_type,
                    resolution.border_color,
                    resolution.representative_hash,
                    resolution.gem_yield,
                    resolution.observed_at,
                    timestamp,
                    timestamp + GEM_CACHE_TTL_SECONDS,
                ),
            )
            connection.commit()
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return
        finally:
            if connection is not None:
                self._close(connection)

    def put_negative(
        self,
        game_app_id: str,
        card_rarity: CardRarity,
        *,
        now: float | None = None,
    ) -> None:
        timestamp = time.time() if now is None else now
        connection: sqlite3.Connection | None = None
        try:
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO gem_price_cache (
                    game_app_id, card_rarity, status, item_type, border_color,
                    representative_hash, gem_yield, observed_at, created_at,
                    expires_at
                ) VALUES (?, ?, 'negative', NULL, NULL, NULL, NULL, NULL, ?, ?)
                ON CONFLICT(game_app_id, card_rarity) DO UPDATE SET
                    status = excluded.status,
                    item_type = NULL,
                    border_color = NULL,
                    representative_hash = NULL,
                    gem_yield = NULL,
                    observed_at = NULL,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at
                """,
                (
                    game_app_id,
                    card_rarity,
                    timestamp,
                    timestamp + GEM_NEGATIVE_CACHE_TTL_SECONDS,
                ),
            )
            connection.commit()
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return
        finally:
            if connection is not None:
                self._close(connection)


class _CircuitOpenError(Exception):
    def __init__(self, retry_after_seconds: int) -> None:
        self.retry_after_seconds = retry_after_seconds
        super().__init__("Steam Community circuit is open")


class _CommunityRateLimitedError(Exception):
    def __init__(self, retry_after_seconds: int | None) -> None:
        self.retry_after_seconds = retry_after_seconds
        super().__init__("Steam Community request was rate limited")


class SteamCommunityLimiter:
    """Serialize Community requests and enforce a process-local circuit."""

    def __init__(self, *, minimum_start_interval_seconds: float = 4.0) -> None:
        self.minimum_start_interval_seconds = max(4.0, minimum_start_interval_seconds)
        self._lock = asyncio.Lock()
        self._last_started: float | None = None
        self._circuit_until = 0.0

    @staticmethod
    def _clock() -> float:
        return time.monotonic()

    def circuit_retry_after(self) -> int | None:
        remaining = self._circuit_until - self._clock()
        return max(0, math.ceil(remaining)) if remaining > 0 else None

    async def run[T](self, operation: Callable[[], Awaitable[T]]) -> T:
        async with self._lock:
            now = self._clock()
            if now < self._circuit_until:
                raise _CircuitOpenError(max(1, math.ceil(self._circuit_until - now)))
            if self._last_started is not None:
                wait_seconds = self.minimum_start_interval_seconds - (
                    now - self._last_started
                )
                if wait_seconds > 0:
                    await asyncio.sleep(wait_seconds)
                    now = self._clock()
                    if now < self._circuit_until:
                        raise _CircuitOpenError(
                            max(1, math.ceil(self._circuit_until - now))
                        )
            self._last_started = self._clock()
            try:
                return await operation()
            except _CommunityRateLimitedError as error:
                bounded = error.retry_after_seconds
                delay = max(
                    MIN_CIRCUIT_OPEN_SECONDS
                    if bounded is None
                    else self.minimum_start_interval_seconds,
                    float(bounded if bounded is not None else 0),
                )
                self._circuit_until = max(self._circuit_until, self._clock() + delay)
                raise _CircuitOpenError(max(1, math.ceil(delay))) from error


class SteamCommunityGemProvider:
    """Read-only Steam Community listing and gem-value provider."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_client: AsyncHTTPClient,
        limiter: SteamCommunityLimiter | None = None,
    ) -> None:
        self.settings = settings
        self.http_client = http_client
        self.limiter = limiter or SteamCommunityLimiter()

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Cookie": STEAM_COMMUNITY_COOKIE,
            "Referer": STEAM_COMMUNITY_REFERER,
            "User-Agent": STEAM_OPTIMIZER_USER_AGENT,
        }

    async def lookup(
        self,
        market_hash_name: str,
        *,
        game_app_id: str,
        card_rarity: CardRarity,
    ) -> CommunityLookup:
        if (
            not isinstance(market_hash_name, str)
            or not market_hash_name
            or len(market_hash_name) > MAX_GEM_MARKET_HASH_NAME_LENGTH
            or not isinstance(game_app_id, str)
            or not _ASCII_DIGITS.fullmatch(game_app_id)
            or len(game_app_id) > MAX_GEM_APP_ID_LENGTH
            or card_rarity not in ("normal", "foil")
        ):
            return CommunityLookup(failure="Invalid gem lookup metadata.")
        expected_app_id = int(game_app_id)
        expected_border = 0 if card_rarity == "normal" else 1

        async def limited_get(url: str, *, params: Mapping[str, str]) -> HTTPResponse:
            async def operation() -> HTTPResponse:
                try:
                    response = await self.http_client.get(
                        url,
                        params=params,
                        headers=self._headers,
                        follow_redirects=False,
                    )
                except (
                    httpx2.HTTPError,
                    OSError,
                    TimeoutError,
                    RuntimeError,
                ) as error:
                    raise ValueError from error
                if response.status_code == 429:
                    raise _CommunityRateLimitedError(_bounded_retry_after(response))
                return response

            return await self.limiter.run(operation)

        listing_url = STEAM_MARKET_LISTING_RENDER_ENDPOINT.format(
            market_hash_name=quote(market_hash_name, safe="")
        )
        try:
            listing_response = await limited_get(
                listing_url,
                params={
                    "query": "",
                    "start": "0",
                    "count": "1",
                    "country": "US",
                    "language": "english",
                    "currency": "1",
                },
            )
            if not 200 <= listing_response.status_code < 300:
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            if not _response_content_length_within(
                listing_response, MAX_GEM_LISTING_BYTES
            ):
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            try:
                payload = listing_response.json()
            except (TypeError, ValueError):
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            if _bounded_json_size(payload, MAX_GEM_LISTING_BYTES) is None:
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            action = _first_listing_action(payload)
            parsed = parse_get_goo_value_action(action)
            if parsed is None:
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            app_id, item_type, border_color = parsed
            if app_id != expected_app_id or border_color != expected_border:
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )

            value_response = await limited_get(
                STEAM_GOO_VALUE_ENDPOINT,
                params={
                    "appid": str(app_id),
                    "item_type": str(item_type),
                    "border_color": str(border_color),
                },
            )
            if not 200 <= value_response.status_code < 300:
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            if not _response_content_length_within(
                value_response, MAX_GEM_LISTING_BYTES
            ):
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            try:
                value_payload = value_response.json()
            except (TypeError, ValueError):
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            if _bounded_json_size(value_payload, MAX_GEM_LISTING_BYTES) is None:
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            if not isinstance(value_payload, Mapping) or not _is_success(
                value_payload.get("success")
            ):
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            gem_yield = _parse_gem_yield(value_payload.get("goo_value"))
            if gem_yield is None:
                return CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            resolution = GemResolution(
                item_type=item_type,
                border_color=border_color,
                representative_hash=market_hash_name,
                gem_yield=gem_yield,
                observed_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            )
        except _CircuitOpenError as error:
            return CommunityLookup(
                rate_limited=True,
                retry_after_seconds=error.retry_after_seconds,
                failure="Steam Community requests are temporarily rate limited.",
            )
        except (
            IncompleteJSONError,
            JSONError,
            ValueError,
            TypeError,
            ArithmeticError,
        ):
            return CommunityLookup(failure="Steam Community gem data is unavailable.")
        return CommunityLookup(resolution=resolution)


def _parse_gem_yield(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if 0 <= value <= MAX_GEM_YIELD else None
    if not isinstance(value, str) or not _ASCII_DIGITS.fullmatch(value):
        return None
    normalized = value.lstrip("0") or "0"
    if len(normalized) > len(str(MAX_GEM_YIELD)):
        return None
    parsed = int(normalized)
    return parsed if parsed <= MAX_GEM_YIELD else None


def _listing_asset_id(value: object) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        if value < 0:
            return None
        value = str(value)
    if not isinstance(value, str) or not value:
        return None
    if len(value) > MAX_GEM_LISTING_SCALAR_LENGTH:
        return None
    return value


def _first_listing_action(payload: object) -> object:
    if not isinstance(payload, Mapping) or not _is_success(payload.get("success")):
        return None
    listinginfo = payload.get("listinginfo")
    if not isinstance(listinginfo, Mapping) or not listinginfo:
        return None
    first_listing = next(iter(listinginfo.values()))
    if not isinstance(first_listing, Mapping):
        return None
    listing_asset = first_listing.get("asset")
    if not isinstance(listing_asset, Mapping):
        return None
    asset_id = _listing_asset_id(listing_asset.get("id"))
    if asset_id is None:
        return None
    assets = payload.get("assets")
    if not isinstance(assets, Mapping):
        return None
    app_assets = assets.get("753")
    if not isinstance(app_assets, Mapping):
        return None
    context_assets = app_assets.get("6")
    if not isinstance(context_assets, Mapping):
        return None
    first_asset = context_assets.get(asset_id)
    if not isinstance(first_asset, Mapping):
        return None
    owner_actions = first_asset.get("owner_actions")
    if not isinstance(owner_actions, list):
        return None
    # The first listing asset is fixed by listinginfo; do not trust asset-map
    # insertion order, which may contain another listing's asset first.
    for raw_action in owner_actions:
        if not isinstance(raw_action, Mapping):
            continue
        link = raw_action.get("link")
        if isinstance(link, str) and "getgoovalue" in link.casefold():
            return link
    return None


class GemPricingService:
    """Cache-aware, single-flight, bounded gem lookup orchestration."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_client: AsyncHTTPClient | None = None,
        cache: GemPriceCache | None = None,
        provider: GemProviderProtocol | None = None,
        limiter: SteamCommunityLimiter | None = None,
    ) -> None:
        self.settings = settings
        self.cache = cache or GemPriceCache(settings.gem_price_cache_path)
        if provider is None:
            if http_client is None:
                raise ValueError(_GEM_HTTP_CLIENT_ERROR)
            provider = SteamCommunityGemProvider(
                settings,
                http_client=http_client,
                limiter=limiter,
            )
        self.provider = provider
        self._inflight: dict[tuple[str, CardRarity], asyncio.Task[CommunityLookup]] = {}

    def _record_lookup(
        self,
        key: tuple[str, CardRarity],
        outcome: CommunityLookup,
    ) -> None:
        if outcome.resolution is not None:
            self.cache.put_positive(key[0], key[1], outcome.resolution)
            return
        if outcome.rate_limited:
            return
        cached = self.cache.get(key[0], key[1])
        if cached is None or cached.status != "positive":
            self.cache.put_negative(key[0], key[1])

    def _complete_lookup(
        self,
        key: tuple[str, CardRarity],
        completed: asyncio.Future[CommunityLookup],
    ) -> None:
        if self._inflight.get(key) is completed:
            self._inflight.pop(key, None)
        try:
            outcome = completed.result()
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001 - isolate provider failures per key
            outcome = CommunityLookup(
                failure="Steam Community gem data is unavailable."
            )
        if not isinstance(outcome, CommunityLookup):
            outcome = CommunityLookup(
                failure="Steam Community gem data is unavailable."
            )
        self._record_lookup(key, outcome)

    async def _lookup_once(
        self,
        key: tuple[str, CardRarity],
        representative_hash: str,
        stale: GemCacheEntry | None,
    ) -> CommunityLookup:
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(
                self.provider.lookup(
                    representative_hash,
                    game_app_id=key[0],
                    card_rarity=key[1],
                )
            )
            self._inflight[key] = task
            task.add_done_callback(
                lambda completed: self._complete_lookup(key, completed)
            )
        try:
            outcome = await asyncio.shield(task)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - isolate provider failures per key
            outcome = CommunityLookup(
                failure="Steam Community gem data is unavailable."
            )
        finally:
            if task.done() and self._inflight.get(key) is task:
                self._inflight.pop(key, None)

        if not isinstance(outcome, CommunityLookup):
            outcome = CommunityLookup(
                failure="Steam Community gem data is unavailable."
            )
        self._record_lookup(key, outcome)
        if outcome.resolution is not None:
            return outcome
        if stale is not None and stale.status == "positive":
            stale_resolution = stale.resolution()
            if stale_resolution is not None:
                return CommunityLookup(
                    resolution=stale_resolution,
                    rate_limited=outcome.rate_limited,
                    retry_after_seconds=outcome.retry_after_seconds,
                    failure=outcome.failure or "Using expired cached gem value.",
                )
        return outcome

    async def resolve(
        self,
        groups: Mapping[tuple[str, CardRarity], str | None],
    ) -> GemScanResult:
        if not groups:
            return GemScanResult(values={})
        values: dict[tuple[str, CardRarity], GemResolution] = {}
        pending_count = 0
        rate_limited = False
        retry_after_seconds: int | None = None
        used_stale_cache = False
        misses = 0
        max_misses = max(0, int(self.settings.gem_lookup_max_misses_per_scan))
        deadline = time.monotonic() + self.settings.gem_lookup_budget_seconds
        cached_entries = self.cache.get_many(groups)

        for key in sorted(groups, key=lambda value: (value[0], value[1])):
            cached = cached_entries.get(key)
            if cached is not None and not cached.expired:
                resolution = cached.resolution()
                if resolution is not None:
                    values[key] = resolution
                continue
            stale = (
                cached if cached is not None and cached.status == "positive" else None
            )
            stale_resolution = stale.resolution() if stale is not None else None
            representative_hash = groups[key]
            if representative_hash is None:
                if stale_resolution is not None:
                    values[key] = stale_resolution
                    used_stale_cache = True
                else:
                    pending_count += 1
                continue
            if misses >= max_misses:
                if stale_resolution is not None:
                    values[key] = stale_resolution
                    used_stale_cache = True
                else:
                    pending_count += 1
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if stale_resolution is not None:
                    values[key] = stale_resolution
                    used_stale_cache = True
                else:
                    pending_count += 1
                continue
            misses += 1
            timeout = min(self.settings.gem_lookup_timeout_seconds, remaining)
            try:
                outcome = await asyncio.wait_for(
                    self._lookup_once(key, representative_hash, stale), timeout=timeout
                )
            except TimeoutError:
                outcome = CommunityLookup(
                    resolution=stale_resolution,
                    failure="Gem lookup remained pending beyond this scan budget.",
                )
            if outcome.resolution is not None:
                values[key] = outcome.resolution
                if stale is not None and outcome.failure is not None:
                    used_stale_cache = True
            else:
                pending_count += 1
            if outcome.rate_limited:
                rate_limited = True
                if outcome.retry_after_seconds is not None:
                    retry_after_seconds = max(
                        retry_after_seconds or 0, outcome.retry_after_seconds
                    )

        return GemScanResult(
            values=values,
            pending_count=pending_count,
            rate_limited=rate_limited,
            retry_after_seconds=retry_after_seconds,
            used_stale_cache=used_stale_cache,
        )


__all__ = [
    "MIN_CIRCUIT_OPEN_SECONDS",
    "SACK_OF_GEMS_GEM_COUNT",
    "SACK_OF_GEMS_MARKET_HASH_NAME",
    "STEAM_GOO_VALUE_ENDPOINT",
    "STEAM_MARKET_LISTING_RENDER_ENDPOINT",
    "CardMetadata",
    "CardRarity",
    "CommunityLookup",
    "GemCacheEntry",
    "GemPriceCache",
    "GemPricingService",
    "GemResolution",
    "GemScanResult",
    "SteamCommunityGemProvider",
    "SteamCommunityLimiter",
    "canonical_decimal",
    "gem_cash_value",
    "parse_card_metadata",
    "parse_get_goo_value_action",
]
