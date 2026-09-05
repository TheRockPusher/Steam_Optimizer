from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import sqlite3
import time
from collections.abc import Iterable, Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

import httpx2
from ijson.common import IncompleteJSONError, JSONError

from app.gem_pricing import (
    CACHE_SCHEMA_VERSION,
    GEM_CACHE_TTL_SECONDS,
    GEM_NEGATIVE_CACHE_TTL_SECONDS,
    MAX_GEM_LISTING_SCALAR_LENGTH,
    MIN_CIRCUIT_OPEN_SECONDS,
    GemPriceCache,
    SteamCommunityLimiter,
    _bounded_retry_after,
    _CircuitOpenError,
    _CommunityRateLimitedError,
)
from app.json_parsing import reject_duplicate_object_keys

if TYPE_CHECKING:
    from app.http_protocols import AsyncHTTPClient, HTTPResponse
    from app.settings import Settings

STEAM_COMMUNITY_BASE_URL = "https://steamcommunity.com"
STEAM_MARKET_SEARCH_RENDER_ENDPOINT = (
    f"{STEAM_COMMUNITY_BASE_URL}/market/search/render/"
)
STEAM_COMMUNITY_REFERER = f"{STEAM_COMMUNITY_BASE_URL}/market/"
STEAM_COMMUNITY_COOKIE = "bMarketOptOut=1"
STEAM_OPTIMIZER_USER_AGENT = (
    "SteamOptimizer/0.1.1 (+https://github.com/TheRockPusher/Steam_Optimizer)"
)

BOOSTER_CACHE_SCHEMA_VERSION = CACHE_SCHEMA_VERSION
BOOSTER_CACHE_TTL_SECONDS = GEM_CACHE_TTL_SECONDS
BOOSTER_NEGATIVE_CACHE_TTL_SECONDS = GEM_NEGATIVE_CACHE_TTL_SECONDS
MAX_BOOSTER_APP_ID_LENGTH = 20
MIN_BOOSTER_CARD_SET_SIZE = 5
MAX_BOOSTER_CARD_SET_SIZE = 15
MAX_BOOSTER_SEARCH_BYTES = 8 * 1024 * 1024
MAX_BOOSTER_SEARCH_NESTING = 32
MAX_BOOSTER_SEARCH_SCALAR_LENGTH = MAX_GEM_LISTING_SCALAR_LENGTH
MAX_RETRY_AFTER_SECONDS = 900

_BOOSTER_HTTP_CLIENT_ERROR = "http_client is required without a booster provider."
_CACHE_SCHEMA_VERSION_TYPE_ERROR = "schema_version must be an integer."
_CACHE_SCHEMA_VERSION_VALUE_ERROR = "schema_version must be positive."
_CACHE_READ_ONLY_REPLACE_ERROR = "Cannot replace a read-only or missing SQLite cache."
_CACHE_CONNECTION_ERROR = "SQLite connection was not created."
_BOOSTER_CACHE_TABLE_NAME = "booster_card_count_cache"
_BOOSTER_CACHE_TABLE_SQL = """
CREATE TABLE booster_card_count_cache (
    game_app_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('positive', 'negative')),
    card_set_size INTEGER,
    game_name TEXT,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    PRIMARY KEY (game_app_id)
)
"""
_BOOSTER_CACHE_TABLE_INFO = (
    ("game_app_id", "TEXT", 1, None, 1),
    ("status", "TEXT", 1, None, 0),
    ("card_set_size", "INTEGER", 0, None, 0),
    ("game_name", "TEXT", 0, None, 0),
    ("created_at", "REAL", 1, None, 0),
    ("expires_at", "REAL", 1, None, 0),
)
# get_many binds one variable per game AppID; 999 keys per statement keeps
# every batch at SQLite's portable variable ceiling of 999.
_BOOSTER_GET_MANY_BATCH_SIZE = 999
_ASCII_DIGITS = re.compile(r"[0-9]+")
_STEAM_CARD_TYPE_SUFFIX = " Trading Card"
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class BoosterResolution:
    card_set_size: int
    gem_cost: int
    game_name: str | None = None


@dataclass(frozen=True, slots=True)
class BoosterCacheEntry:
    game_app_id: str
    status: Literal["positive", "negative"]
    card_set_size: int | None
    created_at: float
    expires_at: float
    game_name: str | None = None

    @property
    def expired(self) -> bool:
        return self.expires_at <= time.time()

    def resolution(self) -> BoosterResolution | None:
        if self.status != "positive" or self.card_set_size is None:
            return None
        gem_cost = derive_booster_gem_cost(self.card_set_size)
        if gem_cost is None:
            return None
        return BoosterResolution(
            card_set_size=self.card_set_size,
            gem_cost=gem_cost,
            game_name=self.game_name,
        )


@dataclass(frozen=True, slots=True)
class BoosterLookup:
    card_set_size: int | None = None
    rate_limited: bool = False
    retry_after_seconds: int | None = None
    failure: str | None = None
    game_name: str | None = None
    # Only a successful, structurally valid market response can establish
    # that an AppID has no supported normal-card set.  Transport and parse
    # failures remain retryable and must not poison the negative cache.
    definitive_negative: bool = field(default=False, compare=False, repr=False)


@dataclass(frozen=True, slots=True)
class BoosterScanResult:
    values: Mapping[str, BoosterResolution]
    pending_count: int = 0
    rate_limited: bool = False
    retry_after_seconds: int | None = None
    used_stale_cache: bool = False


class BoosterProviderProtocol(Protocol):
    async def lookup(self, game_app_id: str) -> BoosterLookup:
        """Resolve one game's normal trading-card set size."""
        ...


def derive_booster_gem_cost(card_set_size: int) -> int | None:
    """Derive the integer gem cost for one booster from its card set size."""

    if (
        isinstance(card_set_size, bool)
        or not isinstance(card_set_size, int)
        or not MIN_BOOSTER_CARD_SET_SIZE <= card_set_size <= MAX_BOOSTER_CARD_SET_SIZE
    ):
        return None
    return (12_000 + card_set_size) // (2 * card_set_size)


def _valid_game_app_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= MAX_BOOSTER_APP_ID_LENGTH
        and _ASCII_DIGITS.fullmatch(value) is not None
    )


def _parse_card_set_size(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and _ASCII_DIGITS.fullmatch(value):
        normalized = value.lstrip("0") or "0"
        if len(normalized) > 2:
            return None
        parsed = int(normalized)
    else:
        return None
    if not MIN_BOOSTER_CARD_SET_SIZE <= parsed <= MAX_BOOSTER_CARD_SET_SIZE:
        return None
    return parsed


def _is_definitive_set_count(value: object) -> bool:
    """Return whether a successful count value proves no supported set."""

    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return 0 <= value <= 99
    if not isinstance(value, str) or _ASCII_DIGITS.fullmatch(value) is None:
        return False
    normalized = value.lstrip("0") or "0"
    return len(normalized) <= 2


def _validated_game_name(value: object) -> str | None:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_BOOSTER_SEARCH_SCALAR_LENGTH
        or "\x00" in value
    ):
        return None
    normalized = value.strip()
    return normalized or None


def _validated_game_tag(
    tags: object,
    game_app_id: str,
) -> str | None:
    if not isinstance(tags, list):
        return None
    found: str | None = None
    for tag in tags:
        if not isinstance(tag, Mapping):
            continue
        category = tag.get("category")
        internal_name = tag.get("internal_name")
        if category != "Game" or internal_name != f"app_{game_app_id}":
            continue
        candidate = _validated_game_name(tag.get("localized_tag_name"))
        if candidate is None:
            return None
        if found is None:
            found = candidate
        elif found != candidate:
            return None
    return found


def _validated_game_type(value: object) -> str | None:
    normalized = _validated_game_name(value)
    if normalized is None or not normalized.endswith(_STEAM_CARD_TYPE_SUFFIX):
        return None
    return _validated_game_name(normalized[: -len(_STEAM_CARD_TYPE_SUFFIX)])


def _game_name_from_result(
    payload: Mapping[str, object],
    game_app_id: str,
) -> str | None:
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        return None
    candidates: list[str] = []
    for result in results:
        if not isinstance(result, Mapping):
            continue
        description = result.get("asset_description")
        if not isinstance(description, Mapping):
            description = result
        tags = description.get("tags")
        tagged_name = _validated_game_tag(tags, game_app_id)
        typed_name = _validated_game_type(description.get("type"))
        if tagged_name is not None:
            if typed_name is not None and typed_name != tagged_name:
                return None
            candidates.append(tagged_name)
        elif "tags" not in description or tags == []:
            if typed_name is not None:
                candidates.append(typed_name)
    unique_candidates = tuple(dict.fromkeys(candidates))
    return unique_candidates[0] if len(unique_candidates) == 1 else None


def _bounded_json_size(value: object, maximum: int) -> int | None:
    total = 0
    pending: list[tuple[object, int]] = [(value, 0)]
    while pending:
        current, depth = pending.pop()
        if depth > MAX_BOOSTER_SEARCH_NESTING:
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
            if len(current) > MAX_BOOSTER_SEARCH_SCALAR_LENGTH:
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
    if not isinstance(value, str) or _ASCII_DIGITS.fullmatch(value.strip()) is None:
        return False
    normalized = value.strip().lstrip("0")
    return not normalized or (
        len(normalized) <= len(str(maximum)) and int(normalized) <= maximum
    )


def _is_success(value: object) -> bool:
    return value is True or (
        isinstance(value, int) and not isinstance(value, bool) and value == 1
    )


class BoosterPriceCache:
    """Persistent SQLite cache keyed only by semantic game AppID."""

    def __init__(
        self,
        path: str | Path,
        schema_version: int = BOOSTER_CACHE_SCHEMA_VERSION,
    ) -> None:
        if isinstance(schema_version, bool) or not isinstance(schema_version, int):
            raise TypeError(_CACHE_SCHEMA_VERSION_TYPE_ERROR)
        if schema_version <= 0:
            raise ValueError(_CACHE_SCHEMA_VERSION_VALUE_ERROR)
        self.path = path
        self.schema_version = schema_version
        self._memory_connection: sqlite3.Connection | None = None
        self._gem_schema = self._new_gem_schema()

    def _new_gem_schema(self) -> GemPriceCache:
        # The Gem cache owns the shared user_version/table migration contract.
        return GemPriceCache(self.path, schema_version=self.schema_version)

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
    ) -> tuple[tuple[object, ...], ...]:
        rows = connection.execute(
            f"PRAGMA table_info({_BOOSTER_CACHE_TABLE_NAME})"
        ).fetchall()
        return tuple((row[1], row[2], row[3], row[4], row[5]) for row in rows)

    @staticmethod
    def _table_sql(connection: sqlite3.Connection) -> str | None:
        row = connection.execute(
            """
            SELECT sql
              FROM sqlite_master
             WHERE type = 'table' AND name = ?
            """,
            (_BOOSTER_CACHE_TABLE_NAME,),
        ).fetchone()
        return row[0] if row is not None and isinstance(row[0], str) else None

    @classmethod
    def _is_compatible_table(cls, connection: sqlite3.Connection) -> bool:
        table_sql = cls._table_sql(connection)
        return (
            cls._table_signature(connection) == _BOOSTER_CACHE_TABLE_INFO
            and table_sql is not None
            and cls._normalized_sql(table_sql)
            == cls._normalized_sql(_BOOSTER_CACHE_TABLE_SQL)
        )

    @staticmethod
    def _object_type(connection: sqlite3.Connection) -> str | None:
        row = connection.execute(
            """
            SELECT type
              FROM sqlite_master
             WHERE name = ? COLLATE NOCASE
            """,
            (_BOOSTER_CACHE_TABLE_NAME,),
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
            "index": f"DROP INDEX IF EXISTS {_BOOSTER_CACHE_TABLE_NAME}",
            "table": f"DROP TABLE IF EXISTS {_BOOSTER_CACHE_TABLE_NAME}",
            "trigger": f"DROP TRIGGER IF EXISTS {_BOOSTER_CACHE_TABLE_NAME}",
            "view": f"DROP VIEW IF EXISTS {_BOOSTER_CACHE_TABLE_NAME}",
        }
        statement = statements.get(object_type or "")
        if statement is not None:
            connection.execute(statement)

    def _initialize_booster_table(self, connection: sqlite3.Connection) -> None:
        object_type = self._object_type(connection)
        if object_type == "table" and self._is_compatible_table(connection):
            return
        try:
            connection.execute("BEGIN IMMEDIATE")
            object_type = self._object_type(connection)
            if object_type == "table" and self._is_compatible_table(connection):
                connection.commit()
                return
            self._drop_object(connection, object_type)
            connection.execute(_BOOSTER_CACHE_TABLE_SQL)
            connection.commit()
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
            # GemPriceCache owns the shared PRAGMA user_version contract.  Run
            # it on this same connection, then initialize only our table.
            self._gem_schema._initialize(connection)
            self._initialize_booster_table(connection)
        except sqlite3.Error as error:
            if connection is not None:
                connection.close()
                connection = None
            if (
                in_memory
                or not self._gem_schema._is_corruption(error)
                or self._gem_schema._is_read_only(error)
                or self._read_only_file(path)
                or self._read_only_file(path.parent)
            ):
                raise
            self._archive_corrupt(path)
            try:
                connection = sqlite3.connect(path, timeout=2.0)
                self._gem_schema._initialize(connection)
                self._initialize_booster_table(connection)
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

    def initialize(self) -> None:
        connection = self._connect()
        self._close(connection)

    def _close(self, connection: sqlite3.Connection) -> None:
        if self.path != ":memory:":
            connection.close()

    @staticmethod
    def _sqlite_text(value: object, *, maximum: int) -> str | None:
        if not isinstance(value, str) or not value or len(value) > maximum:
            return None
        return value

    @staticmethod
    def _sqlite_real(value: object) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            return None
        try:
            result = float(value)
        except TypeError, ValueError, OverflowError:
            return None
        return result if math.isfinite(result) else None

    @staticmethod
    def _cache_status(value: object) -> Literal["positive", "negative"] | None:
        if value == "positive":
            return "positive"
        if value == "negative":
            return "negative"
        return None

    @classmethod
    def _entry(cls, row: tuple[object, ...]) -> BoosterCacheEntry | None:
        if len(row) != 6:
            return None
        game_app_id = cls._sqlite_text(row[0], maximum=MAX_BOOSTER_APP_ID_LENGTH)
        if game_app_id is None or not _valid_game_app_id(game_app_id):
            return None
        status = cls._cache_status(row[1])
        card_set_size = _parse_card_set_size(row[2])
        game_name = _validated_game_name(row[3])
        if status == "negative":
            game_name = None
        created_at = cls._sqlite_real(row[4])
        expires_at = cls._sqlite_real(row[5])
        if status is None or created_at is None or expires_at is None:
            return None
        if status == "positive" and card_set_size is None:
            return None
        if status == "negative" and card_set_size is not None:
            return None
        return BoosterCacheEntry(
            game_app_id=game_app_id,
            status=status,
            card_set_size=card_set_size,
            created_at=created_at,
            expires_at=expires_at,
            game_name=game_name,
        )

    def get(self, game_app_id: str) -> BoosterCacheEntry | None:
        connection: sqlite3.Connection | None = None
        try:
            connection = self._connect()
            row = connection.execute(
                """
                SELECT game_app_id, status, card_set_size, game_name,
                       created_at, expires_at
                  FROM booster_card_count_cache
                 WHERE game_app_id = ?
                """,
                (game_app_id,),
            ).fetchone()
            return None if row is None else self._entry(row)
        except OSError, sqlite3.Error, TypeError, ValueError:
            return None
        finally:
            if connection is not None:
                self._close(connection)

    def get_many(self, game_app_ids: Iterable[str]) -> dict[str, BoosterCacheEntry]:
        unique_ids = tuple(dict.fromkeys(game_app_ids))
        if not unique_ids:
            return {}
        connection: sqlite3.Connection | None = None
        results: dict[str, BoosterCacheEntry] = {}
        try:
            connection = self._connect()
            for start in range(0, len(unique_ids), _BOOSTER_GET_MANY_BATCH_SIZE):
                chunk = unique_ids[start : start + _BOOSTER_GET_MANY_BATCH_SIZE]
                id_values = ",".join(["?"] * len(chunk))
                rows = connection.execute(
                    f"""
                    SELECT game_app_id, status, card_set_size, game_name,
                           created_at, expires_at
                      FROM booster_card_count_cache
                     WHERE game_app_id IN ({id_values})
                    """,  # noqa: S608 - id_values contains only literal "?"
                    chunk,
                ).fetchall()
                for row in rows:
                    entry = self._entry(row)
                    if entry is not None:
                        results[entry.game_app_id] = entry
        except OSError, sqlite3.Error, TypeError, ValueError:
            return {}
        finally:
            if connection is not None:
                self._close(connection)
        return results

    def put_positive(
        self,
        game_app_id: str,
        card_set_size: int,
        *,
        game_name: str | None = None,
        now: float | None = None,
    ) -> None:
        timestamp = time.time() if now is None else now
        normalized_game_name = _validated_game_name(game_name)
        if (
            not _valid_game_app_id(game_app_id)
            or _parse_card_set_size(card_set_size) is None
        ):
            return
        connection: sqlite3.Connection | None = None
        try:
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO booster_card_count_cache (
                    game_app_id, status, card_set_size, game_name,
                    created_at, expires_at
                ) VALUES (?, 'positive', ?, ?, ?, ?)
                ON CONFLICT(game_app_id) DO UPDATE SET
                    status = excluded.status,
                    card_set_size = excluded.card_set_size,
                    game_name = COALESCE(
                        excluded.game_name,
                        booster_card_count_cache.game_name
                    ),
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at
                """,
                (
                    game_app_id,
                    card_set_size,
                    normalized_game_name,
                    timestamp,
                    timestamp + BOOSTER_CACHE_TTL_SECONDS,
                ),
            )
            connection.commit()
        except OSError, sqlite3.Error, TypeError, ValueError:
            return
        finally:
            if connection is not None:
                self._close(connection)

    def put_negative(self, game_app_id: str, *, now: float | None = None) -> None:
        timestamp = time.time() if now is None else now
        if not _valid_game_app_id(game_app_id):
            return
        connection: sqlite3.Connection | None = None
        try:
            connection = self._connect()
            connection.execute(
                """
                INSERT INTO booster_card_count_cache (
                    game_app_id, status, card_set_size, game_name,
                    created_at, expires_at
                ) VALUES (?, 'negative', NULL, NULL, ?, ?)
                ON CONFLICT(game_app_id) DO UPDATE SET
                    status = excluded.status,
                    card_set_size = NULL,
                    game_name = NULL,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at
                WHERE booster_card_count_cache.status = 'negative'
                """,
                (
                    game_app_id,
                    timestamp,
                    timestamp + BOOSTER_NEGATIVE_CACHE_TTL_SECONDS,
                ),
            )
            connection.commit()
        except OSError, sqlite3.Error, TypeError, ValueError:
            return
        finally:
            if connection is not None:
                self._close(connection)


class SteamCommunityBoosterProvider:
    """Read-only public Steam Market card-set-size provider."""

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

    async def lookup(self, game_app_id: str) -> BoosterLookup:
        if not _valid_game_app_id(game_app_id):
            return BoosterLookup(failure="Invalid booster lookup metadata.")

        async def operation() -> HTTPResponse:
            try:
                response = await self.http_client.get(
                    STEAM_MARKET_SEARCH_RENDER_ENDPOINT,
                    params={
                        "query": "",
                        "start": "0",
                        "count": "1",
                        "appid": "753",
                        "category_753_Game[]": f"tag_app_{game_app_id}",
                        "category_753_item_class[]": "tag_item_class_2",
                        "category_753_cardborder[]": "tag_cardborder_0",
                        "norender": "1",
                    },
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

        try:
            response = await self.limiter.run(operation)
            if not 200 <= response.status_code < 300:
                return BoosterLookup(failure="Steam Market card data is unavailable.")
            if not _response_content_length_within(response, MAX_BOOSTER_SEARCH_BYTES):
                return BoosterLookup(failure="Steam Market card data is unavailable.")
            raw_text = response.text
            if not isinstance(raw_text, str):
                return BoosterLookup(failure="Steam Market card data is unavailable.")
            try:
                if len(raw_text.encode("utf-8")) > MAX_BOOSTER_SEARCH_BYTES:
                    return BoosterLookup(
                        failure="Steam Market card data is unavailable."
                    )
                payload = json.loads(
                    raw_text,
                    object_pairs_hook=reject_duplicate_object_keys,
                )
            except TypeError, UnicodeError, ValueError, RecursionError:
                return BoosterLookup(failure="Steam Market card data is unavailable.")
            if _bounded_json_size(payload, MAX_BOOSTER_SEARCH_BYTES) is None:
                return BoosterLookup(failure="Steam Market card data is unavailable.")
            if not isinstance(payload, Mapping) or not _is_success(
                payload.get("success")
            ):
                return BoosterLookup(failure="Steam Market card data is unavailable.")
            raw_count = payload.get("total_count")
            card_set_size = _parse_card_set_size(raw_count)
            if card_set_size is None:
                return BoosterLookup(
                    failure="Steam Market card data is unavailable.",
                    definitive_negative=_is_definitive_set_count(raw_count),
                )
            return BoosterLookup(
                card_set_size=card_set_size,
                game_name=_game_name_from_result(payload, game_app_id),
            )
        except _CircuitOpenError as error:
            return BoosterLookup(
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
            return BoosterLookup(failure="Steam Market card data is unavailable.")


@dataclass(frozen=True, slots=True)
class _QueuedLookup:
    game_app_id: str


class BoosterPricingService:
    """Cache-aware booster lookup service with one background warmer."""

    def __init__(
        self,
        settings: Settings,
        *,
        http_client: AsyncHTTPClient | None = None,
        cache: BoosterPriceCache | None = None,
        provider: BoosterProviderProtocol | None = None,
        limiter: SteamCommunityLimiter | None = None,
    ) -> None:
        self.settings = settings
        self.cache = cache or BoosterPriceCache(settings.gem_price_cache_path)
        if provider is None:
            if http_client is None:
                raise ValueError(_BOOSTER_HTTP_CLIENT_ERROR)
            provider = SteamCommunityBoosterProvider(
                settings,
                http_client=http_client,
                limiter=limiter,
            )
        self.provider = provider
        provider_limiter = getattr(provider, "limiter", None)
        self.limiter = (
            limiter
            if limiter is not None
            else provider_limiter
            if isinstance(provider_limiter, SteamCommunityLimiter)
            else None
        )
        self._queue: asyncio.Queue[_QueuedLookup] | None = None
        self._scheduled: set[str] = set()
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
            name="booster-price-warmer",
        )

    async def start(self) -> None:
        self.cache.initialize()
        self._ensure_started()

    async def stop(self) -> None:
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
        queue = self._queue
        if queue is not None:
            await queue.join()

    @staticmethod
    def _safe_outcome(outcome: object) -> BoosterLookup:
        return (
            outcome
            if isinstance(outcome, BoosterLookup)
            else BoosterLookup(failure="Steam Market card data is unavailable.")
        )

    def _rate_limit_delay(self, outcome: BoosterLookup) -> int:
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
                outcome = await self.provider.lookup(item.game_app_id)
            except Exception:  # noqa: BLE001 - isolate provider failures per key
                outcome = BoosterLookup(
                    failure="Steam Market card data is unavailable."
                )
            outcome = self._safe_outcome(outcome)
            if outcome.rate_limited:
                delay = self._rate_limit_delay(outcome)
                self._rate_limited_until = max(
                    self._rate_limited_until,
                    self._clock() + delay,
                )
                _LOGGER.info(
                    "booster warmer rate retry delay=%d depth=%d",
                    delay,
                    self._queue.qsize() if self._queue is not None else 0,
                )
                await self._sleep(delay)
                continue
            self._record_lookup(item.game_app_id, outcome)
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
            except Exception:  # noqa: BLE001 - keep warming other games
                self._record_lookup(
                    item.game_app_id,
                    BoosterLookup(failure="Steam Market card data is unavailable."),
                )
            finally:
                self._scheduled.discard(item.game_app_id)
                queue.task_done()

    def _queue_lookup(self, game_app_id: str) -> bool:
        self._ensure_started()
        queue = self._queue
        if queue is None or game_app_id in self._scheduled:
            return False
        self._scheduled.add(game_app_id)
        queue.put_nowait(_QueuedLookup(game_app_id=game_app_id))
        return True

    def _record_lookup(self, game_app_id: str, outcome: BoosterLookup) -> None:
        if outcome.rate_limited:
            return
        if outcome.card_set_size is not None:
            card_set_size = _parse_card_set_size(outcome.card_set_size)
            if card_set_size is not None:
                self.cache.put_positive(
                    game_app_id,
                    card_set_size,
                    game_name=outcome.game_name,
                )
            return
        if outcome.definitive_negative is True:
            self.cache.put_negative(game_app_id)

    def _rate_limit_status(self) -> tuple[bool, int | None]:
        remaining = self._rate_limited_until - self._clock()
        if remaining <= 0:
            self._rate_limited_until = 0.0
            return False, None
        return True, max(1, math.ceil(remaining))

    def read_cached(
        self,
        game_app_ids: Iterable[str],
        *,
        require_game_name: bool = False,
        require_fresh: bool = False,
    ) -> BoosterScanResult:
        """Read completed warmer results without scheduling provider work."""

        unique_ids = tuple(dict.fromkeys(game_app_ids))
        cached_entries = self.cache.get_many(unique_ids)
        values: dict[str, BoosterResolution] = {}
        pending_count = 0
        used_stale_cache = False
        for game_app_id in unique_ids:
            if not _valid_game_app_id(game_app_id):
                pending_count += 1
                continue
            cached = cached_entries.get(game_app_id)
            if cached is None:
                pending_count += 1
                continue
            if cached.status == "negative":
                continue
            resolution = cached.resolution()
            if resolution is None or (
                require_game_name and resolution.game_name is None
            ):
                pending_count += 1
                continue
            if cached.expired:
                used_stale_cache = True
                if require_fresh:
                    pending_count += 1
                    continue
            values[game_app_id] = resolution
        rate_limited, retry_after_seconds = self._rate_limit_status()
        return BoosterScanResult(
            values=values,
            pending_count=pending_count,
            rate_limited=rate_limited,
            retry_after_seconds=retry_after_seconds,
            used_stale_cache=used_stale_cache,
        )

    async def resolve(
        self,
        game_app_ids: Iterable[str],
        *,
        require_game_name: bool = False,
    ) -> BoosterScanResult:
        unique_ids = tuple(dict.fromkeys(game_app_ids))
        if not unique_ids:
            return BoosterScanResult(values={})
        values: dict[str, BoosterResolution] = {}
        pending_count = 0
        used_stale_cache = False
        cached_entries = self.cache.get_many(unique_ids)

        for game_app_id in sorted(unique_ids, key=lambda value: (len(value), value)):
            if not _valid_game_app_id(game_app_id):
                pending_count += 1
                continue
            cached = cached_entries.get(game_app_id)
            resolution = cached.resolution() if cached is not None else None
            has_required_name = not require_game_name or (
                resolution is not None and resolution.game_name is not None
            )
            if cached is not None and not cached.expired:
                if (
                    cached.status == "positive"
                    and resolution is not None
                    and has_required_name
                ):
                    values[game_app_id] = resolution
                elif cached.status != "positive":
                    continue
                else:
                    pending_count += 1
                    self._queue_lookup(game_app_id)
                continue
            stale_resolution = (
                resolution
                if cached is not None
                and cached.status == "positive"
                and has_required_name
                else None
            )
            if stale_resolution is not None:
                values[game_app_id] = stale_resolution
                used_stale_cache = True
            if stale_resolution is None:
                pending_count += 1
            self._queue_lookup(game_app_id)

        rate_limited, retry_after_seconds = self._rate_limit_status()
        return BoosterScanResult(
            values=values,
            pending_count=pending_count,
            rate_limited=rate_limited,
            retry_after_seconds=retry_after_seconds,
            used_stale_cache=used_stale_cache,
        )


__all__ = [
    "BOOSTER_CACHE_SCHEMA_VERSION",
    "BOOSTER_CACHE_TTL_SECONDS",
    "BOOSTER_NEGATIVE_CACHE_TTL_SECONDS",
    "MAX_BOOSTER_APP_ID_LENGTH",
    "MAX_BOOSTER_CARD_SET_SIZE",
    "MAX_BOOSTER_SEARCH_BYTES",
    "MIN_BOOSTER_CARD_SET_SIZE",
    "STEAM_MARKET_SEARCH_RENDER_ENDPOINT",
    "BoosterCacheEntry",
    "BoosterLookup",
    "BoosterPriceCache",
    "BoosterPricingService",
    "BoosterProviderProtocol",
    "BoosterResolution",
    "BoosterScanResult",
    "SteamCommunityBoosterProvider",
    "derive_booster_gem_cost",
]
