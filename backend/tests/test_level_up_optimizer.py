from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest

import app.level_up_optimizer as optimizer
from app.level_up_optimizer import (
    BadgeState,
    CatalogCard,
    CatalogSet,
    Holding,
    LevelUpOptimizationResponse,
    OptimizerInputError,
    ResolvedCatalog,
    level_for_xp,
    minimum_xp,
    optimize_level_up,
    project_xp,
    xp_to_next_level,
)
from app.market_fees import (
    MarketFeeContract,
)
from app.market_fees import (
    calculate_item_fees as real_calculate_item_fees,
)
from app.market_fees import (
    decimal_to_minor as real_decimal_to_minor,
)
from app.market_fees import (
    seller_receipt_from_buyer_total as real_seller_receipt_from_buyer_total,
)

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence


NOW = datetime(2026, 8, 28, 12, tzinfo=UTC)


def fee_contract() -> MarketFeeContract:
    return MarketFeeContract(
        currency_code="USD",
        minor_digits=2,
        price_basis="buyer_total",
        steam_fee_bps=500,
        publisher_fee_bps=1_000,
        min_fee_minor=1,
        max_quote_age_seconds=900,
        max_inventory_age_seconds=3_600,
    )


@dataclass(frozen=True)
class Breakdown:
    seller_receipt_minor: int
    steam_fee_minor: int
    publisher_fee_minor: int
    buyer_total_minor: int


def _decimal_to_minor(value: object, digits: int) -> int | None:
    try:
        scaled = Decimal(str(value)) * (10**digits)
    except (ArithmeticError, TypeError, ValueError):
        return None
    if scaled != scaled.to_integral_value() or scaled < 0:
        return None
    return int(scaled)


def _receipt(total: int, contract: MarketFeeContract) -> int:
    del contract
    return total


def _fees(receipt: int, contract: MarketFeeContract) -> Breakdown:
    del contract
    return Breakdown(receipt, 0, 0, receipt)


@pytest.fixture(autouse=True)
def deterministic_fee_functions(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep ordinary scenarios small; the fee test restores the real contract."""

    monkeypatch.setattr(optimizer, "_decimal_to_minor", _decimal_to_minor)
    monkeypatch.setattr(optimizer, "_seller_receipt_from_buyer_total", _receipt)
    monkeypatch.setattr(optimizer, "_calculate_item_fees", _fees)


def card(
    app_id: int,
    number: int,
    *,
    buy: str | None = "1.00",
    sell: str | None = "1.00",
    observed_at: datetime = NOW,
    buy_quantity: int | None = 1,
    sell_quantity: int | None = 1,
) -> CatalogCard:
    name = f"Card {number}"
    return CatalogCard(
        market_hash_name=f"{app_id}-{name} (Trading Card)",
        app_id=app_id,
        card_name=name,
        highest_buy=buy,
        lowest_sell=sell,
        highest_buy_quantity=buy_quantity,
        lowest_sell_quantity=sell_quantity,
        observed_at=observed_at,
    )


def game(
    app_id: int,
    *,
    buy: str | None = "1.00",
    sell: str | None = "1.00",
    observed_at: datetime = NOW,
    buy_quantity: int | None = 1,
    sell_quantity: int | None = 1,
    count: int = 5,
) -> CatalogSet:
    return CatalogSet(
        app_id=app_id,
        game_name=f"Game {app_id}",
        cards=tuple(
            card(
                app_id,
                number,
                buy=buy,
                sell=sell,
                observed_at=observed_at,
                buy_quantity=buy_quantity,
                sell_quantity=sell_quantity,
            )
            for number in range(1, count + 1)
        ),
    )


def catalog(*sets: CatalogSet) -> ResolvedCatalog:
    return ResolvedCatalog(
        generation=1,
        generated_at=NOW,
        sets=sets,
    )


def holdings_for(
    *sets: CatalogSet,
    owned_quantity: int = 1,
    sellable_quantity: int | None = None,
) -> tuple[Holding, ...]:
    sellable = owned_quantity if sellable_quantity is None else sellable_quantity
    return tuple(
        Holding(card.market_hash_name, owned_quantity, sellable)
        for current_set in sets
        for card in current_set.cards
    )


def holdings_for_cards(
    *cards: CatalogCard,
    owned_quantity: int = 1,
    sellable_quantity: int | None = None,
) -> tuple[Holding, ...]:
    sellable = owned_quantity if sellable_quantity is None else sellable_quantity
    return tuple(
        Holding(card.market_hash_name, owned_quantity, sellable) for card in cards
    )


def badges(*levels: tuple[int, int], xp: int = 0) -> BadgeState:
    return BadgeState(xp, level_for_xp(xp), dict(levels))


def run_optimizer(
    current_catalog: ResolvedCatalog,
    current_holdings: tuple[Holding, ...],
    current_badges: BadgeState | None = None,
    *,
    inventory_refreshed_at: datetime = NOW,
    now: datetime = NOW,
    contract: MarketFeeContract | None = None,
) -> LevelUpOptimizationResponse:
    return optimize_level_up(
        current_catalog,
        current_holdings,
        current_badges or badges(),
        inventory_refreshed_at,
        now,
        contract or fee_contract(),
    )


@pytest.mark.parametrize(
    ("level", "threshold"),
    [(0, 0), (9, 900), (10, 1_000), (19, 2_800), (20, 3_000), (120, 78_000)],
)
def test_minimum_xp_thresholds(level: int, threshold: int) -> None:
    assert minimum_xp(level) == threshold
    assert level_for_xp(threshold) == level
    if level:
        assert level_for_xp(threshold - 1) == level - 1


def test_projection_reports_xp_level_and_next_threshold() -> None:
    projection = project_xp(1_250, 200)
    assert projection.xp == 1_450
    assert projection.level == 12
    assert projection.xp_to_next_level == minimum_xp(13) - 1_450
    assert xp_to_next_level(1_250, 11) == 150


def test_projection_reaching_maximum_level_keeps_next_threshold() -> None:
    current_xp = minimum_xp(optimizer.MAX_PLAYER_LEVEL) - 50
    projection = project_xp(current_xp, 100)
    assert projection.level == optimizer.MAX_PLAYER_LEVEL
    assert projection.xp_to_next_level == (
        optimizer._minimum_xp_threshold(optimizer.MAX_PLAYER_LEVEL + 1) - projection.xp
    )


@pytest.mark.parametrize(
    "value",
    [
        "440-Foil (Trading Card)",
        "440-Booster Pack",
        "440-Card",
        "0-Card (Trading Card)",
        "440- (Trading Card)",
    ],
)
def test_strict_normal_card_hash_rejects_non_cards(value: str) -> None:
    with pytest.raises(OptimizerInputError):
        CatalogCard(value, 440, "Card")


def test_canonical_hash_parser_does_not_decode_input() -> None:
    value = CatalogCard("440-Card%20One (Trading Card)", 440, "Card%20One")
    assert value.market_hash_name == "440-Card%20One (Trading Card)"


def test_malformed_or_incomplete_sets_fail_closed() -> None:
    with pytest.raises(OptimizerInputError):
        CatalogSet(440, "Game", tuple(card(440, n) for n in range(1, 5)))
    with pytest.raises(OptimizerInputError):
        CatalogSet(
            440, "Game", (*tuple(card(440, n) for n in range(1, 6)), card(441, 6))
        )


def test_one_sellable_card_is_an_independent_source_action() -> None:
    source = game(440, buy="2.00")
    destination = game(441, sell="0.10")
    result = run_optimizer(
        catalog(source, destination),
        holdings_for_cards(source.cards[0], owned_quantity=3, sellable_quantity=2),
    )

    assert result.status == "ready"
    assert result.source is not None
    assert len(result.source.rows) == 1
    row = result.source.rows[0]
    assert row.market_hash_name == source.cards[0].market_hash_name
    assert row.quantity == 1
    assert row.top_bid_quantity == 1
    assert result.source.set_size == 5
    assert result.totals is not None
    assert result.totals.source_buyer_total == 200
    assert result.totals.seller_receipt_total == 200


def test_non_sellable_or_unquoted_card_is_no_sellable_card() -> None:
    unmarketable = game(440)
    result = run_optimizer(
        catalog(unmarketable),
        holdings_for_cards(unmarketable.cards[0], sellable_quantity=0),
    )
    assert result.status == "no_opportunity"
    assert result.reason == "no_sellable_card"

    no_bid = game(441, buy_quantity=None)
    result = run_optimizer(catalog(no_bid), holdings_for_cards(no_bid.cards[0]))
    assert result.status == "no_opportunity"
    assert result.reason == "no_sellable_card"


def test_real_fee_contract_inverts_each_source_card_and_budgets_on_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(optimizer, "_decimal_to_minor", real_decimal_to_minor)
    monkeypatch.setattr(
        optimizer,
        "_seller_receipt_from_buyer_total",
        real_seller_receipt_from_buyer_total,
    )
    monkeypatch.setattr(optimizer, "_calculate_item_fees", real_calculate_item_fees)

    source = game(440, buy="0.15")
    destination = game(441, sell="0.02")
    result = run_optimizer(
        catalog(source, destination),
        holdings_for_cards(source.cards[0]),
        contract=fee_contract(),
    )

    assert result.status == "ready"
    assert result.source is not None
    assert result.totals is not None
    source_row = result.source.rows[0]
    assert (source_row.buyer_total, source_row.seller_receipt) == (15, 13)
    assert (source_row.steam_fee, source_row.publisher_fee) == (1, 1)
    assert (
        source_row.seller_receipt + source_row.steam_fee + source_row.publisher_fee
        == source_row.buyer_total
    )
    assert result.totals.seller_receipt_total == 13
    assert result.totals.purchase_total == 10
    assert result.totals.unspent_swap_proceeds == 3
    assert result.destinations[0].missing_cards_total == 10


def test_high_value_fee_threshold_compares_net_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(optimizer, "_decimal_to_minor", real_decimal_to_minor)
    monkeypatch.setattr(
        optimizer,
        "_seller_receipt_from_buyer_total",
        real_seller_receipt_from_buyer_total,
    )
    monkeypatch.setattr(optimizer, "_calculate_item_fees", real_calculate_item_fees)
    source = game(440, buy="0.15")
    destination = game(441, sell="0.14")
    holdings = holdings_for_cards(source.cards[0]) + holdings_for_cards(
        *destination.cards[:4],
        sellable_quantity=0,
    )

    rejected = run_optimizer(catalog(source, destination), holdings)
    assert rejected.status == "no_opportunity"
    assert rejected.reason == "no_positive_xp_swap"

    accepted_source = game(442, buy="0.16")
    accepted = run_optimizer(
        catalog(accepted_source, destination),
        holdings_for_cards(accepted_source.cards[0])
        + holdings_for_cards(
            *destination.cards[:4],
            sellable_quantity=0,
        ),
    )
    assert accepted.status == "ready"
    assert accepted.destinations[0].app_id == 441
    assert accepted.totals is not None
    assert accepted.totals.seller_receipt_total == 14

    expensive_destination = game(445, sell="0.20")
    boundary_source = game(446, buy="0.23")
    boundary = run_optimizer(
        catalog(boundary_source, expensive_destination),
        holdings_for_cards(boundary_source.cards[0])
        + holdings_for_cards(
            *expensive_destination.cards[:4],
            sellable_quantity=0,
        ),
    )
    assert boundary.status == "ready"
    assert boundary.totals is not None
    assert boundary.totals.seller_receipt_total == 20
    assert boundary.totals.purchase_total == 20

    skipped_source = game(447, buy="0.22")
    skipped = run_optimizer(
        catalog(skipped_source, expensive_destination),
        holdings_for_cards(skipped_source.cards[0])
        + holdings_for_cards(
            *expensive_destination.cards[:4],
            sellable_quantity=0,
        ),
    )
    assert skipped.status == "no_opportunity"
    assert skipped.reason == "no_sellable_card"


def test_partial_destination_buys_only_missing_hashes() -> None:
    source = game(440, buy="2.00")
    destination_cards = tuple(
        card(441, number, sell=None if number <= 3 else "0.10")
        for number in range(1, 6)
    )
    destination = CatalogSet(441, "Game 441", destination_cards)
    result = run_optimizer(
        catalog(source, destination),
        holdings_for_cards(source.cards[0])
        + holdings_for_cards(*destination.cards[:3], sellable_quantity=0),
    )
    assert result.status == "ready"
    target = result.destinations[0]
    assert target.set_size == 5
    assert target.owned_card_count == 3
    assert [row.market_hash_name for row in target.rows] == [
        destination.cards[3].market_hash_name,
        destination.cards[4].market_hash_name,
    ]
    assert all(row.quantity == 1 for row in target.rows)
    assert target.missing_cards_total == 20
    assert result.totals is not None
    assert result.totals.purchase_total == target.missing_cards_total


def test_same_app_destination_uses_effective_post_sale_holdings() -> None:
    source = game(440, buy="2.00", sell="0.10")
    result = run_optimizer(
        catalog(source), holdings_for_cards(source.cards[0]), badges((440, 0))
    )

    assert result.status == "ready"
    assert result.source is not None
    assert result.destinations[0].app_id == result.source.app_id == 440
    assert result.destinations[0].owned_card_count == 0
    assert {row.market_hash_name for row in result.destinations[0].rows} == {
        card.market_hash_name for card in source.cards
    }
    assert source.cards[0].market_hash_name in {
        row.market_hash_name for row in result.destinations[0].rows
    }


def test_same_app_sole_copy_can_create_latent_fully_owned_destination() -> None:
    source = game(440, buy="10.00", sell="0.10")
    external = game(441, sell="0.10")
    result = run_optimizer(
        catalog(source, external),
        holdings_for(source),
        badges((440, 0)),
    )

    assert result.status == "ready"
    assert [destination.app_id for destination in result.destinations] == [440, 441]
    same_app = result.destinations[0]
    assert same_app.owned_card_count == 4
    assert source.cards[0].market_hash_name in {
        row.market_hash_name for row in same_app.rows
    }


def test_extra_source_copy_remains_owned_after_sale() -> None:
    source = game(440, buy="2.00", sell="0.10")
    result = run_optimizer(
        catalog(source),
        holdings_for_cards(source.cards[0], owned_quantity=2),
        badges((440, 0)),
    )

    assert result.status == "ready"
    target = result.destinations[0]
    assert target.owned_card_count == 1
    assert source.cards[0].market_hash_name not in {
        row.market_hash_name for row in target.rows
    }


def test_selling_an_extra_copy_has_no_direct_craft_opportunity_cost() -> None:
    source = game(440, buy="2.00", sell="10.00")
    destination = game(441, sell="0.10")
    holdings = holdings_for_cards(
        source.cards[0], owned_quantity=2, sellable_quantity=1
    )
    holdings += holdings_for_cards(*source.cards[1:])
    result = run_optimizer(catalog(source, destination), holdings)

    assert result.status == "ready"
    assert result.totals is not None
    assert result.totals.foregone_craft_xp == 0
    assert result.totals.funded_craft_xp == 100


def test_direct_craft_opportunity_cost_rejects_tied_one_badge_route() -> None:
    source = game(440, buy="2.00", sell="10.00")
    destination = game(441, sell="0.10")
    result = run_optimizer(catalog(source, destination), holdings_for(source))

    assert result.status == "no_opportunity"
    assert result.reason == "no_positive_xp_swap"


def test_incomplete_and_maxed_sources_have_zero_foregone_craft_xp() -> None:
    incomplete_source = game(440, buy="2.00")
    destination = game(441, sell="0.10")
    incomplete = run_optimizer(
        catalog(incomplete_source, destination),
        holdings_for_cards(incomplete_source.cards[0]),
    )
    assert incomplete.status == "ready"
    assert incomplete.totals is not None
    assert incomplete.totals.foregone_craft_xp == 0
    assert incomplete.totals.funded_craft_xp == 100

    maxed_source = game(442, buy="2.00")
    maxed = run_optimizer(
        catalog(maxed_source, destination),
        holdings_for_cards(maxed_source.cards[0]),
        badges((442, 5)),
    )
    assert maxed.status == "ready"
    assert maxed.source is not None
    assert maxed.source.badge_level == 5
    assert maxed.totals is not None
    assert maxed.totals.foregone_craft_xp == 0
    assert maxed.totals.funded_craft_xp == 100


def test_destination_options_are_built_once_for_many_sellable_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = game(440, buy="3.00")
    destinations = tuple(game(app_id, sell="0.10") for app_id in range(441, 445))
    calls = 0
    original = optimizer._destination_options

    def counted(
        sets: Sequence[CatalogSet],
        holdings: Mapping[str, Holding],
        badges: BadgeState,
        now: datetime,
        quote_window: int,
        contract: MarketFeeContract,
        sell_quotes: Mapping[str, optimizer._SideQuote | None] | None = None,
    ) -> tuple[optimizer.DestinationPlan, ...]:
        nonlocal calls
        calls += 1
        return original(
            sets,
            holdings,
            badges,
            now,
            quote_window,
            contract,
            sell_quotes,
        )

    monkeypatch.setattr(optimizer, "_destination_options", counted)
    result = run_optimizer(
        catalog(source, *destinations),
        holdings_for_cards(*source.cards, owned_quantity=2),
    )

    assert result.status == "ready"
    assert calls == 1


def test_maxed_destinations_are_excluded_and_level_four_advances_to_five() -> None:
    source = game(440, buy="2.00")
    maxed = game(441, sell="0.01")
    level_four = game(442, sell="0.10")
    result = run_optimizer(
        catalog(source, maxed, level_four),
        holdings_for_cards(source.cards[0]),
        badges((441, 5), (442, 4)),
    )

    assert result.status == "ready"
    assert [destination.app_id for destination in result.destinations] == [442]
    assert result.destinations[0].badge_level_before == 4
    assert result.destinations[0].badge_level_after == 5


def test_exact_budget_is_accepted_and_five_destination_scope_is_deterministic() -> None:
    source = game(440, buy="2.00")
    exact_destinations = tuple(game(app_id, sell="0.10") for app_id in range(441, 445))
    exact = run_optimizer(
        catalog(source, *exact_destinations), holdings_for_cards(source.cards[0])
    )
    assert exact.status == "ready"
    assert exact.totals is not None
    assert exact.totals.purchase_total == 200
    assert exact.totals.unspent_swap_proceeds == 0

    cap_source = game(450, buy="3.00")
    cap_destinations = tuple(game(app_id, sell="0.08") for app_id in range(451, 457))
    capped = run_optimizer(
        catalog(cap_source, *cap_destinations), holdings_for_cards(cap_source.cards[0])
    )
    assert capped.status == "ready"
    assert capped.totals is not None
    assert capped.totals.destination_count == 5
    assert capped.totals.scope_limited is True
    assert capped.scope_limited is True


def test_source_and_destination_ties_are_input_order_independent() -> None:
    source = game(440, buy="2.00")
    destination_a = game(442, sell="0.10")
    destination_b = game(443, sell="0.10")
    held = holdings_for_cards(source.cards[1], source.cards[0])
    first = run_optimizer(catalog(destination_b, source, destination_a), held)
    second = run_optimizer(
        catalog(destination_a, source, destination_b), tuple(reversed(held))
    )

    assert first.to_dict() == second.to_dict()
    assert first.source is not None
    assert first.source.rows[0].market_hash_name == source.cards[0].market_hash_name
    assert [item.app_id for item in first.destinations] == [442, 443]


def test_destination_tie_breakers_use_cost_age_missing_count_then_app_id() -> None:
    source = game(440, buy="2.00")
    older = game(441, sell="0.10", observed_at=NOW - timedelta(seconds=300))
    fresh_low_id = game(442, sell="0.10", observed_at=NOW - timedelta(seconds=100))
    fresh_high_id = game(443, sell="0.10", observed_at=NOW - timedelta(seconds=100))
    result = run_optimizer(
        catalog(source, fresh_high_id, older, fresh_low_id),
        holdings_for_cards(source.cards[0]),
    )

    assert result.status == "ready"
    assert [item.app_id for item in result.destinations] == [442, 443, 441]


def test_valid_until_uses_only_selected_source_and_missing_quotes() -> None:
    source = game(440, buy="2.00")
    destination = game(441, sell="0.10", observed_at=NOW - timedelta(seconds=100))
    result = run_optimizer(
        catalog(source, destination), holdings_for_cards(source.cards[0])
    )

    assert result.status == "ready"
    assert result.valid_until == NOW + timedelta(seconds=800)


def test_missing_side_quotes_depth_and_staleness_are_local() -> None:
    source = game(440, buy="2.00")
    no_ask = game(441, sell=None)
    result = run_optimizer(catalog(source, no_ask), holdings_for_cards(source.cards[0]))
    assert result.status == "no_opportunity"
    assert result.reason == "no_positive_xp_swap"

    shallow = game(442, sell="0.10", sell_quantity=0)
    result = run_optimizer(
        catalog(source, shallow), holdings_for_cards(source.cards[0])
    )
    assert result.status == "no_opportunity"
    assert result.reason == "no_positive_xp_swap"

    stale_source = game(443, buy="2.00", observed_at=NOW - timedelta(seconds=901))
    result = run_optimizer(
        catalog(stale_source), holdings_for_cards(stale_source.cards[0])
    )
    assert result.status == "no_opportunity"
    assert result.reason == "no_sellable_card"


def test_serialization_uses_final_singular_and_missing_card_fields() -> None:
    source = game(440, buy="2.00")
    destination = game(441, sell="0.10")
    result = run_optimizer(
        catalog(source, destination), holdings_for_cards(source.cards[0])
    )
    payload = result.to_dict()

    source_payload = payload["source"]
    assert isinstance(source_payload, dict)
    assert isinstance(source_payload["rows"], list)
    assert len(source_payload["rows"]) == 1
    destinations_payload = payload["destinations"]
    assert isinstance(destinations_payload, list)
    destination_payload = destinations_payload[0]
    assert isinstance(destination_payload, dict)
    assert destination_payload["owned_card_count"] == 0
    assert destination_payload["missing_cards_total"] == 50
    assert "set_subtotal" not in destination_payload
    totals_payload = payload["totals"]
    assert isinstance(totals_payload, dict)
    assert "foregone_craft_xp" in totals_payload
    assert "funded_craft_xp" in totals_payload
    assert "direct_craft_xp" not in totals_payload
    assert "swap_path_xp" not in totals_payload
    assert "catalog_total_sets" not in payload
    assert "catalog_resolved_sets" not in payload
    assert "catalog_pending_sets" not in payload


@pytest.mark.parametrize(
    ("catalog_age", "inventory_age", "reason"),
    [
        (timedelta(seconds=901), timedelta(0), "price_generation_stale"),
        (timedelta(0), timedelta(seconds=3_601), "inventory_snapshot_too_old"),
    ],
)
def test_stale_generation_and_inventory_are_input_errors(
    catalog_age: timedelta,
    inventory_age: timedelta,
    reason: str,
) -> None:
    source = game(440)
    stale_catalog = ResolvedCatalog(1, NOW - catalog_age, (source,))
    with pytest.raises(OptimizerInputError) as error:
        run_optimizer(
            stale_catalog,
            holdings_for_cards(source.cards[0]),
            inventory_refreshed_at=NOW - inventory_age,
        )
    assert error.value.reason == reason


def test_empty_catalog_is_no_opportunity() -> None:
    result = run_optimizer(catalog(), ())
    assert result.status == "no_opportunity"
    assert result.reason == "no_sellable_card"


def test_duplicate_holdings_and_invalid_badges_fail_closed() -> None:
    source = game(440)
    duplicate = Holding(source.cards[0].market_hash_name, 1, 1)
    with pytest.raises(OptimizerInputError) as error:
        run_optimizer(catalog(source), (duplicate, duplicate))
    assert error.value.reason == "inventory_invalid"

    with pytest.raises(OptimizerInputError) as error:
        BadgeState(1_250, 10, {})
    assert error.value.reason == "badge_data_unavailable"
