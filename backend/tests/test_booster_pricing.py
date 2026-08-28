from __future__ import annotations

import asyncio
import time
from contextlib import suppress
from typing import TYPE_CHECKING, Any

import pytest

if TYPE_CHECKING:
    from collections.abc import Coroutine, Mapping, Sequence
    from pathlib import Path

from app.booster_pricing import (
    BOOSTER_NEGATIVE_CACHE_TTL_SECONDS,
    MAX_BOOSTER_SEARCH_BYTES,
    MAX_BOOSTER_SEARCH_SCALAR_LENGTH,
    STEAM_MARKET_SEARCH_RENDER_ENDPOINT,
    BoosterCacheEntry,
    BoosterLookup,
    BoosterPriceCache,
    BoosterPricingService,
    BoosterResolution,
    SteamCommunityBoosterProvider,
    derive_booster_gem_cost,
)
from app.settings import Settings


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: object = None,
        *,
        headers: Mapping[str, str] | None = None,
        json_error: BaseException | None = None,
    ) -> None:
        self.status_code = status_code
        self.payload = payload
        self.headers = dict(headers or {})
        self.json_error = json_error
        self.text = ""

    def json(self) -> object:
        if self.json_error is not None:
            raise self.json_error
        return self.payload


class FakeHTTPClient:
    def __init__(
        self,
        responses: Sequence[FakeResponse | BaseException],
    ) -> None:
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


@pytest.mark.parametrize(
    ("card_set_size", "expected_gem_cost"),
    [
        (5, 1200),
        (6, 1000),
        (7, 857),
        (8, 750),
        (9, 667),
        (10, 600),
        (11, 545),
        (12, 500),
        (13, 462),
        (14, 429),
        (15, 400),
    ],
)
def test_derive_booster_gem_cost_covers_every_supported_set_size(
    card_set_size: int,
    expected_gem_cost: int,
) -> None:
    assert derive_booster_gem_cost(card_set_size) == expected_gem_cost


@pytest.mark.parametrize(
    "card_set_size",
    [4, 16, 0, -1, True, False, 5.0, "5", None, object()],
)
def test_derive_booster_gem_cost_rejects_bounds_and_non_integer_types(
    card_set_size: object,
) -> None:
    assert derive_booster_gem_cost(card_set_size) is None  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("success", "total_count"),
    [(True, 7), (1, "7")],
)
def test_provider_requests_one_normal_card_count_with_public_market_parameters(
    success: object,
    total_count: object,
) -> None:
    client = FakeHTTPClient(
        [FakeResponse(200, {"success": success, "total_count": total_count})]
    )
    provider = SteamCommunityBoosterProvider(settings(), http_client=client)

    result = run(provider.lookup("123"))

    assert result == BoosterLookup(card_set_size=7)
    assert client.get_calls == [
        {
            "url": STEAM_MARKET_SEARCH_RENDER_ENDPOINT,
            "params": {
                "query": "",
                "start": "0",
                "count": "1",
                "appid": "753",
                "category_753_Game[]": "tag_app_123",
                "category_753_item_class[]": "tag_item_class_2",
                "category_753_cardborder[]": "tag_cardborder_0",
                "norender": "1",
            },
            "headers": {
                "Accept": "application/json",
                "Cookie": "bMarketOptOut=1",
                "Referer": "https://steamcommunity.com/market/",
                "User-Agent": (
                    "SteamOptimizer/0.1.1 (+https://github.com/"
                    "TheRockPusher/Steam_Optimizer)"
                ),
            },
            "follow_redirects": False,
            "timeout": None,
        }
    ]


def test_provider_rejects_invalid_app_id_without_making_a_market_request() -> None:
    client = FakeHTTPClient([])
    provider = SteamCommunityBoosterProvider(settings(), http_client=client)

    result = run(provider.lookup("not-an-app-id"))

    assert result == BoosterLookup(failure="Invalid booster lookup metadata.")
    assert client.get_calls == []


@pytest.mark.parametrize(
    ("status_code", "payload", "headers", "json_error"),
    [
        (503, {"success": True, "total_count": 7}, None, None),
        (
            200,
            {"success": True, "total_count": 7},
            {"Content-Length": str(MAX_BOOSTER_SEARCH_BYTES + 1)},
            None,
        ),
        (200, None, None, ValueError("invalid json")),
        (200, {"success": False, "total_count": 7}, None, None),
        (200, {"success": True, "total_count": 4}, None, None),
        (200, {"success": True, "total_count": "16"}, None, None),
        (
            200,
            {"success": True, "total_count": "seven"},
            None,
            None,
        ),
        (
            200,
            {
                "success": True,
                "total_count": "x" * (MAX_BOOSTER_SEARCH_SCALAR_LENGTH + 1),
            },
            None,
            None,
        ),
    ],
)
def test_provider_rejects_unavailable_or_invalid_market_payloads(
    status_code: int,
    payload: object,
    headers: Mapping[str, str] | None,
    json_error: BaseException | None,
) -> None:
    client = FakeHTTPClient(
        [
            FakeResponse(
                status_code,
                payload,
                headers=headers,
                json_error=json_error,
            )
        ]
    )
    provider = SteamCommunityBoosterProvider(settings(), http_client=client)

    result = run(provider.lookup("123"))

    assert result == BoosterLookup(failure="Steam Market card data is unavailable.")


def test_provider_rejects_market_payload_over_aggregate_size_bound() -> None:
    padding = ["x" * 1024] * (MAX_BOOSTER_SEARCH_BYTES // 1024 + 1)
    payload = {"success": True, "total_count": 7, "padding": padding}
    client = FakeHTTPClient([FakeResponse(200, payload)])
    provider = SteamCommunityBoosterProvider(settings(), http_client=client)

    result = run(provider.lookup("123"))

    assert result == BoosterLookup(failure="Steam Market card data is unavailable.")


class RecordingProvider:
    def __init__(self, outcome: BoosterLookup) -> None:
        self.outcome = outcome
        self.calls: list[str] = []

    async def lookup(self, game_app_id: str) -> BoosterLookup:
        self.calls.append(game_app_id)
        return self.outcome


class EventProvider:
    def __init__(self, outcome: BoosterLookup) -> None:
        self.outcome = outcome
        self.calls: list[str] = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def lookup(self, game_app_id: str) -> BoosterLookup:
        self.calls.append(game_app_id)
        self.started.set()
        await self.release.wait()
        return self.outcome


def test_cache_persists_positive_and_negative_entries_without_cross_status_overwrite(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "boosters.sqlite3"
    cache = BoosterPriceCache(cache_path)
    timestamp = time.time()
    cache.put_positive("123", 7, now=timestamp)
    cache.put_negative("456", now=timestamp)

    reopened = BoosterPriceCache(cache_path)
    positive = reopened.get("123")
    negative = reopened.get("456")

    assert isinstance(positive, BoosterCacheEntry)
    assert positive.status == "positive"
    assert positive.card_set_size == 7
    assert positive.resolution() == BoosterResolution(card_set_size=7, gem_cost=857)
    assert isinstance(negative, BoosterCacheEntry)
    assert negative.status == "negative"
    assert negative.card_set_size is None
    assert negative.resolution() is None

    reopened.put_negative("123", now=timestamp + 1)
    preserved = reopened.get("123")
    assert preserved is not None
    assert preserved.status == "positive"
    assert preserved.card_set_size == 7


def test_service_suppresses_fresh_negative_cache_and_requeues_expired_entry(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "boosters.sqlite3"
    cache = BoosterPriceCache(cache_path)
    cache.put_negative("123", now=time.time())
    provider = RecordingProvider(BoosterLookup(card_set_size=8))
    service = BoosterPricingService(
        settings(gem_price_cache_path=str(cache_path)),
        cache=cache,
        provider=provider,
    )

    async def exercise() -> None:
        await service.start()
        fresh = await service.resolve(("123",))
        assert fresh.values == {}
        assert fresh.pending_count == 0
        assert provider.calls == []

        cache.put_negative(
            "123",
            now=time.time() - BOOSTER_NEGATIVE_CACHE_TTL_SECONDS - 1,
        )
        expired = await service.resolve(("123",))
        assert expired.values == {}
        assert expired.pending_count == 1
        await service.wait_until_idle()

        assert provider.calls == ["123"]
        refreshed = service.read_cached(("123",))
        assert refreshed.values == {
            "123": BoosterResolution(card_set_size=8, gem_cost=750)
        }
        assert refreshed.pending_count == 0
        await service.stop()

    run(exercise())


def test_service_resolve_returns_before_provider_and_cached_refresh_sees_completion(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "boosters.sqlite3"
    provider = EventProvider(BoosterLookup(card_set_size=7))
    service = BoosterPricingService(
        settings(gem_price_cache_path=str(cache_path)),
        cache=BoosterPriceCache(cache_path),
        provider=provider,
    )

    async def exercise() -> None:
        await service.start()
        resolve_task = asyncio.create_task(service.resolve(("123",)))
        try:
            first = await asyncio.wait_for(
                asyncio.shield(resolve_task),
                timeout=0.5,
            )
            assert first.values == {}
            assert first.pending_count == 1

            await provider.started.wait()
            assert provider.calls == ["123"]
            provider.release.set()
            await service.wait_until_idle()

            refreshed = service.read_cached(("123",))
            assert refreshed.values == {
                "123": BoosterResolution(card_set_size=7, gem_cost=857)
            }
            assert refreshed.pending_count == 0
        finally:
            provider.release.set()
            if not resolve_task.done():
                resolve_task.cancel()
                with suppress(asyncio.CancelledError):
                    await resolve_task
            await service.stop()

    run(exercise())
