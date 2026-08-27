from __future__ import annotations

import asyncio
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
    STEAMAPIS_ITEMS_ENDPOINT,
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


class DelayedProvider:
    def __init__(self, resolution: GemResolution) -> None:
        self.resolution = resolution
        self.calls: list[tuple[str, str, CardRarity]] = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.completed = asyncio.Event()

    async def lookup(
        self,
        market_hash_name: str,
        *,
        game_app_id: str,
        card_rarity: CardRarity,
    ) -> CommunityLookup:
        self.calls.append((market_hash_name, game_app_id, card_rarity))
        self.started.set()
        await self.release.wait()
        self.completed.set()
        return CommunityLookup(resolution=self.resolution)


def test_service_deduplicates_inflight_lookup_and_uses_cache() -> None:
    key: tuple[str, CardRarity] = ("10", "normal")
    provider = DelayedProvider(
        GemResolution(
            item_type=5,
            border_color=0,
            representative_hash="Card B",
            gem_yield=0,
            observed_at="2026-08-27T00:00:00Z",
        )
    )
    service = GemPricingService(
        settings(gem_lookup_budget_seconds=1, gem_lookup_timeout_seconds=1),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )

    async def exercise() -> tuple[GemScanResult, GemScanResult, GemScanResult]:
        first_task = asyncio.create_task(service.resolve({key: "Card B"}))
        await provider.started.wait()
        second_task = asyncio.create_task(service.resolve({key: "Card A"}))
        await asyncio.sleep(0)
        provider.release.set()
        first_result, second_result = await asyncio.gather(first_task, second_task)
        third_result = await service.resolve({key: "Card C"})
        return first_result, second_result, third_result

    first, second, third = run(exercise())
    assert len(provider.calls) == 1
    assert first.values[key].gem_yield == 0
    assert second.values[key].gem_yield == 0
    assert third.values[key].gem_yield == 0


def test_timed_out_lookup_is_cached_when_background_task_finishes() -> None:
    key: tuple[str, CardRarity] = ("10", "normal")
    provider = DelayedProvider(
        GemResolution(
            item_type=5,
            border_color=0,
            representative_hash="Card",
            gem_yield=0,
            observed_at="2026-08-27T00:00:00Z",
        )
    )
    service = GemPricingService(
        settings(gem_lookup_budget_seconds=0.01, gem_lookup_timeout_seconds=0.01),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )

    async def exercise() -> GemScanResult:
        result = await service.resolve({key: "Card"})
        provider.release.set()
        await provider.completed.wait()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return result

    result = run(exercise())
    assert result.pending_count == 1
    entry = service.cache.get(*key)
    assert entry is not None
    assert entry.status == "positive"
    resolution = entry.resolution()
    assert resolution is not None
    assert resolution.gem_yield == 0


def test_cancelled_lookup_is_cached_when_background_task_finishes() -> None:
    key: tuple[str, CardRarity] = ("10", "normal")
    provider = DelayedProvider(
        GemResolution(
            item_type=5,
            border_color=0,
            representative_hash="Card",
            gem_yield=0,
            observed_at="2026-08-27T00:00:00Z",
        )
    )
    service = GemPricingService(
        settings(gem_lookup_budget_seconds=1, gem_lookup_timeout_seconds=1),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )

    async def exercise() -> None:
        request = asyncio.create_task(service.resolve({key: "Card"}))
        await provider.started.wait()
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        provider.release.set()
        await provider.completed.wait()
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    run(exercise())
    entry = service.cache.get(*key)
    assert entry is not None
    assert entry.status == "positive"
    resolution = entry.resolution()
    assert resolution is not None
    assert resolution.gem_yield == 0


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
    provider = DelayedProvider(
        GemResolution(
            item_type=5,
            border_color=0,
            representative_hash="A",
            gem_yield=100,
            observed_at="2026-08-27T00:00:00Z",
        )
    )
    provider.release.set()
    service = GemPricingService(
        settings(gem_lookup_budget_seconds=1, gem_lookup_timeout_seconds=1),
        cache=GemPriceCache(":memory:"),
        provider=provider,
    )
    steamapis = SteamApisClient(
        settings(gem_lookup_budget_seconds=1, gem_lookup_timeout_seconds=1),
        http_client=client,
        gem_pricing=service,
    )

    result = run(steamapis.fetch_inventory("42"))
    by_id = {item.class_id: item for item in result.items}

    assert result.status == "public"
    assert result.unique_item_count == 2
    assert result.priceable_item_count == 2
    assert result.priced_item_count == 2
    assert result.price_status == "complete"
    assert result.gem_priceable_item_count == 2
    assert result.gem_priced_item_count == 2
    assert result.gem_status == "complete"
    assert by_id["1"].gem_yield == 100
    assert by_id["2"].gem_yield == 100
    assert by_id["1"].gem_cash_value == "0.2"
    assert by_id["2"].gem_cash_value == "0.2"
    assert result.gem_cash_context is not None
    assert result.gem_cash_context.sack_price == "2"
    assert provider.calls == [("A", "10", "normal")]
    assert client.get_calls[1]["url"] == STEAMAPIS_ITEMS_ENDPOINT
