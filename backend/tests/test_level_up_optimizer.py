from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

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
from app.market_fees import MarketFeeContract

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
        scaled = Decimal(value) * (10**digits)
    except (
        ArithmeticError,
        TypeError,
        ValueError,
    ):  # The optimizer owns strict handling.
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


def catalog(*sets: CatalogSet, complete: bool = True) -> ResolvedCatalog:
    return ResolvedCatalog(
        generation=1,
        generated_at=NOW,
        sets=sets,
        complete=complete,
        pending_app_ids=() if complete else (999,),
    )


def holdings_for(*sets: CatalogSet, sellable: bool = True) -> tuple[Holding, ...]:
    return tuple(
        Holding(card.market_hash_name, 1, 1 if sellable else 0)
        for current_set in sets
        for card in current_set.cards
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
) -> LevelUpOptimizationResponse:
    return optimize_level_up(
        current_catalog,
        current_holdings,
        current_badges or badges(),
        inventory_refreshed_at,
        now,
        fee_contract(),
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


def test_source_requires_complete_sellable_owned_set_and_bid_depth() -> None:
    source = game(440, buy_quantity=None)
    result = run_optimizer(catalog(source), holdings_for(source))
    assert result.status == "no_opportunity"
    assert result.reason == "no_complete_sellable_set"

    unmarketable = game(441)
    result = run_optimizer(
        catalog(unmarketable), holdings_for(unmarketable, sellable=False)
    )
    assert result.status == "no_opportunity"
    assert result.reason == "no_complete_sellable_set"


def test_destination_eligibility_excludes_owned_level_five_source_and_missing_ask() -> (
    None
):
    source = game(440, buy="2.00")
    owned_destination = game(441)
    level_five_destination = game(442)
    no_ask_destination = game(443, sell=None)
    result = run_optimizer(
        catalog(source, owned_destination, level_five_destination, no_ask_destination),
        holdings_for(source, owned_destination),
        badges((442, 5)),
    )
    assert result.status == "no_opportunity"
    assert result.reason == "no_positive_xp_swap"


def test_exact_budget_and_cheapest_first_maximize_destination_count() -> None:
    source = game(440, buy="0.50")
    expensive = game(441, sell="2.00")
    cheap_one = game(442, sell="0.25")
    cheap_two = game(443, sell="0.25")
    result = run_optimizer(
        catalog(source, expensive, cheap_one, cheap_two), holdings_for(source)
    )
    assert result.status == "ready"
    assert [item.app_id for item in result.destinations] == [442, 443]
    assert result.totals.purchase_total == result.totals.seller_receipt_total
    assert result.totals.unspent_swap_proceeds == 0


def test_at_least_two_destinations_is_required() -> None:
    source = game(440, buy="1.00")
    destination = game(441, sell="0.50")
    result = run_optimizer(catalog(source, destination), holdings_for(source))
    assert result.status == "no_opportunity"
    assert result.reason == "no_positive_xp_swap"


def test_five_destination_cap_has_an_affordable_sixth_proof() -> None:
    source = game(440, buy="2.00")
    destinations = tuple(game(app_id, sell="0.10") for app_id in range(441, 447))
    result = run_optimizer(catalog(source, *destinations), holdings_for(source))
    assert result.status == "ready"
    assert result.totals.destination_count == 5
    assert result.scope_limited is True
    assert result.totals.scope_limited is True


def test_source_and_destination_ties_are_input_order_independent() -> None:
    source_low = game(440, buy="2.00")
    source_high = game(441, buy="2.00")
    destination_a = game(442, sell="0.10")
    destination_b = game(443, sell="0.10")
    first = run_optimizer(
        catalog(source_high, destination_b, source_low, destination_a),
        holdings_for(source_low, source_high),
    )
    second = run_optimizer(
        catalog(destination_a, source_low, destination_b, source_high),
        holdings_for(source_high, source_low),
    )
    assert first.source.app_id == second.source.app_id == 440
    assert [item.app_id for item in first.destinations] == [442, 443]
    assert [item.app_id for item in second.destinations] == [442, 443]


def test_each_row_drives_totals_and_valid_until() -> None:
    source = game(440, buy="2.00")
    first_destination = game(441, sell="0.10")
    second_destination = game(442, sell="0.10")
    result = run_optimizer(
        catalog(source, first_destination, second_destination), holdings_for(source)
    )
    assert result.status == "ready"
    assert result.totals.source_buyer_total == sum(
        row.buyer_total for row in result.source.rows
    )
    assert result.totals.seller_receipt_total == sum(
        row.seller_receipt for row in result.source.rows
    )
    assert result.totals.purchase_total == sum(
        row.buyer_total
        for destination in result.destinations
        for row in destination.rows
    )
    assert result.valid_until == NOW + timedelta(seconds=900)


def test_destination_tie_breakers_use_cost_age_count_then_app_id() -> None:
    source = game(440, buy="2.00")
    older = game(441, sell="0.10", observed_at=NOW - timedelta(seconds=300))
    fresh_low_id = game(442, sell="0.10", observed_at=NOW - timedelta(seconds=100))
    fresh_high_id = game(443, sell="0.10", observed_at=NOW - timedelta(seconds=100))
    result = run_optimizer(
        catalog(source, older, fresh_high_id, fresh_low_id), holdings_for(source)
    )
    assert result.status == "ready"
    assert [item.app_id for item in result.destinations[:3]] == [442, 443, 441]


def test_destination_card_count_breaks_equal_cost_and_age() -> None:
    source = game(440, buy="2.00")
    six_card = game(441, sell="0.00", count=6)
    five_card_low_id = game(442, sell="0.00")
    five_card_high_id = game(443, sell="0.00")
    result = run_optimizer(
        catalog(source, five_card_high_id, six_card, five_card_low_id),
        holdings_for(source),
    )
    assert result.status == "ready"
    assert [item.app_id for item in result.destinations[:3]] == [442, 443, 441]


def test_source_ranking_prefers_xp_then_unspent_then_freshness_actions_and_app_id() -> (
    None
):
    source_low = game(440, buy="2.00", observed_at=NOW - timedelta(seconds=300))
    source_high = game(441, buy="2.00", observed_at=NOW - timedelta(seconds=100))
    destination_a = game(442, sell="0.10")
    destination_b = game(443, sell="0.10")
    result = run_optimizer(
        catalog(source_low, source_high, destination_a, destination_b),
        holdings_for(source_low, source_high),
    )
    assert result.status == "ready"
    assert result.source.app_id == 441


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
            holdings_for(source),
            inventory_refreshed_at=NOW - inventory_age,
        )
    assert error.value.reason == reason


def test_unresolved_catalog_is_warming_not_no_opportunity() -> None:
    unresolved = CatalogSet(440, None, (), set_size=5, resolved=False)
    result = run_optimizer(catalog(unresolved, complete=False), ())
    assert result.status == "warming"
    assert result.reason == "catalog_warming"


def test_stale_side_quote_is_only_that_side_ineligible() -> None:
    source = game(440, buy="2.00", observed_at=NOW - timedelta(seconds=901))
    destination = game(441, sell="0.10", observed_at=NOW)
    result = run_optimizer(catalog(source, destination), holdings_for(source))
    assert result.status == "no_opportunity"
    assert result.reason == "no_complete_sellable_set"


def test_invalid_badge_consistency_fails_closed() -> None:
    with pytest.raises(OptimizerInputError) as error:
        BadgeState(1_250, 10, {})
    assert error.value.reason == "badge_data_unavailable"
