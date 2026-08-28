from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import pytest

if TYPE_CHECKING:
    from collections.abc import (
        AsyncIterator,
        Awaitable,
        Callable,
        Coroutine,
        Mapping,
        Sequence,
    )
    from pathlib import Path
    from sqlite3 import Connection

from app.gem_pricing import (
    _GEM_CACHE_TABLE_SQL,
    CACHE_SCHEMA_VERSION,
    GEM_CACHE_TTL_SECONDS,
    GEM_NEGATIVE_CACHE_TTL_SECONDS,
    MIN_CIRCUIT_OPEN_SECONDS,
    STEAM_GOO_VALUE_ENDPOINT,
    CardRarity,
    CommunityLookup,
    GemPriceCache,
    GemPricingService,
    GemResolution,
    GemScanResult,
    SteamCommunityGemProvider,
    SteamCommunityLimiter,
    _CircuitOpenError,
    _CommunityRateLimitedError,
    canonical_decimal,
    gem_cash_value,
    parse_card_metadata,
    parse_get_goo_value_action,
)
from app.settings import Settings
from app.steam_gateway import (
    InventoryItem,
    SteamApisClient,
)


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: object = None,
        *,
        headers: Mapping[str, str] | None = None,
        chunks: Sequence[bytes] | None = None,
    ) -> None:
        self.status_code = status_code
        self.payload = payload
        self.headers = dict(headers or {})
        self.chunks = tuple(chunks or ())
        self.text = ""

    def json(self) -> object:
        return self.payload

    def aiter_bytes(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        del chunk_size

        async def chunks() -> AsyncIterator[bytes]:
            for chunk in self.chunks:
                yield chunk

        return chunks()


class FakeHTTPClient:
    def __init__(
        self,
        responses: Sequence[FakeResponse | BaseException],
        *,
        stream_response: FakeResponse | None = None,
    ) -> None:
        self.responses = list(responses)
        self.stream_response = stream_response
        self.get_calls: list[dict[str, object]] = []
        self.stream_calls: list[dict[str, object]] = []

    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> FakeResponse:
        self.get_calls.append(
            {
                "url": url,
                "params": params,
                "headers": headers,
                "follow_redirects": follow_redirects,
                "timeout": timeout,
            }
        )
        if not self.responses:
            raise AssertionError
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response

    async def post(
        self,
        url: str,
        *,
        data: Mapping[str, str],
    ) -> FakeResponse:
        del url, data
        raise AssertionError

    @asynccontextmanager
    async def stream(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> AsyncIterator[FakeResponse]:
        self.stream_calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "follow_redirects": follow_redirects,
                "timeout": timeout,
            }
        )
        del method, url, headers, follow_redirects, timeout
        if self.stream_response is None:
            raise AssertionError
        yield self.stream_response


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "development",
        "signing_secret": "test-signing-secret",
        "steamapi_key": "server-only-key",
        "steam_web_api_key": "profile-key",
    }
    values.update(overrides)
    return Settings.model_validate(values)


def test_settings_have_no_synchronous_gem_lookup_controls() -> None:
    assert "gem_lookup_timeout_seconds" not in Settings.model_fields
    assert "gem_lookup_budget_seconds" not in Settings.model_fields
    assert "gem_lookup_max_misses_per_scan" not in Settings.model_fields


def run[T](awaitable: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(awaitable)


def card_tags(
    *,
    app_id: str = "10",
    game_name: str = "Example Game",
    border: str = "cardborder_0",
) -> list[dict[str, object]]:
    return [
        {"category": "item_class", "internal_name": "item_class_2"},
        {
            "category": "Game",
            "internal_name": f"app_{app_id}",
            "localized_tag_name": game_name,
        },
        {"category": "cardborder", "internal_name": border},
    ]


def card_description(
    class_id: str,
    name: str,
    market_hash_name: str,
    *,
    app_id: str = "10",
    game_name: str = "Example Game",
    border: str = "cardborder_0",
) -> dict[str, object]:
    return {
        "classid": class_id,
        "instanceid": "0",
        "name": name,
        "marketHashName": market_hash_name,
        "marketable": 1,
        "tradable": 1,
        "tags": card_tags(
            app_id=app_id,
            game_name=game_name,
            border=border,
        ),
    }


def item_asset(class_id: str) -> dict[str, object]:
    return {"classid": class_id, "instanceid": "0", "amount": "1"}


def render_payload(action: str, *, listing_asset: str = "123") -> dict[str, object]:
    return {
        "success": True,
        "listinginfo": {
            "listing-1": {"asset": {"id": listing_asset}},
        },
        "assets": {
            "753": {
                "6": {
                    "999": {
                        "owner_actions": [
                            {
                                "link": (
                                    "javascript:GetGooValue('%bad%', '%asset%', "
                                    "999, 5, 1)"
                                )
                            }
                        ]
                    },
                    listing_asset: {"owner_actions": [{"link": action}]},
                }
            }
        },
    }


@pytest.mark.parametrize(
    ("border", "rarity"),
    [("cardborder_0", "normal"), ("cardborder_1", "foil")],
)
def test_parse_card_metadata_strict_rarities(border: str, rarity: CardRarity) -> None:
    metadata = parse_card_metadata(card_tags(border=border))

    assert metadata.item_type == "trading_card"
    assert metadata.game_app_id == "10"
    assert metadata.game_name == "Example Game"
    assert metadata.card_rarity == rarity


def test_inventory_item_rejects_partial_card_metadata() -> None:
    with pytest.raises(
        ValueError,
        match="Inventory item gem metadata is inconsistent",
    ):
        InventoryItem(
            class_id="1",
            instance_id="0",
            name="Card",
            quantity=1,
            marketable=True,
            tradable=True,
            item_type="trading_card",
            game_app_id="10",
        )


def test_parse_card_metadata_rejects_noncard_without_card_class_tag() -> None:
    metadata = parse_card_metadata(
        [
            {"category": "Game", "internal_name": "app_10"},
            {"category": "cardborder", "internal_name": "cardborder_0"},
        ]
    )

    assert metadata.item_type == "other"
    assert metadata.game_app_id is None
    assert metadata.game_name is None
    assert metadata.card_rarity is None


@pytest.mark.parametrize(
    "tags",
    [
        [
            {"category": "item_class", "internal_name": "item_class_2"},
            {"category": "Game", "internal_name": "app_not_digits"},
            {"category": "cardborder", "internal_name": "cardborder_0"},
        ],
        [
            {"category": "item_class", "internal_name": "item_class_2"},
            {"category": "Game", "internal_name": "app_10"},
            {"category": "cardborder", "internal_name": "cardborder_9"},
        ],
        [
            {"category": "item_class", "internal_name": "item_class_2"},
            {"category": "Game", "internal_name": "app_10"},
            {"category": "cardborder", "internal_name": "cardborder_0"},
            "malformed-tag",
        ],
    ],
)
def test_parse_card_metadata_keeps_malformed_cards_unresolved(
    tags: object,
) -> None:
    metadata = parse_card_metadata(tags)

    assert metadata.item_type == "trading_card"
    assert metadata.game_app_id is None
    assert metadata.game_name is None
    assert metadata.card_rarity is None


@pytest.mark.parametrize(
    ("action", "expected"),
    [
        (
            "javascript:GetGooValue('%contextid%', '%assetid%', 753, 5, 0);",
            (753, 5, 0),
        ),
        (
            ' javascript : GetGooValue( "context", 123, 753, 6, 1 ) ',
            (753, 6, 1),
        ),
    ],
)
def test_parse_get_goo_value_action_accepts_static_numeric_tuple(
    action: str, expected: tuple[int, int, int]
) -> None:
    assert parse_get_goo_value_action(action) == expected


@pytest.mark.parametrize(
    "action",
    [
        "",
        "javascript:GetGooValue('%contextid%', '%assetid%', 753, 5)",
        "javascript:alert(1)",
        "javascript:GetGooValue('%contextid%', '%assetid%', 753, 5, alert(1))",
        "javascript:GetGooValue('%contextid%', '%assetid%', 753, 5, 2)",
        None,
    ],
)
def test_parse_get_goo_value_action_rejects_malformed_scripts(
    action: object,
) -> None:
    assert parse_get_goo_value_action(action) is None


def test_gem_cash_value_uses_decimal_math_and_preserves_zero() -> None:
    assert canonical_decimal("001.2500") == "1.25"
    assert gem_cash_value(250, "2.00") == "0.5"
    assert gem_cash_value(250, Decimal("2.00")) == "0.5"
    assert gem_cash_value(0, "2.00") == "0"
    assert gem_cash_value(1, "-2.00") is None
    assert (
        gem_cash_value(1, "123456789012345678901234567890")
        == "123456789012345678901234567.89"
    )


def test_cache_persists_zero_and_distinguishes_negative_entries(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "gems.sqlite3"
    positive = GemResolution(
        item_type=5,
        border_color=0,
        representative_hash="Card",
        gem_yield=0,
        observed_at="2026-08-27T00:00:00Z",
    )

    GemPriceCache(str(cache_path)).put_positive("10", "normal", positive)
    GemPriceCache(str(cache_path)).put_negative("10", "foil")

    reopened = GemPriceCache(str(cache_path))
    zero_entry = reopened.get("10", "normal")
    negative_entry = reopened.get("10", "foil")
    assert zero_entry is not None
    assert zero_entry.status == "positive"
    zero_resolution = zero_entry.resolution()
    assert zero_resolution is not None
    assert zero_resolution.gem_yield == 0
    assert negative_entry is not None
    assert negative_entry.status == "negative"
    assert negative_entry.resolution() is None


def test_cache_negative_write_preserves_positive_row(tmp_path: Path) -> None:
    cache = GemPriceCache(tmp_path / "gems.sqlite3")
    positive = resolution_for("Card", gem_yield=20)

    cache.put_positive("10", "normal", positive, now=100.0)
    cache.put_negative("10", "normal", now=200.0)

    entry = cache.get("10", "normal")
    assert entry is not None
    assert entry.status == "positive"
    assert entry.resolution() == positive


def test_cache_reads_multiple_groups_with_one_connection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = GemPriceCache(tmp_path / "gems.sqlite3")
    resolution = GemResolution(
        item_type=5,
        border_color=0,
        representative_hash="Card",
        gem_yield=20,
        observed_at="2026-08-27T00:00:00Z",
    )
    cache.put_positive("10", "normal", resolution)
    cache.put_positive("20", "foil", resolution)
    original_connect = cache._connect
    connection_count = 0

    def counted_connect() -> Connection:
        nonlocal connection_count
        connection_count += 1
        return original_connect()

    monkeypatch.setattr(cache, "_connect", counted_connect)

    entries = cache.get_many((("10", "normal"), ("20", "foil")))

    assert set(entries) == {("10", "normal"), ("20", "foil")}
    assert connection_count == 1


def test_cache_reopen_preserves_rows_and_schema_version(tmp_path: Path) -> None:
    cache_path = tmp_path / "gems.sqlite3"
    resolution = GemResolution(
        item_type=5,
        border_color=0,
        representative_hash="Card",
        gem_yield=20,
        observed_at="2026-08-27T00:00:00Z",
    )
    GemPriceCache(cache_path).put_positive("10", "normal", resolution)
    GemPriceCache(cache_path).put_negative("20", "foil")

    reopened = GemPriceCache(cache_path)
    assert reopened.get("10", "normal") is not None
    assert reopened.get("20", "foil") is not None
    with sqlite3.connect(cache_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (
            CACHE_SCHEMA_VERSION,
        )


def test_cache_migrates_exact_legacy_v0_table_without_losing_rows(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(cache_path) as connection:
        connection.execute(
            """
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
        )
        connection.execute(
            """
            INSERT INTO gem_price_cache (
                game_app_id, card_rarity, status, item_type, border_color,
                representative_hash, gem_yield, observed_at, created_at,
                expires_at
            ) VALUES ('10', 'normal', 'positive', 5, 0, 'Card', 20, ?, 0, 100)
            """,
            ("2026-08-27T00:00:00Z",),
        )
        connection.execute(
            """
            INSERT INTO gem_price_cache (
                game_app_id, card_rarity, status, created_at, expires_at
            ) VALUES ('20', 'foil', 'negative', 0, 100)
            """
        )
        connection.commit()

    cache = GemPriceCache(cache_path)
    positive = cache.get("10", "normal")
    negative = cache.get("20", "foil")
    assert positive is not None
    assert positive.gem_yield == 20
    assert negative is not None
    assert negative.status == "negative"
    with sqlite3.connect(cache_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (
            CACHE_SCHEMA_VERSION,
        )


def test_cache_version_mismatch_resets_transactionally(tmp_path: Path) -> None:
    cache_path = tmp_path / "versioned.sqlite3"
    resolution = GemResolution(
        item_type=5,
        border_color=0,
        representative_hash="Card",
        gem_yield=20,
        observed_at="2026-08-27T00:00:00Z",
    )
    GemPriceCache(cache_path).put_positive("10", "normal", resolution)

    mismatched = GemPriceCache(cache_path, schema_version=2)
    assert mismatched.get("10", "normal") is None
    with sqlite3.connect(cache_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (2,)


def test_cache_incompatible_schema_resets_to_current_table(tmp_path: Path) -> None:
    cache_path = tmp_path / "incompatible.sqlite3"
    with sqlite3.connect(cache_path) as connection:
        connection.execute("CREATE TABLE gem_price_cache (old_value TEXT)")
        connection.execute(
            "INSERT INTO gem_price_cache (old_value) VALUES ('discarded')"
        )
        connection.commit()

    cache = GemPriceCache(cache_path)
    assert cache.get("10", "normal") is None
    with sqlite3.connect(cache_path) as connection:
        columns = connection.execute("PRAGMA table_info(gem_price_cache)").fetchall()
        assert len(columns) == 10
        assert connection.execute("PRAGMA user_version").fetchone() == (
            CACHE_SCHEMA_VERSION,
        )


def test_cache_uppercase_check_literals_reset_schema(tmp_path: Path) -> None:
    cache_path = tmp_path / "uppercase-check.sqlite3"
    uppercase_sql = _GEM_CACHE_TABLE_SQL.replace("'positive'", "'POSITIVE'").replace(
        "'negative'", "'NEGATIVE'"
    )
    with sqlite3.connect(cache_path) as connection:
        connection.execute(uppercase_sql)
        connection.execute(f"PRAGMA user_version = {CACHE_SCHEMA_VERSION}")
        connection.execute(
            """
            INSERT INTO gem_price_cache (
                game_app_id, card_rarity, status, item_type, border_color,
                representative_hash, gem_yield, observed_at, created_at,
                expires_at
            ) VALUES ('10', 'normal', 'POSITIVE', 5, 0, 'Card', 20, ?, 0, 100)
            """,
            ("2026-08-27T00:00:00Z",),
        )
        connection.commit()

    cache = GemPriceCache(cache_path)
    assert cache.get("10", "normal") is None
    with sqlite3.connect(cache_path) as connection:
        row = connection.execute("SELECT COUNT(*) FROM gem_price_cache").fetchone()
        table_sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'gem_price_cache'"
        ).fetchone()[0]
    assert row == (0,)
    assert "'positive', 'negative'" in table_sql


def test_cache_concurrent_initialization_preserves_new_rows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache_path = tmp_path / "concurrent.sqlite3"
    initial_reads = threading.Barrier(2)
    first_write = threading.Event()
    second_reset_timed_out = threading.Event()
    state_lock = threading.Lock()
    object_type_calls = 0
    drop_calls = 0
    positive_calls = 0
    errors: list[BaseException] = []
    resolution = GemResolution(
        item_type=5,
        border_color=0,
        representative_hash="Card",
        gem_yield=20,
        observed_at="2026-08-27T00:00:00Z",
    )

    original_object_type = GemPriceCache._object_type

    def gated_object_type(connection: Connection) -> str | None:
        nonlocal object_type_calls
        with state_lock:
            object_type_calls += 1
            wait_for_initial_read = object_type_calls <= 2
        if wait_for_initial_read:
            initial_reads.wait(timeout=5)
        return original_object_type(connection)

    original_drop_object = GemPriceCache._drop_object

    def controlled_drop_object(
        connection: Connection,
        object_type: str | None,
    ) -> None:
        nonlocal drop_calls
        with state_lock:
            drop_calls += 1
            wait_for_first_write = drop_calls == 2
        if wait_for_first_write and not first_write.wait(timeout=5):
            second_reset_timed_out.set()
        original_drop_object(connection, object_type)

    original_put_positive = GemPriceCache.put_positive

    def tracked_put_positive(
        cache: GemPriceCache,
        game_app_id: str,
        card_rarity: CardRarity,
        value: GemResolution,
        *,
        now: float | None = None,
    ) -> None:
        nonlocal positive_calls
        original_put_positive(
            cache,
            game_app_id,
            card_rarity,
            value,
            now=now,
        )
        with state_lock:
            positive_calls += 1
            is_first_write = positive_calls == 1
        if is_first_write:
            first_write.set()

    monkeypatch.setattr(
        GemPriceCache,
        "_object_type",
        staticmethod(gated_object_type),
    )
    monkeypatch.setattr(
        GemPriceCache,
        "_drop_object",
        staticmethod(controlled_drop_object),
    )
    monkeypatch.setattr(GemPriceCache, "put_positive", tracked_put_positive)

    def write(key: tuple[str, CardRarity]) -> None:
        try:
            GemPriceCache(cache_path).put_positive(*key, resolution)
        except (OSError, RuntimeError, sqlite3.Error) as error:
            with state_lock:
                errors.append(error)

    threads = [
        threading.Thread(target=write, args=(("10", "normal"),)),
        threading.Thread(target=write, args=(("20", "foil"),)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    assert second_reset_timed_out.is_set() is False
    assert positive_calls == 2
    cache = GemPriceCache(cache_path)
    assert cache.get("10", "normal") is not None
    assert cache.get("20", "foil") is not None


def test_corrupt_cache_is_archived_and_recreated(tmp_path: Path) -> None:
    cache_path = tmp_path / "corrupt.sqlite3"
    cache_path.write_bytes(b"not sqlite")

    assert GemPriceCache(cache_path).get("10", "normal") is None
    assert list(tmp_path.glob("corrupt.sqlite3.corrupt-*"))
    with sqlite3.connect(cache_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (
            CACHE_SCHEMA_VERSION,
        )


def test_provider_uses_listinginfo_asset_and_static_opt_out_cookie(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock_values = iter((0.0, 0.0, 4.0, 4.0))
    monkeypatch.setattr(
        SteamCommunityLimiter,
        "_clock",
        staticmethod(lambda: next(clock_values)),
    )
    action = "javascript:GetGooValue('%contextid%', '%assetid%', 753, 5, 0);"
    client = FakeHTTPClient(
        [
            FakeResponse(200, render_payload(action)),
            FakeResponse(200, {"success": 1, "goo_value": "0"}),
        ]
    )
    provider = SteamCommunityGemProvider(
        settings(),
        http_client=client,
        limiter=SteamCommunityLimiter(),
    )

    result = run(
        provider.lookup(
            "Example Card",
            game_app_id="753",
            card_rarity="normal",
        )
    )

    resolution = result.resolution
    assert resolution is not None
    assert resolution.gem_yield == 0
    assert len(client.get_calls) == 2
    assert client.get_calls[0]["headers"] == {
        "Accept": "application/json",
        "Cookie": "bMarketOptOut=1",
        "Referer": "https://steamcommunity.com/market/",
        "User-Agent": (
            "SteamOptimizer/0.1.1 (+https://github.com/TheRockPusher/Steam_Optimizer)"
        ),
    }
    assert client.get_calls[0]["follow_redirects"] is False
    assert client.get_calls[1]["url"] == STEAM_GOO_VALUE_ENDPOINT
    assert client.get_calls[1]["params"] == {
        "appid": "753",
        "item_type": "5",
        "border_color": "0",
    }


def test_provider_rejects_app_or_border_mismatch_before_goo_request() -> None:
    action = "javascript:GetGooValue('%contextid%', '%assetid%', 999, 5, 1);"
    client = FakeHTTPClient([FakeResponse(200, render_payload(action))])
    provider = SteamCommunityGemProvider(settings(), http_client=client)

    result = run(
        provider.lookup(
            "Example Card",
            game_app_id="753",
            card_rarity="normal",
        )
    )

    assert result.resolution is None
    assert result.failure is not None
    assert len(client.get_calls) == 1


def test_provider_429_without_retry_after_keeps_circuit_open() -> None:
    client = FakeHTTPClient([FakeResponse(429)])
    provider = SteamCommunityGemProvider(settings(), http_client=client)

    first = run(
        provider.lookup(
            "Example Card",
            game_app_id="753",
            card_rarity="normal",
        )
    )
    second = run(
        provider.lookup(
            "Example Card",
            game_app_id="753",
            card_rarity="normal",
        )
    )

    assert first.rate_limited is True
    assert first.retry_after_seconds is not None
    assert first.retry_after_seconds >= MIN_CIRCUIT_OPEN_SECONDS
    assert second.rate_limited is True
    assert len(client.get_calls) == 1


def test_rate_limit_opens_conservative_breaker_without_waiting() -> None:
    limiter = SteamCommunityLimiter()
    calls = 0

    async def rate_limited() -> None:
        nonlocal calls
        calls += 1
        raise _CommunityRateLimitedError(None)

    first = run_capture_circuit(limiter, rate_limited)
    assert first.retry_after_seconds >= MIN_CIRCUIT_OPEN_SECONDS

    async def should_not_run() -> None:
        nonlocal calls
        calls += 1

    second = run_capture_circuit(limiter, should_not_run)
    assert second.retry_after_seconds >= MIN_CIRCUIT_OPEN_SECONDS
    assert calls == 1


def run_capture_circuit(
    limiter: SteamCommunityLimiter,
    operation: Callable[[], Awaitable[None]],
) -> _CircuitOpenError:
    async def invoke() -> _CircuitOpenError:
        try:
            await limiter.run(operation)
        except _CircuitOpenError as error:
            return error
        raise AssertionError

    return run(invoke())


class ScriptedProvider:
    def __init__(
        self,
        outcomes: Sequence[CommunityLookup | BaseException] = (),
        *,
        block: bool = False,
    ) -> None:
        self.outcomes = list(outcomes)
        self.block = block
        self.calls: list[tuple[str, str, CardRarity]] = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.active = 0
        self.max_active = 0
        self.cancelled = False
        self.completed = asyncio.Event()

    async def lookup(
        self,
        market_hash_name: str,
        *,
        game_app_id: str,
        card_rarity: CardRarity,
    ) -> CommunityLookup:
        self.calls.append((market_hash_name, game_app_id, card_rarity))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.started.set()
        try:
            if self.block:
                await self.release.wait()
            outcome: CommunityLookup | BaseException
            if self.outcomes:
                outcome = self.outcomes.pop(0)
            else:
                outcome = CommunityLookup(
                    resolution=GemResolution(
                        item_type=5,
                        border_color=0,
                        representative_hash=market_hash_name,
                        gem_yield=20,
                        observed_at="2026-08-27T00:00:00Z",
                    )
                )
            if not isinstance(outcome, BaseException):
                self.completed.set()
                return outcome
            raise outcome
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        finally:
            self.active -= 1


def resolution_for(
    representative_hash: str = "Card",
    *,
    gem_yield: int = 20,
) -> GemResolution:
    return GemResolution(
        item_type=5,
        border_color=0,
        representative_hash=representative_hash,
        gem_yield=gem_yield,
        observed_at="2026-08-27T00:00:00Z",
    )


def test_service_start_initializes_persistent_cache(tmp_path: Path) -> None:
    cache_path = tmp_path / "gems.sqlite3"
    service = GemPricingService(
        settings(),
        cache=GemPriceCache(cache_path),
        provider=ScriptedProvider(),
    )

    async def exercise() -> None:
        await service.start()
        await service.stop()

    run(exercise())

    with sqlite3.connect(cache_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (
            CACHE_SCHEMA_VERSION,
        )


def test_cache_only_refresh_never_calls_or_starts_provider() -> None:
    cached_key: tuple[str, CardRarity] = ("10", "normal")
    missing_key: tuple[str, CardRarity] = ("20", "foil")
    negative_key: tuple[str, CardRarity] = ("30", "normal")
    cache = GemPriceCache(":memory:")
    cache.put_positive(*cached_key, resolution_for("Cached"))
    cache.put_negative(*negative_key)
    provider = ScriptedProvider()
    service = GemPricingService(settings(), cache=cache, provider=provider)

    result = service.read_cached((cached_key, missing_key, negative_key))

    assert result.values[cached_key].gem_yield == 20
    assert result.pending_count == 1
    assert provider.calls == []
    assert service._worker_task is None


def test_service_returns_fresh_and_expired_positive_immediately() -> None:
    key: tuple[str, CardRarity] = ("10", "normal")
    stale_key: tuple[str, CardRarity] = ("20", "foil")
    cache = GemPriceCache(":memory:")
    now = time.time()
    cache.put_positive("10", "normal", resolution_for("Fresh"), now=now)
    cache.put_positive(
        "20",
        "foil",
        resolution_for("Stale"),
        now=now - GEM_CACHE_TTL_SECONDS - 1,
    )
    provider = ScriptedProvider()
    service = GemPricingService(settings(), cache=cache, provider=provider)

    async def exercise() -> GemScanResult:
        result = await service.resolve({key: "Fresh", stale_key: None})
        assert result.pending_count == 0
        assert result.used_stale_cache is True
        assert result.values[key].gem_yield == 20
        assert result.values[stale_key].representative_hash == "Stale"
        assert provider.calls == []
        assert service._queue is not None
        assert service._queue.qsize() == 1
        await service.stop()
        return result

    run(exercise())


def test_service_queues_every_uncached_group_and_serializes_worker() -> None:
    groups: dict[tuple[str, CardRarity], str] = {
        (str(index), "normal"): f"Card {index}" for index in range(5)
    }
    provider = ScriptedProvider()
    service = GemPricingService(
        settings(),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )

    async def exercise() -> GemScanResult:
        result = await service.resolve(groups)
        assert result.pending_count == len(groups)
        assert service._queue is not None
        assert service._queue.qsize() == len(groups)
        await service.wait_until_idle()
        assert len(provider.calls) == len(groups)
        assert provider.max_active == 1
        await service.stop()
        return result

    run(exercise())


def test_service_deduplicates_queued_and_active_keys() -> None:
    key: tuple[str, CardRarity] = ("10", "normal")
    provider = ScriptedProvider(
        [CommunityLookup(resolution=resolution_for())],
        block=True,
    )
    service = GemPricingService(
        settings(),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )

    async def exercise() -> None:
        first = await service.resolve({key: "Card A"})
        assert first.pending_count == 1
        await asyncio.sleep(0)
        await provider.started.wait()
        second = await service.resolve({key: "Card B"})
        assert second.pending_count == 1
        assert len(provider.calls) == 1
        assert service._queue is not None
        assert service._queue.qsize() == 0
        provider.release.set()
        await service.wait_until_idle()
        third = await service.resolve({key: "Card C"})
        assert third.values[key].gem_yield == 20
        assert len(provider.calls) == 1
        await service.stop()

    run(exercise())


def test_service_suppresses_fresh_negative_and_requeues_expired_negative() -> None:
    key: tuple[str, CardRarity] = ("10", "normal")
    cache = GemPriceCache(":memory:")
    cache.put_negative("10", "normal", now=time.time())
    provider = ScriptedProvider()
    service = GemPricingService(settings(), cache=cache, provider=provider)

    async def exercise() -> None:
        fresh = await service.resolve({key: "Card"})
        assert fresh.pending_count == 0
        assert fresh.values == {}
        assert provider.calls == []
        cache.put_negative(
            "10",
            "normal",
            now=time.time() - GEM_NEGATIVE_CACHE_TTL_SECONDS - 1,
        )
        expired = await service.resolve({key: "Card"})
        assert expired.pending_count == 1
        await service.wait_until_idle()
        assert len(provider.calls) == 1
        await service.stop()

    run(exercise())


def test_service_keeps_unresolvable_group_pending_without_queue() -> None:
    key: tuple[str, CardRarity] = ("10", "normal")
    provider = ScriptedProvider()
    service = GemPricingService(
        settings(),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )

    async def exercise() -> None:
        result = await service.resolve({key: None})
        assert result.pending_count == 1
        assert provider.calls == []
        assert service._queue is None
        await service.stop()

    run(exercise())


def test_service_failure_caches_negative_and_continues() -> None:
    first_key: tuple[str, CardRarity] = ("10", "normal")
    second_key: tuple[str, CardRarity] = ("20", "normal")
    provider = ScriptedProvider(
        [
            CommunityLookup(failure="unavailable"),
            CommunityLookup(resolution=resolution_for("Second")),
        ]
    )
    service = GemPricingService(
        settings(),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )

    async def exercise() -> None:
        result = await service.resolve({first_key: "First", second_key: "Second"})
        assert result.pending_count == 2
        await service.wait_until_idle()
        first = service.cache.get(*first_key)
        second = service.cache.get(*second_key)
        assert first is not None
        assert first.status == "negative"
        assert second is not None
        assert second.status == "positive"
        assert len(provider.calls) == 2
        await service.stop()

    run(exercise())


def test_service_rate_limit_retries_same_key_without_negative_or_drain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_key: tuple[str, CardRarity] = ("10", "normal")
    second_key: tuple[str, CardRarity] = ("20", "normal")
    provider = ScriptedProvider(
        [
            CommunityLookup(rate_limited=True, retry_after_seconds=0),
            CommunityLookup(resolution=resolution_for("First")),
            CommunityLookup(resolution=resolution_for("Second")),
        ]
    )
    service = GemPricingService(
        settings(),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )
    delays: list[float] = []
    rate_paused = asyncio.Event()
    release_retry = asyncio.Event()

    async def no_sleep(seconds: float) -> None:
        delays.append(seconds)
        rate_paused.set()
        await release_retry.wait()

    monkeypatch.setattr(service, "_sleep", no_sleep)

    async def exercise() -> None:
        result = await service.resolve({first_key: "First", second_key: "Second"})
        assert result.rate_limited is False
        await provider.started.wait()
        await rate_paused.wait()
        paused = await service.resolve({first_key: "First", second_key: "Second"})
        assert paused.rate_limited is True
        assert paused.retry_after_seconds is not None
        assert paused.retry_after_seconds >= MIN_CIRCUIT_OPEN_SECONDS
        release_retry.set()
        await service.wait_until_idle()
        assert len(provider.calls) == 3
        assert provider.calls[0][1] == "10"
        assert provider.calls[1][1] == "10"
        assert provider.calls[2][1] == "20"
        assert delays == [MIN_CIRCUIT_OPEN_SECONDS]
        first = service.cache.get(*first_key)
        assert first is not None
        assert first.status == "positive"
        assert first.resolution() is not None
        await service.stop()

    run(exercise())


def test_service_stop_cancels_active_work_is_idempotent_and_restarts() -> None:
    groups: dict[tuple[str, CardRarity], str] = {
        ("10", "normal"): "Card 10",
        ("20", "normal"): "Card 20",
    }
    provider = ScriptedProvider(block=True)
    service = GemPricingService(
        settings(),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )

    async def exercise() -> None:
        await service.resolve(groups)
        await asyncio.sleep(0)
        await provider.started.wait()
        await service.stop()
        assert provider.cancelled is True
        assert service._worker_task is None
        assert service._queue is None
        assert service._scheduled == set()
        await service.stop()
        await service.start()
        first_worker = service._worker_task
        await service.start()
        assert service._worker_task is first_worker
        assert first_worker is not None
        assert not first_worker.done()
        await service.stop()

    run(exercise())


def test_inventory_groups_cards_and_prices_sack_without_coverage_inflation() -> None:
    descriptions = [
        card_description("1", "Card B", "B"),
        card_description("2", "Card A", "A"),
    ]
    inventory_payload = {
        "success": 1,
        "assets": [item_asset("1"), item_asset("2")],
        "descriptions": descriptions,
        "more_items": 0,
    }
    price_feed = (
        b'{"metadata":{},"items":['
        b'{"marketHashName":"A","orderBook":{"lowestSell":"1.00"}},'
        b'{"marketHashName":"B","orderBook":{"lowestSell":"1.00"}},'
        b'{"marketHashName":"753-Sack of Gems",'
        b'"orderBook":{"lowestSell":"2.00"}}]}'
    )
    client = FakeHTTPClient(
        [
            FakeResponse(200, inventory_payload),
            FakeResponse(
                302,
                headers={
                    "Location": (
                        "https://steamapis-test.r2.cloudflarestorage.com/items.json"
                    )
                },
            ),
        ],
        stream_response=FakeResponse(200, chunks=[price_feed]),
    )
    provider = ScriptedProvider(
        [CommunityLookup(resolution=resolution_for("A", gem_yield=100))],
        block=True,
    )
    service = GemPricingService(
        settings(),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )
    steamapis = SteamApisClient(
        settings(),
        http_client=client,
        gem_pricing=service,
    )

    async def exercise() -> None:
        result = await steamapis.fetch_inventory("42")
        by_id = {item.class_id: item for item in result.items}
        assert result.status == "public"
        assert result.unique_item_count == 2
        assert result.priceable_item_count == 2
        assert result.priced_item_count == 2
        assert result.price_status == "complete"
        assert result.gem_priceable_item_count == 2
        assert result.gem_priced_item_count == 0
        assert result.gem_status == "unavailable"
        assert by_id["1"].gem_yield is None
        assert by_id["2"].gem_yield is None
        assert provider.completed.is_set() is False

        provider.release.set()
        await service.wait_until_idle()
        assert provider.calls == [("A", "10", "normal")]
        cached = await service.resolve({("10", "normal"): "A"})
        assert cached.pending_count == 0
        assert cached.values[("10", "normal")].gem_yield == 100
        await service.stop()

    run(exercise())
