from __future__ import annotations

import asyncio
import logging
import math
import re
import sqlite3
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping
from contextlib import suppress
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
CACHE_SCHEMA_VERSION = 1
_GEM_HTTP_CLIENT_ERROR = "http_client is required without a gem provider."
_CACHE_SCHEMA_VERSION_TYPE_ERROR = "schema_version must be an integer."
_CACHE_SCHEMA_VERSION_VALUE_ERROR = "schema_version must be positive."
_CACHE_USER_VERSION_UNAVAILABLE_ERROR = "SQLite user_version is unavailable."
_CACHE_USER_VERSION_INVALID_ERROR = "SQLite user_version is invalid."
_CACHE_READ_ONLY_REPLACE_ERROR = "Cannot replace a read-only or missing SQLite cache."
_CACHE_CONNECTION_ERROR = "SQLite connection was not created."
_GEM_CACHE_TABLE_NAME = "gem_price_cache"
_GEM_CACHE_TABLE_SQL = """
CREATE TABLE gem_price_cache (
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
_GEM_CACHE_TABLE_INFO = (
    ("game_app_id", "TEXT", 1, None, 1),
    ("card_rarity", "TEXT", 1, None, 2),
    ("status", "TEXT", 1, None, 0),
    ("item_type", "INTEGER", 0, None, 0),
    ("border_color", "INTEGER", 0, None, 0),
    ("representative_hash", "TEXT", 0, None, 0),
    ("gem_yield", "INTEGER", 0, None, 0),
    ("observed_at", "TEXT", 0, None, 0),
    ("created_at", "REAL", 1, None, 0),
    ("expires_at", "REAL", 1, None, 0),
)
_LOGGER = logging.getLogger(__name__)


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

    def __init__(
        self,
        path: str | Path,
        schema_version: int = CACHE_SCHEMA_VERSION,
    ) -> None:
        if isinstance(schema_version, bool) or not isinstance(schema_version, int):
            raise TypeError(_CACHE_SCHEMA_VERSION_TYPE_ERROR)
        if schema_version <= 0:
            raise ValueError(_CACHE_SCHEMA_VERSION_VALUE_ERROR)
        self.path = path
        self.schema_version = schema_version
        self._memory_connection: sqlite3.Connection | None = None

    @staticmethod
    def _is_corruption(error: sqlite3.Error) -> bool:
        corruption_codes = {
            code
            for code in (
                getattr(sqlite3, "SQLITE_CORRUPT", None),
                getattr(sqlite3, "SQLITE_CORRUPT_VTAB", None),
                getattr(sqlite3, "SQLITE_FORMAT", None),
                getattr(sqlite3, "SQLITE_NOTADB", None),
            )
            if isinstance(code, int)
        }
        if getattr(error, "sqlite_errorcode", None) in corruption_codes:
            return True
        message = str(error).casefold()
        return any(
            marker in message
            for marker in (
                "file is not a database",
                "database disk image is malformed",
                "unsupported file format",
                "malformed database schema",
            )
        )

    @staticmethod
    def _is_read_only(error: sqlite3.Error) -> bool:
        read_only_codes = {
            code
            for code in (
                getattr(sqlite3, "SQLITE_READONLY", None),
                getattr(sqlite3, "SQLITE_READONLY_DBMOVED", None),
                getattr(sqlite3, "SQLITE_READONLY_CANTINIT", None),
                getattr(sqlite3, "SQLITE_READONLY_DIRECTORY", None),
            )
            if isinstance(code, int)
        }
        if getattr(error, "sqlite_errorcode", None) in read_only_codes:
            return True
        message = str(error).casefold()
        return "readonly" in message or "read-only" in message or "read only" in message

    @staticmethod
    def _table_signature(
        connection: sqlite3.Connection,
    ) -> tuple[tuple[object, ...], ...]:
        rows = connection.execute("PRAGMA table_info(gem_price_cache)").fetchall()
        return tuple((row[1], row[2], row[3], row[4], row[5]) for row in rows)

    @staticmethod
    def _table_sql(connection: sqlite3.Connection) -> str | None:
        row = connection.execute(
            """
            SELECT sql
              FROM sqlite_master
             WHERE type = 'table' AND name = ?
            """,
            (_GEM_CACHE_TABLE_NAME,),
        ).fetchone()
        return row[0] if row is not None and isinstance(row[0], str) else None

    @staticmethod
    def _normalized_sql(sql: str) -> str:
        parts: list[str] = []
        outside_quote: list[str] = []
        quote: str | None = None

        def flush_outside_quote() -> None:
            if outside_quote:
                parts.append("".join(outside_quote).replace("ifnotexists", ""))
                outside_quote.clear()

        index = 0
        while index < len(sql):
            character = sql[index]
            if quote is None:
                if character in ("'", '"', "`") or character == "[":
                    flush_outside_quote()
                    quote = "]" if character == "[" else character
                    parts.append(character)
                elif character.isspace():
                    pass
                else:
                    outside_quote.append(character.casefold())
            else:
                parts.append(character)
                if character == quote:
                    if (
                        quote != "]"
                        and index + 1 < len(sql)
                        and sql[index + 1] == quote
                    ):
                        parts.append(sql[index + 1])
                        index += 1
                    else:
                        quote = None
            index += 1
        flush_outside_quote()
        return "".join(parts)

    @classmethod
    def _is_compatible_table(cls, connection: sqlite3.Connection) -> bool:
        table_sql = cls._table_sql(connection)
        return (
            cls._table_signature(connection) == _GEM_CACHE_TABLE_INFO
            and table_sql is not None
            and cls._normalized_sql(table_sql)
            == cls._normalized_sql(_GEM_CACHE_TABLE_SQL)
        )

    @staticmethod
    def _object_type(connection: sqlite3.Connection) -> str | None:
        row = connection.execute(
            """
            SELECT type
              FROM sqlite_master
             WHERE name = ? COLLATE NOCASE
            """,
            (_GEM_CACHE_TABLE_NAME,),
        ).fetchone()
        if row is None:
            return None
        return row[0] if isinstance(row[0], str) else None

    @staticmethod
    def _drop_object(
        connection: sqlite3.Connection,
        object_type: str | None,
    ) -> None:
        statements = {
            "index": "DROP INDEX IF EXISTS gem_price_cache",
            "table": "DROP TABLE IF EXISTS gem_price_cache",
            "trigger": "DROP TRIGGER IF EXISTS gem_price_cache",
            "view": "DROP VIEW IF EXISTS gem_price_cache",
        }
        if object_type is None:
            return
        statement = statements.get(object_type)
        if statement is not None:
            connection.execute(statement)

    def _schema_state(
        self,
        connection: sqlite3.Connection,
    ) -> tuple[int, str | None, bool]:
        row = connection.execute("PRAGMA user_version").fetchone()
        if row is None:
            raise sqlite3.DatabaseError(_CACHE_USER_VERSION_UNAVAILABLE_ERROR)
        user_version = row[0]
        if not isinstance(user_version, int):
            raise sqlite3.DatabaseError(_CACHE_USER_VERSION_INVALID_ERROR)
        object_type = self._object_type(connection)
        compatible = object_type == "table" and self._is_compatible_table(connection)
        return user_version, object_type, compatible

    def _initialize(self, connection: sqlite3.Connection) -> None:
        initial_user_version, _, initial_compatible = self._schema_state(connection)
        if initial_user_version == self.schema_version and initial_compatible:
            return
        try:
            connection.execute("BEGIN IMMEDIATE")
            user_version, object_type, compatible = self._schema_state(connection)
            if user_version == self.schema_version and compatible:
                connection.commit()
                return
            if user_version == 0 and compatible:
                connection.execute(f"PRAGMA user_version = {self.schema_version}")
            else:
                self._drop_object(connection, object_type)
                connection.execute(_GEM_CACHE_TABLE_SQL)
                connection.execute(f"PRAGMA user_version = {self.schema_version}")
            connection.commit()
        except sqlite3.Error as error:
            connection.rollback()
            if (
                initial_user_version == 0
                and initial_compatible
                and self._is_read_only(error)
            ):
                return
            raise
        except BaseException:
            connection.rollback()
            raise

    @staticmethod
    def _read_only_file(path: Path) -> bool:
        try:
            return path.stat().st_mode & 0o222 == 0
        except OSError:
            return True

    @classmethod
    def _archive_corrupt(cls, path: Path) -> None:
        if not path.is_file() or cls._read_only_file(path):
            raise OSError(_CACHE_READ_ONLY_REPLACE_ERROR)
        archive = path.with_name(f"{path.name}.corrupt-{time.time_ns()}")
        path.replace(archive)

    def _connect(self) -> sqlite3.Connection:
        in_memory = self.path == ":memory:"
        if in_memory and self._memory_connection is not None:
            return self._memory_connection
        path = Path(self.path).expanduser()
        if not in_memory:
            path.parent.mkdir(parents=True, exist_ok=True)
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(
                ":memory:" if in_memory else path,
                timeout=2.0,
            )
            self._initialize(connection)
        except sqlite3.Error as error:
            if connection is not None:
                connection.close()
                connection = None
            if (
                in_memory
                or not self._is_corruption(error)
                or self._is_read_only(error)
                or self._read_only_file(path)
                or self._read_only_file(path.parent)
            ):
                raise
            self._archive_corrupt(path)
            try:
                connection = sqlite3.connect(path, timeout=2.0)
                self._initialize(connection)
            except BaseException:
                if connection is not None:
                    connection.close()
                raise
        except BaseException:
            if connection is not None:
                connection.close()
            raise
        if connection is None:
            raise sqlite3.DatabaseError(_CACHE_CONNECTION_ERROR)
        if in_memory:
            self._memory_connection = connection
        return connection

    def _close(self, connection: sqlite3.Connection) -> None:
        if self.path != ":memory:":
            connection.close()

    def initialize(self) -> None:
        """Validate and migrate the persistent cache before serving requests."""
        connection = self._connect()
        self._close(connection)

    @staticmethod
    def _sqlite_text(value: object, *, maximum: int) -> str | None:
        if not isinstance(value, str) or not value or len(value) > maximum:
            return None
        return value

    @staticmethod
    def _sqlite_integer(value: object) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            if not math.isfinite(value) or not value.is_integer():
                return None
            return int(value)
        if not isinstance(value, str):
            return None
        normalized = value.strip()
        if not re.fullmatch(r"-?[0-9]+", normalized):
            return None
        try:
            return int(normalized)
        except ValueError:
            return None

    @staticmethod
    def _sqlite_real(value: object) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            return None
        try:
            result = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return result if math.isfinite(result) else None

    @staticmethod
    def _cache_rarity(value: object) -> CardRarity | None:
        if value == "normal":
            return "normal"
        if value == "foil":
            return "foil"
        return None

    @staticmethod
    def _cache_status(value: object) -> Literal["positive", "negative"] | None:
        if value == "positive":
            return "positive"
        if value == "negative":
            return "negative"
        return None

    @classmethod
    def _entry(cls, row: tuple[object, ...]) -> GemCacheEntry | None:
        if len(row) != 10:
            return None
        game_app_id = cls._sqlite_text(row[0], maximum=MAX_GEM_APP_ID_LENGTH)
        if game_app_id is None or _ASCII_DIGITS.fullmatch(game_app_id) is None:
            return None
        card_rarity = cls._cache_rarity(row[1])
        status = cls._cache_status(row[2])
        if card_rarity is None or status is None:
            return None
        item_type = cls._sqlite_integer(row[3])
        border_color = cls._sqlite_integer(row[4])
        representative_hash = cls._sqlite_text(
            row[5], maximum=MAX_GEM_MARKET_HASH_NAME_LENGTH
        )
        gem_yield = cls._sqlite_integer(row[6])
        observed_at = cls._sqlite_text(row[7], maximum=MAX_GEM_LISTING_SCALAR_LENGTH)
        created_at = cls._sqlite_real(row[8])
        expires_at = cls._sqlite_real(row[9])
        if created_at is None or expires_at is None:
            return None
        if item_type is not None and not 0 <= item_type <= MAX_GEM_ITEM_TYPE:
            return None
        if border_color is not None and border_color not in (0, 1):
            return None
        if gem_yield is not None and not 0 <= gem_yield <= MAX_GEM_YIELD:
            return None
        if status == "positive":
            if (
                item_type is None
                or border_color is None
                or representative_hash is None
                or gem_yield is None
                or observed_at is None
            ):
                return None
        elif any(
            value is not None
            for value in (
                item_type,
                border_color,
                representative_hash,
                gem_yield,
                observed_at,
            )
        ):
            return None
        return GemCacheEntry(
            game_app_id=game_app_id,
            card_rarity=card_rarity,
            status=status,
            item_type=item_type,
            border_color=border_color,
            representative_hash=representative_hash,
            gem_yield=gem_yield,
            observed_at=observed_at,
            created_at=created_at,
            expires_at=expires_at,
        )

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
            return None if row is None else self._entry(row)
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
                if row is not None:
                    entry = self._entry(row)
                    if entry is not None:
                        results[(game_app_id, card_rarity)] = entry
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
                WHERE gem_price_cache.status = 'negative'
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


@dataclass(frozen=True, slots=True)
class _QueuedLookup:
    key: tuple[str, CardRarity]
    representative_hash: str


class GemPricingService:
    """Cache-aware gem lookup service with one background warmer."""

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
        self._queue: asyncio.Queue[_QueuedLookup] | None = None
        self._scheduled: set[tuple[str, CardRarity]] = set()
        self._worker_task: asyncio.Task[None] | None = None
        self._rate_limited_until = 0.0

    @staticmethod
    def _clock() -> float:
        return time.monotonic()

    async def _sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)

    def _ensure_started(self) -> None:
        task = self._worker_task
        if task is not None:
            if not task.done():
                return
            with suppress(BaseException):
                task.exception()
        self._queue = asyncio.Queue()
        self._scheduled = set()
        self._rate_limited_until = 0.0
        self._worker_task = asyncio.create_task(
            self._run_worker(),
            name="gem-price-warmer",
        )

    async def start(self) -> None:
        """Initialize the cache and start the single warmer worker."""
        self.cache.initialize()
        self._ensure_started()

    async def stop(self) -> None:
        """Cancel the worker and discard queued work without orphan tasks."""
        task = self._worker_task
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        elif task is not None:
            with suppress(BaseException):
                task.exception()
        queue = self._queue
        if queue is not None:
            while True:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                else:
                    queue.task_done()
        self._worker_task = None
        self._queue = None
        self._scheduled.clear()
        self._rate_limited_until = 0.0

    async def wait_until_idle(self) -> None:
        """Wait until all currently queued work has reached a terminal outcome."""
        queue = self._queue
        if queue is not None:
            await queue.join()

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
        self.cache.put_negative(key[0], key[1])

    @staticmethod
    def _safe_outcome(outcome: object) -> CommunityLookup:
        return (
            outcome
            if isinstance(outcome, CommunityLookup)
            else CommunityLookup(failure="Steam Community gem data is unavailable.")
        )

    def _rate_limit_delay(self, outcome: CommunityLookup) -> int:
        retry_after = outcome.retry_after_seconds
        if (
            isinstance(retry_after, bool)
            or not isinstance(retry_after, int)
            or retry_after < 0
        ):
            retry_after = None
        return min(
            MAX_RETRY_AFTER_SECONDS,
            max(MIN_CIRCUIT_OPEN_SECONDS, retry_after or 0),
        )

    async def _process_lookup(self, item: _QueuedLookup) -> None:
        while True:
            try:
                outcome = await self.provider.lookup(
                    item.representative_hash,
                    game_app_id=item.key[0],
                    card_rarity=item.key[1],
                )
            except Exception:  # noqa: BLE001 - isolate provider failures per key
                outcome = CommunityLookup(
                    failure="Steam Community gem data is unavailable."
                )
            outcome = self._safe_outcome(outcome)
            if outcome.rate_limited:
                delay = self._rate_limit_delay(outcome)
                self._rate_limited_until = max(
                    self._rate_limited_until,
                    self._clock() + delay,
                )
                _LOGGER.info(
                    "gem warmer rate retry delay=%d depth=%d",
                    delay,
                    self._queue.qsize() if self._queue is not None else 0,
                )
                await self._sleep(delay)
                continue
            self._record_lookup(item.key, outcome)
            if outcome.resolution is not None:
                _LOGGER.info(
                    "gem warmer success depth=%d",
                    self._queue.qsize() if self._queue is not None else 0,
                )
            else:
                _LOGGER.info(
                    "gem warmer failure depth=%d",
                    self._queue.qsize() if self._queue is not None else 0,
                )
            self._rate_limited_until = 0.0
            return

    async def _run_worker(self) -> None:
        queue = self._queue
        if queue is None:
            return
        while True:
            item = await queue.get()
            try:
                await self._process_lookup(item)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep warming other groups
                self._record_lookup(
                    item.key,
                    CommunityLookup(failure="Steam Community gem data is unavailable."),
                )
                _LOGGER.info(
                    "gem warmer failure depth=%d",
                    queue.qsize(),
                )
            finally:
                self._scheduled.discard(item.key)
                queue.task_done()

    def _queue_lookup(
        self,
        key: tuple[str, CardRarity],
        representative_hash: str,
    ) -> bool:
        self._ensure_started()
        if key in self._scheduled:
            return False
        queue = self._queue
        if queue is None:
            return False
        self._scheduled.add(key)
        queue.put_nowait(_QueuedLookup(key, representative_hash))
        return True

    def _rate_limit_status(self) -> tuple[bool, int | None]:
        remaining = self._rate_limited_until - self._clock()
        if remaining <= 0:
            self._rate_limited_until = 0.0
            return False, None
        return True, max(1, math.ceil(remaining))

    def read_cached(
        self,
        keys: Iterable[tuple[str, CardRarity]],
    ) -> GemScanResult:
        """Read completed warmer results without scheduling provider work."""
        unique_keys = tuple(dict.fromkeys(keys))
        cached_entries = self.cache.get_many(unique_keys)
        values: dict[tuple[str, CardRarity], GemResolution] = {}
        used_stale_cache = False
        pending_count = 0
        terminal_negative_count = 0
        for key in unique_keys:
            cached = cached_entries.get(key)
            if cached is None:
                pending_count += 1
                continue
            if cached.status == "negative":
                if cached.expired:
                    pending_count += 1
                else:
                    terminal_negative_count += 1
                continue
            resolution = cached.resolution()
            if resolution is None:
                pending_count += 1
                continue
            values[key] = resolution
            used_stale_cache = used_stale_cache or cached.expired
        rate_limited, retry_after_seconds = self._rate_limit_status()
        _LOGGER.info(
            (
                "gem cache refresh requested=%d cached=%d pending=%d "
                "terminal_negative=%d rate_limited=%s"
            ),
            len(unique_keys),
            len(values),
            pending_count,
            terminal_negative_count,
            rate_limited,
        )
        return GemScanResult(
            values=values,
            pending_count=pending_count,
            rate_limited=rate_limited,
            retry_after_seconds=retry_after_seconds,
            used_stale_cache=used_stale_cache,
        )

    async def resolve(
        self,
        groups: Mapping[tuple[str, CardRarity], str | None],
    ) -> GemScanResult:
        if not groups:
            return GemScanResult(values={})
        values: dict[tuple[str, CardRarity], GemResolution] = {}
        pending_count = 0
        used_stale_cache = False
        fresh_count = 0
        stale_count = 0
        negative_count = 0
        queued_count = 0
        unresolvable_count = 0
        cached_entries = self.cache.get_many(groups)

        for key in sorted(groups, key=lambda value: (value[0], value[1])):
            cached = cached_entries.get(key)
            resolution = cached.resolution() if cached is not None else None
            if cached is not None and not cached.expired:
                if cached.status == "positive" and resolution is not None:
                    values[key] = resolution
                    fresh_count += 1
                elif cached.status == "negative":
                    negative_count += 1
                else:
                    unresolvable_count += 1
                continue

            stale_resolution = (
                resolution
                if cached is not None and cached.status == "positive"
                else None
            )
            representative_hash = groups[key]
            if stale_resolution is not None:
                values[key] = stale_resolution
                used_stale_cache = True
                stale_count += 1
                if representative_hash is None and cached is not None:
                    representative_hash = cached.representative_hash
            if representative_hash is None:
                pending_count += 1
                unresolvable_count += 1
                continue
            if stale_resolution is None:
                pending_count += 1
            if self._queue_lookup(key, representative_hash):
                queued_count += 1

        rate_limited, retry_after_seconds = self._rate_limit_status()
        _LOGGER.info(
            (
                "gem scan requested=%d fresh=%d stale=%d negative=%d "
                "queued=%d unresolvable=%d depth=%d rate_limited=%s"
            ),
            len(groups),
            fresh_count,
            stale_count,
            negative_count,
            queued_count,
            unresolvable_count,
            self._queue.qsize() if self._queue is not None else 0,
            rate_limited,
        )
        return GemScanResult(
            values=values,
            pending_count=pending_count,
            rate_limited=rate_limited,
            retry_after_seconds=retry_after_seconds,
            used_stale_cache=used_stale_cache,
        )


__all__ = [
    "CACHE_SCHEMA_VERSION",
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
