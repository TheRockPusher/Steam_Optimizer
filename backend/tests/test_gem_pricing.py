from __future__ import annotations

import asyncio
import sqlite3
import time
from contextlib import asynccontextmanager
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

from app.gem_pricing import (
    CACHE_SCHEMA_VERSION,
    GEM_CACHE_TTL_SECONDS,
    GEM_NEGATIVE_CACHE_TTL_SECONDS,
    MIN_CIRCUIT_OPEN_SECONDS,
    STEAM_GOO_VALUE_ENDPOINT,
    CommunityLookup,
    GemKey,
    GemPriceCache,
    GemPricingService,
    GemResolution,
    ItemMetadata,
    ItemType,
    SteamCommunityGemProvider,
    SteamCommunityLimiter,
    _CircuitOpenError,
    _CommunityRateLimitedError,
    canonical_decimal,
    gem_cash_value,
    parse_get_goo_value_action,
    parse_item_metadata,
)
from app.settings import Settings


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: object = None,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self.payload = payload
        self.headers = dict(headers or {})
        self.text = ""

    def json(self) -> object:
        return self.payload

    def aiter_bytes(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        del chunk_size

        async def chunks() -> AsyncIterator[bytes]:
            yield b""

        return chunks()


class FakeHTTPClient:
    def __init__(self, responses: Sequence[FakeResponse | BaseException]) -> None:
        self.responses = list(responses)
        self.get_calls: list[dict[str, object]] = []

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

    @asynccontextmanager
    async def stream(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> AsyncIterator[FakeResponse]:
        del method, url, params, headers, follow_redirects, timeout
        if not self.responses:
            raise AssertionError
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        yield response

    async def post(self, url: str, *, data: Mapping[str, str]) -> FakeResponse:
        del url, data
        raise AssertionError


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "development",
        "signing_secret": "test-signing-secret",
        "steamapi_key": "server-only-key",
        "steam_web_api_key": "profile-key",
    }
    values.update(overrides)
    return Settings.model_validate(values)


def run[T](awaitable: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(awaitable)


def tag_item_class(class_number: int) -> dict[str, object]:
    return {
        "category": "item_class",
        "internal_name": f"item_class_{class_number}",
    }


def item_tags(
    class_number: int,
    *,
    app_id: str = "10",
    game_name: str = "Example Game",
    rarity: str = "Rare",
    border: str = "cardborder_0",
) -> list[dict[str, object]]:
    return [
        tag_item_class(class_number),
        {
            "category": "Game",
            "internal_name": f"app_{app_id}",
            "localized_tag_name": game_name,
        },
        {
            "category": "droprate",
            "internal_name": "droprate_1",
            "localized_tag_name": rarity,
        },
        {"category": "cardborder", "internal_name": border},
    ]


def goo_action(
    *,
    app_id: str = "10",
    item_type: int = 5,
    border_color: int = 0,
) -> str:
    return (
        "javascript:GetGooValue('%contextid%', '%assetid%', "
        f"{app_id}, {item_type}, {border_color});"
    )


def render_payload(
    action: str,
    *,
    listing_asset: str = "123",
) -> dict[str, object]:
    return {
        "success": True,
        "listinginfo": {"listing-1": {"asset": {"id": listing_asset}}},
        "assets": {
            "753": {
                "6": {
                    "999": {
                        "owner_actions": [
                            {
                                "link": goo_action(
                                    app_id="999",
                                    item_type=5,
                                    border_color=1,
                                )
                            }
                        ]
                    },
                    listing_asset: {"owner_actions": [{"link": action}]},
                }
            }
        },
    }


def resolution_for(
    key: GemKey,
    representative_hash: str = "Card",
    *,
    gem_yield: int = 20,
) -> GemResolution:
    return GemResolution(
        key=key,
        representative_hash=representative_hash,
        gem_yield=gem_yield,
        observed_at="2026-08-27T00:00:00Z",
    )


_ITEM_TYPES: tuple[tuple[int, ItemType], ...] = (
    (1, "badge"),
    (2, "trading_card"),
    (3, "profile_background"),
    (4, "emoticon"),
    (5, "booster_pack"),
    (6, "consumable"),
    (7, "game_goo"),
    (8, "profile_modifier"),
    (9, "scene"),
    (10, "sale_item"),
    (11, "sticker"),
    (12, "chat_effect"),
    (13, "mini_profile_background"),
    (14, "avatar_frame"),
    (15, "animated_avatar"),
    (16, "steam_deck_keyboard_skin"),
    (17, "steam_deck_startup_movie"),
)


@pytest.mark.parametrize(("class_number", "expected"), _ITEM_TYPES)
def test_parse_item_metadata_maps_all_canonical_item_classes(
    class_number: int,
    expected: ItemType,
) -> None:
    metadata = parse_item_metadata(item_tags(class_number), [], None)

    assert metadata.item_type == expected


@pytest.mark.parametrize(
    "tags",
    [
        [],
        [tag_item_class(0)],
        [tag_item_class(18)],
        [tag_item_class(2), tag_item_class(3)],
        [
            tag_item_class(2),
            {
                "category": "item_class",
                "internal_name": "item_class_02",
            },
        ],
        [{"category": "Game", "internal_name": "app_10"}],
    ],
)
def test_parse_item_metadata_unknown_missing_and_conflicting_classes_are_other(
    tags: object,
) -> None:
    metadata = parse_item_metadata(tags, [], None)

    assert metadata.item_type == "other"


def test_parse_item_metadata_preserves_independent_metadata() -> None:
    metadata = parse_item_metadata(item_tags(3), [], None)

    assert metadata == ItemMetadata(
        item_type="profile_background",
        game_app_id="10",
        game_name="Example Game",
        rarity="Rare",
        card_border="normal",
        gem_key=None,
    )


def test_whitespace_only_localized_metadata_is_discarded_independently() -> None:
    tags = item_tags(3)
    for tag in tags:
        if tag.get("category") in ("Game", "droprate"):
            tag["localized_tag_name"] = "   "

    metadata = parse_item_metadata(tags, [], None)

    assert metadata.item_type == "profile_background"
    assert metadata.game_app_id == "10"
    assert metadata.game_name is None
    assert metadata.rarity is None
    assert metadata.card_border == "normal"


def test_malformed_optional_metadata_fields_are_independent() -> None:
    tags = [
        tag_item_class(4),
        {
            "category": "Game",
            "internal_name": "app_not_digits",
            "localized_tag_name": "Still a game name",
        },
        {
            "category": "droprate",
            "internal_name": "droprate_1",
            "localized_tag_name": "x" * 8193,
        },
        {"category": "cardborder", "internal_name": "cardborder_unknown"},
    ]

    metadata = parse_item_metadata(tags, [], None)

    assert metadata.item_type == "emoticon"
    assert metadata.game_app_id is None
    assert metadata.game_name == "Still a game name"
    assert metadata.rarity is None
    assert metadata.card_border is None


@pytest.mark.parametrize("class_number", [3, 4])
def test_keyed_backgrounds_and_emoticons_have_gem_key_without_class_inference(
    class_number: int,
) -> None:
    key = GemKey("10", 42, 1)

    metadata = parse_item_metadata(
        item_tags(class_number),
        [
            {"link": goo_action(app_id="10", item_type=42, border_color=1)},
            {"link": "javascript:showDetails()"},
        ],
        None,
    )

    assert metadata.item_type in ("profile_background", "emoticon")
    assert metadata.gem_key == key


@pytest.mark.parametrize(
    ("class_number", "market_bucket_id", "expected"),
    [
        (2, "B620-5", GemKey("620", 5, 0)),
        (2, "B278100-5-1", GemKey("278100", 5, 1)),
        (3, "B730-18", GemKey("730", 18, 0)),
        (4, "B730-14", GemKey("730", 14, 0)),
    ],
)
def test_provider_market_bucket_ids_supply_exact_gem_keys(
    class_number: int,
    market_bucket_id: str,
    expected: GemKey,
) -> None:
    metadata = parse_item_metadata(
        item_tags(class_number),
        [
            {
                "name": "View Full Size",
                "link": "https://shared.steamstatic.com/background.jpg",
            }
        ],
        market_bucket_id,
    )

    assert metadata.gem_key == expected


@pytest.mark.parametrize(
    "market_bucket_id",
    [
        "",
        "B730",
        "B730-14-2",
        "B730-14-extra",
        "B730--14",
        "B0730-14",
        "B730-014",
        "B730-10000000000",
        "B100000000000000000000-14",
        {"id": "B730-14"},
    ],
)
def test_provider_market_bucket_ids_reject_malformed_or_unbounded_values(
    market_bucket_id: object,
) -> None:
    metadata = parse_item_metadata(item_tags(3), [], market_bucket_id)

    assert metadata.gem_key is None


def test_provider_market_bucket_id_is_limited_to_gem_convertible_item_classes() -> None:
    metadata = parse_item_metadata(item_tags(5), [], "B730-14")

    assert metadata.item_type == "booster_pack"
    assert metadata.gem_key is None


def test_owner_actions_and_market_bucket_id_preserve_validity_semantics() -> None:
    action = {"link": goo_action(app_id="10", item_type=5, border_color=0)}
    expected = GemKey("10", 5, 0)

    assert parse_item_metadata(item_tags(3), [action], None).gem_key == expected
    assert parse_item_metadata(item_tags(3), [action], "B10-5").gem_key == expected
    assert parse_item_metadata(item_tags(3), [action], "B10-6").gem_key is None
    assert parse_item_metadata(item_tags(3), [action], "malformed").gem_key is None
    assert parse_item_metadata(item_tags(3), [action], {"id": "B10-5"}).gem_key is None
    assert (
        parse_item_metadata(
            item_tags(3),
            [{"link": "javascript:GetGooValue(1)"}],
            "B10-5",
        ).gem_key
        is None
    )


@pytest.mark.parametrize("class_number", [5, 6, 7, 16, 17])
def test_named_item_types_without_owner_action_are_keyless(class_number: int) -> None:
    metadata = parse_item_metadata(item_tags(class_number), [], None)

    assert metadata.item_type != "other"
    assert metadata.gem_key is None


@pytest.mark.parametrize(
    ("action", "expected"),
    [
        (
            goo_action(app_id="0753", item_type=5, border_color=0),
            GemKey("753", 5, 0),
        ),
        (
            ' javascript : GetGooValue( "context", 123, 753, 6, 1 ) ',
            GemKey("753", 6, 1),
        ),
    ],
)
def test_parse_get_goo_value_action_accepts_static_numeric_tuple(
    action: str,
    expected: GemKey,
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
        (
            "javascript:GetGooValue("
            "'%contextid%', '%assetid%', 100000000000000000000, 5, 0)"
        ),
        None,
    ],
)
def test_parse_get_goo_value_action_rejects_nonstatic_or_unbounded_scripts(
    action: object,
) -> None:
    assert parse_get_goo_value_action(action) is None


def test_owner_actions_ignore_unrelated_and_reject_distinct_keys() -> None:
    tags = item_tags(3)
    first = {"link": goo_action(app_id="10", item_type=5, border_color=0)}
    second = {"link": goo_action(app_id="10", item_type=6, border_color=0)}

    assert parse_item_metadata(
        tags,
        [
            {"link": "javascript:showDetails()"},
            {"link": "javascript:OpenURL('https://example.test/GetGooValue')"},
            first,
        ],
        None,
    ).gem_key == GemKey("10", 5, 0)
    assert parse_item_metadata(tags, [first, second], None).gem_key is None
    assert (
        parse_item_metadata(
            tags, [first, {"link": "javascript:GetGooValue(1)"}], None
        ).gem_key
        is None
    )


def test_gem_key_rejects_invalid_bounds_and_is_frozen() -> None:
    with pytest.raises((TypeError, ValueError)):
        GemKey("not-digits", 1, 0)
    with pytest.raises((TypeError, ValueError)):
        GemKey("1", 1_000_000_001, 0)
    with pytest.raises((TypeError, ValueError)):
        GemKey("1", 1, 2)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="border_color"):
        GemKey("1", 1, 1.0)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="canonical"):
        GemKey("0001", 1, 0)
    key = GemKey("1", 1, 0)
    assert key.app_id == "1"
    with pytest.raises(AttributeError):
        key.app_id = "2"  # type: ignore[misc]


def test_gem_cash_value_uses_decimal_math_and_preserves_zero() -> None:
    assert canonical_decimal("001.2500") == "1.25"
    assert gem_cash_value(250, "2.00") == "0.5"
    assert gem_cash_value(250, "2.00") == gem_cash_value(250, "2")
    assert gem_cash_value(0, "2.00") == "0"
    assert gem_cash_value(1, "-2.00") is None


def test_cache_is_keyed_by_full_gem_key_and_preserves_negative_semantics(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "gems.sqlite3"
    key = GemKey("10", 5, 0)
    foil_key = GemKey("10", 5, 1)
    resolution = resolution_for(key, gem_yield=0)
    cache = GemPriceCache(cache_path)

    cache.put_positive(key, resolution)
    cache.put_negative(foil_key)

    assert cache.get(key) is not None
    assert cache.get(key).resolution() == resolution  # type: ignore[union-attr]
    negative = cache.get(foil_key)
    assert negative is not None
    assert negative.status == "negative"
    assert negative.resolution() is None
    assert set(cache.get_many([key, foil_key])) == {key, foil_key}

    with sqlite3.connect(cache_path) as connection:
        columns = connection.execute("PRAGMA table_info(gem_price_cache)").fetchall()
        assert [column[1] for column in columns] == [
            "app_id",
            "item_type",
            "border_color",
            "status",
            "representative_hash",
            "gem_yield",
            "observed_at",
            "created_at",
            "expires_at",
        ]
        assert connection.execute("PRAGMA user_version").fetchone() == (
            CACHE_SCHEMA_VERSION,
        )


def test_cache_negative_write_does_not_replace_positive_row(tmp_path: Path) -> None:
    key = GemKey("10", 5, 0)
    cache = GemPriceCache(tmp_path / "gems.sqlite3")
    resolution = resolution_for(key)

    cache.put_positive(key, resolution, now=100.0)
    cache.put_negative(key, now=200.0)

    entry = cache.get(key)
    assert entry is not None
    assert entry.status == "positive"
    assert entry.resolution() == resolution


def test_cache_cleanly_resets_v1_schema(tmp_path: Path) -> None:
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
        connection.execute("PRAGMA user_version = 1")
        connection.commit()

    cache = GemPriceCache(cache_path)
    assert cache.get(GemKey("10", 5, 0)) is None
    with sqlite3.connect(cache_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (
            CACHE_SCHEMA_VERSION,
        )
        assert connection.execute(
            "SELECT COUNT(*) FROM gem_price_cache"
        ).fetchone() == (0,)


def test_cache_get_many_matches_individual_gets_beyond_sql_variable_bound(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "gems.sqlite3"
    cache = GemPriceCache(cache_path)
    shared_app_id = "2000"
    distinct_keys = [
        GemKey(shared_app_id, 5, 0),
        GemKey(shared_app_id, 5, 1),
        GemKey(shared_app_id, 6, 0),
    ]
    resolutions = {
        key: resolution_for(key, f"Card-{index}", gem_yield=index)
        for index, key in enumerate(distinct_keys)
    }
    filler_keys = [GemKey(str(app_id), 3, 0) for app_id in range(1, 1001)]
    missing_keys = [
        GemKey(shared_app_id, 7, 0),
        GemKey("999999", 5, 0),
        GemKey("999999", 5, 1),
    ]
    malformed_positive_key = GemKey("888888", 5, 0)
    malformed_negative_key = GemKey("888888", 5, 1)
    for key in distinct_keys:
        cache.put_positive(key, resolutions[key])
    rows = [
        (
            key.app_id,
            key.item_type,
            key.border_color,
            "positive" if index % 2 == 0 else "negative",
            f"Filler-{key.app_id}" if index % 2 == 0 else None,
            index % 1000 if index % 2 == 0 else None,
            "2026-08-27T00:00:00Z" if index % 2 == 0 else None,
            1000.0,
            2000.0,
        )
        for index, key in enumerate(filler_keys)
    ]
    rows.extend(
        [
            # Positive row missing the required resolution payload.
            (
                malformed_positive_key.app_id,
                malformed_positive_key.item_type,
                malformed_positive_key.border_color,
                "positive",
                None,
                None,
                "2026-08-27T00:00:00Z",
                1000.0,
                2000.0,
            ),
            # Negative row carrying a forbidden gem_yield payload.
            (
                malformed_negative_key.app_id,
                malformed_negative_key.item_type,
                malformed_negative_key.border_color,
                "negative",
                None,
                5,
                None,
                1000.0,
                2000.0,
            ),
        ]
    )
    with sqlite3.connect(cache_path) as connection:
        connection.executemany(
            """
            INSERT INTO gem_price_cache (
                app_id, item_type, border_color, status,
                representative_hash, gem_yield, observed_at,
                created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )

    requested = [
        *distinct_keys,
        *filler_keys,
        *missing_keys,
        malformed_positive_key,
        malformed_negative_key,
        *distinct_keys,
    ]

    results = cache.get_many(requested)

    expected = {
        key: entry
        for key in dict.fromkeys(requested)
        if (entry := cache.get(key)) is not None
    }
    assert results == expected
    for key in distinct_keys:
        assert results[key].key == key
        assert results[key].resolution() == resolutions[key]
    for key in [*missing_keys, malformed_positive_key, malformed_negative_key]:
        assert key not in results


def test_provider_validates_listing_action_against_exact_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = GemKey("753", 5, 0)
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                render_payload(goo_action(app_id="753", item_type=5, border_color=0)),
            ),
            FakeResponse(200, {"success": 1, "goo_value": "0"}),
        ]
    )
    provider = SteamCommunityGemProvider(settings(), http_client=client)
    # Deterministic limiter clock: each _clock() read advances 10s of fake
    # time, so the second limiter.run computes a start-interval wait <= 0 and
    # throttling stays serialized without any real wall-clock sleep.
    fake_time = 0.0

    def deterministic_clock() -> float:
        nonlocal fake_time
        fake_time += 10.0
        return fake_time

    monkeypatch.setattr(
        SteamCommunityLimiter, "_clock", staticmethod(deterministic_clock)
    )

    result = run(provider.lookup("Example Card", gem_key=key))

    assert result.resolution is not None
    assert result.resolution.key == key
    assert result.resolution.gem_yield == 0
    assert client.get_calls[1]["url"] == STEAM_GOO_VALUE_ENDPOINT
    assert client.get_calls[1]["params"] == {
        "appid": "753",
        "item_type": "5",
        "border_color": "0",
    }


def test_provider_rejects_listing_key_mismatch_before_goo_request() -> None:
    key = GemKey("753", 5, 0)
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                render_payload(goo_action(app_id="753", item_type=6, border_color=0)),
            )
        ]
    )
    provider = SteamCommunityGemProvider(settings(), http_client=client)
    result = run(provider.lookup("Example Card", gem_key=key))

    assert result.resolution is None
    assert result.failure is not None
    assert len(client.get_calls) == 1


def test_provider_429_without_retry_after_keeps_circuit_open() -> None:
    key = GemKey("753", 5, 0)
    client = FakeHTTPClient([FakeResponse(429)])
    provider = SteamCommunityGemProvider(settings(), http_client=client)

    first = run(provider.lookup("Example Card", gem_key=key))
    second = run(provider.lookup("Example Card", gem_key=key))

    assert first.rate_limited is True
    assert first.retry_after_seconds is not None
    assert first.retry_after_seconds >= MIN_CIRCUIT_OPEN_SECONDS
    assert second.rate_limited is True
    assert len(client.get_calls) == 1


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


class ScriptedProvider:
    def __init__(
        self,
        outcomes: Sequence[CommunityLookup | BaseException] = (),
        *,
        block: bool = False,
    ) -> None:
        self.outcomes = list(outcomes)
        self.block = block
        self.calls: list[tuple[str, GemKey]] = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.active = 0
        self.max_active = 0

    async def lookup(
        self,
        market_hash_name: str,
        *,
        gem_key: GemKey,
    ) -> CommunityLookup:
        self.calls.append((market_hash_name, gem_key))
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
                    resolution=resolution_for(gem_key, market_hash_name)
                )
            if isinstance(outcome, BaseException):
                raise outcome
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        else:
            return outcome
        finally:
            self.active -= 1


def test_service_cache_only_refresh_never_starts_provider() -> None:
    cached_key = GemKey("10", 5, 0)
    missing_key = GemKey("10", 6, 0)
    cache = GemPriceCache(":memory:")
    cache.put_positive(cached_key, resolution_for(cached_key, "Cached"))
    provider = ScriptedProvider()
    service = GemPricingService(settings(), cache=cache, provider=provider)

    result = service.read_cached([cached_key, missing_key])

    assert result.values[cached_key].gem_yield == 20
    assert result.pending_count == 1
    assert provider.calls == []
    assert service._worker_task is None


def test_service_resolves_exact_keys_and_serializes_worker() -> None:
    groups = {
        GemKey("10", 5, 0): "Card normal",
        GemKey("10", 5, 1): "Card foil",
        GemKey("20", 6, 0): "Other item",
    }
    provider = ScriptedProvider()
    service = GemPricingService(
        settings(), cache=GemPriceCache(":memory:"), provider=provider
    )

    async def exercise() -> None:
        result = await service.resolve(groups)
        assert result.pending_count == len(groups)
        await service.wait_until_idle()
        assert set(provider.calls) == {
            (market_hash, key) for key, market_hash in groups.items()
        }
        assert provider.max_active == 1
        cached = service.read_cached(groups)
        assert set(cached.values) == set(groups)
        assert all(resolution.key == key for key, resolution in cached.values.items())
        await service.stop()

    run(exercise())


def test_service_returns_stale_values_while_refreshing_and_uses_cache_key() -> None:
    key = GemKey("10", 5, 0)
    cache = GemPriceCache(":memory:")
    cache.put_positive(
        key,
        resolution_for(key, "Stale"),
        now=time.time() - GEM_CACHE_TTL_SECONDS - 1,
    )
    provider = ScriptedProvider()
    service = GemPricingService(settings(), cache=cache, provider=provider)

    async def exercise() -> None:
        result = await service.resolve({key: None})
        assert result.pending_count == 0
        assert result.used_stale_cache is True
        assert result.values[key].representative_hash == "Stale"
        assert service._queue is not None
        assert service._queue.qsize() == 1
        await service.stop()

    run(exercise())


def test_service_fresh_and_expired_negative_entries() -> None:
    key = GemKey("10", 5, 0)
    cache = GemPriceCache(":memory:")
    cache.put_negative(key)
    provider = ScriptedProvider()
    service = GemPricingService(settings(), cache=cache, provider=provider)

    async def exercise() -> None:
        fresh = await service.resolve({key: "Card"})
        assert fresh.pending_count == 0
        assert provider.calls == []
        cache.put_negative(key, now=time.time() - GEM_NEGATIVE_CACHE_TTL_SECONDS - 1)
        expired = await service.resolve({key: "Card"})
        assert expired.pending_count == 1
        await service.wait_until_idle()
        assert provider.calls == [("Card", key)]
        await service.stop()

    run(exercise())


def test_service_rate_limit_retries_same_key_without_negative_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = GemKey("10", 5, 0)
    provider = ScriptedProvider(
        [
            CommunityLookup(rate_limited=True, retry_after_seconds=0),
            CommunityLookup(resolution=resolution_for(key, "Card")),
        ]
    )
    service = GemPricingService(
        settings(), cache=GemPriceCache(":memory:"), provider=provider
    )
    delays: list[float] = []
    retry_started = asyncio.Event()
    release_retry = asyncio.Event()

    async def no_sleep(seconds: float) -> None:
        delays.append(seconds)
        retry_started.set()
        await release_retry.wait()

    monkeypatch.setattr(service, "_sleep", no_sleep)

    async def exercise() -> None:
        await service.resolve({key: "Card"})
        await retry_started.wait()
        paused = await service.resolve({key: "Card"})
        assert paused.rate_limited is True
        assert paused.retry_after_seconds is not None
        release_retry.set()
        await service.wait_until_idle()
        assert provider.calls == [("Card", key), ("Card", key)]
        assert delays == [MIN_CIRCUIT_OPEN_SECONDS]
        cached = service.cache.get(key)
        assert cached is not None
        assert cached.status == "positive"
        await service.stop()

    run(exercise())


def test_service_stop_cancels_active_work_and_restarts() -> None:
    key = GemKey("10", 5, 0)
    provider = ScriptedProvider(block=True)
    service = GemPricingService(
        settings(), cache=GemPriceCache(":memory:"), provider=provider
    )

    async def exercise() -> None:
        await service.resolve({key: "Card"})
        await asyncio.sleep(0)
        await provider.started.wait()
        await service.stop()
        assert provider.cancelled is True
        assert service._worker_task is None
        assert service._queue is None
        assert service._scheduled == set()
        await service.start()
        worker = service._worker_task
        await service.start()
        assert service._worker_task is worker
        await service.stop()

    run(exercise())
