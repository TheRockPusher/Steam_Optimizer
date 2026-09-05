from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta, tzinfo
from decimal import Decimal
from typing import TYPE_CHECKING, Self, cast

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

if TYPE_CHECKING:
    from collections.abc import (
        AsyncIterator,
        Awaitable,
        Iterable,
        Mapping,
        Sequence,
    )
    from pathlib import Path


import app.steam_gateway as steam_gateway
import app.steamapis_price_cache as steamapis_price_cache
from app.booster_pricing import BoosterScanResult
from app.gem_pricing import (
    GemKey,
    GemPriceCache,
    GemPricingService,
    GemResolution,
    GemScanResult,
)
from app.level_up_optimizer import BadgeState
from app.main import create_app
from app.settings import Settings
from app.steam_gateway import (
    MAX_BADGE_DECODED_SIZE,
    MAX_BADGE_RECORDS,
    MAX_BADGE_RESPONSE_BYTES,
    MAX_INVENTORY_ASSETS_PER_PAGE,
    MAX_INVENTORY_CURSOR_LENGTH,
    MAX_INVENTORY_PAGES,
    MAX_PRICE_STREAM_BYTES,
    MAX_RETRY_AFTER_SECONDS,
    PROFILE_ENDPOINT,
    STEAM_ICON_BASE_URL,
    STEAMAPIS_BADGES_ENDPOINT,
    STEAMAPIS_BULK_HOST_SUFFIX,
    STEAMAPIS_INVENTORY_ENDPOINT,
    STEAMAPIS_ITEMS_ENDPOINT,
    BadgeCheck,
    InventoryCheck,
    SteamApisClient,
    SteamGateway,
    _observed_at,
    _provider_amount,
)
from app.steamapis_price_cache import SteamApisPriceCache


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: object = None,
        *,
        headers: Mapping[str, str] | None = None,
        chunks: list[bytes] | None = None,
        json_error: BaseException | None = None,
        stream_error: BaseException | None = None,
    ) -> None:
        self.status_code = status_code
        self.payload = payload
        self.headers = dict(headers or {})
        self.chunks = chunks or []
        self.json_error = json_error
        self.stream_error = stream_error
        self.text = ""

    def json(self) -> object:
        if self.json_error is not None:
            raise self.json_error
        return self.payload

    def aiter_bytes(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        del chunk_size

        async def chunks() -> AsyncIterator[bytes]:
            for chunk in self.chunks:
                yield chunk
            if self.stream_error is not None:
                raise self.stream_error

        return chunks()


class FakeHTTPClient:
    def __init__(
        self,
        responses: Sequence[FakeResponse | BaseException],
        *,
        stream_response: FakeResponse | BaseException | None = None,
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
        result = self.responses.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

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
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = False,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> AsyncIterator[FakeResponse]:
        self.stream_calls.append(
            {
                "method": method,
                "url": url,
                "params": params,
                "headers": headers,
                "follow_redirects": follow_redirects,
                "timeout": timeout,
            }
        )
        if isinstance(self.stream_response, BaseException):
            raise self.stream_response
        if self.stream_response is None:
            raise AssertionError
        yield self.stream_response


class NoopGemPricing:
    async def resolve(self, keys: Mapping[GemKey, str | None]) -> GemScanResult:
        del keys
        return GemScanResult(values={})


class FixedGemPricing:
    def __init__(self, values: Mapping[GemKey, GemResolution]) -> None:
        self.values = values
        self.groups: dict[GemKey, str | None] | None = None

    async def resolve(self, groups: Mapping[GemKey, str | None]) -> GemScanResult:
        self.groups = dict(groups)
        return GemScanResult(values=self.values)


class NoopBoosterPricing:
    async def resolve(self, game_app_ids: Iterable[str]) -> BoosterScanResult:
        del game_app_ids
        return BoosterScanResult(values={})


_LEVEL_UP_PROVIDER_CALL_ERROR = "level-up must not use booster metadata providers"


class ExplodingLevelUpProviders:
    async def resolve(
        self,
        game_app_ids: Iterable[str],
        *,
        require_game_name: bool = False,
    ) -> BoosterScanResult:
        del game_app_ids, require_game_name
        raise AssertionError(_LEVEL_UP_PROVIDER_CALL_ERROR)


class MinimalClient:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "development",
        "signing_secret": "test-signing-secret",
        "steamapi_key": "server-only-key",
        "steam_web_api_key": "profile-key",
        "steamapis_price_cache_path": ":memory:",
    }
    values.update(overrides)
    return Settings.model_validate(values)


def run[T](awaitable: Awaitable[T]) -> T:
    async def resolve() -> T:
        return await awaitable

    return asyncio.run(resolve())


def page(
    *,
    success: object = 1,
    wrapped: bool = False,
    assets: list[dict[str, object]] | None = None,
    descriptions: list[dict[str, object]] | None = None,
    more_items: object = 0,
    last_assetid: str | None = None,
) -> dict[str, object]:
    body: dict[str, object] = {
        "assets": assets or [],
        "descriptions": descriptions or [],
        "more_items": more_items,
    }
    if last_assetid is not None:
        body["last_assetid"] = last_assetid
    if wrapped:
        return {"success": success, "result": body}
    body["success"] = success
    return body


def item_description(
    class_id: str,
    name: str,
    *,
    instance_id: str = "0",
    market_hash_name: str | None = None,
    icon_url: str | None = None,
    marketable: object = 0,
    tradable: object = 1,
    tags: list[dict[str, object]] | None = None,
    owner_actions: list[dict[str, object]] | None = None,
    actions: list[dict[str, object]] | None = None,
    market_bucket_id: object = None,
) -> dict[str, object]:
    description: dict[str, object] = {
        "classid": class_id,
        "instanceid": instance_id,
        "name": name,
        "marketHashName": market_hash_name,
        "icon_url": icon_url,
        "marketable": marketable,
        "tradable": tradable,
    }
    if tags is not None:
        description["tags"] = tags
    if owner_actions is not None:
        description["owner_actions"] = owner_actions
    if actions is not None:
        description["actions"] = actions
    if market_bucket_id is not None:
        description["market_bucket_id"] = market_bucket_id
    return description


def trading_card_tags(
    app_id: str = "440",
    game_name: str = "Team Fortress 2",
    border_color: int = 0,
) -> list[dict[str, object]]:
    return [
        {"category": "item_class", "internal_name": "item_class_2"},
        {
            "category": "Game",
            "internal_name": f"app_{app_id}",
            "localized_tag_name": game_name,
        },
        {"category": "cardborder", "internal_name": f"cardborder_{border_color}"},
    ]


def goo_owner_actions(
    *,
    app_id: str = "753",
    item_type: int = 5,
    border_color: int = 0,
) -> list[dict[str, object]]:
    return [
        {
            "link": (
                "javascript:GetGooValue('%contextid%', '%assetid%', "
                f"{app_id}, {item_type}, {border_color});"
            )
        }
    ]


def item_asset(
    class_id: str, *, instance_id: str = "0", amount: str = "1"
) -> dict[str, object]:
    return {"classid": class_id, "instanceid": instance_id, "amount": amount}


def test_inventory_item_class_mapping_covers_full_item_type_union() -> None:
    expected = [
        "badge",
        "trading_card",
        "profile_background",
        "emoticon",
        "booster_pack",
        "consumable",
        "game_goo",
        "profile_modifier",
        "scene",
        "sale_item",
        "sticker",
        "chat_effect",
        "mini_profile_background",
        "avatar_frame",
        "animated_avatar",
        "steam_deck_keyboard_skin",
        "steam_deck_startup_movie",
        "other",
    ]
    descriptions = [
        item_description(
            str(index),
            item_type,
            tags=[
                {
                    "category": "item_class",
                    "internal_name": (
                        f"item_class_{index}" if index < 18 else "item_class_999"
                    ),
                }
            ],
        )
        for index, item_type in enumerate(expected, start=1)
    ]
    parsed = steam_gateway._parse_inventory_page(
        page(
            assets=[item_asset(str(index)) for index in range(1, len(expected) + 1)],
            descriptions=descriptions,
        )
    )
    assert parsed is not None
    assert [description.item_type for description in parsed.descriptions] == expected
    assert all(description.gem_key is None for description in parsed.descriptions)


def test_inventory_gem_key_schema_publishes_canonical_bounds() -> None:
    schema = steam_gateway.InventoryItem.model_json_schema()
    gem_key_schema = schema["$defs"]["GemKey"]["properties"]

    assert gem_key_schema["app_id"]["pattern"] == r"^(?:0|[1-9][0-9]*)$"
    assert gem_key_schema["app_id"]["maxLength"] == 20
    assert gem_key_schema["item_type"]["minimum"] == 0
    assert gem_key_schema["item_type"]["maximum"] == 1_000_000_000


def test_inventory_metadata_is_independent_of_item_class() -> None:
    tags: list[dict[str, object]] = [
        {"category": "item_class", "internal_name": "item_class_3"},
        {
            "category": "Game",
            "internal_name": "app_440",
            "localized_tag_name": "Team Fortress 2",
        },
        {
            "category": "droprate",
            "internal_name": "Rarity_Rare",
            "localized_tag_name": "Rare",
        },
        {"category": "cardborder", "internal_name": "cardborder_1"},
    ]
    parsed = steam_gateway._parse_inventory_page(
        page(
            assets=[item_asset("1")],
            descriptions=[item_description("1", "Background", tags=tags)],
        )
    )
    assert parsed is not None
    description = parsed.descriptions[0]
    assert description.item_type == "profile_background"
    assert description.game_app_id == "440"
    assert description.game_name == "Team Fortress 2"
    assert description.rarity == "Rare"
    assert description.card_border == "foil"
    assert description.gem_key is None


def test_keyed_backgrounds_and_emoticons_use_exact_gem_keys() -> None:
    background_key = GemKey(app_id="440", item_type=501, border_color=0)
    emoticon_key = GemKey(app_id="440", item_type=502, border_color=1)
    parsed = steam_gateway._parse_inventory_page(
        page(
            assets=[item_asset("1"), item_asset("2")],
            descriptions=[
                item_description(
                    "1",
                    "Background",
                    tags=[
                        {
                            "category": "item_class",
                            "internal_name": "item_class_3",
                        }
                    ],
                    owner_actions=goo_owner_actions(
                        app_id="440", item_type=501, border_color=0
                    ),
                ),
                item_description(
                    "2",
                    "Emoticon",
                    tags=[
                        {
                            "category": "item_class",
                            "internal_name": "item_class_4",
                        }
                    ],
                    owner_actions=goo_owner_actions(
                        app_id="440", item_type=502, border_color=1
                    ),
                ),
            ],
        )
    )
    assert parsed is not None
    assert parsed.descriptions[0].item_type == "profile_background"
    assert parsed.descriptions[0].gem_key == background_key
    assert parsed.descriptions[1].item_type == "emoticon"
    assert parsed.descriptions[1].gem_key == emoticon_key


def test_live_provider_market_buckets_resolve_exact_gem_values() -> None:
    cases: list[
        tuple[
            str,
            str,
            list[dict[str, object]],
            str,
            GemKey,
            int,
            int,
            str,
        ]
    ] = [
        (
            "1",
            "Normal Card",
            trading_card_tags(app_id="620", game_name="Portal 2"),
            "B620-5",
            GemKey(app_id="620", item_type=5, border_color=0),
            100,
            2,
            "0.02",
        ),
        (
            "2",
            "Foil Card",
            trading_card_tags(
                app_id="278100",
                game_name="RIVE",
                border_color=1,
            ),
            "B278100-5-1",
            GemKey(app_id="278100", item_type=5, border_color=1),
            150,
            1,
            "0.03",
        ),
        (
            "3",
            "Background",
            [
                {"category": "item_class", "internal_name": "item_class_3"},
                {"category": "Game", "internal_name": "app_730"},
            ],
            "B730-18",
            GemKey(app_id="730", item_type=18, border_color=0),
            200,
            3,
            "0.04",
        ),
        (
            "4",
            "Emoticon",
            [
                {"category": "item_class", "internal_name": "item_class_4"},
                {"category": "Game", "internal_name": "app_730"},
            ],
            "B730-14",
            GemKey(app_id="730", item_type=14, border_color=0),
            300,
            4,
            "0.06",
        ),
    ]
    descriptions = [
        item_description(
            class_id,
            name,
            market_hash_name=f"{key.app_id}-{name}",
            tags=tags,
            actions=[
                {
                    "name": "View Full Size",
                    "link": "https://shared.steamstatic.com/background.jpg",
                }
            ]
            if name == "Background"
            else None,
            market_bucket_id=market_bucket_id,
        )
        for class_id, name, tags, market_bucket_id, key, _, _, _ in cases
    ]
    resolutions = {
        key: GemResolution(
            key=key,
            representative_hash=f"{key.app_id}-{name}",
            gem_yield=gem_yield,
            observed_at="2026-08-28T00:00:00Z",
        )
        for _, name, _, _, key, gem_yield, _, _ in cases
    }
    gem_pricing = FixedGemPricing(resolutions)
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[
                        item_asset(class_id, amount=str(quantity))
                        for class_id, _, _, _, _, _, quantity, _ in cases
                    ],
                    descriptions=descriptions,
                ),
            ),
            price_redirect(),
        ],
        stream_response=price_stream(
            name="753-Sack of Gems",
            lowest_sell="0.20",
        ),
    )
    steamapis = SteamApisClient(
        settings(),
        http_client=client,
        gem_pricing=gem_pricing,  # type: ignore[arg-type]
        booster_pricing=NoopBoosterPricing(),  # type: ignore[arg-type]
    )

    result = run(steamapis.fetch_inventory("42"))

    assert gem_pricing.groups == {
        key: f"{key.app_id}-{name}" for _, name, _, _, key, _, _, _ in cases
    }
    assert result.total_asset_count == 10
    assert result.unique_item_count == 4
    assert result.gem_status == "complete"
    assert result.gem_priceable_item_count == 4
    assert result.gem_priced_item_count == 4
    assert result.gem_cash_context is not None
    assert result.gem_cash_context.currency == "USD"
    by_name = {item.name: item for item in result.items}
    assert result.gem_cash_context is not None
    assert result.gem_cash_context.sack_price == "0.2"
    assert result.gem_cash_context.highest_buy == "0.1"
    for _, name, _, _, key, gem_yield, _, gem_cash_value in cases:
        assert by_name[name].gem_key == key
        assert by_name[name].gem_yield == gem_yield
        assert by_name[name].gem_cash_value == gem_cash_value


def test_gem_cash_context_supports_highest_buy_without_lowest_sell() -> None:
    context = steam_gateway._gem_cash_context(
        steam_gateway.InventoryPrice(highest_buy="0.10", lowest_sell=None)
    )

    assert context is not None
    assert context.sack_price is None
    assert context.highest_buy == "0.1"


@pytest.mark.parametrize(
    "actions",
    [
        goo_owner_actions(app_id="440", item_type=502, border_color=1),
        [{"link": ("javascript:GetGooValue('%contextid%', '%assetid%', 440, 501)")}],
        {"link": "javascript:GetGooValue('%contextid%', '%assetid%', 440, 501)"},
    ],
    ids=("conflicting-keys", "malformed-goo-tuple", "malformed-alias"),
)
def test_inventory_dual_action_aliases_fail_closed(actions: object) -> None:
    description = item_description(
        "1",
        "Background",
        tags=[
            {"category": "item_class", "internal_name": "item_class_3"},
        ],
        owner_actions=goo_owner_actions(app_id="440", item_type=501, border_color=0),
        market_bucket_id="B440-501",
    )
    description["actions"] = actions

    parsed = steam_gateway._parse_inventory_page(
        page(
            wrapped=True,
            success=True,
            assets=[item_asset("1")],
            descriptions=[description],
        )
    )

    assert parsed is not None
    assert parsed.descriptions[0].gem_key is None


def test_malformed_owner_action_keeps_inventory_available_and_keyless() -> None:
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[
                        item_description(
                            "1",
                            "Background",
                            tags=[
                                {
                                    "category": "item_class",
                                    "internal_name": "item_class_3",
                                }
                            ],
                            owner_actions=[{"link": "javascript:alert(1)"}],
                        )
                    ],
                ),
            )
        ]
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "public"
    assert result.items[0].item_type == "profile_background"
    assert result.items[0].gem_key is None
    assert result.gem_priceable_item_count == 0


def test_gem_groups_and_status_are_driven_only_by_exact_keys() -> None:
    first_key = GemKey(app_id="440", item_type=501, border_color=0)
    second_key = GemKey(app_id="440", item_type=502, border_color=1)
    items = [
        steam_gateway.InventoryItem(
            class_id="1",
            instance_id="0",
            name="Background",
            market_hash_name="z-background",
            quantity=1,
            marketable=False,
            tradable=True,
            item_type="profile_background",
            gem_key=first_key,
            gem_yield=13,
        ),
        steam_gateway.InventoryItem(
            class_id="2",
            instance_id="0",
            name="Emoticon",
            market_hash_name="a-emoticon",
            quantity=1,
            marketable=False,
            tradable=True,
            item_type="emoticon",
            gem_key=second_key,
        ),
        steam_gateway.InventoryItem(
            class_id="3",
            instance_id="0",
            name="Named keyless item",
            quantity=1,
            marketable=False,
            tradable=True,
            item_type="profile_background",
        ),
    ]
    assert steam_gateway._gem_group_representatives(items) == {
        first_key: "z-background",
        second_key: "a-emoticon",
    }
    scan = GemScanResult(
        values={
            first_key: GemResolution(
                key=first_key,
                representative_hash="z-background",
                gem_yield=13,
                observed_at="2026-08-28T00:00:00Z",
            )
        }
    )
    status = steam_gateway._gem_status_for_items(items, scan)
    assert status == (
        "partial",
        "Gem prices are unavailable for some gem-convertible items.",
        2,
        1,
    )


def test_inventory_gem_metadata_requires_key_and_cash_requires_yield() -> None:
    base = {
        "class_id": "1",
        "instance_id": "0",
        "name": "Item",
        "quantity": 1,
        "marketable": False,
        "tradable": True,
    }
    with pytest.raises(ValidationError):
        steam_gateway.InventoryItem(**base, gem_yield=1)
    with pytest.raises(ValidationError):
        steam_gateway.InventoryItem(
            **base,
            gem_key=GemKey(app_id="440", item_type=501, border_color=0),
            gem_cash_value="1",
        )


def price_redirect() -> FakeResponse:
    return FakeResponse(
        302,
        headers={
            "Location": (
                "https://prices.steamapis-test.r2.cloudflarestorage.com/items.json"
            )
        },
    )


def price_stream(
    name: str = "Name",
    *,
    highest_buy: str = "0.10",
    lowest_sell: str | None = "0.20",
    observed_at: int = 1787788800000,
) -> FakeResponse:
    order_book = f'"highestBuy":"{highest_buy}"'
    if lowest_sell is not None:
        order_book += f',"lowestSell":"{lowest_sell}"'
    return FakeResponse(
        200,
        chunks=[
            (
                '{"metadata":{"appId":753,"itemCount":1},"items":[{"marketHashName":"'
                + name
                + '","orderBook":{'
                + order_book
                + '},"updatedAt":'
                + str(observed_at)
                + "}]}"
            ).encode()
        ],
    )


@pytest.mark.parametrize(("wrapped", "success"), [(False, 1), (True, True)])
def test_inventory_accepts_live_and_documented_success_shapes(
    wrapped: object, success: object
) -> None:
    assert isinstance(wrapped, bool)
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    wrapped=wrapped,
                    success=success,
                    assets=[item_asset("00000000000000000042", amount="2")],
                    descriptions=[item_description("00000000000000000042", "Cards")],
                ),
            )
        ]
    )
    result = run(
        SteamGateway(settings(), http_client=client).check_inventory(
            "76561198000000000"
        )
    )
    assert isinstance(result, InventoryCheck)
    assert result.status == "public"
    assert result.total_asset_count == 2
    assert result.unique_item_count == 1
    assert result.items[0].class_id == "00000000000000000042"
    assert result.items[0].quantity == 2
    assert client.get_calls[0]["url"] == STEAMAPIS_INVENTORY_ENDPOINT.format(
        steam_id="76561198000000000"
    )
    assert client.get_calls[0]["headers"] == {
        "x-api-key": "server-only-key",
        "User-Agent": "SteamOptimizer/0.1.1 (+https://github.com/TheRockPusher/Steam_Optimizer)",
    }


def test_inventory_fetches_all_pages_and_aggregates_quantities() -> None:
    description = item_description("1", "Card")
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1", amount="2")],
                    descriptions=[description],
                    more_items=1,
                    last_assetid="opaque-cursor",
                ),
            ),
            FakeResponse(
                200,
                page(assets=[item_asset("1", amount="3")], descriptions=[]),
            ),
        ]
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "public"
    assert result.total_asset_count == 5
    assert result.items[0].quantity == 5
    assert client.get_calls[1]["params"] == {"start_assetid": "opaque-cursor"}


@pytest.mark.parametrize(
    "responses",
    [
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[item_description("1", "Card")],
                    more_items=1,
                ),
            )
        ],
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[item_description("1", "Card")],
                    more_items=1,
                    last_assetid="same",
                ),
            ),
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[item_description("1", "Card")],
                    more_items=1,
                    last_assetid="same",
                ),
            ),
        ],
    ],
)
def test_inventory_rejects_missing_or_repeated_cursor_without_partial_output(
    responses: list[FakeResponse],
) -> None:
    client = FakeHTTPClient(responses)
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "unavailable"
    assert result.total_asset_count == 0
    assert result.items == []
    assert not client.stream_calls


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (
            {
                "error": (
                    "Could not retrieve user inventory. Make sure profile and "
                    "inventory is public. (403) (403)"
                ),
                "code": 403,
            },
            "private",
        ),
        ("<html>Cloudflare 403</html>", "unavailable"),
        ({"error": "Could not retrieve user inventory. (403)"}, "unavailable"),
    ],
)
def test_inventory_403_requires_verified_private_error(
    payload: object, expected: str
) -> None:
    response = FakeResponse(403, payload)
    client = FakeHTTPClient([response])
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == expected
    assert result.items == []


@pytest.mark.parametrize(
    "response",
    [
        FakeResponse(200, json_error=ValueError("malformed")),
        OSError("network"),
        FakeResponse(429, {}, headers={"Retry-After": "17"}),
    ],
)
def test_inventory_malformed_network_and_rate_limit_are_unavailable(
    response: FakeResponse | BaseException,
) -> None:
    client = FakeHTTPClient([response])
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "unavailable"
    assert result.items == []
    if isinstance(response, FakeResponse) and response.status_code == 429:
        assert result.rate_limited is True
        assert result.retry_after_seconds == 17
    else:
        assert result.rate_limited is False


def test_inventory_aggregation_sort_icons_and_partial_prices() -> None:
    descriptions = [
        item_description(
            "2",
            "zebra",
            market_hash_name="Plain Name",
            icon_url="relative-icon",
            marketable=1,
        ),
        item_description(
            "1",
            "Alpha",
            market_hash_name="Encoded | Name",
            icon_url="https://community.cloudflare.steamstatic.com/economy/image/full",
            marketable=1,
            tradable=0,
        ),
        item_description("3", "Unmarketable", marketable=0),
    ]
    inventory_response = FakeResponse(
        200,
        page(
            assets=[
                item_asset("2", amount="2"),
                item_asset("1"),
                item_asset("3"),
            ],
            descriptions=descriptions,
        ),
    )
    bulk_response = FakeResponse(
        200,
        chunks=[
            b'{"metadata":{"appId":753,"itemCount":1},"items":['
            b'{"marketHashName":"Plain ',
            b'Name","orderBook":{"highestBuy":"0.12","lowestSell":0.13},',
            b'"updatedAt":1787788800000}]}',
        ],
    )
    client = FakeHTTPClient(
        [
            inventory_response,
            FakeResponse(
                302,
                headers={
                    "Location": "https://steamapis-test.r2.cloudflarestorage.com/items.json"
                },
            ),
        ],
        stream_response=bulk_response,
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "public"
    assert [item.name for item in result.items] == ["Alpha", "Unmarketable", "zebra"]
    assert (
        result.items[0].icon_url
        == "https://community.cloudflare.steamstatic.com/economy/image/full"
    )
    assert result.items[0].marketable is True
    assert result.items[0].tradable is False
    assert result.items[2].icon_url == f"{STEAM_ICON_BASE_URL}relative-icon"
    assert result.items[2].quantity == 2
    assert result.priceable_item_count == 2
    assert result.priced_item_count == 1
    assert result.price_status == "partial"
    assert result.items[0].price is None
    assert result.items[2].price is not None
    assert result.items[2].price.highest_buy == "0.12"
    assert result.items[2].price.lowest_sell == "0.13"
    assert result.items[2].price.currency == "USD"
    assert result.items[2].price.observed_at == "2026-08-27T00:00:00Z"
    assert client.stream_calls[0]["headers"] is None
    stream_url = client.stream_calls[0]["url"]
    assert isinstance(stream_url, str)
    assert "server-only-key" not in stream_url


def test_inventory_items_sort_class_ids_by_string_order() -> None:
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("9"), item_asset("10")],
                    descriptions=[
                        item_description("9", "Same Card"),
                        item_description("10", "Same Card"),
                    ],
                ),
            ),
        ],
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))

    assert result.status == "public"
    assert [item.class_id for item in result.items] == ["10", "9"]
    assert [item.name for item in result.items] == ["Same Card", "Same Card"]


def test_bulk_redirect_rejects_non_https_without_streaming() -> None:
    client = FakeHTTPClient(
        [FakeResponse(302, headers={"Location": "http://cdn.example/items.json"})]
    )
    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({"Name"})
        )
    )
    assert lookup.status == "unavailable"
    assert client.stream_calls == []


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("0.12", "0.12"),
        ("1.005", "1.005"),
        ("12", "12"),
        ("1e3", "1000"),
        ("10000000000", "10000000000"),
        ("10000000000.01", None),
        ("1e999997", None),
        ("1e-20000", None),
        (Decimal("0.13"), "0.13"),
        ("-0", None),
        ("NaN", None),
    ],
)
def test_provider_amount_is_exact_fixed_point_and_bounded(
    value: object, expected: str | None
) -> None:
    assert _provider_amount(value) == expected


@pytest.mark.parametrize(
    "location",
    [
        "https://cdn.example/items.json",
        "https://r2.cloudflarestorage.com/items.json",
        "https://prices.r2.cloudflarestorage.com.evil.example/items.json",
        "https://prices.r2.cloudflarestorage.com:8443/items.json",
        "https://user:pass@prices.r2.cloudflarestorage.com/items.json",
    ],
)
def test_bulk_redirect_rejects_unverified_origins_and_ports(
    location: str,
) -> None:
    client = FakeHTTPClient([FakeResponse(302, headers={"Location": location})])
    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({"Name"})
        )
    )
    assert lookup.status == "unavailable"
    assert client.stream_calls == []


def test_bulk_redirect_accepts_verified_r2_suffix_on_default_https_port() -> None:
    location = f"https://prices{STEAMAPIS_BULK_HOST_SUFFIX}/items.json"
    client = FakeHTTPClient(
        [FakeResponse(302, headers={"Location": location})],
        stream_response=FakeResponse(200, chunks=[b'{"items":[]}']),
    )
    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({"Name"})
        )
    )
    assert lookup.status == "unavailable"
    assert client.stream_calls[0]["url"] == location


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1787788800000, "2026-08-27T00:00:00Z"),
        ("9999-12-31T23:59:59.999000+00:00", "9999-12-31T23:59:59.999000Z"),
        (253402300799999, "9999-12-31T23:59:59.999000Z"),
        (253402300800000, None),
        (1e999997, None),
    ],
)
def test_observed_at_milliseconds_are_bounded_and_exact(
    value: object, expected: str | None
) -> None:
    assert _observed_at(value) == expected


def test_settings_reads_steamapi_key_and_bulk_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STEAMAPI_KEY", "from-environment")
    credential = "test-signing-secret"
    configured = Settings(
        signing_secret=credential,
        steam_bulk_timeout_seconds=90,
    )
    assert configured.steamapi_key == "from-environment"
    assert configured.steam_bulk_timeout_seconds == 90


def test_lifespan_closes_each_default_http_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clients: list[MinimalClient] = []
    timeouts: list[object] = []

    def factory(**kwargs: object) -> MinimalClient:
        timeouts.append(kwargs["timeout"])
        client = MinimalClient()
        clients.append(client)
        return client

    monkeypatch.setattr("app.main.httpx2.AsyncClient", factory)
    application = create_app(settings())
    with TestClient(application):
        pass
    assert timeouts == [10.0, 120.0]
    assert all(client.closed for client in clients)
    assert STEAMAPIS_ITEMS_ENDPOINT.startswith("https://api.steamapis.com/")
    assert PROFILE_ENDPOINT.startswith("https://api.steampowered.com/")


@pytest.mark.parametrize(
    "payload",
    [
        {"success": 1},
        {"success": 1, "assets": []},
        {"success": 1, "descriptions": []},
        {"success": True, "result": None},
        {"success": True, "result": {"assets": []}},
    ],
)
def test_inventory_rejects_success_payloads_without_both_collections(
    payload: object,
) -> None:
    client = FakeHTTPClient([FakeResponse(200, payload)])
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "unavailable"
    assert result.items == []
    assert client.stream_calls == []


def test_inventory_constrains_absolute_icon_origin() -> None:
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[
                        item_description(
                            "1",
                            "Card",
                            icon_url="https://attacker.example/track",
                        )
                    ],
                ),
            )
        ]
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "public"
    assert result.items[0].icon_url is None


@pytest.mark.parametrize(
    ("retry_after", "expected"),
    [("0", 0), ("900", 900), ("901", 900), ("999999999999999999999", 900)],
)
def test_retry_after_is_clamped_to_public_bound(
    retry_after: str, expected: int
) -> None:
    client = FakeHTTPClient(
        [FakeResponse(429, {}, headers={"Retry-After": retry_after})]
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.rate_limited is True
    assert result.retry_after_seconds == expected
    assert result.retry_after_seconds is not None
    assert result.retry_after_seconds <= MAX_RETRY_AFTER_SECONDS


def test_inventory_retry_after_model_rejects_values_above_bound() -> None:
    with pytest.raises(ValidationError):
        InventoryCheck(
            status="unavailable",
            message="limited",
            retry_after_seconds=MAX_RETRY_AFTER_SECONDS + 1,
        )
    assert (
        InventoryCheck(
            status="unavailable",
            message="limited",
            retry_after_seconds=MAX_RETRY_AFTER_SECONDS,
        ).retry_after_seconds
        == MAX_RETRY_AFTER_SECONDS
    )


def test_price_coverage_is_per_row_and_nonmarketable_rows_stay_unpriced() -> None:
    descriptions = [
        item_description("1", "Shared A", market_hash_name="Shared", marketable=1),
        item_description("2", "Shared B", market_hash_name="Shared", marketable=1),
        item_description("3", "No hash", market_hash_name=None, marketable=1),
        item_description("4", "Not marketable", market_hash_name="Shared"),
    ]
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[
                        item_asset("1"),
                        item_asset("2"),
                        item_asset("3"),
                        item_asset("4"),
                    ],
                    descriptions=descriptions,
                ),
            ),
            FakeResponse(
                302,
                headers={
                    "Location": "https://steamapis-test.r2.cloudflarestorage.com/items.json"
                },
            ),
        ],
        stream_response=FakeResponse(
            200,
            chunks=[
                b'{"metadata":{"appId":753,"itemCount":1},"items":[{"marketHashName":"Shared",'
                b'"orderBook":{"highestBuy":"1.00"}}]}',
            ],
        ),
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    by_id = {item.class_id: item for item in result.items}
    assert result.priceable_item_count == 3
    assert result.priced_item_count == 2
    assert result.price_status == "partial"
    assert by_id["1"].price is not None
    assert by_id["2"].price is not None
    assert by_id["3"].price is None
    assert by_id["4"].price is None


def test_inventory_includes_booster_price_and_card_count() -> None:
    card_market_hash_name = "440-Test Card (Trading Card)"
    booster_market_hash_name = "440-Team Fortress 2 Booster Pack"
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[
                        item_description(
                            "1",
                            "Test Card",
                            market_hash_name=card_market_hash_name,
                            marketable=1,
                            tags=trading_card_tags(),
                        )
                    ],
                ),
            ),
            FakeResponse(
                302,
                headers={
                    "Location": "https://prices.r2.cloudflarestorage.com/items.json"
                },
            ),
        ],
        stream_response=FakeResponse(
            200,
            chunks=[
                b'{"metadata":{"appId":753,"itemCount":2},"items":['
                b'{"marketHashName":"440-Test Card (Trading Card)",'
                b'"orderBook":{"highestBuy":"0.10","lowestSell":"0.20"},'
                b'"updatedAt":1787788800000},'
                b'{"marketHashName":"440-Team Fortress 2 Booster Pack",'
                b'"orderBook":{"highestBuy":"0.11","lowestSell":"0.13"},'
                b'"updatedAt":1787788800000}'
                b"]}"
            ],
        ),
    )
    steamapis = SteamApisClient(
        settings(),
        http_client=client,
        gem_pricing=NoopGemPricing(),  # type: ignore[arg-type]
        booster_pricing=NoopBoosterPricing(),  # type: ignore[arg-type]
    )

    result = run(steamapis.fetch_inventory("42"))

    assert result.status == "public"
    assert len(result.boosters) == 1
    booster = result.boosters[0]
    assert booster.game_app_id == "440"
    assert booster.game_name == "Team Fortress 2"
    assert booster.market_hash_name == booster_market_hash_name
    assert booster.card_count == 3
    assert booster.card_set_size is None
    assert booster.gem_cost is None
    assert booster.price is not None
    assert booster.price.highest_buy == "0.11"
    assert booster.price.lowest_sell == "0.13"
    assert booster.price.observed_at == "2026-08-27T00:00:00Z"


def test_truncated_bulk_json_preserves_public_inventory() -> None:
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[
                        item_description(
                            "1", "Card", market_hash_name="Card", marketable=1
                        )
                    ],
                ),
            ),
            FakeResponse(
                302,
                headers={
                    "Location": "https://steamapis-test.r2.cloudflarestorage.com/items.json"
                },
            ),
        ],
        stream_response=FakeResponse(
            200,
            chunks=[b'{"metadata":{},"items":[{"marketHashName":"Card"'],
        ),
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "public"
    assert len(result.items) == 1
    assert result.items[0].price is None
    assert result.price_status == "unavailable"


def test_price_join_checks_case_sensitive_unquoted_name() -> None:
    client = FakeHTTPClient(
        [
            FakeResponse(
                302,
                headers={"Location": "https://prices.r2.cloudflarestorage.com/list"},
            ),
        ],
        stream_response=FakeResponse(
            200,
            chunks=[
                b'{"metadata":{"appId":753,"itemCount":1},"items":[{"marketHashName":"Encoded%20Name",'
                b'"orderBook":{"lowestSell":"0.25"}}]}',
            ],
        ),
    )
    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({"Encoded Name"})
        )
    )
    assert lookup.status == "complete"
    assert lookup.prices["Encoded Name"].lowest_sell == "0.25"
    assert client.get_calls[0]["headers"] == {
        "x-api-key": "server-only-key",
        "User-Agent": "SteamOptimizer/0.1.1 (+https://github.com/TheRockPusher/Steam_Optimizer)",
    }
    assert client.get_calls[0]["follow_redirects"] is False


def test_price_stream_decodes_percent_literal_exactly_once() -> None:
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(
            200,
            chunks=[
                b'{"metadata":{"appId":753,"itemCount":1},"items":['
                b'{"marketHashName":"Literal%2520Name",'
                b'"orderBook":{"lowestSell":"0.25"}}]}'
            ],
        ),
    )

    lookup = run(
        SteamApisClient(settings(), http_client=client).fetch_prices(
            frozenset({"Literal%20Name"})
        )
    )

    assert lookup.status == "complete"
    assert set(lookup.prices) == {"Literal%20Name"}


def test_live_literal_percent_keeps_prices_and_level_up_available(
    tmp_path: Path,
) -> None:
    quote_time = datetime.now(UTC)
    configured = settings(
        gem_price_cache_path=str(tmp_path / "boosters.sqlite3"),
        level_up_currency_code="USD",
        level_up_currency_minor_digits=2,
        level_up_price_basis="buyer_total",
        level_up_steam_fee_bps=500,
        level_up_publisher_fee_bps=1_000,
        level_up_min_fee_minor=1,
        level_up_max_quote_age_seconds=900,
        level_up_max_inventory_age_seconds=3_600,
    )
    source_hashes = [f"440-Source Card {index} (Trading Card)" for index in range(1, 6)]
    destination_hashes = [
        f"{app_id}-Destination {app_id} Card {index} (Trading Card)"
        for app_id in (10, 20)
        for index in range(1, 6)
    ]
    literal_percent_name = "1115050-100% Complete"

    def price_row(
        market_hash_name: str,
        highest_buy: float,
        lowest_sell: float,
    ) -> dict[str, object]:
        return {
            "marketHashName": market_hash_name,
            "orderBook": {
                "highestBuy": highest_buy,
                "lowestSell": lowest_sell,
                "buyOrdersTop10": [{"price": highest_buy, "quantity": 1}],
                "sellOrdersTop10": [{"price": lowest_sell, "quantity": 1}],
            },
            "updatedAt": int(quote_time.timestamp() * 1_000),
        }

    rows = [
        *(price_row(name, 2.0, 1.0) for name in source_hashes),
        *(price_row(name, 0.10, 0.10) for name in destination_hashes),
        price_row(literal_percent_name, 0.05, 0.1),
    ]
    bulk_client = FakeHTTPClient(
        [],
        stream_response=FakeResponse(
            200,
            chunks=[
                json.dumps(
                    {
                        "metadata": {"appId": 753, "itemCount": len(rows)},
                        "items": rows,
                    },
                    separators=(",", ":"),
                ).encode()
            ],
        ),
    )
    gateway_http_client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset(str(index)) for index in range(1, 6)],
                    descriptions=[
                        item_description(
                            str(index),
                            f"Source Card {index}",
                            market_hash_name=market_hash_name,
                            marketable=1,
                            tags=trading_card_tags(),
                        )
                        for index, market_hash_name in enumerate(
                            source_hashes,
                            start=1,
                        )
                    ],
                ),
            ),
            price_redirect(),
        ]
    )
    gateway = SteamGateway(
        configured,
        http_client=gateway_http_client,
        bulk_http_client=bulk_client,
        gem_pricing=NoopGemPricing(),  # type: ignore[arg-type]
    )

    inventory = run(gateway.check_inventory("76561198000000000"))
    generation = gateway.steamapis.price_cache.read(frozenset({literal_percent_name}))
    plan_time = datetime.now(UTC)
    result = run(
        gateway.check_level_up(
            tuple(
                steam_gateway.Holding(
                    market_hash_name=item.market_hash_name,
                    owned_quantity=item.quantity,
                    sellable_quantity=item.quantity,
                )
                for item in inventory.items
                if item.market_hash_name is not None
            ),
            {
                10: ("Destination Ten", 5),
                20: ("Destination Twenty", 5),
                440: ("Source Game", 5),
            },
            BadgeState(0, 0, {}),
            inventory_refreshed_at=plan_time,
            badge_refreshed_at=plan_time,
            now=plan_time,
        )
    )

    assert inventory.status == "public"
    assert inventory.price_status == "complete"
    assert inventory.priceable_item_count == inventory.priced_item_count == 5
    assert inventory.items[0].price is not None
    assert inventory.items[0].price.highest_buy == "2.0"
    assert generation.has_generation is True
    assert generation.optimizer_complete is True
    assert set(generation.prices) == {literal_percent_name}
    assert generation.prices[literal_percent_name].highest_buy == "0.05"
    assert generation.prices[literal_percent_name].lowest_sell == "0.1"
    assert (result.status, result.reason) == ("ready", "ready")
    assert result.source is not None
    assert result.source.app_id == 440
    assert [destination.app_id for destination in result.destinations] == [10, 20]
    assert gateway_http_client.stream_calls == []


def test_price_cache_fresh_hit_avoids_second_provider_refresh() -> None:
    client = FakeHTTPClient([price_redirect()], stream_response=price_stream())
    steamapis = SteamApisClient(settings(), http_client=client)

    first = run(steamapis.fetch_prices(frozenset({"Name"})))
    second = run(steamapis.fetch_prices(frozenset({"Name"})))

    assert first.status == second.status == "complete"
    assert second.prices["Name"].lowest_sell == "0.20"
    assert len(client.get_calls) == 1
    assert len(client.stream_calls) == 1


def test_price_cache_expiry_triggers_one_new_full_refresh(tmp_path: Path) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    client = FakeHTTPClient(
        [price_redirect(), price_redirect()],
        stream_response=price_stream(),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )

    run(steamapis.fetch_prices(frozenset({"Name"})))
    with sqlite3.connect(cache_path) as connection:
        connection.execute("UPDATE steamapis_price_cache_meta SET refreshed_at = 0")
        connection.commit()

    refreshed = run(steamapis.fetch_prices(frozenset({"Name"})))

    assert refreshed.status == "complete"
    assert len(client.get_calls) == 2
    assert len(client.stream_calls) == 2


def test_price_cache_concurrent_stale_readers_coalesce_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def blocked_stream_with_price(
        _response: object,
        _requested_names: frozenset[str],
        on_price: steam_gateway._PriceRefreshSink | None = None,
    ) -> tuple[
        dict[str, object],
        set[str],
        steam_gateway._PriceStreamSummary,
    ]:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        assert callable(on_price)
        on_price(
            "Name",
            "0.10",
            "0.20",
            "2026-08-27T00:00:00Z",
            None,
            None,
        )
        return {}, set(), steam_gateway._PriceStreamSummary(753, 1, 1)

    monkeypatch.setattr(steam_gateway, "_stream_prices", blocked_stream_with_price)
    client = FakeHTTPClient([price_redirect()], stream_response=FakeResponse(200))
    steamapis = SteamApisClient(settings(), http_client=client)

    async def exercise() -> tuple[
        steam_gateway._PriceLookup, steam_gateway._PriceLookup
    ]:
        first = asyncio.create_task(steamapis.fetch_prices(frozenset({"Name"})))
        await entered.wait()
        second = asyncio.create_task(steamapis.fetch_prices(frozenset({"Name"})))
        await asyncio.sleep(0)
        assert calls == 1
        release.set()
        return await asyncio.gather(first, second)

    first, second = run(exercise())
    assert first.status == second.status == "complete"
    assert len(client.get_calls) == 1
    assert len(client.stream_calls) == 1


def test_price_cache_survives_client_restart(tmp_path: Path) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    first_client = FakeHTTPClient([price_redirect()], stream_response=price_stream())
    first = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=first_client,
    )
    run(first.fetch_prices(frozenset({"Name"})))

    second_client = FakeHTTPClient([])
    second = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=second_client,
    )
    result = run(second.fetch_prices(frozenset({"Name"})))

    assert result.status == "complete"
    assert result.prices["Name"].highest_buy == "0.10"
    assert second_client.get_calls == []
    assert second_client.stream_calls == []


def test_price_cache_is_read_without_an_api_key_after_restart(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    first = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=FakeHTTPClient(
            [price_redirect()],
            stream_response=price_stream(),
        ),
    )
    run(first.fetch_prices(frozenset({"Name"})))

    second_client = FakeHTTPClient([])
    second = SteamApisClient(
        settings(
            steamapi_key="",
            steamapis_price_cache_path=str(cache_path),
        ),
        http_client=second_client,
    )
    result = run(second.fetch_prices(frozenset({"Name"})))

    assert result.status == "complete"
    assert result.prices["Name"].lowest_sell == "0.20"
    assert second_client.get_calls == []


def test_price_cache_uses_stale_generation_when_refresh_fails(tmp_path: Path) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    client = FakeHTTPClient(
        [price_redirect(), OSError("provider unavailable")],
        stream_response=price_stream(),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )
    run(steamapis.fetch_prices(frozenset({"Name"})))
    with sqlite3.connect(cache_path) as connection:
        connection.execute("UPDATE steamapis_price_cache_meta SET refreshed_at = 0")
        connection.commit()

    stale = run(steamapis.fetch_prices(frozenset({"Name"})))

    assert stale.status == "complete"
    assert stale.used_stale_cache is True
    assert stale.prices["Name"].lowest_sell == "0.20"
    assert len(client.get_calls) == 2


def test_inventory_discloses_stale_price_fallback(tmp_path: Path) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    client = FakeHTTPClient(
        [
            price_redirect(),
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[
                        item_description(
                            "1",
                            "Name",
                            market_hash_name="Name",
                            marketable=1,
                        )
                    ],
                ),
            ),
            OSError("provider unavailable"),
        ],
        stream_response=price_stream(),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
        gem_pricing=NoopGemPricing(),  # type: ignore[arg-type]
    )
    run(steamapis.fetch_prices(frozenset({"Name"})))
    with sqlite3.connect(cache_path) as connection:
        connection.execute("UPDATE steamapis_price_cache_meta SET refreshed_at = 0")
        connection.commit()

    result = run(steamapis.fetch_inventory("42"))

    assert result.price_status == "complete"
    assert result.price_message == "Prices are complete using a cached fallback."
    assert result.items[0].price is not None
    assert result.items[0].price.lowest_sell == "0.20"


def test_inventory_discloses_stale_auxiliary_market_context(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    sack_name = "753-Sack of Gems"
    client = FakeHTTPClient(
        [
            price_redirect(),
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[
                        item_description(
                            "1",
                            "Trading Card",
                            marketable=0,
                            tags=trading_card_tags(),
                            owner_actions=goo_owner_actions(
                                app_id="440",
                                item_type=2,
                                border_color=0,
                            ),
                        )
                    ],
                ),
            ),
            OSError("provider unavailable"),
        ],
        stream_response=price_stream(name=sack_name),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
        gem_pricing=NoopGemPricing(),  # type: ignore[arg-type]
    )
    run(steamapis.fetch_prices(frozenset({sack_name})))
    with sqlite3.connect(cache_path) as connection:
        connection.execute("UPDATE steamapis_price_cache_meta SET refreshed_at = 0")
        connection.commit()

    result = run(steamapis.fetch_inventory("42"))

    assert result.priceable_item_count == 0
    assert result.gem_cash_context is not None
    assert (
        result.price_message
        == "Displayed booster or gem market context uses a cached fallback."
    )


def test_price_cache_failed_refresh_backoff_prevents_stampede(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 1_000.0
    monkeypatch.setattr(steamapis_price_cache.time, "time", lambda: now)
    client = FakeHTTPClient([OSError("provider unavailable")])
    steamapis = SteamApisClient(settings(), http_client=client)

    first = run(steamapis.fetch_prices(frozenset({"Name"})))
    second = run(steamapis.fetch_prices(frozenset({"Name"})))
    assert first.status == second.status == "unavailable"
    assert len(client.get_calls) == 1

    now += steamapis_price_cache.PRICE_REFRESH_RETRY_BASE_SECONDS + 1
    client.responses.append(price_redirect())
    client.stream_response = price_stream()
    third = run(steamapis.fetch_prices(frozenset({"Name"})))

    assert third.status == "complete"
    assert len(client.get_calls) == 2


def test_price_cache_malformed_refresh_keeps_previous_generation(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    client = FakeHTTPClient(
        [price_redirect(), price_redirect()],
        stream_response=price_stream(),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )
    run(steamapis.fetch_prices(frozenset({"Name"})))
    with sqlite3.connect(cache_path) as connection:
        connection.execute("UPDATE steamapis_price_cache_meta SET refreshed_at = 0")
        connection.commit()
    client.stream_response = FakeResponse(
        200,
        chunks=[
            b'{"items":[{"marketHashName":"Name","orderBook":{"lowestSell":"9.99"}'
        ],
    )

    stale = run(steamapis.fetch_prices(frozenset({"Name"})))

    assert stale.status == "complete"
    assert stale.used_stale_cache is True
    assert stale.prices["Name"].lowest_sell == "0.20"
    with sqlite3.connect(cache_path) as connection:
        row = connection.execute(
            """
            SELECT highest_buy, lowest_sell
              FROM steamapis_price_cache
             WHERE generation = (
                 SELECT generation FROM steamapis_price_cache_meta WHERE singleton = 1
             )
            """
        ).fetchone()
    assert row == ("0.10", "0.20")


def test_price_cache_empty_json_refresh_keeps_previous_generation(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    client = FakeHTTPClient(
        [price_redirect(), price_redirect()],
        stream_response=price_stream(),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )
    run(steamapis.fetch_prices(frozenset({"Name"})))
    with sqlite3.connect(cache_path) as connection:
        connection.execute("UPDATE steamapis_price_cache_meta SET refreshed_at = 0")
        connection.commit()
    client.stream_response = FakeResponse(
        200,
        chunks=[
            b'{"items":[],"metadata":{"marketHashName":"Bogus",'
            b'"orderBook":{"lowestSell":"9.99"}}}'
        ],
    )

    stale = run(steamapis.fetch_prices(frozenset({"Name"})))

    assert stale.status == "complete"
    assert stale.used_stale_cache is True
    assert stale.prices["Name"].lowest_sell == "0.20"


def test_price_cache_cancelled_refresh_keeps_previous_generation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    client = FakeHTTPClient(
        [price_redirect(), price_redirect()],
        stream_response=price_stream(),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )
    run(steamapis.fetch_prices(frozenset({"Name"})))
    with sqlite3.connect(cache_path) as connection:
        connection.execute("UPDATE steamapis_price_cache_meta SET refreshed_at = 0")
        connection.commit()
    partial_installed = asyncio.Event()

    async def blocked_stream(
        _response: object,
        _requested_names: frozenset[str],
        on_price: steam_gateway._PriceRefreshSink | None = None,
    ) -> tuple[
        dict[str, object],
        set[str],
        steam_gateway._PriceStreamSummary,
    ]:
        assert callable(on_price)
        on_price(
            "Partial",
            None,
            "9.99",
            "2026-08-27T00:00:00Z",
            None,
            None,
        )
        partial_installed.set()
        await asyncio.Event().wait()
        pytest.fail("stream must be cancelled, not completed")

    original_stream_prices = steam_gateway._stream_prices
    monkeypatch.setattr(steam_gateway, "_stream_prices", blocked_stream)

    async def exercise() -> None:
        pending = asyncio.create_task(steamapis.fetch_prices(frozenset({"Name"})))
        await partial_installed.wait()
        refresh_task = steamapis._price_refresh_task
        assert refresh_task is not None
        refresh_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending

        surviving = SteamApisPriceCache(cache_path).read(("Name", "Partial"))
        assert surviving.has_generation is True
        assert surviving.generation == 1
        assert set(surviving.prices) == {"Name"}
        assert surviving.prices["Name"].lowest_sell == "0.20"
        assert surviving.retry_suppressed is False
        assert surviving.failure_count == 0
        assert (
            steam_gateway._price_refresh_lock(steamapis.price_cache).locked() is False
        )

        monkeypatch.setattr(steam_gateway, "_stream_prices", original_stream_prices)
        client.responses.append(price_redirect())
        client.stream_response = price_stream()
        refreshed = await steamapis.fetch_prices(frozenset({"Name"}))

        assert refreshed.status == "complete"
        assert refreshed.prices["Name"].lowest_sell == "0.20"
        assert len(client.get_calls) == 3
        assert SteamApisPriceCache(cache_path).read().generation == 2

    run(exercise())


def test_bulk_refresh_yields_event_loop_and_cancels_mid_stream(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    row_count = 20_000
    rows = ",".join(
        f'{{"marketHashName":"440-Card {index} (Trading Card)","orderBook":{{}}}}'
        for index in range(row_count)
    )
    payload = (
        '{"metadata":{"appId":753,"itemCount":'
        + str(row_count)
        + '},"items":['
        + rows
        + "]}"
    ).encode()
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(200, chunks=[payload]),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )

    async def exercise() -> None:
        pending = asyncio.create_task(steamapis._refresh_prices())
        for _ in range(8):
            await asyncio.sleep(0)
        # Bounded cooperative segments keep the loop responsive: a fully
        # buffered 20k-row feed is still mid-stream after eight rounds
        # instead of monopolizing one step, so cancelling it lands inside a
        # segment and aborts without installing a generation.
        assert not pending.done()
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending

    run(exercise())

    surviving = SteamApisPriceCache(cache_path).read()
    assert surviving.has_generation is False
    assert surviving.retry_suppressed is False
    assert surviving.failure_count == 0
    assert steam_gateway._price_refresh_lock(steamapis.price_cache).locked() is False


def test_price_cache_recovers_corrupt_database(tmp_path: Path) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    cache_path.write_bytes(b"not a sqlite database")
    client = FakeHTTPClient([price_redirect()], stream_response=price_stream())
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )

    result = run(steamapis.fetch_prices(frozenset({"Name"})))

    assert result.status == "complete"
    assert any(tmp_path.glob("prices.sqlite3.corrupt-*"))


def test_unrequested_price_numbers_are_bounded_during_full_feed_cache(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    client = FakeHTTPClient(
        [
            FakeResponse(
                302,
                headers={"Location": "https://prices.r2.cloudflarestorage.com/list"},
            )
        ],
        stream_response=FakeResponse(
            200,
            chunks=[
                b'{"metadata":{"appId":753,"itemCount":2},"items":['
                b'{"marketHashName":"440-Unrequested (Trading Card)","orderBook":'
                b'{"highestBuy":1e999997},"updatedAt":1e999997},'
                b'{"marketHashName":"Requested","orderBook":{"highestBuy":"0.10"}}]}',
            ],
        ),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )

    lookup = run(steamapis.fetch_prices(frozenset({"Requested"})))

    assert lookup.status == "complete"
    assert set(lookup.prices) == {"Requested"}
    assert lookup.prices["Requested"].highest_buy == "0.10"
    cache = SteamApisPriceCache(cache_path)
    cached = cache.read(("440-Unrequested (Trading Card)", "Requested"))
    assert cached.has_generation is True
    assert set(cached.prices) == {"Requested"}
    unrequested = cache.read_catalog(app_ids=[440]).groups[440][0]
    assert unrequested.market_hash_name == "440-Unrequested (Trading Card)"
    assert unrequested.highest_buy is None
    assert unrequested.lowest_sell is None
    assert unrequested.observed_at is None
    assert cached.prices["Requested"].highest_buy == "0.10"


def test_inventory_rejects_oversized_cursor_before_next_request() -> None:
    oversized_cursor = "c" * (MAX_INVENTORY_CURSOR_LENGTH + 1)
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[item_description("1", "Card")],
                    more_items=1,
                    last_assetid=oversized_cursor,
                ),
            )
        ]
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "unavailable"
    assert len(client.get_calls) == 1


def test_inventory_rejects_page_asset_budget() -> None:
    assets = [
        item_asset(str(index)) for index in range(MAX_INVENTORY_ASSETS_PER_PAGE + 1)
    ]
    client = FakeHTTPClient([FakeResponse(200, page(assets=assets, descriptions=[]))])
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "unavailable"
    assert result.items == []


def test_inventory_rejects_excessive_pagination() -> None:
    responses = [
        FakeResponse(
            200,
            page(more_items=1, last_assetid=f"cursor-{index}"),
        )
        for index in range(MAX_INVENTORY_PAGES)
    ]
    client = FakeHTTPClient(responses)
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "unavailable"
    assert result.items == []
    assert len(client.get_calls) == MAX_INVENTORY_PAGES


def test_inventory_rejects_advertised_page_body_over_byte_budget() -> None:
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(),
                headers={"Content-Length": str(16 * 1024 * 1024 + 1)},
            )
        ]
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "unavailable"


def test_bulk_stream_decoded_byte_limit_is_enforced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    monkeypatch.setattr(steam_gateway, "MAX_PRICE_STREAM_BYTES", 8)
    client = FakeHTTPClient(
        [
            FakeResponse(
                302,
                headers={"Location": "https://prices.r2.cloudflarestorage.com/list"},
            )
        ],
        stream_response=FakeResponse(200, chunks=[b'{"items":[]}']),
    )
    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({"Name"})
        )
    )
    assert lookup.status == "unavailable"


def test_declared_partial_bulk_generation_is_not_committed() -> None:
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(
            200,
            chunks=[
                b'{"metadata":{"appId":753,"itemCount":2},"items":['
                b'{"marketHashName":"Only Row",'
                b'"orderBook":{"lowestSell":"0.25"}}]}'
            ],
        ),
    )
    steamapis = SteamApisClient(settings(), http_client=client)

    lookup = run(steamapis.fetch_prices(frozenset({"Only Row"})))
    assert lookup.status == "unavailable"
    assert steamapis.price_cache.read().has_generation is False


@pytest.mark.parametrize(
    "invalid_item",
    [
        {"orderBook": {"lowestSell": "0.25"}},
        {"marketHashName": "", "orderBook": {"lowestSell": "0.25"}},
        {"marketHashName": 440, "orderBook": {"lowestSell": "0.25"}},
        {
            "marketHashName": "Valid Row",
            "orderBook": {"lowestSell": "0.25"},
        },
        None,
        7,
        [],
    ],
)
def test_invalid_or_duplicate_bulk_item_aborts_complete_generation(
    invalid_item: object,
) -> None:
    payload = {
        "metadata": {"appId": 753, "itemCount": 2},
        "items": [
            {
                "marketHashName": "Valid Row",
                "orderBook": {"lowestSell": "0.25"},
            },
            invalid_item,
        ],
    }
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(
            200,
            chunks=[json.dumps(payload).encode()],
        ),
    )
    steamapis = SteamApisClient(settings(), http_client=client)

    lookup = run(steamapis.fetch_prices(frozenset({"Valid Row"})))

    assert lookup.status == "unavailable"
    assert steamapis.price_cache.read().has_generation is False


def test_duplicate_top_level_items_member_aborts_complete_generation() -> None:
    payload = (
        b'{"metadata":{"appId":753,"itemCount":2},'
        b'"items":[{"marketHashName":"First Row"}],'
        b'"items":[{"marketHashName":"Second Row"}]}'
    )
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(200, chunks=[payload]),
    )
    steamapis = SteamApisClient(settings(), http_client=client)

    lookup = run(steamapis.fetch_prices(frozenset({"First Row", "Second Row"})))

    assert lookup.status == "unavailable"
    assert steamapis.price_cache.read().has_generation is False


def test_bulk_stream_rejects_duplicate_semantic_price_aliases() -> None:
    payload = (
        b'{"metadata":{"appId":753,"itemCount":1},'
        b'"items":[{"marketHashName":"Ambiguous Row","orderBook":'
        b'{"highestBuy":"0.25","highest_buy":"0.50"}}]}'
    )
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(200, chunks=[payload]),
    )
    steamapis = SteamApisClient(settings(), http_client=client)

    lookup = run(steamapis.fetch_prices(frozenset({"Ambiguous Row"})))

    assert lookup.status == "unavailable"
    assert steamapis.price_cache.read().has_generation is False


def test_bulk_stream_nesting_limit_is_enforced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    monkeypatch.setattr(steam_gateway, "MAX_PRICE_STREAM_NESTING", 4)
    nested = b"[" * 5 + b"]" * 5
    client = FakeHTTPClient(
        [
            FakeResponse(
                302,
                headers={"Location": "https://prices.r2.cloudflarestorage.com/list"},
            )
        ],
        stream_response=FakeResponse(200, chunks=[nested]),
    )
    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({"Name"})
        )
    )
    assert lookup.status == "unavailable"
    assert MAX_PRICE_STREAM_BYTES > 392_000_000


def test_inventory_single_flight_does_not_retain_completed_results() -> None:
    client = SteamApisClient(settings(), http_client=FakeHTTPClient([]))
    calls = 0
    started = asyncio.Event()
    release = asyncio.Event()

    async def fake_fetch(_: str) -> InventoryCheck:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return InventoryCheck(status="public", message="ok")

    client._fetch_inventory_uncached = fake_fetch  # type: ignore[method-assign]

    async def exercise() -> tuple[InventoryCheck, InventoryCheck, InventoryCheck]:
        first = asyncio.create_task(client.fetch_inventory("42"))
        await started.wait()
        second = asyncio.create_task(client.fetch_inventory("42"))
        release.set()
        first_result, second_result = await asyncio.gather(first, second)
        third_result = await client.fetch_inventory("42")
        return first_result, second_result, third_result

    first_result, second_result, third_result = run(exercise())
    assert first_result == second_result == third_result
    assert calls == 2


def test_steamapis_stop_cancels_shielded_inventory_before_gem_warmer() -> None:
    async def exercise() -> None:
        allow_resolution = asyncio.Event()
        fetch_started = asyncio.Event()
        fetch_cancelled = asyncio.Event()

        class BlockingProvider:
            started = asyncio.Event()

            async def lookup(self, *_args: object, **_kwargs: object) -> object:
                self.started.set()
                await asyncio.Event().wait()

        provider = BlockingProvider()
        gem_pricing = GemPricingService(
            settings(),
            cache=GemPriceCache(":memory:"),
            provider=provider,  # type: ignore[arg-type]
        )
        client = SteamApisClient(
            settings(),
            http_client=FakeHTTPClient([]),
            gem_pricing=gem_pricing,
        )

        async def fake_fetch(_: str) -> InventoryCheck:
            fetch_started.set()
            try:
                await allow_resolution.wait()
                await gem_pricing.resolve(
                    {GemKey(app_id="10", item_type=5, border_color=0): "Card"}
                )
            except asyncio.CancelledError:
                fetch_cancelled.set()
                raise
            return InventoryCheck(status="public", message="ok")

        client._fetch_inventory_uncached = fake_fetch  # type: ignore[method-assign]
        request = asyncio.create_task(client.fetch_inventory("42"))
        await fetch_started.wait()
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert "42" in client._inventory_inflight

        await client.stop()
        assert fetch_cancelled.is_set()

        try:
            allow_resolution.set()
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(provider.started.wait(), timeout=0.05)
        finally:
            await gem_pricing.stop()

    run(exercise())


def test_bulk_stream_semaphore_limits_concurrent_streams(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    monkeypatch.setattr(steam_gateway, "_BULK_STREAM_SEMAPHORE", asyncio.Semaphore(1))
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def blocked_stream(
        _: object,
        __: frozenset[str],
        on_price: steam_gateway._PriceRefreshSink | None = None,
    ) -> tuple[dict, set]:
        del on_price
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            await release.wait()
        return {}, set()

    monkeypatch.setattr(steam_gateway, "_stream_prices", blocked_stream)
    first_client = FakeHTTPClient(
        [
            FakeResponse(
                302,
                headers={"Location": "https://first.r2.cloudflarestorage.com/list"},
            )
        ],
        stream_response=FakeResponse(200),
    )
    second_client = FakeHTTPClient(
        [
            FakeResponse(
                302,
                headers={"Location": "https://second.r2.cloudflarestorage.com/list"},
            )
        ],
        stream_response=FakeResponse(200),
    )

    async def exercise() -> tuple[
        steam_gateway._PriceLookup,
        steam_gateway._PriceLookup,
    ]:
        first = asyncio.create_task(
            SteamApisClient(settings(), http_client=first_client).fetch_prices(
                frozenset({"Name"})
            )
        )
        await entered.wait()
        second = asyncio.create_task(
            SteamApisClient(settings(), http_client=second_client).fetch_prices(
                frozenset({"Name"})
            )
        )
        await asyncio.sleep(0)
        assert second_client.stream_calls == []
        release.set()
        return await asyncio.gather(first, second)

    first_lookup, second_lookup = run(exercise())
    assert first_lookup.status == second_lookup.status == "unavailable"
    assert calls == 2


def test_inventory_rejects_aggregate_asset_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    monkeypatch.setattr(steam_gateway, "MAX_INVENTORY_ASSETS", 1)
    client = FakeHTTPClient(
        [
            FakeResponse(
                200,
                page(
                    assets=[item_asset("1")],
                    descriptions=[item_description("1", "First")],
                    more_items=1,
                    last_assetid="next",
                ),
            ),
            FakeResponse(
                200,
                page(
                    assets=[item_asset("2")],
                    descriptions=[item_description("2", "Second")],
                ),
            ),
        ]
    )
    result = run(SteamGateway(settings(), http_client=client).check_inventory("42"))
    assert result.status == "unavailable"
    assert result.items == []


def test_price_depth_sums_only_units_at_exact_top_prices() -> None:
    name = "440-Test Card (Trading Card)"
    payload = (
        '{"metadata":{"appId":753,"itemCount":1},"items":[{"marketHashName":"'
        + name
        + '","orderBook":{"highestBuy":"0.10","lowestSell":"0.20",'
        '"buyOrdersTop10":[{"price":"0.10","quantity":2},'
        '{"price":"0.09","quantity":99},{"price":"0.10","quantity":"3"}],'
        '"sellOrdersTop10":[{"price":"0.20","quantity":4},'
        '{"price":"0.21","quantity":99},{"price":"0.20","quantity":"1"}]}}]}'
    ).encode()
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(200, chunks=[payload]),
    )

    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({name})
        )
    )

    assert lookup.status == "complete"
    assert lookup.prices[name].highest_buy_quantity == 5
    assert lookup.prices[name].lowest_sell_quantity == 5


def test_price_depth_rejects_scalar_that_is_not_book_extreme() -> None:
    name = "440-Test Card (Trading Card)"
    payload = (
        '{"metadata":{"appId":753,"itemCount":1},"items":[{"marketHashName":"'
        + name
        + '","orderBook":{"highestBuy":"0.10","lowestSell":"0.20",'
        '"buyOrdersTop10":[{"price":"0.20","quantity":2},'
        '{"price":"0.10","quantity":3}],'
        '"sellOrdersTop10":[{"price":"0.10","quantity":4},'
        '{"price":"0.20","quantity":1}]}}]}'
    ).encode()
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(200, chunks=[payload]),
    )

    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({name})
        )
    )

    assert lookup.status == "complete"
    assert lookup.prices[name].highest_buy_quantity is None
    assert lookup.prices[name].lowest_sell_quantity is None


def test_malformed_price_depth_becomes_null_without_losing_price() -> None:
    name = "440-Test Card (Trading Card)"
    payload = (
        '{"metadata":{"appId":753,"itemCount":1},"items":[{"marketHashName":"'
        + name
        + '","orderBook":{"highestBuy":"0.10","lowestSell":"0.20",'
        '"buyOrdersTop10":[[],{"price":"0.10","quantity":1}],'
        '"sellOrdersTop10":[[],{"price":"0.20","quantity":1}]}}]}'
    ).encode()
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(200, chunks=[payload]),
    )

    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({name})
        )
    )

    assert lookup.status == "complete"
    assert lookup.prices[name].highest_buy == "0.10"
    assert lookup.prices[name].lowest_sell == "0.20"
    assert lookup.prices[name].highest_buy_quantity is None
    assert lookup.prices[name].lowest_sell_quantity is None


def test_price_cache_catalog_normalizes_card_metadata_and_is_bounded(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    card_name = "440-Test Card (Trading Card)"
    non_card_name = "440-Test Booster Pack"
    payload = (
        '{"metadata":{"appId":753,"itemCount":2},"items":['
        '{"marketHashName":"'
        + card_name
        + '","orderBook":{"highestBuy":"0.10","lowestSell":"0.20"}},'
        '{"marketHashName":"'
        + non_card_name
        + '","orderBook":{"highestBuy":"0.11","lowestSell":"0.21"}}]}'
    ).encode()
    client = FakeHTTPClient(
        [price_redirect()],
        stream_response=FakeResponse(200, chunks=[payload]),
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=client,
    )

    run(steamapis.fetch_prices(frozenset({card_name})))
    catalog = steamapis.read_price_catalog(max_rows=1)

    assert catalog.generation == 1
    assert catalog.fresh is True
    assert catalog.row_count == 1
    assert catalog.truncated is False
    assert set(catalog.groups) == {440}
    card = catalog.groups[440][0]
    assert card.market_hash_name == card_name
    assert card.normal_card_app_id == 440
    assert card.normal_card_name == "Test Card"


@pytest.mark.parametrize("read_only", [False, True])
def test_price_cache_reopens_legacy_index_shape_without_losing_generation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    read_only: bool,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    cache = SteamApisPriceCache(cache_path)
    refresh = cache.begin_refresh()
    refresh.add(
        "440-Card (Trading Card)",
        "0.10",
        "0.20",
        "2026-08-26T12:00:00Z",
        1,
        1,
    )
    refresh.commit(
        now=datetime(2026, 8, 26, 12, tzinfo=UTC).timestamp(),
        optimizer_complete=True,
    )
    with sqlite3.connect(cache_path) as connection:
        connection.execute("DROP INDEX steamapis_price_cache_generation_app_id_idx")
        connection.execute(
            """
            CREATE INDEX steamapis_price_cache_generation_app_id_idx
                ON steamapis_price_cache (generation, normal_card_app_id)
            """
        )
        connection.commit()
    connection.close()
    if read_only:
        connect = sqlite3.connect

        def read_only_connect(database: Path, *, timeout: float) -> sqlite3.Connection:
            return connect(f"{database.as_uri()}?mode=ro", timeout=timeout, uri=True)

        monkeypatch.setattr(sqlite3, "connect", read_only_connect)

    reopened = SteamApisPriceCache(cache_path)
    reopened.initialize()
    retained = reopened.read(("440-Card (Trading Card)",))
    catalog = reopened.read_catalog()

    assert retained.has_generation is True
    assert retained.generation == 1
    assert retained.prices["440-Card (Trading Card)"].lowest_sell == "0.20"
    assert catalog.row_count == 1
    assert catalog.groups[440][0].lowest_sell == "0.20"


def test_price_cache_catalog_retains_normal_card_without_quotes(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    card_name = "440-Unquoted Card (Trading Card)"
    payload = (
        '{"metadata":{"appId":753,"itemCount":1},"items":['
        '{"marketHashName":"' + card_name + '","orderBook":{}}]}'
    ).encode()
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=FakeHTTPClient(
            [price_redirect()],
            stream_response=FakeResponse(200, chunks=[payload]),
        ),
    )

    run(steamapis.fetch_prices(frozenset({card_name})))
    catalog = steamapis.read_price_catalog(max_rows=10)

    assert catalog.optimizer_complete is True
    assert catalog.row_count == 1
    card = catalog.groups[440][0]
    assert card.market_hash_name == card_name
    assert card.highest_buy is None
    assert card.lowest_sell is None


def test_price_cache_catalog_filters_unrelated_app_ids(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    cache = SteamApisPriceCache(cache_path)
    refresh = cache.begin_refresh()
    quote_time = "2026-08-26T12:00:00Z"
    for app_id in (10, 440, 999):
        refresh.add(
            f"{app_id}-Card (Trading Card)",
            "0.10",
            "0.20",
            quote_time,
            1,
            1,
        )
    refresh.commit(
        now=datetime(2026, 8, 26, 12, tzinfo=UTC).timestamp(),
        optimizer_complete=True,
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=FakeHTTPClient([]),
        price_cache=cache,
    )

    filtered = steamapis.read_price_catalog(max_rows=10, app_ids={440})
    empty = steamapis.read_price_catalog(max_rows=10, app_ids=())
    direct = cache.read_catalog(max_rows=10, app_ids={440})

    assert filtered.generation == 1
    assert filtered.optimizer_complete is True
    assert filtered.row_count == 1
    assert filtered.truncated is False
    assert direct.groups == filtered.groups
    assert set(filtered.groups) == {440}
    assert [card.market_hash_name for card in filtered.groups[440]] == [
        "440-Card (Trading Card)"
    ]
    assert empty.generation == filtered.generation
    assert empty.refreshed_at == filtered.refreshed_at
    assert empty.optimizer_complete is True
    assert empty.groups == {}
    assert empty.row_count == 0
    assert empty.truncated is False


def test_price_cache_catalog_truncation_reports_overflow_rows(
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "prices.sqlite3"
    cache = SteamApisPriceCache(cache_path)
    refresh = cache.begin_refresh()
    quote_time = "2026-08-26T12:00:00Z"
    for name in (
        "440-Alpha (Trading Card)",
        "440-Beta (Trading Card)",
        "999-Gamma (Trading Card)",
    ):
        refresh.add(name, "0.10", "0.20", quote_time, 1, 1)
    refresh.commit(
        now=datetime(2026, 8, 26, 12, tzinfo=UTC).timestamp(),
        optimizer_complete=True,
    )
    steamapis = SteamApisClient(
        settings(steamapis_price_cache_path=str(cache_path)),
        http_client=FakeHTTPClient([]),
        price_cache=cache,
    )

    catalog = steamapis.read_price_catalog(max_rows=2)

    assert catalog.generation == 1
    assert catalog.optimizer_complete is True
    assert catalog.row_count == 2
    assert catalog.truncated is True
    assert set(catalog.groups) == {440}
    assert [card.market_hash_name for card in catalog.groups[440]] == [
        "440-Alpha (Trading Card)",
        "440-Beta (Trading Card)",
    ]


def _badge_payload(
    *,
    player_xp: int = 0,
    player_level: int = 0,
    badges: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "success": True,
        "result": {
            "xp": player_xp,
            "level": player_level,
            "badges": badges or [],
        },
    }


def _badge_stream_response(
    payload: object,
    *,
    status_code: int = 200,
    headers: Mapping[str, str] | None = None,
) -> FakeResponse:
    return FakeResponse(
        status_code,
        headers=headers,
        chunks=[json.dumps(payload).encode()],
    )


def test_get_badges_uses_steamapis_endpoint_server_key_and_signed_steam_id() -> None:
    client = FakeHTTPClient(
        [],
        stream_response=_badge_stream_response(
            _badge_payload(
                badges=[
                    {"appID": 440, "borderColor": 0, "level": 3},
                    {"appID": 10, "borderColor": 0, "level": 2},
                    {"appID": 440, "borderColor": 1, "level": 50},
                    {
                        "appID": 2_243_720,
                        "borderColor": 0,
                        "level": 372_366,
                    },
                    {"appID": 2_861_690, "borderColor": 7, "level": "unknown"},
                    {"id": 1, "level": 7},
                ]
            )
        ),
    )
    gateway = SteamGateway(
        settings(
            steamapi_key="server-badge-key",
            steam_web_api_key=None,
        ),
        http_client=client,
    )

    result = run(gateway._fetch_badge_state("76561198000000000"))

    assert result.player_xp == 0
    assert result.player_level == 0
    assert dict(result.normal_badge_levels) == {10: 2, 440: 3}
    assert client.get_calls == []
    assert client.stream_calls == [
        {
            "method": "GET",
            "url": STEAMAPIS_BADGES_ENDPOINT.format(
                steam_id="76561198000000000",
            ),
            "params": None,
            "headers": {
                "x-api-key": "server-badge-key",
                "Accept-Encoding": "identity",
                "User-Agent": (
                    "SteamOptimizer/0.1.1 "
                    "(+https://github.com/TheRockPusher/Steam_Optimizer)"
                ),
            },
            "follow_redirects": False,
            "timeout": None,
        }
    ]


def test_badge_check_rejects_inconsistent_xp_and_level() -> None:
    with pytest.raises(ValidationError):
        BadgeCheck(
            status="public",
            message="Steam badge data is available.",
            player_xp=1_250,
            player_level=12,
            checked_at="2026-08-26T12:00:00Z",
            normal_badge_levels=[],
        )


def test_check_badges_returns_validated_public_xp_and_level() -> None:
    client = FakeHTTPClient(
        [],
        stream_response=_badge_stream_response(
            _badge_payload(
                player_xp=100,
                player_level=1,
                badges=[
                    {"appID": 440, "borderColor": 0, "level": 1},
                    {"appID": 10, "borderColor": 0, "level": 2},
                ],
            )
        ),
    )
    gateway = SteamGateway(settings(), http_client=client)

    result = run(gateway.check_badges("76561198000000000"))

    assert result.status == "public"
    assert result.message == "Steam badge data is available."
    assert result.player_xp == 100
    assert result.player_level == 1
    assert result.checked_at is not None
    assert result.model_dump()["normal_badge_levels"] == [
        {"app_id": 10, "level": 2},
        {"app_id": 440, "level": 1},
    ]
    assert client.get_calls == []
    assert len(client.stream_calls) == 1
    assert client.stream_calls[0]["url"] == STEAMAPIS_BADGES_ENDPOINT.format(
        steam_id="76561198000000000"
    )


def test_check_badges_maps_provider_failure_to_unavailable_not_private() -> None:
    client = FakeHTTPClient(
        [],
        stream_response=_badge_stream_response(
            _badge_payload(),
            status_code=403,
        ),
    )
    gateway = SteamGateway(settings(), http_client=client)

    result = run(gateway.check_badges("76561198000000000"))

    assert result.status == "unavailable"
    assert result.message == "Steam badge check is unavailable."
    assert result.player_xp is None
    assert result.player_level is None
    assert result.checked_at is None
    assert result.normal_badge_levels == []


@pytest.mark.parametrize(
    "payload",
    [
        _badge_payload(player_xp=100, player_level=0),
        {"success": True, "result": {"xp": 0, "level": 0}},
    ],
)
def test_check_badges_maps_invalid_payload_to_unavailable(
    payload: object,
) -> None:
    client = FakeHTTPClient(
        [],
        stream_response=_badge_stream_response(payload),
    )
    gateway = SteamGateway(settings(), http_client=client)

    result = run(gateway.check_badges("76561198000000000"))

    assert result.status == "unavailable"
    assert result.player_xp is None
    assert result.player_level is None
    assert result.checked_at is None
    assert result.normal_badge_levels == []


def test_get_badges_accepts_documented_snake_case_fields() -> None:
    result = steam_gateway._parse_badges_payload(
        {
            "success": True,
            "result": {
                "player_xp": 100,
                "player_level": 1,
                "badges": [
                    {"appid": 440, "border_color": 0, "level": 1},
                ],
            },
        },
    )

    assert result.player_xp == 100
    assert result.player_level == 1
    assert dict(result.normal_badge_levels) == {440: 1}


@pytest.mark.parametrize(
    "payload",
    [
        {
            "success": True,
            "result": {
                "xp": 100,
                "player_xp": 100,
                "level": 1,
                "badges": [],
            },
        },
        _badge_payload(
            player_xp=100,
            player_level=1,
            badges=[
                {
                    "appID": 440,
                    "appid": 440,
                    "borderColor": 0,
                    "level": 1,
                }
            ],
        ),
        _badge_payload(
            player_xp=100,
            player_level=1,
            badges=[
                {
                    "appID": 440,
                    "borderColor": 0,
                    "border_color": 0,
                    "level": 1,
                }
            ],
        ),
    ],
)
def test_get_badges_rejects_ambiguous_provider_aliases(
    payload: dict[str, object],
) -> None:
    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        steam_gateway._parse_badges_payload(payload)


@pytest.mark.parametrize(
    "raw_app_id",
    [False, 0.0, "440", -1, steam_gateway.MAX_APP_ID + 1],
)
def test_get_badges_ignores_unrecognized_app_ids(raw_app_id: object) -> None:
    result = steam_gateway._parse_badges_payload(
        _badge_payload(
            player_xp=100,
            player_level=1,
            badges=[
                {
                    "appID": raw_app_id,
                    "borderColor": 0,
                    "level": 1,
                }
            ],
        )
    )

    assert dict(result.normal_badge_levels) == {}


def test_get_badges_ignores_non_game_irrelevant_and_foil_records() -> None:
    result = steam_gateway._parse_badges_payload(
        _badge_payload(
            player_xp=100,
            player_level=1,
            badges=[
                {"id": 13, "level": 625},
                {"appID": None},
                {"appID": 0},
                {"appID": 2_243_720, "borderColor": 99, "level": "unknown"},
                {"appID": 440, "borderColor": 1},
                {"appID": 440, "borderColor": 1, "level": 999},
                {"appID": 440, "borderColor": 0, "level": 1},
                {"appID": 10, "borderColor": 0, "level": 2},
            ],
        ),
    )

    assert dict(result.normal_badge_levels) == {10: 2, 440: 1}


@pytest.mark.parametrize(
    "badge",
    [
        {"appID": 440, "level": 1},
        {"appID": 440, "borderColor": 2, "level": 1},
        {"appID": 440, "borderColor": False, "level": 1},
        {"appID": 440, "borderColor": 0, "level": 6},
        {"appID": 440, "borderColor": 0, "level": -1},
    ],
)
def test_get_badges_ignores_records_outside_normal_badge_shape(
    badge: dict[str, object],
) -> None:
    result = steam_gateway._parse_badges_payload(_badge_payload(badges=[badge]))

    assert dict(result.normal_badge_levels) == {}


@pytest.mark.parametrize(
    "badge",
    [
        {"appID": 440, "borderColor": 0},
        {"appID": 440, "borderColor": 0, "level": False},
        {"appID": 440, "borderColor": 0, "level": "1"},
    ],
)
def test_get_badges_rejects_malformed_normal_badge(
    badge: dict[str, object],
) -> None:
    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        steam_gateway._parse_badges_payload(
            _badge_payload(badges=[badge]),
        )


def test_get_badges_rejects_duplicate_normal_badges() -> None:
    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        steam_gateway._parse_badges_payload(
            _badge_payload(
                badges=[
                    {"appID": 440, "borderColor": 0, "level": 1},
                    {"appID": 440, "borderColor": 0, "level": 2},
                ]
            ),
        )


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"success": False, "result": {}},
        {"success": True, "result": None},
        {"success": True, "result": {"xp": 0, "level": 0}},
        {
            "success": True,
            "result": {"xp": 0, "level": 0, "badges": {}},
        },
        {
            "success": True,
            "result": {"xp": False, "level": 0, "badges": []},
        },
        {
            "success": True,
            "result": {"xp": 0, "level": False, "badges": []},
        },
    ],
)
def test_get_badges_rejects_malformed_envelopes(payload: object) -> None:
    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        steam_gateway._parse_badges_payload(payload)


def test_get_badges_rejects_decoded_payload_over_structural_bound() -> None:
    payload = _badge_payload()
    result = cast("dict[str, object]", payload["result"])
    result["padding"] = [None] * (MAX_BADGE_DECODED_SIZE // 32)

    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        steam_gateway._parse_badges_payload(payload)


@pytest.mark.parametrize("status_code", [400, 403, 429, 500])
def test_get_badges_rejects_non_success_responses(status_code: int) -> None:
    client = FakeHTTPClient(
        [],
        stream_response=_badge_stream_response(
            _badge_payload(),
            status_code=status_code,
        ),
    )
    gateway = SteamGateway(settings(), http_client=client)

    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        run(gateway._fetch_badge_state("76561198000000000"))


def test_get_badges_rejects_duplicate_object_members() -> None:
    payload = (
        b'{"success":true,"result":{"xp":0,"level":0,"badges":'
        b'[{"appID":440,"level":1,"level":5}]}}'
    )
    client = FakeHTTPClient(
        [],
        stream_response=FakeResponse(200, chunks=[payload]),
    )
    gateway = SteamGateway(settings(), http_client=client)

    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        run(gateway._fetch_badge_state("76561198000000000"))


@pytest.mark.parametrize("steam_id", ["", "abc", " 123", "1" * 21])
def test_get_badges_rejects_invalid_steam_ids_before_network(
    steam_id: str,
) -> None:
    client = FakeHTTPClient([])
    gateway = SteamGateway(settings(), http_client=client)

    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        run(gateway._fetch_badge_state(steam_id))

    assert client.stream_calls == []


@pytest.mark.parametrize(
    "response",
    [
        FakeResponse(200, chunks=[b"\xff"]),
        FakeResponse(200, headers={"content-length": "unknown"}),
        FakeResponse(
            200,
            headers={"content-encoding": "gzip"},
            chunks=[json.dumps(_badge_payload()).encode()],
        ),
        FakeResponse(
            200,
            chunks=[b'{"success":'],
            stream_error=OSError("connection reset"),
        ),
    ],
)
def test_get_badges_fails_closed_for_transport_corruption(
    response: FakeResponse,
) -> None:
    client = FakeHTTPClient([], stream_response=response)
    gateway = SteamGateway(settings(), http_client=client)

    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        run(gateway._fetch_badge_state("76561198000000000"))


def test_get_badges_fails_closed_for_timeout_malformed_and_bounded_inputs() -> None:
    timeout_client = FakeHTTPClient([], stream_response=TimeoutError())
    malformed_client = FakeHTTPClient(
        [],
        stream_response=FakeResponse(200, chunks=[b"{"]),
    )
    oversized_header_client = FakeHTTPClient(
        [],
        stream_response=_badge_stream_response(
            _badge_payload(),
            headers={"content-length": str(MAX_BADGE_RESPONSE_BYTES + 1)},
        ),
    )
    oversized_body_client = FakeHTTPClient(
        [],
        stream_response=FakeResponse(
            200,
            chunks=[b"x" * MAX_BADGE_RESPONSE_BYTES, b"x"],
        ),
    )
    overbounded_list_client = FakeHTTPClient(
        [],
        stream_response=_badge_stream_response(
            _badge_payload(badges=[{"appID": 0}] * (MAX_BADGE_RECORDS + 1))
        ),
    )
    inconsistent_client = FakeHTTPClient(
        [],
        stream_response=_badge_stream_response(
            _badge_payload(player_xp=1000, player_level=0)
        ),
    )

    with pytest.raises(TimeoutError):
        run(
            SteamGateway(settings(), http_client=timeout_client)._fetch_badge_state(
                "76561198000000000",
            )
        )
    for client in (
        malformed_client,
        oversized_header_client,
        oversized_body_client,
        overbounded_list_client,
        inconsistent_client,
    ):
        with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
            run(
                SteamGateway(settings(), http_client=client)._fetch_badge_state(
                    "76561198000000000",
                )
            )


def test_get_badges_rejects_compact_decoded_object_amplification() -> None:
    body = (
        b'{"success":true,"result":{"xp":0,"level":0,"badges":[],"padding":['
        + b'"x",' * 600_000
        + b'"x"]}}'
    )
    assert len(body) < MAX_BADGE_RESPONSE_BYTES
    client = FakeHTTPClient(
        [],
        stream_response=FakeResponse(200, chunks=[body]),
    )

    with pytest.raises(steam_gateway.InvalidSteamApisPayloadError):
        run(
            SteamGateway(settings(), http_client=client)._fetch_badge_state(
                "76561198000000000",
            )
        )


def test_get_badges_accepts_large_valid_public_profile() -> None:
    badges: list[dict[str, object]] = [
        {
            "id": 1,
            "appID": 1_000_000 + index,
            "borderColor": 0,
            "level": 10_000 + index,
            "xp": 100,
            "name": "Steam Awards - 2024",
            "icon": "a" * 24,
            "iconGray": "b" * 24,
        }
        for index in range(20_180)
    ]
    badges.append({"id": 1, "appID": 440, "borderColor": 0, "level": 2})
    payload = _badge_payload(player_xp=200, player_level=2, badges=badges)
    body = json.dumps(payload).encode()
    assert 2 * 1024 * 1024 < len(body) <= MAX_BADGE_RESPONSE_BYTES
    client = FakeHTTPClient(
        [],
        stream_response=FakeResponse(
            200,
            headers={"content-length": str(len(body))},
            chunks=[body],
        ),
    )

    result = run(
        SteamGateway(settings(), http_client=client)._fetch_badge_state(
            "76561198000000000",
        )
    )

    assert result.player_xp == 200
    assert result.player_level == 2
    assert dict(result.normal_badge_levels) == {440: 2}


def test_level_up_empty_holdings_respect_missing_contract() -> None:
    client = FakeHTTPClient([])
    gateway = SteamGateway(
        settings(
            steam_web_api_key=None,
            steamapi_key=None,
            level_up_currency_code=None,
            level_up_currency_minor_digits=None,
            level_up_price_basis=None,
            level_up_steam_fee_bps=None,
            level_up_publisher_fee_bps=None,
            level_up_min_fee_minor=None,
        ),
        http_client=client,
    )

    result = run(
        gateway.check_level_up(
            (),
            {},
            BadgeState(0, 0, {}),
            inventory_refreshed_at=datetime(2026, 8, 26, 12, tzinfo=UTC),
            badge_refreshed_at=datetime(2026, 8, 26, 12, tzinfo=UTC),
            now=datetime(2026, 8, 26, 12, tzinfo=UTC),
        )
    )

    assert result.status == "unavailable"
    assert result.reason == "currency_contract_missing"
    assert client.get_calls == []
    assert client.stream_calls == []


def test_level_up_refreshes_clock_after_catalog_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start = datetime(2026, 8, 26, 12, tzinfo=UTC)

    class AdvancingDateTime(datetime):
        ticks = iter((start.timestamp(), (start + timedelta(seconds=2)).timestamp()))

        @classmethod
        def now(cls, tz: tzinfo | None = None) -> Self:
            return cls.fromtimestamp(next(cls.ticks), tz)

    configured = settings(
        level_up_currency_code="USD",
        level_up_currency_minor_digits=2,
        level_up_price_basis="buyer_total",
        level_up_steam_fee_bps=500,
        level_up_publisher_fee_bps=1000,
        level_up_min_fee_minor=1,
        level_up_max_quote_age_seconds=900,
        level_up_max_inventory_age_seconds=3600,
    )
    gateway = SteamGateway(configured, http_client=FakeHTTPClient([]))

    monkeypatch.setattr(steam_gateway, "datetime", AdvancingDateTime)
    monkeypatch.setattr(
        gateway.steamapis,
        "read_price_catalog",
        lambda *, max_rows, app_ids=None: steam_gateway.NormalCardCatalogRead(
            1,
            start.timestamp(),
            {},
            optimizer_complete=max_rows > 0 and app_ids is not None,
        ),
    )

    result = run(
        gateway.check_level_up(
            (),
            {440: ("Team Fortress 2", 5)},
            BadgeState(0, 0, {}),
            inventory_refreshed_at=start - timedelta(seconds=3599),
            badge_refreshed_at=start - timedelta(seconds=3599),
        )
    )

    assert result.status == "unavailable"
    assert result.reason == "inventory_snapshot_too_old"


def test_level_up_invalid_catalog_group_is_excluded(
    tmp_path: Path,
) -> None:
    quote_time = datetime.now(UTC)
    configured = settings(
        steamapis_price_cache_path=str(tmp_path / "prices.sqlite3"),
        level_up_currency_code="USD",
        level_up_currency_minor_digits=2,
        level_up_price_basis="buyer_total",
        level_up_steam_fee_bps=500,
        level_up_publisher_fee_bps=1000,
        level_up_min_fee_minor=1,
        level_up_max_quote_age_seconds=900,
        level_up_max_inventory_age_seconds=3600,
    )
    price_cache = SteamApisPriceCache(configured.steamapis_price_cache_path)
    refresh = price_cache.begin_refresh()
    market_hash_names = [
        f"440-Oversized Set Card {index} (Trading Card)" for index in range(16)
    ]
    for market_hash_name in market_hash_names:
        refresh.add(market_hash_name, "1.00", "1.00", quote_time.isoformat(), 1, 1)
    refresh.commit(now=time.time(), optimizer_complete=True)
    now = datetime.now(UTC)
    client = FakeHTTPClient([])
    gateway = SteamGateway(
        configured,
        http_client=client,
        price_cache=price_cache,
    )

    result = run(
        gateway.check_level_up(
            (
                steam_gateway.Holding(
                    market_hash_name=market_hash_names[0],
                    owned_quantity=1,
                    sellable_quantity=1,
                ),
            ),
            {440: ("Oversized Set", None)},
            BadgeState(0, 0, {}),
            inventory_refreshed_at=now,
            badge_refreshed_at=now,
            now=now,
        )
    )

    assert (result.status, result.reason) == (
        "no_opportunity",
        "no_sellable_card",
    )
    assert client.stream_calls == []


def test_level_up_requires_steamapis_key_before_provider_calls() -> None:
    now = datetime(2026, 8, 26, 12, tzinfo=UTC)
    client = FakeHTTPClient([])
    gateway = SteamGateway(
        settings(
            steamapi_key=None,
            steam_web_api_key="profile-only-key",
            level_up_currency_code="USD",
            level_up_currency_minor_digits=2,
            level_up_price_basis="buyer_total",
            level_up_steam_fee_bps=500,
            level_up_publisher_fee_bps=1000,
            level_up_min_fee_minor=1,
        ),
        http_client=client,
    )

    result = run(
        gateway.check_level_up(
            (
                steam_gateway.Holding(
                    market_hash_name="440-Card (Trading Card)",
                    owned_quantity=1,
                    sellable_quantity=1,
                ),
            ),
            {440: ("Source Game", 5)},
            BadgeState(0, 0, {}),
            inventory_refreshed_at=now,
            badge_refreshed_at=now,
            now=now,
        )
    )

    assert result.status == "unavailable"
    assert result.reason == "steamapi_key_missing"
    assert client.get_calls == []
    assert client.stream_calls == []


def test_level_up_uses_supplied_badges_without_redundant_provider_calls(
    tmp_path: Path,
) -> None:
    quote_time = datetime.now(UTC)
    configured = settings(
        steamapis_price_cache_path=str(tmp_path / "prices.sqlite3"),
        level_up_currency_code="USD",
        level_up_currency_minor_digits=2,
        level_up_price_basis="buyer_total",
        level_up_steam_fee_bps=500,
        level_up_publisher_fee_bps=1000,
        level_up_min_fee_minor=1,
        level_up_max_quote_age_seconds=900,
        level_up_max_inventory_age_seconds=3600,
    )
    price_cache = SteamApisPriceCache(configured.steamapis_price_cache_path)
    refresh = price_cache.begin_refresh()
    source_hashes = [f"440-Source Card {index} (Trading Card)" for index in range(1, 6)]
    for market_hash_name in source_hashes:
        refresh.add(market_hash_name, "1.00", "1.00", quote_time.isoformat(), 1, 1)
    refresh.commit(now=time.time(), optimizer_complete=True)
    client = FakeHTTPClient([])
    providers = ExplodingLevelUpProviders()
    gateway = SteamGateway(
        configured,
        http_client=client,
        price_cache=price_cache,
        booster_pricing=providers,  # type: ignore[arg-type]
    )
    now = datetime.now(UTC)

    result = run(
        gateway.check_level_up(
            tuple(
                steam_gateway.Holding(
                    market_hash_name=market_hash_name,
                    owned_quantity=1,
                    sellable_quantity=1,
                )
                for market_hash_name in source_hashes
            ),
            {440: ("Source Game", 5)},
            BadgeState(0, 0, {}),
            inventory_refreshed_at=now,
            badge_refreshed_at=now,
            now=now,
        )
    )

    assert (result.status, result.reason) == (
        "no_opportunity",
        "no_positive_xp_swap",
    )
    assert client.get_calls == []
    assert client.stream_calls == []


def test_level_up_real_gateway_returns_flat_ready_plan_without_inventory_fetch(
    tmp_path: Path,
) -> None:
    quote_time = datetime.now(UTC)
    configured = settings(
        steamapis_price_cache_path=str(tmp_path / "prices.sqlite3"),
        level_up_currency_code="USD",
        level_up_currency_minor_digits=2,
        level_up_price_basis="buyer_total",
        level_up_steam_fee_bps=500,
        level_up_publisher_fee_bps=1000,
        level_up_min_fee_minor=1,
        level_up_max_quote_age_seconds=900,
        level_up_max_inventory_age_seconds=3600,
    )
    price_cache = SteamApisPriceCache(configured.steamapis_price_cache_path)
    refresh = price_cache.begin_refresh()
    source_hashes = [f"440-Source Card {index} (Trading Card)" for index in range(1, 6)]
    unqualified_source_hashes = [
        f"50-Unqualified Source {index} (Trading Card)" for index in range(1, 6)
    ]
    destination_hashes = {
        app_id: [
            f"{app_id}-Destination {app_id} Card {index} (Trading Card)"
            for index in range(1, 6)
        ]
        for app_id in (10, 20)
    }
    unqualified_destination_hashes = [
        f"40-Unqualified Destination {index} (Trading Card)" for index in range(1, 6)
    ]
    unaffordable_hashes = [
        f"30-Unaffordable Card {index} (Trading Card)" for index in range(1, 6)
    ]
    for market_hash_name in source_hashes:
        refresh.add(market_hash_name, "10.00", "1.00", quote_time.isoformat(), 1, 1)
    for market_hash_name in unqualified_source_hashes:
        refresh.add(
            market_hash_name,
            "200.00",
            "200.00",
            quote_time.isoformat(),
            1,
            1,
        )
    for hashes in destination_hashes.values():
        for market_hash_name in hashes:
            refresh.add(market_hash_name, "0.25", "0.25", quote_time.isoformat(), 1, 1)
    for market_hash_name in unqualified_destination_hashes:
        refresh.add(
            market_hash_name,
            "0.25",
            "0.25",
            quote_time.isoformat(),
            1,
            None,
        )
    for market_hash_name in unaffordable_hashes:
        refresh.add(
            market_hash_name,
            "0.01",
            "99.00",
            quote_time.isoformat(),
            1,
            None,
        )
    refresh.commit(now=time.time(), optimizer_complete=True)
    now = datetime.now(UTC)

    client = FakeHTTPClient([])
    providers = ExplodingLevelUpProviders()
    gateway = SteamGateway(
        configured,
        http_client=client,
        price_cache=price_cache,
        booster_pricing=providers,  # type: ignore[arg-type]
    )
    game_metadata = {
        10: ("Destination Ten", 5),
        20: ("Destination Twenty", 5),
        30: ("Unaffordable", 5),
        40: ("Unqualified Destination", 6),
        440: ("Source Game", 5),
        50: ("Unqualified Source", 6),
    }
    holdings = tuple(
        steam_gateway.Holding(
            market_hash_name=market_hash_name,
            owned_quantity=1,
            sellable_quantity=1,
        )
        for market_hash_name in source_hashes + unqualified_source_hashes
    )

    result = run(
        gateway.check_level_up(
            holdings,
            game_metadata,
            BadgeState(0, 0, {}),
            inventory_refreshed_at=now,
            badge_refreshed_at=now,
            now=now,
        )
    )
    payload = result.to_dict()
    source_payload = cast("dict[str, object]", payload["source"])
    destination_payloads = cast(
        "list[dict[str, object]]",
        payload["destinations"],
    )

    assert result.status == "ready", (result.status, result.reason)
    assert source_payload["app_id"] == "440"
    assert len(cast("list[dict[str, object]]", source_payload["rows"])) == 1
    assert [value["app_id"] for value in destination_payloads] == ["440", "10", "20"]
    assert [
        len(cast("list[dict[str, object]]", value["rows"]))
        for value in destination_payloads
    ] == [1, 5, 5]
    assert set(source_payload) == {
        "app_id",
        "game_name",
        "badge_level",
        "set_size",
        "rows",
    }
    assert client.get_calls == []
    assert client.stream_calls == []


def test_level_up_gateway_uses_one_sellable_card_and_partial_destination(
    tmp_path: Path,
) -> None:
    quote_time = datetime.now(UTC)
    configured = settings(
        steamapis_price_cache_path=str(tmp_path / "prices.sqlite3"),
        level_up_currency_code="USD",
        level_up_currency_minor_digits=2,
        level_up_price_basis="buyer_total",
        level_up_steam_fee_bps=500,
        level_up_publisher_fee_bps=1000,
        level_up_min_fee_minor=1,
        level_up_max_quote_age_seconds=900,
        level_up_max_inventory_age_seconds=3600,
    )
    price_cache = SteamApisPriceCache(configured.steamapis_price_cache_path)
    refresh = price_cache.begin_refresh()
    source_hashes = [f"440-Source Card {index} (Trading Card)" for index in range(1, 6)]
    destination_hashes = [
        f"20-Destination Card {index} (Trading Card)" for index in range(1, 6)
    ]
    for index, market_hash_name in enumerate(source_hashes, start=1):
        refresh.add(
            market_hash_name,
            "3.00" if index == 1 else None,
            "99.00",
            quote_time.isoformat(),
            1 if index == 1 else None,
            1,
        )
    for index, market_hash_name in enumerate(destination_hashes, start=1):
        refresh.add(
            market_hash_name,
            None,
            None if index <= 2 else "0.50",
            quote_time.isoformat(),
            None,
            None if index <= 2 else 1,
        )
    refresh.commit(now=quote_time.timestamp(), optimizer_complete=True)
    client = FakeHTTPClient([])
    gateway = SteamGateway(
        configured,
        http_client=client,
        price_cache=price_cache,
        booster_pricing=ExplodingLevelUpProviders(),  # type: ignore[arg-type]
    )
    holdings = (
        steam_gateway.Holding(
            market_hash_name=source_hashes[0],
            owned_quantity=1,
            sellable_quantity=1,
        ),
        *(
            steam_gateway.Holding(
                market_hash_name=market_hash_name,
                owned_quantity=1,
                sellable_quantity=0,
            )
            for market_hash_name in destination_hashes[:2]
        ),
    )

    result = run(
        gateway.check_level_up(
            holdings,
            {440: ("Source Game", 5), 20: ("Destination Game", 5)},
            BadgeState(0, 0, {440: 5}),
            inventory_refreshed_at=quote_time,
            badge_refreshed_at=quote_time,
            now=quote_time,
        )
    )

    assert result.status == "ready", (result.status, result.reason)
    assert result.source is not None
    assert result.source.badge_level == 5
    assert result.source.app_id == 440
    assert len(result.source.rows) == 1
    assert result.source.rows[0].market_hash_name == source_hashes[0]
    assert result.destinations == (result.destinations[0],)
    destination = result.destinations[0]
    assert destination.app_id == 20
    assert destination.set_size == 5
    assert destination.owned_card_count == 2
    assert destination.missing_cards_total == 150
    assert client.get_calls == []
    assert client.stream_calls == []


@pytest.mark.parametrize(
    ("refresh_state", "expected_reason"),
    [
        ("refreshing", "price_generation_refreshing"),
        ("unavailable", "price_generation_unavailable"),
    ],
)
@pytest.mark.parametrize("quote_age_seconds", [600, 1200])
def test_level_up_reports_catalog_refresh_state_without_awaiting_it(
    quote_age_seconds: int,
    refresh_state: str,
    expected_reason: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class StrictPriceAgeSpy:
        def __init__(self) -> None:
            self.scheduled_ages: list[int] = []

        def schedule_price_catalog_refresh(self, *, max_age_seconds: int) -> str:
            self.scheduled_ages.append(max_age_seconds)
            return refresh_state

        def read_price_catalog(
            self,
            *,
            max_rows: int,
            app_ids: Iterable[int] | None = None,
        ) -> steam_gateway.NormalCardCatalogRead:
            del max_rows, app_ids
            return steam_gateway.NormalCardCatalogRead(0, None, {})

    configured = settings(
        level_up_currency_code="USD",
        level_up_currency_minor_digits=2,
        level_up_price_basis="buyer_total",
        level_up_steam_fee_bps=500,
        level_up_publisher_fee_bps=1000,
        level_up_min_fee_minor=1,
        level_up_max_quote_age_seconds=quote_age_seconds,
        level_up_max_inventory_age_seconds=3600,
    )
    gateway = SteamGateway(configured, http_client=FakeHTTPClient([]))
    strict_cache = StrictPriceAgeSpy()
    monkeypatch.setattr(gateway, "steamapis", strict_cache)
    now = datetime.now(UTC)

    result = run(
        gateway.check_level_up(
            (
                steam_gateway.Holding(
                    market_hash_name="440-Test Card (Trading Card)",
                    owned_quantity=1,
                    sellable_quantity=1,
                ),
            ),
            {440: ("Test Game", 5)},
            BadgeState(0, 0, {}),
            inventory_refreshed_at=now,
            badge_refreshed_at=now,
            now=now,
        )
    )

    assert result.status == "unavailable"
    assert result.reason == expected_reason
    assert strict_cache.scheduled_ages == [quote_age_seconds]


def test_duplicate_feed_hash_aborts_generation_without_cross_row_merge(
    tmp_path: Path,
) -> None:
    cache = SteamApisPriceCache(tmp_path / "prices.sqlite3")
    original = cache.begin_refresh()
    original.add(
        "440-Card (Trading Card)",
        "0.10",
        None,
        "2026-08-26T12:00:00Z",
        1,
        None,
    )
    original.commit(now=time.time())
    before = cache.read(["440-Card (Trading Card)"])

    replacement = cache.begin_refresh()
    replacement.add(
        "440-Card (Trading Card)",
        None,
        "0.20",
        "2026-08-26T12:01:00Z",
        None,
        2,
    )
    with pytest.raises(ValueError, match="Duplicate market hash"):
        replacement.add(
            "440-Card (Trading Card)",
            "0.15",
            None,
            "2026-08-26T12:02:00Z",
            3,
            None,
        )
    replacement.abort()

    after = cache.read(["440-Card (Trading Card)"])
    assert after.generation == before.generation
    assert after.prices == before.prices


def test_price_cache_keeps_committed_catalog_readable_during_large_refresh(
    tmp_path: Path,
) -> None:
    cache = SteamApisPriceCache(tmp_path / "prices.sqlite3")
    name = "440-Card (Trading Card)"
    original = cache.begin_refresh()
    original.add(name, "0.10", "0.20", None)
    original.commit(optimizer_complete=True)
    before = cache.read_catalog(app_ids=[440])

    replacement = cache.begin_refresh()
    try:
        replacement.add(name, "0.11", "0.21", None)
        # Exceed SQLite's default page cache while the streamed transaction is open.
        for index in range(50_000):
            replacement.add(f"Unrelated item {index}", "0.10", "0.20", None)
        during = cache.read_catalog(app_ids=[440])
        assert during.groups == before.groups
        assert during.generation == before.generation
        replacement.commit(optimizer_complete=True)
    finally:
        replacement.abort()

    after = cache.read_catalog(app_ids=[440])
    assert after.generation == before.generation + 1
    assert after.groups[440][0].lowest_sell == "0.21"
