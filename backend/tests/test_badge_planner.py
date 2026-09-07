"""Targeted boundary tests for the badge planning domain.

Each test defends one genuinely risky boundary: repeated crafts under ask
depth, protected copies, the badge level cap and exclusions, cost-optimality
of the ``cheapest`` policy against brute force, zero-spend owned sets when
quotes are unusable, and stale data that must never become actionable.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import product
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
    OptimizerInputError,
    ResolvedCatalog,
    level_for_xp,
)
from app.market_fees import MarketFeeContract

if TYPE_CHECKING:
    from collections.abc import Mapping

NOW = datetime(2026, 9, 1, 12, tzinfo=UTC)


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
    observed_at: datetime = NOW,
) -> CatalogCard:
    name = f"Card {number}"
    return CatalogCard(
        market_hash_name=f"{app_id}-{name}",
        app_id=app_id,
        card_name=name,
        lowest_sell=sell,
        lowest_sell_quantity=sell_quantity,
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


def standard_game(
    app_id: int,
    game_name: str,
    *,
    owned_counts: dict[int, int],
    sell: str = "0.10",
    sell_quantity: int = 5,
    observed_at: datetime = NOW,
) -> tuple[CatalogSet, list[Holding]]:
    cards = [
        make_card(
            app_id,
            number,
            sell=sell,
            sell_quantity=sell_quantity,
            observed_at=observed_at,
        )
        for number in range(1, 6)
    ]
    return make_set(app_id, game_name, cards), make_holdings(app_id, owned_counts)


def make_badges(*, xp: int = 0, levels: dict[int, int] | None = None) -> BadgeState:
    return BadgeState(
        player_xp=xp,
        player_level=level_for_xp(xp),
        normal_badge_levels=levels or {},
    )


def make_options(**overrides: object) -> BadgePlanningOptions:
    values: dict[str, object] = {"mode": "budget", "budget_minor": 10_000}
    values.update(overrides)
    return BadgePlanningOptions(**values)  # type: ignore[arg-type]


def run_planner(
    catalog: ResolvedCatalog | None,
    holdings: list[Holding],
    metadata: Mapping[int, tuple[str, int | None]],
    options: BadgePlanningOptions,
    *,
    badges: BadgeState | None = None,
    contract: MarketFeeContract | None = None,
    inventory_at: datetime = NOW,
    badge_at: datetime = NOW,
    now: datetime = NOW,
    availability_reason: str | None = None,
) -> BadgePlanningResponse:
    return plan_badges(
        catalog=catalog,
        holdings=holdings,
        game_metadata=metadata,
        badges=badges or make_badges(),
        inventory_refreshed_at=inventory_at,
        badge_refreshed_at=badge_at,
        now=now,
        fee_contract=contract,
        options=options,
        availability_reason=availability_reason,
    )


def test_repeated_crafts_respect_cumulative_ask_depth() -> None:
    cards = [make_card(500, number) for number in range(1, 5)]
    cards.append(make_card(500, 5, sell_quantity=2))
    catalog = ResolvedCatalog(
        generation=1,
        generated_at=NOW,
        sets=(make_set(500, "Depth Game", cards),),
    )
    holdings = make_holdings(500, {1: 1, 2: 1, 3: 1, 4: 1, 5: 1})
    options = make_options(mode="target", target_level=8, budget_minor=100_000)

    response = run_planner(catalog, holdings, {}, options, contract=fee_contract())

    assert response.status == "ready"
    game = response.games[0]
    assert game.craftable_count == 1
    assert game.missing_count == 0
    assert game.completion_cost_minor == 0

    cheapest = response.plans[0]
    assert cheapest.strategy == "cheapest"
    assert cheapest.status == "partial"
    assert cheapest.reason == "craft_depth_insufficient"
    assert cheapest.craft_count == 3
    assert cheapest.spend_minor == 100
    assert cheapest.shortfall_xp == 500
    assert cheapest.projected_xp == 300
    assert cheapest.projected_level == 3
    assert cheapest.owned_cards_used == 5
    assert cheapest.purchase_count == 10
    step = cheapest.steps[0]
    assert step.badge_level_before == 0
    assert step.badge_level_after == 3
    purchases = {purchase.market_hash_name: purchase for purchase in step.purchases}
    assert purchases["500-Card 5"].quantity == 2
    assert purchases["500-Card 1"].quantity == 2
    assert all(purchase.unit_price_minor == 10 for purchase in purchases.values())
    # Depth exhaustion is policy-independent: every plan crafts the same three.
    for plan in response.plans:
        assert plan.craft_count == 3
        assert plan.spend_minor == 100
        assert plan.remaining_budget_minor == 100_000 - 100


def test_protections_reserve_copies_enable_replacements_and_validate() -> None:
    catalog_set, holdings = standard_game(
        600,
        "Protected Game",
        owned_counts=dict.fromkeys(range(1, 6), 2),
        sell="0.30",
    )
    catalog = ResolvedCatalog(generation=1, generated_at=NOW, sets=(catalog_set,))
    contract = fee_contract()

    keep_one = make_options(
        budget_minor=5_000,
        protections=[
            {
                "market_hash_name": f"600-Card {number}",
                "keep_quantity": 1,
                "never_sell": False,
            }
            for number in range(1, 6)
        ],
    )
    response = run_planner(catalog, holdings, {}, keep_one, contract=contract)
    game = response.games[0]
    assert game.status == "craftable"
    assert game.craftable_count == 1
    assert all(
        card.keep_quantity == 1 and card.available_quantity == 1 for card in game.cards
    )
    plan = response.plans[0]
    assert plan.status == "ready"
    assert plan.craft_count == 5
    assert plan.owned_cards_used == 5
    assert plan.purchase_count == 20
    assert plan.spend_minor == 600
    assert plan.remaining_budget_minor == 4_400

    keep_all = make_options(
        budget_minor=5_000,
        protections=[
            {
                "market_hash_name": f"600-Card {number}",
                "keep_quantity": 2,
                "never_sell": False,
            }
            for number in range(1, 6)
        ],
    )
    reserved_response = run_planner(catalog, holdings, {}, keep_all, contract=contract)
    reserved_game = reserved_response.games[0]
    assert reserved_game.status == "reserved"
    assert reserved_game.reason == "next_craft_blocked_by_protections"
    assert reserved_game.craftable_count == 0
    replacement_plan = reserved_response.plans[0]
    # Reserved copies are never consumed; replacements are bought instead.
    assert replacement_plan.owned_cards_used == 0
    assert replacement_plan.purchase_count == 25
    assert replacement_plan.spend_minor == 750
    assert all(step.owned_cards_used == 0 for step in replacement_plan.steps)

    never_sell_only = make_options(
        budget_minor=5_000,
        protections=[
            {
                "market_hash_name": "600-Card 1",
                "keep_quantity": 0,
                "never_sell": True,
            }
        ],
    )
    sell_lock_response = run_planner(
        catalog, holdings, {}, never_sell_only, contract=contract
    )
    locked = sell_lock_response.games[0].cards[0]
    assert locked.never_sell is True
    assert locked.keep_quantity == 0
    assert locked.available_quantity == 2
    assert sell_lock_response.games[0].craftable_count == 2

    with pytest.raises(OptimizerInputError) as exceeded:
        run_planner(
            catalog,
            holdings,
            {},
            make_options(
                budget_minor=5_000,
                protections=[
                    {
                        "market_hash_name": "600-Card 1",
                        "keep_quantity": 3,
                        "never_sell": False,
                    }
                ],
            ),
            contract=contract,
        )
    assert exceeded.value.reason == "protection_keep_exceeds_owned"

    with pytest.raises(OptimizerInputError) as unknown:
        run_planner(
            catalog,
            holdings,
            {},
            make_options(
                budget_minor=5_000,
                protections=[
                    {
                        "market_hash_name": "600-Unknown",
                        "keep_quantity": 1,
                        "never_sell": False,
                    }
                ],
            ),
            contract=contract,
        )
    assert unknown.value.reason == "protection_unknown_card"


def test_badge_cap_excluded_and_every_game_visible() -> None:
    mid_set, mid_holdings = standard_game(
        700, "Mid Game", owned_counts=dict.fromkeys(range(1, 6), 2)
    )
    maxed_set, maxed_holdings = standard_game(
        800, "Maxed Game", owned_counts=dict.fromkeys(range(1, 6), 3)
    )
    excluded_set, excluded_holdings = standard_game(
        900,
        "Excluded Game",
        owned_counts=dict.fromkeys(range(1, 6), 1),
        sell="0.05",
        sell_quantity=10,
    )
    catalog = ResolvedCatalog(
        generation=1,
        generated_at=NOW,
        sets=(mid_set, maxed_set, excluded_set),
    )
    holdings = mid_holdings + maxed_holdings + excluded_holdings
    badges = make_badges(levels={700: 4, 800: 5, 900: 0})
    options = make_options(budget_minor=10_000, excluded_app_ids=["900"])

    response = run_planner(
        catalog, holdings, {}, options, badges=badges, contract=fee_contract()
    )

    assert response.status == "ready"
    assert [game.app_id for game in response.games] == ["700", "800", "900"]
    by_id = {game.app_id: game for game in response.games}
    assert by_id["700"].status == "craftable"
    assert by_id["700"].craftable_count == 1
    assert by_id["800"].status == "maxed"
    assert by_id["800"].reason == "badge_level_maxed"
    assert by_id["800"].craftable_count == 0
    assert by_id["900"].status == "excluded"
    assert by_id["900"].reason == "excluded_by_options"
    # Exclusion is intent: the factual capability stays visible but is never
    # planned.
    assert by_id["900"].craftable_count == 1
    for plan in response.plans:
        assert plan.craft_count == 1
        assert [step.app_id for step in plan.steps] == ["700"]
        assert plan.xp_gain == 100
        assert plan.projected_level == 1
    assert response.plans[0].spend_minor == 0


def test_cheapest_target_matches_brute_force_on_small_fixture() -> None:
    alpha_set, alpha_holdings = standard_game(
        100, "Alpha", owned_counts=dict.fromkeys(range(1, 6), 1)
    )
    beta_set = make_set(
        200,
        "Beta",
        [
            make_card(200, number, sell="0.05", sell_quantity=10)
            for number in range(1, 6)
        ],
    )
    gamma_set = make_set(
        300,
        "Gamma",
        [
            make_card(300, number, sell="0.20", sell_quantity=3)
            for number in range(1, 6)
        ],
    )
    delta_set, delta_holdings = standard_game(
        400,
        "Delta",
        owned_counts=dict.fromkeys(range(1, 6), 4),
        sell="0.50",
        sell_quantity=1,
    )
    catalog = ResolvedCatalog(
        generation=1,
        generated_at=NOW,
        sets=(alpha_set, beta_set, gamma_set, delta_set),
    )
    metadata = {200: ("Beta", 5), 300: ("Gamma", 5)}
    holdings = alpha_holdings + delta_holdings
    options = make_options(mode="target", target_level=6, budget_minor=100)

    response = run_planner(
        catalog, holdings, metadata, options, contract=fee_contract()
    )

    assert response.status == "ready"
    assert [game.app_id for game in response.games] == ["100", "200", "300", "400"]
    assert [plan.strategy for plan in response.plans] == [
        "cheapest",
        "fewest_purchases",
        "preserve_cards",
    ]
    cheapest, fewest, preserve = response.plans

    def cumulative(kalpha: int, kbeta: int, kgamma: int, kdelta: int) -> int:
        cost_alpha = 0 if kalpha <= 1 else 50 * (kalpha - 1)
        cost_beta = 25 * kbeta
        cost_gamma = 100 * kgamma
        cost_delta = 0 if kdelta <= 4 else 250
        return cost_alpha + cost_beta + cost_gamma + cost_delta

    best = min(
        (cumulative(ka, kb, kg, kd), (ka, kb, kg, kd))
        for ka, kb, kg, kd in product(range(6), range(6), range(4), range(6))
        if ka + kb + kg + kd >= 6 and cumulative(ka, kb, kg, kd) <= 100
    )
    assert cheapest.status == "ready"
    assert cheapest.reason == "target_reached"
    assert cheapest.target_reached is True
    assert cheapest.shortfall_xp == 0
    assert cheapest.craft_count == 6
    assert cheapest.spend_minor == best[0]
    assert cheapest.spend_minor == 25
    assert cheapest.remaining_budget_minor == 75
    assert cheapest.projected_xp == 600
    assert cheapest.projected_level == 6
    assert {step.app_id: step.craft_count for step in cheapest.steps} == {
        "100": 1,
        "200": 1,
        "400": 4,
    }

    # Owned copies first, then cheapest: same total here, fewer alternatives.
    assert fewest.craft_count == 6
    assert fewest.spend_minor == 25
    assert fewest.purchase_count == 5

    # Preserve spends the whole wallet to keep owned sets intact.
    assert preserve.craft_count == 6
    assert preserve.spend_minor == 100
    assert preserve.remaining_budget_minor == 0
    assert preserve.purchase_count == 20
    assert preserve.owned_cards_used == 10


def test_zero_spend_owned_sets_with_unavailable_quotes() -> None:
    metadata = {1100: ("Prime", 5), 1200: ("Quill", 5)}
    holdings = make_holdings(1100, {1: 2, 2: 2, 3: 2, 4: 2, 5: 2}) + make_holdings(
        1200, {1: 1}
    )
    options = make_options(budget_minor=500)

    response = run_planner(None, holdings, metadata, options)

    assert response.status == "ready"
    assert response.currency_code is None
    assert response.minor_digits is None
    assert response.valid_until == _iso(NOW + timedelta(seconds=3_600))
    by_id = {game.app_id: game for game in response.games}
    assert by_id["1100"].status == "craftable"
    assert by_id["1100"].craftable_count == 2
    assert by_id["1100"].completion_cost_minor == 0
    assert by_id["1200"].status == "incomplete"
    assert by_id["1200"].missing_count == 4
    assert by_id["1200"].completion_cost_minor is None
    for game in response.games:
        for card in game.cards:
            assert card.buy_price_minor is None
            assert card.buy_quantity is None
            assert card.quote_timestamp is None
    for plan in response.plans:
        assert plan.status == "ready"
        assert plan.reason == "xp_maximized"
        assert plan.spend_minor == 0
        assert plan.purchase_count == 0
        assert plan.remaining_budget_minor == 500
    assert response.plans[0].craft_count == 2
    assert [step.app_id for step in response.plans[0].steps] == ["1100"]
    assert response.plans[0].steps[0].purchases == []


def test_stale_data_is_visible_but_never_actionable() -> None:
    stale_quote_cards = [make_card(1300, number) for number in range(1, 5)]
    stale_quote_cards.append(
        make_card(1300, 5, observed_at=NOW - timedelta(seconds=901))
    )
    stale_quote_set = make_set(1300, "Stale Quote Game", stale_quote_cards)
    future_set = make_set(
        1400,
        "Future Quote Game",
        [
            make_card(1400, number, observed_at=NOW + timedelta(seconds=60))
            for number in range(1, 6)
        ],
    )
    catalog = ResolvedCatalog(
        generation=1, generated_at=NOW, sets=(stale_quote_set, future_set)
    )
    holdings = make_holdings(1300, {1: 1, 2: 1, 3: 1, 4: 1})
    metadata = {1400: ("Future Quote Game", 5)}
    contract = fee_contract()
    options = make_options(budget_minor=10_000)

    fresh = run_planner(catalog, holdings, metadata, options, contract=contract)
    # The purchase path cannot be evaluated: every game that needs a purchase
    # for its next craft is blocked by a stale per-item quote, so the response
    # names the quote condition instead of a misleading no_opportunity plan.
    assert fresh.status == "unavailable"
    assert fresh.reason == "price_generation_stale"
    assert fresh.plans == []
    assert fresh.valid_until is None
    by_id = {game.app_id: game for game in fresh.games}
    stale_card = next(
        card for card in by_id["1300"].cards if card.market_hash_name == "1300-Card 5"
    )
    assert stale_card.buy_price_minor is None
    assert stale_card.quote_timestamp is None
    assert by_id["1300"].status == "incomplete"
    assert by_id["1300"].missing_count == 1
    assert by_id["1300"].completion_cost_minor is None
    assert by_id["1400"].status == "incomplete"
    assert all(card.buy_price_minor is None for card in by_id["1400"].cards)
    quoted = [
        card
        for game in fresh.games
        for card in game.cards
        if card.quote_timestamp is not None
    ]
    assert quoted
    assert all(card.quote_timestamp == _iso(NOW) for card in quoted)

    stale_inventory = run_planner(
        catalog,
        holdings,
        metadata,
        options,
        contract=contract,
        inventory_at=NOW - timedelta(seconds=3_601),
    )
    assert stale_inventory.status == "unavailable"
    assert stale_inventory.reason == "inventory_snapshot_stale"
    assert stale_inventory.plans == []
    assert stale_inventory.valid_until is None
    # The dashboard stays visible even when nothing is actionable.
    assert [game.app_id for game in stale_inventory.games] == ["1300", "1400"]

    stale_badges = run_planner(
        catalog,
        holdings,
        metadata,
        options,
        contract=contract,
        badge_at=NOW - timedelta(seconds=3_601),
    )
    assert stale_badges.status == "unavailable"
    assert stale_badges.reason == "badge_snapshot_stale"
    assert stale_badges.plans == []

    future_inventory = run_planner(
        catalog,
        holdings,
        metadata,
        options,
        contract=contract,
        inventory_at=NOW + timedelta(seconds=1),
    )
    assert future_inventory.status == "unavailable"
    assert future_inventory.reason == "inventory_snapshot_in_future"
    assert future_inventory.plans == []


def test_missing_ask_depth_for_purchase_only_games_is_unavailable() -> None:
    cards = [make_card(1500, number, sell=None) for number in range(1, 6)]
    catalog = ResolvedCatalog(
        generation=1,
        generated_at=NOW,
        sets=(make_set(1500, "No Ask Game", cards),),
    )
    holdings = make_holdings(1500, {1: 1, 2: 1, 3: 1, 4: 1})
    response = run_planner(
        catalog, holdings, {}, make_options(), contract=fee_contract()
    )

    # The feed rows exist but carry no usable ask, so the purchase path cannot
    # be evaluated and the response must not claim a factual no_opportunity.
    assert (response.status, response.reason) == (
        "unavailable",
        "quote_depth_unavailable",
    )
    assert response.plans == []
    by_id = {game.app_id: game for game in response.games}
    assert by_id["1500"].missing_count == 1
    assert by_id["1500"].completion_cost_minor is None


def test_budget_blocked_route_with_usable_quotes_stays_factual() -> None:
    cards = [make_card(1600, number) for number in range(1, 6)]
    catalog = ResolvedCatalog(
        generation=1,
        generated_at=NOW,
        sets=(make_set(1600, "Priced Game", cards),),
    )
    holdings = make_holdings(1600, {1: 1, 2: 1, 3: 1, 4: 1})
    contract = fee_contract()

    target = run_planner(
        catalog,
        holdings,
        {},
        make_options(mode="target", target_level=20, budget_minor=0),
        contract=contract,
    )
    assert (target.status, target.reason) == ("ready", "ready")
    assert all(
        plan.status == "no_opportunity" and plan.reason == "budget_insufficient"
        for plan in target.plans
    )

    budget = run_planner(
        catalog,
        holdings,
        {},
        make_options(budget_minor=0),
        contract=contract,
    )
    assert (budget.status, budget.reason) == ("ready", "ready")
    assert all(
        plan.status == "no_opportunity" and plan.reason == "no_crafts_available"
        for plan in budget.plans
    )
