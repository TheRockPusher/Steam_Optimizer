"""Economic boundary tests for the complete-set sale alternative.

Each test defends one genuinely risky boundary of the on-demand opportunity:
exact bid-backed receipts, receipt-only replacement funding that never mixes
the Wallet budget, the free-craft baseline against original holdings,
replacement XP that may lose to the baseline, and every fail-closed source or
bid condition.  The alternative is informational: no test here exercises any
transaction path because the planner has none.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest

from app.badge_planner import (
    BadgePlanningOptions,
    BadgePlanningResponse,
    plan_badges,
)
from app.level_up_optimizer import (
    BadgeState,
    CatalogCard,
    CatalogSet,
    Holding,
    ResolvedCatalog,
    level_for_xp,
)
from app.market_fees import MarketFeeContract

if TYPE_CHECKING:
    from collections.abc import Mapping

NOW = datetime(2026, 9, 1, 12, tzinfo=UTC)

# A buyer total of 16 splits into receipt14 plus minimum fees1 and1:
# 14 + max(floor(14*5%),1) + max(floor(14*10%),1) == 16.
BID_BUYER_TOTAL_MINOR = 16
BID_SELLER_RECEIPT_MINOR = 14


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


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def make_card(
    app_id: int,
    number: int,
    *,
    sell: str | None = "0.10",
    sell_quantity: int | None = 5,
    buy: str | None = "0.16",
    buy_quantity: int | None = 5,
    observed_at: datetime = NOW,
) -> CatalogCard:
    name = f"Card {number}"
    return CatalogCard(
        market_hash_name=f"{app_id}-{name}",
        app_id=app_id,
        card_name=name,
        lowest_sell=sell,
        lowest_sell_quantity=sell_quantity,
        highest_buy=buy,
        highest_buy_quantity=buy_quantity,
        observed_at=observed_at,
    )


def make_set(app_id: int, game_name: str, cards: list[CatalogCard]) -> CatalogSet:
    return CatalogSet(app_id=app_id, game_name=game_name, cards=tuple(cards))


def make_holdings(app_id: int, counts: dict[int, int]) -> list[Holding]:
    return [
        Holding(
            market_hash_name=f"{app_id}-Card {number}",
            owned_quantity=owned,
            sellable_quantity=owned,
        )
        for number, owned in sorted(counts.items())
    ]


def make_badges(*, xp: int = 0, levels: dict[int, int] | None = None) -> BadgeState:
    return BadgeState(
        player_xp=xp,
        player_level=level_for_xp(xp),
        normal_badge_levels=levels or {},
    )


def make_options(**overrides: object) -> BadgePlanningOptions:
    values: dict[str, object] = {"mode": "budget", "budget_minor": 10_000}
    values.update(overrides)
    return BadgePlanningOptions.model_validate(values)


def standard_game(
    app_id: int,
    game_name: str,
    *,
    owned_counts: dict[int, int],
    sell: str = "0.10",
    sell_quantity: int = 5,
    buy: str | None = "0.16",
    buy_quantity: int | None = 5,
    observed_at: datetime = NOW,
) -> tuple[CatalogSet, list[Holding]]:
    cards = [
        make_card(
            app_id,
            number,
            sell=sell,
            sell_quantity=sell_quantity,
            buy=buy,
            buy_quantity=buy_quantity,
            observed_at=observed_at,
        )
        for number in range(1, 6)
    ]
    return make_set(app_id, game_name, cards), make_holdings(app_id, owned_counts)


def run_planner(
    catalog: ResolvedCatalog | None,
    holdings: list[Holding],
    metadata: Mapping[int, tuple[str, int | None]],
    options: BadgePlanningOptions,
    *,
    badges: BadgeState | None = None,
    contract: MarketFeeContract | None = None,
    now: datetime = NOW,
) -> BadgePlanningResponse:
    return plan_badges(
        catalog=catalog,
        holdings=holdings,
        game_metadata=metadata,
        badges=badges or make_badges(),
        inventory_refreshed_at=NOW,
        badge_refreshed_at=NOW,
        now=now,
        fee_contract=contract,
        options=options,
    )


def catalog_with(*sets: CatalogSet) -> ResolvedCatalog:
    return ResolvedCatalog(generation=1, generated_at=NOW, sets=tuple(sets))


def sale_game() -> tuple[CatalogSet, list[Holding]]:
    return standard_game(500, "Sale Game", owned_counts=dict.fromkeys(range(1, 6), 1))


def cheap_game() -> CatalogSet:
    return make_set(
        200,
        "Cheap Game",
        [
            make_card(200, number, sell="0.05", sell_quantity=10, buy=None)
            for number in range(1, 6)
        ],
    )


def test_complete_set_sale_prices_exact_receipts_and_replacement() -> None:
    sale_set, sale_holdings = sale_game()
    catalog = catalog_with(sale_set, cheap_game())
    contract = fee_contract()
    options = make_options(scope="catalog", compare_app_id="500")

    response = run_planner(catalog, sale_holdings, {}, options, contract=contract)

    assert response.status == "ready"
    opportunity = response.opportunity
    assert opportunity is not None
    assert (opportunity.status, opportunity.app_id) == ("ready", "500")
    assert opportunity.reason == "complete_set_sale_alternative"
    assert opportunity.craft_xp == 100
    assert opportunity.net_proceeds_minor == 5 * BID_SELLER_RECEIPT_MINOR
    assert [sale.market_hash_name for sale in opportunity.sales] == [
        f"500-Card {number}" for number in range(1, 6)
    ]
    for sale in opportunity.sales:
        assert sale.quantity == 1
        assert sale.buyer_total_minor == BID_BUYER_TOTAL_MINOR
        assert sale.seller_receipt_minor == BID_SELLER_RECEIPT_MINOR
        assert sale.quote_timestamp == _iso(NOW)
    replacement = opportunity.replacement_plan
    assert replacement is not None
    assert replacement.strategy == "cheapest"
    # The receipts fund exactly two full purchases of the cheap set; the
    # source game is excluded from replacement crafts and purchases.
    assert [step.app_id for step in replacement.steps] == ["200"]
    assert replacement.craft_count == 2
    assert replacement.xp_gain == 200
    assert replacement.spend_minor == 50
    assert replacement.remaining_budget_minor == 5 * BID_SELLER_RECEIPT_MINOR - 50
    baseline = opportunity.baseline_plan
    assert baseline is not None
    # The baseline free-crafts the original source set at zero budget.
    assert [step.app_id for step in baseline.steps] == ["500"]
    assert baseline.craft_count == 1
    assert baseline.xp_gain == 100
    assert baseline.spend_minor == 0
    assert opportunity.additional_xp == replacement.xp_gain - baseline.xp_gain
    assert opportunity.additional_xp == 100
    # Validity covers every used quote: asks set the response ceiling and the
    # alternative must not outlive the bids it sold into.
    assert opportunity.valid_until == _iso(NOW + timedelta(seconds=900))


def test_opportunity_never_mixes_the_wallet_budget() -> None:
    sale_set, sale_holdings = sale_game()
    catalog = catalog_with(sale_set, cheap_game())
    contract = fee_contract()
    options = make_options(scope="catalog", budget_minor=0, compare_app_id="500")

    response = run_planner(catalog, sale_holdings, {}, options, contract=contract)

    # The zero wallet blocks every purchase plan, yet the alternative is
    # still priced: its funding comes solely from hypothetical receipts.
    assert response.plans[0].remaining_budget_minor == 0
    opportunity = response.opportunity
    assert opportunity is not None
    assert opportunity.status == "ready"
    assert opportunity.net_proceeds_minor == 5 * BID_SELLER_RECEIPT_MINOR
    replacement = opportunity.replacement_plan
    assert replacement is not None
    assert replacement.craft_count == 2
    assert replacement.xp_gain == 200
    assert replacement.spend_minor == 50
    assert replacement.remaining_budget_minor == 5 * BID_SELLER_RECEIPT_MINOR - 50
    baseline = opportunity.baseline_plan
    assert baseline is not None
    assert baseline.craft_count == 1
    assert baseline.xp_gain == 100
    assert opportunity.additional_xp == 200 - baseline.xp_gain
    assert opportunity.additional_xp == 100


def test_opportunity_free_craft_baseline_uses_original_holdings() -> None:
    # Two full sets of the only game: selling one set must be compared
    # against the two free crafts the original holdings still allow, so the
    # alternative loses 200 XP and the receipt-funded replacement has no
    # other game to craft.
    pair_set, pair_holdings = standard_game(
        900, "Pair Game", owned_counts=dict.fromkeys(range(1, 6), 2)
    )
    catalog = catalog_with(pair_set)
    contract = fee_contract()
    options = make_options(compare_app_id="900")

    response = run_planner(catalog, pair_holdings, {}, options, contract=contract)

    opportunity = response.opportunity
    assert opportunity is not None
    assert opportunity.status == "ready"
    assert opportunity.net_proceeds_minor == 5 * BID_SELLER_RECEIPT_MINOR
    replacement = opportunity.replacement_plan
    assert replacement is not None
    assert replacement.status == "no_opportunity"
    assert replacement.reason == "no_crafts_available"
    assert replacement.craft_count == 0
    assert replacement.remaining_budget_minor == opportunity.net_proceeds_minor
    baseline = opportunity.baseline_plan
    assert baseline is not None
    assert baseline.craft_count == 2
    assert baseline.xp_gain == 200
    assert baseline.spend_minor == 0
    assert opportunity.additional_xp == 0 - 200
    assert opportunity.additional_xp == -200


def test_opportunity_scope_limits_replacement_and_baseline() -> None:
    sale_set, sale_holdings = sale_game()
    catalog = catalog_with(sale_set, cheap_game())
    contract = fee_contract()
    # Collector mode targets only the cheap game: the untargeted sale source
    # leaves the eligible scope, so the baseline loses its free craft.
    options = make_options(
        mode="collector",
        scope="catalog",
        collector_targets=[{"app_id": "200", "target_level": 1}],
        compare_app_id="500",
    )

    response = run_planner(catalog, sale_holdings, {}, options, contract=contract)

    opportunity = response.opportunity
    assert opportunity is not None
    assert opportunity.status == "ready"
    replacement = opportunity.replacement_plan
    assert replacement is not None
    assert [step.app_id for step in replacement.steps] == ["200"]
    # Budget-mode replacement: receipts may fund crafts past the collector
    # target ceiling, which is exactly why the comparison stays informative.
    assert replacement.craft_count == 2
    assert replacement.xp_gain == 200
    assert replacement.spend_minor == 50
    baseline = opportunity.baseline_plan
    assert baseline is not None
    assert baseline.craft_count == 1
    assert baseline.xp_gain == 100
    assert opportunity.additional_xp == 100


def test_opportunity_validity_covers_bid_expiry() -> None:
    stale_bid_cards = [
        make_card(500, number, observed_at=NOW - timedelta(seconds=600))
        for number in range(1, 6)
    ]
    sale_set = make_set(500, "Sale Game", stale_bid_cards)
    sale_holdings = make_holdings(500, dict.fromkeys(range(1, 6), 1))
    catalog = catalog_with(sale_set, cheap_game())
    contract = fee_contract()
    options = make_options(scope="catalog", compare_app_id="500")

    response = run_planner(catalog, sale_holdings, {}, options, contract=contract)

    opportunity = response.opportunity
    assert opportunity is not None
    assert opportunity.status == "ready"
    # Bids expire 300 seconds before the ask-backed response ceiling, so the
    # alternative deadline must clamp to the bid expiry.
    assert opportunity.valid_until == _iso(NOW + timedelta(seconds=300))


def test_opportunity_fails_closed_on_source_conditions() -> None:
    contract = fee_contract()
    sale_set, sale_holdings = sale_game()
    base_options = make_options(compare_app_id="500")

    def expect_reason(
        reason: str,
        *,
        catalog: ResolvedCatalog,
        holdings: list[Holding],
        metadata: Mapping[int, tuple[str, int | None]] | None = None,
        options: BadgePlanningOptions,
        badges: BadgeState | None = None,
    ) -> None:
        response = run_planner(
            catalog,
            holdings,
            metadata or {},
            options,
            badges=badges,
            contract=contract,
        )
        assert response.status == "ready"
        opportunity = response.opportunity
        assert opportunity is not None
        assert opportunity.status == "unavailable"
        assert opportunity.reason == reason
        assert opportunity.net_proceeds_minor is None
        assert opportunity.sales == []
        assert opportunity.replacement_plan is None
        assert opportunity.baseline_plan is None
        assert opportunity.additional_xp is None
        assert opportunity.valid_until is None
        assert opportunity.craft_xp == 100

    sale_set, sale_holdings = sale_game()
    base_options = make_options(compare_app_id="500")

    # Maxed badges keep the 100-XP comparison truthful by refusing.
    expect_reason(
        "source_badge_maxed",
        catalog=catalog_with(sale_set),
        holdings=sale_holdings,
        options=base_options,
        badges=make_badges(levels={500: 5}),
    )

    # Nothing owned: a catalog-discovered game without holdings cannot sell.
    no_own_set = make_set(
        600, "No Own", [make_card(600, number, buy=None) for number in range(1, 6)]
    )
    expect_reason(
        "source_set_incomplete",
        catalog=catalog_with(sale_set, no_own_set),
        holdings=sale_holdings,
        options=make_options(scope="catalog", compare_app_id="600"),
    )

    # Partial owned composition is never mistaken for a full set.
    _, partial_holdings = standard_game(
        700,
        "Partial Game",
        owned_counts=dict.fromkeys(range(1, 5), 1),
        buy=None,
    )
    expect_reason(
        "source_set_composition_unknown",
        catalog=catalog_with(sale_set),
        holdings=sale_holdings + partial_holdings,
        metadata={700: ("Partial Game", 5)},
        options=make_options(compare_app_id="700"),
    )

    # A never-sell card blocks the sale outright.
    expect_reason(
        "source_set_protected",
        catalog=catalog_with(sale_set),
        holdings=sale_holdings,
        options=make_options(
            compare_app_id="500",
            protections=[
                {
                    "market_hash_name": "500-Card 1",
                    "keep_quantity": 0,
                    "never_sell": True,
                }
            ],
        ),
    )

    # All owned copies of one card reserved: no unreserved set exists.
    expect_reason(
        "source_set_reserved",
        catalog=catalog_with(sale_set),
        holdings=sale_holdings,
        options=make_options(
            compare_app_id="500",
            protections=[
                {
                    "market_hash_name": "500-Card 1",
                    "keep_quantity": 1,
                    "never_sell": False,
                }
            ],
        ),
    )

    # An excluded source game refuses the comparison by intent.
    expect_reason(
        "compare_source_excluded",
        catalog=catalog_with(sale_set),
        holdings=sale_holdings,
        options=make_options(compare_app_id="500", excluded_app_ids=["500"]),
    )

    # An unknown compare AppID is an explicit unavailable, never a guess.
    expect_reason(
        "compare_app_unknown",
        catalog=catalog_with(sale_set),
        holdings=sale_holdings,
        options=make_options(compare_app_id="424242"),
    )


def test_opportunity_bid_health_gates_every_sale() -> None:
    contract = fee_contract()
    sale_set, sale_holdings = sale_game()

    def bid_options(app_id: int) -> BadgePlanningOptions:
        return make_options(compare_app_id=str(app_id))

    # One card without any bid depth blocks the whole alternative; partial
    # sale lists are never emitted.
    one_silent = [
        make_card(600, number, buy="0.16" if number != 1 else None, buy_quantity=5)
        for number in range(1, 6)
    ]
    response = run_planner(
        catalog_with(sale_set, make_set(600, "Silent Bid", one_silent)),
        sale_holdings + make_holdings(600, dict.fromkeys(range(1, 6), 1)),
        {},
        bid_options(600),
        contract=contract,
    )
    opportunity = response.opportunity
    assert opportunity is not None
    assert (opportunity.status, opportunity.reason) == (
        "unavailable",
        "quote_depth_unavailable",
    )
    assert opportunity.sales == []
    assert opportunity.net_proceeds_minor is None

    # A bid that left the freshness window names the stale condition.
    stale_cards = [
        make_card(
            700,
            number,
            observed_at=NOW - timedelta(seconds=901),
        )
        for number in range(1, 6)
    ]
    response = run_planner(
        catalog_with(sale_set, make_set(700, "Stale Bid", stale_cards)),
        sale_holdings + make_holdings(700, dict.fromkeys(range(1, 6), 1)),
        {},
        bid_options(700),
        contract=contract,
    )
    opportunity = response.opportunity
    assert opportunity is not None
    assert (opportunity.status, opportunity.reason) == (
        "unavailable",
        "price_generation_stale",
    )

    # Bid text without depth is invalid data, not a zero price.
    depthless = [
        make_card(800, number, buy="0.16", buy_quantity=None) for number in range(1, 6)
    ]
    response = run_planner(
        catalog_with(sale_set, make_set(800, "Depthless", depthless)),
        sale_holdings + make_holdings(800, dict.fromkeys(range(1, 6), 1)),
        {},
        bid_options(800),
        contract=contract,
    )
    opportunity = response.opportunity
    assert opportunity is not None
    assert (opportunity.status, opportunity.reason) == (
        "unavailable",
        "quote_depth_unavailable",
    )


def test_opportunity_requires_fee_contract_for_receipts() -> None:
    sale_set, sale_holdings = sale_game()
    catalog = catalog_with(sale_set, cheap_game())
    options = make_options(scope="catalog", compare_app_id="500")

    response = run_planner(catalog, sale_holdings, {}, options, contract=None)

    opportunity = response.opportunity
    assert opportunity is not None
    assert (opportunity.status, opportunity.reason) == (
        "unavailable",
        "currency_contract_missing",
    )


def test_no_compare_request_yields_no_opportunity() -> None:
    sale_set, sale_holdings = sale_game()
    catalog = catalog_with(sale_set, cheap_game())
    contract = fee_contract()

    response = run_planner(
        catalog,
        sale_holdings,
        {},
        make_options(scope="catalog"),
        contract=contract,
    )

    assert response.status == "ready"
    assert response.opportunity is None


@pytest.mark.parametrize(
    ("compare_app_id", "expected_status"),
    [("500", "ready"), ("600", "unavailable")],
)
def test_opportunity_matches_requested_app_id(
    compare_app_id: str, expected_status: str
) -> None:
    sale_set, sale_holdings = sale_game()
    catalog = catalog_with(sale_set, cheap_game())
    contract = fee_contract()

    response = run_planner(
        catalog,
        sale_holdings,
        {},
        make_options(scope="catalog", compare_app_id=compare_app_id),
        contract=contract,
    )

    assert response.opportunity is not None
    assert response.opportunity.app_id == compare_app_id
    assert response.opportunity.status == expected_status


def test_comparison_rejects_unmarketable_source_copies() -> None:
    sale_set, holdings = sale_game()
    holdings[0] = Holding(
        market_hash_name=holdings[0].market_hash_name,
        owned_quantity=1,
        sellable_quantity=0,
    )
    result = run_planner(
        catalog_with(sale_set, cheap_game()),
        holdings,
        {},
        make_options(scope="catalog", compare_app_id="500"),
        contract=fee_contract(),
    )
    assert result.opportunity is not None
    assert result.opportunity.status == "unavailable"
    assert result.opportunity.sales == []
    assert result.opportunity.net_proceeds_minor is None


def test_comparison_can_keep_unmarketable_copies_and_sell_marketable_copy() -> None:
    sale_set, _ = sale_game()
    holdings = [
        Holding(
            market_hash_name=f"500-Card {number}",
            owned_quantity=3,
            sellable_quantity=1,
        )
        for number in range(1, 6)
    ]
    result = run_planner(
        catalog_with(sale_set, cheap_game()),
        holdings,
        {},
        make_options(
            mode="collector",
            scope="catalog",
            collector_targets=[{"app_id": "500", "target_level": 1}],
            compare_app_id="500",
            protections=[
                {
                    "market_hash_name": row.market_hash_name,
                    "keep_quantity": 2,
                    "never_sell": False,
                }
                for row in holdings
            ],
        ),
        contract=fee_contract(),
    )
    comparison = result.opportunity
    assert comparison is not None
    assert comparison.status == "ready"
    assert comparison.replacement_plan is not None
    assert [
        (step.app_id, step.craft_count) for step in comparison.replacement_plan.steps
    ] == [("200", 2)]
    assert comparison.baseline_plan is not None
    assert comparison.baseline_plan.xp_gain == 100
