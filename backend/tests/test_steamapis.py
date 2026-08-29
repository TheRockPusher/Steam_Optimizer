from __future__ import annotations

import asyncio
import sqlite3
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

if TYPE_CHECKING:
    from collections.abc import (
        AsyncIterator,
        Awaitable,
        Callable,
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
from app.main import create_app
from app.settings import Settings
from app.steam_gateway import (
    MAX_INVENTORY_ASSETS_PER_PAGE,
    MAX_INVENTORY_CURSOR_LENGTH,
    MAX_INVENTORY_PAGES,
    MAX_PRICE_STREAM_BYTES,
    MAX_RETRY_AFTER_SECONDS,
    PROFILE_ENDPOINT,
    STEAM_ICON_BASE_URL,
    STEAMAPIS_BULK_HOST_SUFFIX,
    STEAMAPIS_INVENTORY_ENDPOINT,
    STEAMAPIS_ITEMS_ENDPOINT,
    InventoryCheck,
    SteamApisClient,
    SteamGateway,
    _observed_at,
    _provider_amount,
)


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: object = None,
        *,
        headers: Mapping[str, str] | None = None,
        chunks: list[bytes] | None = None,
        json_error: BaseException | None = None,
    ) -> None:
        self.status_code = status_code
        self.payload = payload
        self.headers = dict(headers or {})
        self.chunks = chunks or []
        self.json_error = json_error
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
                '{"items":[{"marketHashName":"'
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
            b'{"metadata":{"appId":753},"items":[{"marketHashName":"Plain ',
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
                b'{"metadata":{},"items":[{"marketHashName":"Shared",'
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
                b'{"items":['
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
                b'{"metadata":{},"items":[{"marketHashName":"Encoded%20Name",'
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
        on_price: Callable[[str, steam_gateway.InventoryPrice], None] | None = None,
    ) -> tuple[dict[str, object], set[str]]:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        assert callable(on_price)
        on_price(
            "Name",
            steam_gateway.InventoryPrice(
                highest_buy="0.10",
                lowest_sell="0.20",
                observed_at="2026-08-27T00:00:00Z",
            ),
        )
        return {}, set()

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
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    converted: list[str | None] = []

    original = steam_gateway._price_from_frame

    def spy(
        frame: steam_gateway._PriceFrame,
    ) -> steam_gateway.InventoryPrice:
        converted.append(frame.market_hash_name)
        return original(frame)

    monkeypatch.setattr(steam_gateway, "_price_from_frame", spy)
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
                b'{"items":[{"marketHashName":"Unrequested","orderBook":'
                b'{"highestBuy":1e999997},"updatedAt":1e999997},'
                b'{"marketHashName":"Requested","orderBook":{"highestBuy":"0.10"}}]}',
            ],
        ),
    )
    lookup = run(
        SteamGateway(settings(), http_client=client).steamapis.fetch_prices(
            frozenset({"Requested"})
        )
    )
    assert lookup.status == "complete"
    assert converted == ["Unrequested", "Requested"]


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
    assert client._inventory_inflight == {}


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
        assert client._inventory_inflight == {}
        assert gem_pricing._worker_task is None

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
        on_price: Callable[[str, steam_gateway.InventoryPrice], None] | None = None,
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
