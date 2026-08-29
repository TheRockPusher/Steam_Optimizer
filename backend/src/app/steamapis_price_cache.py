from __future__ import annotations

import math
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

PRICE_CACHE_SCHEMA_VERSION = 3
PRICE_CACHE_TTL_SECONDS = 86_400
PRICE_REFRESH_RETRY_BASE_SECONDS = 60
PRICE_REFRESH_RETRY_MAX_SECONDS = 3_600

MAX_PRICE_AMOUNT = Decimal(10000000000)
MAX_PRICE_DECIMAL_DIGITS = 64
MAX_PRICE_TEXT_LENGTH = 16_384
MAX_OBSERVED_AT_TEXT_LENGTH = 8_192
MAX_PRICE_QUANTITY = 1_000_000_000
MAX_NORMAL_CARD_APP_ID = 2**63 - 1
MAX_NORMAL_CARD_NAME_LENGTH = MAX_PRICE_TEXT_LENGTH
MAX_NORMAL_CARD_CATALOG_ROWS = 250_000
_MAX_OBSERVED_AT_MILLISECONDS = Decimal(253402300799999)
_MAX_GENERATION = 2**63 - 1
_MAX_FAILURE_COUNT = 16
_BATCH_SIZE = 512

_PRICE_AMOUNT_PATTERN = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")
_NORMAL_CARD_PATTERN = re.compile(r"^([1-9][0-9]*)-(.+) \(Trading Card\)$")

_PRICE_TABLE_NAME = "steamapis_price_cache"
_PRICE_META_TABLE_NAME = "steamapis_price_cache_meta"
_PRICE_INDEX_NAME = "steamapis_price_cache_generation_app_id_idx"
_PRICE_TABLE_SQL = """
CREATE TABLE steamapis_price_cache (
    generation INTEGER NOT NULL,
    market_hash_name TEXT NOT NULL,
    highest_buy TEXT,
    lowest_sell TEXT,
    highest_buy_quantity INTEGER,
    lowest_sell_quantity INTEGER,
    normal_card_app_id INTEGER,
    normal_card_name TEXT,
    observed_at TEXT,
    PRIMARY KEY (generation, market_hash_name)
)
"""
_PRICE_INDEX_SQL = f"""
CREATE INDEX {_PRICE_INDEX_NAME}
    ON {_PRICE_TABLE_NAME} (generation, normal_card_app_id)
"""
_PRICE_META_TABLE_SQL = """
CREATE TABLE steamapis_price_cache_meta (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL,
    refreshed_at REAL NOT NULL,
    failed_at REAL,
    retry_until REAL NOT NULL,
    failure_count INTEGER NOT NULL,
    optimizer_complete INTEGER NOT NULL CHECK (optimizer_complete IN (0, 1))
)
"""
_PRICE_TABLE_INFO = (
    ("generation", "INTEGER", 1, None, 1),
    ("market_hash_name", "TEXT", 1, None, 2),
    ("highest_buy", "TEXT", 0, None, 0),
    ("lowest_sell", "TEXT", 0, None, 0),
    ("highest_buy_quantity", "INTEGER", 0, None, 0),
    ("lowest_sell_quantity", "INTEGER", 0, None, 0),
    ("normal_card_app_id", "INTEGER", 0, None, 0),
    ("normal_card_name", "TEXT", 0, None, 0),
    ("observed_at", "TEXT", 0, None, 0),
)
_PRICE_META_TABLE_INFO = (
    ("singleton", "INTEGER", 1, None, 1),
    ("generation", "INTEGER", 1, None, 0),
    ("refreshed_at", "REAL", 1, None, 0),
    ("failed_at", "REAL", 0, None, 0),
    ("retry_until", "REAL", 1, None, 0),
    ("failure_count", "INTEGER", 1, None, 0),
    ("optimizer_complete", "INTEGER", 1, None, 0),
)
_PRICE_INDEX_INFO = (
    (0, "generation"),
    (1, "normal_card_app_id"),
)
_CACHE_CONNECTION_ERROR = "SQLite connection was not created."
_CACHE_READ_ONLY_REPLACE_ERROR = "Cannot replace a read-only or missing SQLite cache."
_CACHE_SCHEMA_VERSION_TYPE_ERROR = "schema_version must be an integer."
_CACHE_SCHEMA_VERSION_VALUE_ERROR = "schema_version must be positive."
_CACHE_USER_VERSION_UNAVAILABLE_ERROR = "SQLite user_version is unavailable."
_PRICE_REFRESH_CLOSED_ERROR = "Price refresh is closed."
_DUPLICATE_MARKET_HASH_ERROR = "Duplicate market hash in price generation."


@dataclass(frozen=True, slots=True)
class CachedPrice:
    market_hash_name: str
    highest_buy: str | None
    lowest_sell: str | None
    observed_at: str | None
    highest_buy_quantity: int | None = None
    lowest_sell_quantity: int | None = None
    normal_card_app_id: int | None = None
    normal_card_name: str | None = None


@dataclass(frozen=True, slots=True)
class NormalCardCatalogRead:
    """The bounded, current-generation normal-card catalog."""

    generation: int
    refreshed_at: float | None
    groups: dict[int, tuple[CachedPrice, ...]]
    row_count: int = 0
    truncated: bool = False
    optimizer_complete: bool = False

    @property
    def fresh(self) -> bool:
        return (
            self.generation > 0
            and self.refreshed_at is not None
            and time.time() < self.refreshed_at + PRICE_CACHE_TTL_SECONDS
        )

    @property
    def has_generation(self) -> bool:
        return self.generation > 0 and self.refreshed_at is not None

    @property
    def generation_age_seconds(self) -> float | None:
        if self.refreshed_at is None:
            return None
        return max(0.0, time.time() - self.refreshed_at)

    @property
    def cards(self) -> dict[int, tuple[CachedPrice, ...]]:
        return self.groups

    @property
    def by_app_id(self) -> dict[int, tuple[CachedPrice, ...]]:
        return self.groups

    @property
    def rows(self) -> tuple[CachedPrice, ...]:
        return tuple(entry for entries in self.groups.values() for entry in entries)

    @property
    def prices(self) -> dict[str, CachedPrice]:
        return {entry.market_hash_name: entry for entry in self.rows}


@dataclass(frozen=True, slots=True)
class PriceCacheRead:
    generation: int
    refreshed_at: float | None
    retry_until: float
    failure_count: int
    prices: dict[str, CachedPrice]
    optimizer_complete: bool = False

    @property
    def fresh(self) -> bool:
        return (
            self.generation > 0
            and self.refreshed_at is not None
            and time.time() < self.refreshed_at + PRICE_CACHE_TTL_SECONDS
        )

    @property
    def retry_suppressed(self) -> bool:
        return self.retry_until > time.time()

    @property
    def has_generation(self) -> bool:
        return self.generation > 0 and self.refreshed_at is not None

    @property
    def generation_age_seconds(self) -> float | None:
        if self.refreshed_at is None:
            return None
        return max(0.0, time.time() - self.refreshed_at)


@dataclass(slots=True)
class _CacheMeta:
    generation: int
    refreshed_at: float
    failed_at: float | None
    retry_until: float
    failure_count: int
    optimizer_complete: bool


class SteamApisPriceCache:
    """Persistent, generation-based cache for the complete SteamApis price feed."""

    def __init__(
        self,
        path: str | Path,
        schema_version: int = PRICE_CACHE_SCHEMA_VERSION,
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

    @staticmethod
    def _table_signature(
        connection: sqlite3.Connection,
        table_name: str,
    ) -> tuple[tuple[object, ...], ...]:
        rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
        return tuple((row[1], row[2], row[3], row[4], row[5]) for row in rows)

    @staticmethod
    def _table_sql(
        connection: sqlite3.Connection,
        table_name: str,
    ) -> str | None:
        row = connection.execute(
            """
            SELECT sql
              FROM sqlite_master
             WHERE type = 'table' AND name = ? COLLATE NOCASE
            """,
            (table_name,),
        ).fetchone()
        return row[0] if row is not None and isinstance(row[0], str) else None

    @staticmethod
    def _index_signature(
        connection: sqlite3.Connection,
        index_name: str,
    ) -> tuple[tuple[object, ...], ...]:
        rows = connection.execute(f"PRAGMA index_info({index_name})").fetchall()
        return tuple((row[0], row[2]) for row in rows)

    @staticmethod
    def _index_sql(
        connection: sqlite3.Connection,
        index_name: str,
    ) -> str | None:
        row = connection.execute(
            """
            SELECT sql
              FROM sqlite_master
             WHERE type = 'index' AND name = ? COLLATE NOCASE
            """,
            (index_name,),
        ).fetchone()
        return row[0] if row is not None and isinstance(row[0], str) else None

    @classmethod
    def _is_compatible_index(
        cls,
        connection: sqlite3.Connection,
        index_name: str,
        expected_info: tuple[tuple[object, ...], ...],
        expected_sql: str,
    ) -> bool:
        index_sql = cls._index_sql(connection, index_name)
        return (
            cls._object_type(connection, index_name) == "index"
            and cls._index_signature(connection, index_name) == expected_info
            and index_sql is not None
            and cls._normalized_sql(index_sql) == cls._normalized_sql(expected_sql)
        )

    @classmethod
    def _is_compatible_table(
        cls,
        connection: sqlite3.Connection,
        table_name: str,
        expected_info: tuple[tuple[object, ...], ...],
        expected_sql: str,
    ) -> bool:
        table_sql = cls._table_sql(connection, table_name)
        return (
            cls._table_signature(connection, table_name) == expected_info
            and table_sql is not None
            and cls._normalized_sql(table_sql) == cls._normalized_sql(expected_sql)
        )

    @staticmethod
    def _object_type(connection: sqlite3.Connection, name: str) -> str | None:
        row = connection.execute(
            """
            SELECT type
              FROM sqlite_master
             WHERE name = ? COLLATE NOCASE
            """,
            (name,),
        ).fetchone()
        return row[0] if row is not None and isinstance(row[0], str) else None

    @staticmethod
    def _drop_object(
        connection: sqlite3.Connection,
        name: str,
        object_type: str | None,
    ) -> None:
        statements = {
            "index": f"DROP INDEX IF EXISTS {name}",
            "table": f"DROP TABLE IF EXISTS {name}",
            "trigger": f"DROP TRIGGER IF EXISTS {name}",
            "view": f"DROP VIEW IF EXISTS {name}",
        }
        statement = statements.get(object_type or "")
        if statement is not None:
            connection.execute(statement)

    def _schema_state(
        self,
        connection: sqlite3.Connection,
    ) -> tuple[int, bool, bool, bool, str | None, str | None, str | None]:
        row = connection.execute("PRAGMA user_version").fetchone()
        if row is None or not isinstance(row[0], int):
            raise sqlite3.DatabaseError(_CACHE_USER_VERSION_UNAVAILABLE_ERROR)
        price_object = self._object_type(connection, _PRICE_TABLE_NAME)
        meta_object = self._object_type(connection, _PRICE_META_TABLE_NAME)
        index_object = self._object_type(connection, _PRICE_INDEX_NAME)
        price_compatible = price_object == "table" and self._is_compatible_table(
            connection,
            _PRICE_TABLE_NAME,
            _PRICE_TABLE_INFO,
            _PRICE_TABLE_SQL,
        )
        meta_compatible = meta_object == "table" and self._is_compatible_table(
            connection,
            _PRICE_META_TABLE_NAME,
            _PRICE_META_TABLE_INFO,
            _PRICE_META_TABLE_SQL,
        )
        index_compatible = price_compatible and self._is_compatible_index(
            connection,
            _PRICE_INDEX_NAME,
            _PRICE_INDEX_INFO,
            _PRICE_INDEX_SQL,
        )
        return (
            row[0],
            price_compatible,
            meta_compatible,
            index_compatible,
            price_object,
            meta_object,
            index_object,
        )

    def _initialize(self, connection: sqlite3.Connection) -> None:
        (
            initial_version,
            initial_price,
            initial_meta,
            initial_index,
            _,
            _,
            _,
        ) = self._schema_state(connection)
        if (
            initial_version == self.schema_version
            and initial_price
            and initial_meta
            and initial_index
        ):
            return
        try:
            connection.execute("BEGIN IMMEDIATE")
            (
                version,
                price_compatible,
                meta_compatible,
                index_compatible,
                price_object,
                meta_object,
                index_object,
            ) = self._schema_state(connection)
            if (
                version == self.schema_version
                and price_compatible
                and meta_compatible
                and index_compatible
            ):
                connection.commit()
                return
            if version == 0 and price_compatible and meta_compatible:
                if not index_compatible:
                    self._drop_object(connection, _PRICE_INDEX_NAME, index_object)
                    connection.execute(_PRICE_INDEX_SQL)
                connection.execute(f"PRAGMA user_version = {self.schema_version}")
            else:
                self._drop_object(connection, _PRICE_TABLE_NAME, price_object)
                self._drop_object(connection, _PRICE_META_TABLE_NAME, meta_object)
                self._drop_object(connection, _PRICE_INDEX_NAME, index_object)
                connection.execute(_PRICE_TABLE_SQL)
                connection.execute(_PRICE_INDEX_SQL)
                connection.execute(_PRICE_META_TABLE_SQL)
                connection.execute(f"PRAGMA user_version = {self.schema_version}")
            connection.commit()
        except sqlite3.Error as error:
            connection.rollback()
            if (
                initial_version == 0
                and initial_price
                and initial_meta
                and initial_index
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
            connection = sqlite3.connect(":memory:" if in_memory else path, timeout=2.0)
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

    def close(self) -> None:
        connection = self._memory_connection
        self._memory_connection = None
        if connection is not None:
            connection.close()

    def initialize(self) -> None:
        connection = self._connect()
        self._close(connection)

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
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value.strip()):
            return None
        try:
            return int(value.strip())
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
    def _normalize_market_hash_name(value: object) -> str | None:
        if (
            not isinstance(value, str)
            or not value
            or len(value) > MAX_PRICE_TEXT_LENGTH
            or "\x00" in value
        ):
            return None
        return value

    @staticmethod
    def _normalize_quantity(value: object) -> int | None:
        if value is None or isinstance(value, bool):
            return None
        if isinstance(value, int):
            parsed = value
        elif isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
            try:
                parsed = int(value)
            except ValueError:
                return None
        else:
            return None
        return parsed if 0 <= parsed <= MAX_PRICE_QUANTITY else None

    @staticmethod
    def _normal_card_metadata(value: object) -> tuple[int, str] | None:
        if not isinstance(value, str):
            return None
        match = _NORMAL_CARD_PATTERN.fullmatch(value)
        if match is None:
            return None
        try:
            app_id = int(match.group(1))
        except (TypeError, ValueError):
            return None
        card_name = match.group(2)
        if (
            not 0 < app_id <= MAX_NORMAL_CARD_APP_ID
            or not card_name
            or len(card_name) > MAX_NORMAL_CARD_NAME_LENGTH
            or "\x00" in card_name
        ):
            return None
        return app_id, card_name

    @staticmethod
    def _normalize_amount(value: object) -> str | None:
        if value is None or isinstance(value, bool):
            return None
        try:
            decimal = value if isinstance(value, Decimal) else Decimal(str(value))
            if (
                not decimal.is_finite()
                or decimal.is_signed()
                or decimal > MAX_PRICE_AMOUNT
            ):
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
            if fixed_length > MAX_PRICE_TEXT_LENGTH:
                return None
            fixed = format(decimal, "f")
        except (ArithmeticError, TypeError, ValueError):
            return None
        if len(fixed) > MAX_PRICE_TEXT_LENGTH or not _PRICE_AMOUNT_PATTERN.fullmatch(
            fixed
        ):
            return None
        return fixed

    @staticmethod
    def _normalize_observed_at(value: object) -> str | None:
        if (
            not isinstance(value, str)
            or not value
            or len(value) > MAX_OBSERVED_AT_TEXT_LENGTH
        ):
            return None
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")

    @classmethod
    def _entry(
        cls,
        row: tuple[object, ...],
        *,
        allow_empty_prices: bool = False,
    ) -> CachedPrice | None:
        if len(row) != 9:
            return None
        generation = cls._sqlite_integer(row[0])
        name = cls._normalize_market_hash_name(row[1])
        highest_buy = cls._normalize_amount(row[2])
        lowest_sell = cls._normalize_amount(row[3])
        highest_buy_quantity = cls._normalize_quantity(row[4])
        lowest_sell_quantity = cls._normalize_quantity(row[5])
        normal_card_app_id: int | None = None
        normal_card_name: str | None = None
        metadata = cls._normal_card_metadata(name)
        if metadata is not None:
            normal_card_app_id, normal_card_name = metadata
        observed_at = cls._normalize_observed_at(row[8]) if row[8] is not None else None
        if highest_buy is None:
            highest_buy_quantity = None
        if lowest_sell is None:
            lowest_sell_quantity = None
        if (
            generation is None
            or generation <= 0
            or generation > _MAX_GENERATION
            or name is None
            or (not allow_empty_prices and highest_buy is None and lowest_sell is None)
        ):
            return None
        return CachedPrice(
            name,
            highest_buy,
            lowest_sell,
            observed_at,
            highest_buy_quantity,
            lowest_sell_quantity,
            normal_card_app_id,
            normal_card_name,
        )

    @classmethod
    def _meta(cls, row: tuple[object, ...] | None) -> _CacheMeta | None:
        if row is None or len(row) != 7:
            return None
        singleton = cls._sqlite_integer(row[0])
        generation = cls._sqlite_integer(row[1])
        refreshed_at = cls._sqlite_real(row[2])
        failed_at = cls._sqlite_real(row[3]) if row[3] is not None else None
        retry_until = cls._sqlite_real(row[4])
        failure_count = cls._sqlite_integer(row[5])
        optimizer_complete = cls._sqlite_integer(row[6])
        if (
            singleton != 1
            or generation is None
            or not 0 <= generation <= _MAX_GENERATION
            or refreshed_at is None
            or refreshed_at < 0
            or (failed_at is not None and failed_at < 0)
            or retry_until is None
            or retry_until < 0
            or failure_count is None
            or not 0 <= failure_count <= _MAX_FAILURE_COUNT
            or optimizer_complete not in (0, 1)
        ):
            return None
        return _CacheMeta(
            generation,
            refreshed_at,
            failed_at,
            retry_until,
            failure_count,
            optimizer_complete == 1,
        )

    @staticmethod
    def _empty_read() -> PriceCacheRead:
        return PriceCacheRead(0, None, 0.0, 0, {})

    def read(self, names: Iterable[str] = ()) -> PriceCacheRead:
        unique_names = tuple(dict.fromkeys(names))
        connection: sqlite3.Connection | None = None
        transaction_started = False
        try:
            connection = self._connect()
            connection.execute("BEGIN")
            transaction_started = True
            meta_row = connection.execute(
                """
                SELECT singleton, generation, refreshed_at, failed_at,
                       retry_until, failure_count, optimizer_complete
                  FROM steamapis_price_cache_meta
                 WHERE singleton = 1
                """
            ).fetchone()
            meta = self._meta(meta_row)
            if meta is None:
                connection.commit()
                transaction_started = False
                return self._empty_read()
            prices: dict[str, CachedPrice] = {}
            if meta.generation > 0 and unique_names:
                for start in range(0, len(unique_names), 500):
                    batch = unique_names[start : start + 500]
                    placeholders = ",".join("?" for _ in batch)
                    query = f"""
                        SELECT generation, market_hash_name, highest_buy,
                               lowest_sell, highest_buy_quantity,
                               lowest_sell_quantity, normal_card_app_id,
                               normal_card_name, observed_at
                          FROM steamapis_price_cache
                         WHERE generation = ?
                           AND market_hash_name IN ({placeholders})
                        """  # noqa: S608 - placeholders contain only literal "?"
                    rows = connection.execute(
                        query,
                        (meta.generation, *batch),
                    ).fetchall()
                    for row in rows:
                        entry = self._entry(row)
                        if entry is not None:
                            prices[entry.market_hash_name] = entry
            result = PriceCacheRead(
                generation=meta.generation,
                refreshed_at=meta.refreshed_at if meta.generation > 0 else None,
                retry_until=meta.retry_until,
                failure_count=meta.failure_count,
                optimizer_complete=meta.optimizer_complete,
                prices=prices,
            )
            connection.commit()
            transaction_started = False
        except (OSError, sqlite3.Error, TypeError, ValueError):
            if connection is not None and transaction_started:
                connection.rollback()
            return self._empty_read()
        else:
            return result
        finally:
            if connection is not None:
                self._close(connection)

    def read_catalog(
        self,
        *,
        max_rows: int = MAX_NORMAL_CARD_CATALOG_ROWS,
    ) -> NormalCardCatalogRead:
        """Read only bounded normal-card rows from the active generation."""

        if isinstance(max_rows, bool) or not isinstance(max_rows, int) or max_rows < 0:
            return NormalCardCatalogRead(0, None, {})
        max_rows = min(max_rows, MAX_NORMAL_CARD_CATALOG_ROWS)
        if max_rows == 0:
            return NormalCardCatalogRead(0, None, {})
        connection: sqlite3.Connection | None = None
        transaction_started = False
        try:
            connection = self._connect()
            connection.execute("BEGIN")
            transaction_started = True
            meta_row = connection.execute(
                """
                SELECT singleton, generation, refreshed_at, failed_at,
                       retry_until, failure_count, optimizer_complete
                  FROM steamapis_price_cache_meta
                 WHERE singleton = 1
                """
            ).fetchone()
            meta = self._meta(meta_row)
            if meta is None or meta.generation <= 0:
                connection.commit()
                transaction_started = False
                return NormalCardCatalogRead(0, None, {})
            cursor = connection.execute(
                """
                SELECT generation, market_hash_name, highest_buy,
                       lowest_sell, highest_buy_quantity,
                       lowest_sell_quantity, normal_card_app_id,
                       normal_card_name, observed_at
                  FROM steamapis_price_cache
                 WHERE generation = ?
                   AND normal_card_app_id IS NOT NULL
                   AND normal_card_name IS NOT NULL
                 ORDER BY normal_card_app_id, market_hash_name
                 LIMIT ?
                """,
                (meta.generation, max_rows + 1),
            )
            grouped: dict[int, list[CachedPrice]] = {}
            row_count = 0
            raw_count = 0
            truncated = False
            while True:
                batch_size = min(_BATCH_SIZE, max_rows + 1)
                rows = cursor.fetchmany(batch_size)
                if not rows:
                    break
                for row in rows:
                    raw_count += 1
                    if raw_count > max_rows:
                        truncated = True
                        break
                    entry = self._entry(row, allow_empty_prices=True)
                    if entry is None or entry.normal_card_app_id is None:
                        continue
                    grouped.setdefault(entry.normal_card_app_id, []).append(entry)
                    row_count += 1
                if truncated:
                    break
                if len(rows) < batch_size:
                    break
            result = NormalCardCatalogRead(
                generation=meta.generation,
                refreshed_at=meta.refreshed_at,
                groups={app_id: tuple(entries) for app_id, entries in grouped.items()},
                row_count=row_count,
                truncated=truncated,
                optimizer_complete=meta.optimizer_complete,
            )
            connection.commit()
            transaction_started = False
        except (OSError, sqlite3.Error, TypeError, ValueError):
            if connection is not None and transaction_started:
                connection.rollback()
            return NormalCardCatalogRead(0, None, {})
        else:
            return result
        finally:
            if connection is not None:
                self._close(connection)

    def read_normal_card_catalog(
        self,
        *,
        max_rows: int = MAX_NORMAL_CARD_CATALOG_ROWS,
    ) -> NormalCardCatalogRead:
        return self.read_catalog(max_rows=max_rows)

    def begin_refresh(self) -> SteamApisPriceRefresh:
        connection: sqlite3.Connection | None = None
        try:
            connection = self._connect()
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT generation FROM steamapis_price_cache_meta WHERE singleton = 1"
            ).fetchone()
            current = self._sqlite_integer(row[0]) if row is not None else 0
            if current is None or current < 0 or current >= _MAX_GENERATION:
                current = 0
            return SteamApisPriceRefresh(self, connection, current + 1)
        except BaseException:
            if connection is not None:
                self._close(connection)
            raise

    def record_refresh_failure(self, *, now: float | None = None) -> None:
        timestamp = time.time() if now is None else now
        if not math.isfinite(timestamp) or timestamp < 0:
            timestamp = time.time()
        connection: sqlite3.Connection | None = None
        try:
            connection = self._connect()
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT singleton, generation, refreshed_at, failed_at,
                       retry_until, failure_count, optimizer_complete
                  FROM steamapis_price_cache_meta
                 WHERE singleton = 1
                """
            ).fetchone()
            meta = self._meta(row)
            failure_count = min(
                (meta.failure_count if meta is not None else 0) + 1,
                _MAX_FAILURE_COUNT,
            )
            retry_seconds = min(
                PRICE_REFRESH_RETRY_BASE_SECONDS * (2 ** (failure_count - 1)),
                PRICE_REFRESH_RETRY_MAX_SECONDS,
            )
            failure_values = (
                timestamp,
                timestamp + retry_seconds,
                failure_count,
            )
            if meta is None:
                connection.execute(
                    """
                    INSERT INTO steamapis_price_cache_meta (
                        singleton, generation, refreshed_at, failed_at,
                        retry_until, failure_count, optimizer_complete
                    ) VALUES (1, 0, 0, ?, ?, ?, 0)
                    ON CONFLICT(singleton) DO UPDATE SET
                        generation = 0,
                        refreshed_at = 0,
                        failed_at = excluded.failed_at,
                        retry_until = excluded.retry_until,
                        failure_count = excluded.failure_count,
                        optimizer_complete = 0
                    """,
                    failure_values,
                )
            else:
                connection.execute(
                    """
                    UPDATE steamapis_price_cache_meta
                       SET failed_at = ?,
                           retry_until = ?,
                           failure_count = ?
                     WHERE singleton = 1
                    """,
                    failure_values,
                )
            connection.commit()
        except (OSError, sqlite3.Error, TypeError, ValueError):
            if connection is not None:
                connection.rollback()
        finally:
            if connection is not None:
                self._close(connection)


class SteamApisPriceRefresh:
    """A transaction that atomically installs one complete streamed generation."""

    __slots__ = (
        "_accepted_count",
        "_accepted_hashes",
        "_batch",
        "_cache",
        "_closed",
        "_connection",
        "_generation",
    )

    def __init__(
        self,
        cache: SteamApisPriceCache,
        connection: sqlite3.Connection,
        generation: int,
    ) -> None:
        self._cache = cache
        self._connection = connection
        self._generation = generation
        self._accepted_count = 0
        self._accepted_hashes: set[str] = set()
        self._batch: list[
            tuple[
                str,
                str | None,
                str | None,
                int | None,
                int | None,
                int | None,
                str | None,
                str | None,
            ]
        ] = []
        self._closed = False

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def accepted_count(self) -> int:
        return self._accepted_count

    def add(
        self,
        market_hash_name: str,
        highest_buy: object,
        lowest_sell: object,
        observed_at: object,
        highest_buy_quantity: object = None,
        lowest_sell_quantity: object = None,
    ) -> None:
        if self._closed:
            raise RuntimeError(_PRICE_REFRESH_CLOSED_ERROR)
        name = self._cache._normalize_market_hash_name(market_hash_name)
        highest = self._cache._normalize_amount(highest_buy)
        lowest = self._cache._normalize_amount(lowest_sell)
        highest_quantity = self._cache._normalize_quantity(highest_buy_quantity)
        lowest_quantity = self._cache._normalize_quantity(lowest_sell_quantity)
        observed = (
            self._cache._normalize_observed_at(observed_at)
            if observed_at is not None
            else None
        )
        if name is None:
            return
        if name in self._accepted_hashes:
            raise ValueError(_DUPLICATE_MARKET_HASH_ERROR)
        self._accepted_hashes.add(name)
        if highest is None:
            highest_quantity = None
        if lowest is None:
            lowest_quantity = None
        metadata = self._cache._normal_card_metadata(name)
        normal_card_app_id, normal_card_name = (
            metadata if metadata is not None else (None, None)
        )
        self._batch.append(
            (
                name,
                highest,
                lowest,
                highest_quantity,
                lowest_quantity,
                normal_card_app_id,
                normal_card_name,
                observed,
            )
        )
        self._accepted_count += 1
        if len(self._batch) >= _BATCH_SIZE:
            self._flush()

    def _flush(self) -> None:
        if not self._batch:
            return
        self._connection.executemany(
            """
            INSERT INTO steamapis_price_cache (
                generation, market_hash_name, highest_buy, lowest_sell,
                highest_buy_quantity, lowest_sell_quantity,
                normal_card_app_id, normal_card_name, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [(self._generation, *row) for row in self._batch],
        )
        self._batch.clear()

    def commit(
        self,
        *,
        now: float | None = None,
        optimizer_complete: bool = False,
    ) -> None:
        if self._closed:
            return
        timestamp = time.time() if now is None else now
        if not math.isfinite(timestamp) or timestamp < 0:
            timestamp = time.time()
        try:
            self._flush()
            self._connection.execute(
                "DELETE FROM steamapis_price_cache WHERE generation != ?",
                (self._generation,),
            )
            self._connection.execute(
                """
                INSERT INTO steamapis_price_cache_meta (
                    singleton, generation, refreshed_at, failed_at,
                    retry_until, failure_count, optimizer_complete
                ) VALUES (1, ?, ?, NULL, 0, 0, ?)
                ON CONFLICT(singleton) DO UPDATE SET
                    generation = excluded.generation,
                    refreshed_at = excluded.refreshed_at,
                    failed_at = NULL,
                    retry_until = 0,
                    failure_count = 0,
                    optimizer_complete = excluded.optimizer_complete
                """,
                (self._generation, timestamp, int(optimizer_complete is True)),
            )
            self._connection.commit()
        except BaseException:
            self._connection.rollback()
            raise
        finally:
            self._close()

    def abort(self) -> None:
        if self._closed:
            return
        try:
            self._connection.rollback()
        finally:
            self._close()

    def _close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._cache._close(self._connection)
