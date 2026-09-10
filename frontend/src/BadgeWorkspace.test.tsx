import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BadgeWorkspace, { type BadgeWorkspaceProps } from "./BadgeWorkspace";
import {
  buildSaleSwapItems,
  isBadgePlanningResponse,
  parseBudgetMinorUnits,
  responseMatchesRequest,
  type BadgeGame,
  type BadgeOpportunity,
  type BadgePlan,
  type BadgePlanningMoney,
  type BadgePlanningRequest,
  type BadgePlanningResponse,
  type BadgePlanningResponseScope,
  type BadgePlanningScope
} from "./badgePlanning";
import type { PlanWorkflowProps } from "./PlanWorkflow";
import type { PlanIntent } from "./planWorkflow";
import { aggregateNormalCardOwnership, levelForXp, minimumXpForLevel } from "./levelUpOptimization";

// BadgeArtwork performs per-app artwork fetches; the workspace is tested with
// a stub that records the props it would receive.
const artworkStubs: Array<{ appId: string; targetLevel: number | null }> = [];
vi.mock("./BadgeArtwork", () => ({
  default: (props: {
    appId: string;
    targetLevel: number | null;
    [key: string]: unknown;
  }) => {
    artworkStubs.push({ appId: props.appId, targetLevel: props.targetLevel });
    return <div data-testid="badge-artwork-stub" />;
  }
}));

// PlanWorkflow is a sibling component with its own storage and rendering; the
// workspace is tested against a stub that records the props it receives.
const workflowStubs: PlanWorkflowProps[] = [];
vi.mock("./PlanWorkflow", () => ({
  default: (props: PlanWorkflowProps) => {
    workflowStubs.push(props);
    return <div data-testid="plan-workflow-stub" />;
  }
}));

// The saved-setup hook touches localStorage; its state is controlled per test
// while the pure restore helpers (currency binding, protection clamping) stay
// real through importOriginal.
const intentHolder: { saved: PlanIntent | null; remember: boolean; error: string | null } = {
  saved: null,
  remember: false,
  error: null
};
const intentCalls = {
  setRemember: vi.fn(),
  save: vi.fn(),
  forget: vi.fn()
};
vi.mock("./planWorkflow", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    usePlanIntent: () => ({
      saved: intentHolder.saved,
      remember: intentHolder.remember,
      error: intentHolder.error,
      setRemember: intentCalls.setRemember,
      save: intentCalls.save,
      forget: intentCalls.forget
    })
  };
});

const NOW = "2026-09-05T12:00:00Z";
const EXPIRES = "2026-09-05T12:15:00Z";
const STEAM_ID = "76561198000000001";
const hashes = Array.from({ length: 5 }, (_, index) => `10-Card ${index} (Trading Card)`);
const catalogHashes = Array.from({ length: 5 }, (_, index) => `20-Extra ${index} (Trading Card)`);
const SCOPE_WIRE: Record<BadgePlanningScope, BadgePlanningResponseScope> = {
  inventory: "inventory_normal_badges",
  selected: "selected_normal_badges",
  catalog: "catalog_normal_badges"
};
const baseRequest: BadgePlanningRequest = {
  inventory_refreshed_at: NOW,
  badge_refreshed_at: NOW,
  player_xp: 1250,
  player_level: 11,
  normal_badge_levels: [{ app_id: 10, level: 0 }],
  games: [{ app_id: "10", game_name: "Orbital Quest", card_set_size: 5, badge_level: 0 }],
  cards: hashes.map((market_hash_name) => ({ market_hash_name, owned_quantity: 2, sellable_quantity: 2 })),
  options: {
    mode: "target",
    target_level: 12,
    budget_minor: 0,
    excluded_app_ids: [],
    protections: [],
    scope: "inventory",
    selected_app_ids: [],
    collector_targets: [],
    compare_app_id: null
  }
};

function quoteFields(currency: string | null) {
  return {
    buy_price_minor: currency === null ? null : 5,
    buy_quantity: currency === null ? null : 10,
    quote_timestamp: currency === null ? null : NOW
  };
}

function buildInventoryGameRow(
  request: BadgePlanningRequest,
  currency: string | null
): BadgeGame {
  const protections = new Map(
    request.options.protections.map((row) => [row.market_hash_name, row])
  );
  const cards = request.cards.map((row, index) => {
    const keep = Math.min(
      protections.get(row.market_hash_name)?.keep_quantity ?? 0,
      row.owned_quantity
    );
    return {
      market_hash_name: row.market_hash_name,
      card_name: `Card ${index}`,
      owned_quantity: row.owned_quantity,
      keep_quantity: keep,
      never_sell: protections.get(row.market_hash_name)?.never_sell ?? false,
      available_quantity: row.owned_quantity - keep,
      ...quoteFields(currency)
    };
  });
  const available = cards.length === 0 ? 0 : Math.min(...cards.map((card) => card.available_quantity));
  const excluded = request.options.excluded_app_ids.includes("10");
  const collectorTarget =
    request.options.collector_targets.find((target) => target.app_id === "10") ?? null;
  return {
    app_id: "10",
    game_name: "Orbital Quest",
    badge_level: 0,
    set_size: cards.length === 0 ? null : 5,
    owned_unique: cards.filter((card) => card.owned_quantity > 0).length,
    owned_cards: cards.reduce((sum, card) => sum + card.owned_quantity, 0),
    available_unique: cards.filter((card) => card.available_quantity > 0).length,
    craftable_count: available,
    missing_count:
      cards.length === 0
        ? null
        : cards.filter((card) => card.available_quantity === 0).length,
    completion_cost_minor:
      available > 0 ? 0 : currency === null ? null : 5,
    status: excluded ? "excluded" : available > 0 ? "craftable" : cards.length === 0 ? "incomplete" : "reserved",
    reason: excluded ? "excluded_by_options" : "set_incomplete",
    target_badge_level: collectorTarget?.target_level ?? null,
    cards
  };
}

function buildDiscoveredGameRow(currency: string | null): BadgeGame {
  const cards = catalogHashes.map((market_hash_name, index) => ({
    market_hash_name,
    card_name: `Extra ${index}`,
    owned_quantity: 0,
    keep_quantity: 0,
    never_sell: false,
    available_quantity: 0,
    ...quoteFields(currency)
  }));
  return {
    app_id: "20",
    game_name: "Discovered Set Game",
    badge_level: 0,
    set_size: 5,
    owned_unique: 0,
    owned_cards: 0,
    available_unique: 0,
    craftable_count: 0,
    missing_count: 5,
    completion_cost_minor: currency === null ? null : 25,
    status: "incomplete",
    reason: "set_incomplete",
    target_badge_level: null,
    cards
  };
}

function buildPlans(
  request: BadgePlanningRequest,
  game: BadgeGame,
  extraGames: readonly BadgeGame[]
): BadgePlan[] {
  const options = request.options;
  const available = game.cards.length === 0
    ? 0
    : Math.min(...game.cards.map((card) => card.available_quantity));
  const excluded = options.excluded_app_ids.includes("10");
  const targetLevel = options.mode === "target" ? options.target_level : null;
  const needed =
    targetLevel === null
      ? available
      : Math.max(0, Math.ceil((minimumXpForLevel(targetLevel) - request.player_xp) / 100));
  const collectorTarget =
    options.collector_targets.find((row) => row.app_id === "10") ?? null;
  const goalNeeded =
    collectorTarget === null ? 0 : Math.max(0, collectorTarget.target_level - game.badge_level);
  const desired =
    options.mode === "target" ? needed : options.mode === "collector" ? goalNeeded : available;
  const crafts = excluded || game.craftable_count === 0 ? 0 : Math.min(available, desired);
  const xp = request.player_xp + crafts * 100;
  const shortfall =
    options.mode === "collector"
      ? Math.max(0, goalNeeded - crafts) * 100
      : targetLevel === null
        ? 0
        : Math.max(0, minimumXpForLevel(targetLevel) - xp);
  const reached =
    options.mode === "collector"
      ? options.collector_targets.length > 0 && shortfall === 0
      : targetLevel !== null && shortfall === 0;
  const plan: BadgePlan = {
    strategy: "cheapest",
    status: crafts === 0 ? "no_opportunity" : shortfall > 0 ? "partial" : "ready",
    reason: crafts === 0 ? "no_crafts_available" : shortfall > 0 ? "craft_depth_insufficient" : "target_reached",
    target_level: targetLevel,
    target_reached: reached,
    craft_count: crafts,
    xp_gain: crafts * 100,
    projected_xp: xp,
    projected_level: levelForXp(xp),
    shortfall_xp: shortfall,
    spend_minor: 0,
    remaining_budget_minor: options.budget_minor,
    purchase_count: 0,
    owned_cards_used: crafts * 5,
    steps:
      crafts === 0
        ? []
        : [
          {
            app_id: "10",
            game_name: "Orbital Quest",
            badge_level_before: game.badge_level,
            badge_level_after: game.badge_level + crafts,
            craft_count: crafts,
            xp_gain: crafts * 100,
            spend_minor: 0,
            owned_cards_used: crafts * 5,
            purchases: []
          }
        ]
  };
  // Extra discovered rows only matter for row counts; plans stay identical.
  void extraGames;
  return [plan, { ...plan, strategy: "fewest_purchases" }, { ...plan, strategy: "preserve_cards" }];
}

function buildReadyOpportunity(
  request: BadgePlanningRequest,
  game: BadgeGame,
  plan: BadgePlan
): BadgeOpportunity {
  const appId = request.options.compare_app_id;
  if (appId === null) {
    throw new Error("opportunity requested without compare_app_id");
  }
  if (appId !== "10") {
    return {
      app_id: appId,
      status: "unavailable",
      reason: "compare_app_unknown",
      net_proceeds_minor: null,
      craft_xp: 100,
      sales: [],
      replacement_plan: null,
      baseline_plan: null,
      additional_xp: null,
      valid_until: null
    };
  }
  // Replacement planning excludes the source game entirely, and no other
  // inventory game can be crafted here, so the receipt-only budget stays
  // unspent instead of returning to the Wallet.
  const proceeds = game.cards.length * 6;
  const replacementPlan: BadgePlan = {
    strategy: "cheapest",
    status: "no_opportunity",
    reason: "no_crafts_available",
    target_level: null,
    target_reached: false,
    craft_count: 0,
    xp_gain: 0,
    projected_xp: request.player_xp,
    projected_level: levelForXp(request.player_xp),
    shortfall_xp: 0,
    spend_minor: 0,
    remaining_budget_minor: proceeds,
    purchase_count: 0,
    owned_cards_used: 0,
    steps: []
  };
  const baselinePlan: BadgePlan = {
    ...plan,
    strategy: "cheapest",
    target_level: null,
    target_reached: false,
    shortfall_xp: 0,
    spend_minor: 0,
    remaining_budget_minor: 0,
    purchase_count: 0
  };
  return {
    app_id: appId,
    status: "ready",
    reason: "complete_set_sale_alternative",
    net_proceeds_minor: proceeds,
    craft_xp: 100,
    sales: game.cards.map((card) => ({
      market_hash_name: card.market_hash_name,
      card_name: card.card_name,
      quantity: 1,
      buyer_total_minor: 8,
      seller_receipt_minor: 6,
      quote_timestamp: NOW
    })),
    replacement_plan: replacementPlan,
    baseline_plan: baselinePlan,
    additional_xp: replacementPlan.xp_gain - baselinePlan.xp_gain,
    valid_until: EXPIRES
  };
}

function responseFor(
  request = baseRequest,
  currency: string | null = "USD"
): BadgePlanningResponse {
  const game = buildInventoryGameRow(request, currency);
  return {
    status: "ready",
    reason: currency === null ? "currency_contract_missing" : "ready",
    generated_at: NOW,
    valid_until: EXPIRES,
    currency_code: currency,
    minor_digits: currency === null ? null : 2,
    inventory_refreshed_at: request.inventory_refreshed_at,
    badge_refreshed_at: request.badge_refreshed_at,
    player_xp: request.player_xp,
    player_level: request.player_level,
    scope: SCOPE_WIRE[request.options.scope],
    evaluated_game_count: 1,
    games: [game],
    opportunity:
      request.options.compare_app_id === null
        ? null
        : buildReadyOpportunity(request, game, buildPlans(request, game, [])[0]),
    plans: buildPlans(request, game, [])
  };
}

function catalogResponseFor(
  request: BadgePlanningRequest,
  currency: string | null = "USD"
): BadgePlanningResponse {
  const games = [buildInventoryGameRow(request, currency), buildDiscoveredGameRow(currency)];
  const plans = buildPlans(request, games[0], [games[1]]);
  return {
    status: "ready",
    reason: currency === null ? "currency_contract_missing" : "ready",
    generated_at: NOW,
    valid_until: EXPIRES,
    currency_code: currency,
    minor_digits: currency === null ? null : 2,
    inventory_refreshed_at: request.inventory_refreshed_at,
    badge_refreshed_at: request.badge_refreshed_at,
    player_xp: request.player_xp,
    player_level: request.player_level,
    scope: "catalog_normal_badges",
    evaluated_game_count: 2,
    games,
    opportunity:
      request.options.compare_app_id === null
        ? null
        : buildReadyOpportunity(request, games[0], plans[0]),
    plans
  };
}

function unavailableOpportunityFor(appId: string, reason: string): BadgeOpportunity {
  return {
    app_id: appId,
    status: "unavailable",
    reason,
    net_proceeds_minor: null,
    craft_xp: 100,
    sales: [],
    replacement_plan: null,
    baseline_plan: null,
    additional_xp: null,
    valid_until: null
  };
}

function intentFixture(overrides: Partial<PlanIntent> = {}): PlanIntent {
  return {
    mode: "target",
    targetLevel: "12",
    budgetText: "0",
    money: null,
    scope: "inventory",
    selectedAppIds: [],
    collectorTargets: [],
    protections: [],
    excludedAppIds: [],
    strategy: "cheapest",
    ...overrides
  };
}

function moneyFixture(currencyCode: string, minorDigits: number): BadgePlanningMoney {
  return { currency_code: currencyCode, minor_digits: minorDigits };
}

function props(overrides: Partial<BadgeWorkspaceProps> = {}): BadgeWorkspaceProps {
  return {
    steamId: STEAM_ID,
    inventoryStatus: "public",
    items: hashes.map((market_hash_name) => ({
      market_hash_name,
      quantity: 2,
      marketable: true,
      tradable: true,
      item_type: "trading_card",
      card_border: "normal",
      game_app_id: "10",
      game_name: "Orbital Quest"
    })),
    boosters: [{ game_app_id: "10", game_name: "Orbital Quest", card_set_size: 5 }],
    badges: {
      status: "public",
      message: "Public",
      player_xp: 1250,
      player_level: 11,
      checked_at: NOW,
      normal_badge_levels: [{ app_id: 10, level: 0 }]
    },
    inventoryRefreshedAt: NOW,
    isInventoryLoading: false,
    isActive: true,
    view: "badges",
    onRefreshInventory: vi.fn(),
    onRefreshBadges: vi.fn(),
    ...overrides
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function deferredFetch() {
  const pending: Array<{ request: BadgePlanningRequest; resolve: (response: Response) => void; init: RequestInit }> = [];
  const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((resolve) => {
    pending.push({ request: JSON.parse(String(init?.body)) as BadgePlanningRequest, resolve, init: init ?? {} });
  }));
  vi.stubGlobal("fetch", fetchMock);
  return pending;
}

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["Date", "setTimeout", "clearTimeout"] });
  intentHolder.saved = null;
  intentHolder.remember = false;
  intentHolder.error = null;
  intentCalls.setRemember.mockClear();
  intentCalls.save.mockClear();
  intentCalls.forget.mockClear();
  workflowStubs.length = 0;
  artworkStubs.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("planning safety boundaries", () => {
  it("retains free crafts without a monetary contract", () => {
    const response = responseFor(baseRequest, null);
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, baseRequest)).toBe(true);
    expect(response.plans[0].xp_gain).toBe(200);
  });

  it("rejects a plan from different budget, exclusions or protected ownership", () => {
    const response = responseFor();
    const excluded = structuredClone(baseRequest);
    excluded.options.excluded_app_ids = ["10"];
    expect(responseMatchesRequest(response, excluded)).toBe(false);
    const protectedRequest = structuredClone(baseRequest);
    protectedRequest.options.protections = [{ market_hash_name: hashes[0], keep_quantity: 1, never_sell: true }];
    expect(responseMatchesRequest(response, protectedRequest)).toBe(false);
    const differentBudget = structuredClone(baseRequest);
    differentBudget.options.budget_minor = 100;
    expect(responseMatchesRequest(response, differentBudget)).toBe(false);
  });

  it("rejects buying the wrong card or more than its quoted depth", () => {
    const response = responseFor();
    const game = response.games[0];
    game.cards[4].owned_quantity = 0;
    game.cards[4].available_quantity = 0;
    game.owned_cards = 8;
    game.owned_unique = game.available_unique = 4;
    game.craftable_count = 0;
    game.missing_count = 1;
    game.completion_cost_minor = 5;
    game.status = "incomplete";
    for (const plan of response.plans) {
      plan.spend_minor = 10;
      plan.purchase_count = 2;
      plan.owned_cards_used = 8;
      plan.steps[0].spend_minor = 10;
      plan.steps[0].owned_cards_used = 8;
      plan.steps[0].purchases = [{ market_hash_name: hashes[4], card_name: "Card 4", quantity: 2, unit_price_minor: 5, total_minor: 10, quote_timestamp: NOW }];
    }
    expect(isBadgePlanningResponse(response)).toBe(true);
    const wrongCard = structuredClone(response);
    wrongCard.plans[0].steps[0].purchases[0].market_hash_name = hashes[0];
    expect(isBadgePlanningResponse(wrongCard)).toBe(false);
    game.cards[4].buy_quantity = 1;
    expect(isBadgePlanningResponse(response)).toBe(false);
  });

  it("subtracts reservations once across split holdings even with never-sell", () => {
    const items = [
      { market_hash_name: hashes[0], quantity: 2, marketable: false, tradable: false, item_type: "trading_card", card_border: "normal", game_app_id: "10", game_name: "Orbital Quest" },
      { market_hash_name: hashes[0], quantity: 3, marketable: true, tradable: true, item_type: "trading_card", card_border: "normal", game_app_id: "10", game_name: "Orbital Quest" },
      { market_hash_name: hashes[1], quantity: 1, marketable: true, tradable: true, item_type: "trading_card", card_border: "normal", game_app_id: "10", game_name: "Orbital Quest" }
    ];
    const reduced = buildSaleSwapItems(items, new Map([[hashes[0], { market_hash_name: hashes[0], keep_quantity: 3, never_sell: true }]]), new Set());
    expect(aggregateNormalCardOwnership(reduced)).toEqual([
      { market_hash_name: hashes[0], owned_quantity: 2, sellable_quantity: 0 },
      { market_hash_name: hashes[1], owned_quantity: 1, sellable_quantity: 1 }
    ]);
    expect(buildSaleSwapItems(items, new Map(), new Set(["10"]))).toEqual([]);
  });

  it("parses exact minor units and rejects rounded, exponential and oversized budgets", () => {
    expect(parseBudgetMinorUnits("0.29", 2)).toEqual({ ok: true, minor: 29 });
    expect(parseBudgetMinorUnits("12", 0)).toEqual({ ok: true, minor: 12 });
    for (const text of ["0.001", "1e2", "-1", "10000000.01"]) {
      expect(parseBudgetMinorUnits(text, 2).ok).toBe(false);
    }
  });
});

describe("BadgeWorkspace", () => {
  it("keeps drafts across views and disables stale plan actions until Apply", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    expect(screen.getAllByRole("link", { name: /badge page/i })).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Wallet budget"), { target: { value: "5.00" } });
    expect(screen.queryByRole("link", { name: /badge page/i })).toBeNull();
    expect(pending).toHaveLength(1);
    rerender(<BadgeWorkspace {...input} view="badges" />);
    rerender(<BadgeWorkspace {...input} />);
    expect(screen.getByLabelText("Wallet budget")).toHaveValue("5.00");
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    expect(pending[1].request.options.budget_minor).toBe(500);
    pending[1].resolve(json(responseFor(pending[1].request)));
    await flush();
    expect(screen.getAllByRole("link", { name: /badge page/i })).toHaveLength(3);
  });

  it("does not revive an old budget after a currency change", async () => {
    const pending = deferredFetch();
    render(<BadgeWorkspace {...props({ view: "plan" })} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    fireEvent.change(screen.getByLabelText("Wallet budget"), { target: { value: "5.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    pending[1].resolve(json(responseFor(pending[1].request, "EUR")));
    await flush();
    expect(pending[2].request.options.budget_minor).toBe(0);
    pending[2].resolve(json(responseFor(pending[2].request, "EUR")));
    await flush();
    expect(screen.getByLabelText("Wallet budget")).toHaveValue("0");
    expect(screen.getByRole("alert")).toHaveTextContent(/currency changed/i);
    expect(pending).toHaveLength(3);
  });

  it("prevents nonzero spending before currency discovery", async () => {
    const pending = deferredFetch();
    render(<BadgeWorkspace {...props({ view: "plan" })} />);
    await flush();
    fireEvent.change(screen.getByLabelText("Wallet budget"), { target: { value: "5" } });
    expect(screen.getByRole("button", { name: "Apply and recalculate" })).toBeDisabled();
    expect(pending[0].request.options.budget_minor).toBe(0);
    pending[0].resolve(json(responseFor(pending[0].request, null)));
    await flush();
    expect(screen.getByRole("button", { name: "Apply and recalculate" })).toBeDisabled();
  });

  it("ignores an earlier request that finishes after protections change", async () => {
    const pending = deferredFetch();
    const input = props();
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Never sell Card 0" }));
    await flush();
    // Leaving the workspace aborts the request; returning starts a new one.
    rerender(<BadgeWorkspace {...input} isActive={false} />);
    await flush();
    rerender(<BadgeWorkspace {...input} />);
    await flush();
    const latest = pending[pending.length - 1];
    latest.resolve(json(responseFor(latest.request)));
    await flush();
    pending[1].resolve(json(responseFor(pending[1].request, "EUR")));
    await flush();
    expect(screen.getByRole("checkbox", { name: "Never sell Card 0" })).toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("accepts refreshed snapshots without waiting for a focus event", async () => {
    const pending = deferredFetch();
    const input = props();
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    const refreshed = "2026-09-05T12:01:00Z";
    vi.setSystemTime(Date.parse(refreshed));
    rerender(<BadgeWorkspace {...input} inventoryRefreshedAt={refreshed}
      badges={{ ...input.badges, checked_at: refreshed }} />);
    await flush();
    expect(screen.queryByRole("heading", { name: "Refresh inventory to plan badges" })).toBeNull();
    const response = responseFor(pending[1].request);
    response.generated_at = refreshed;
    response.inventory_refreshed_at = refreshed;
    response.badge_refreshed_at = refreshed;
    pending[1].resolve(json(response));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    expect(screen.getAllByRole("link", { name: "Market" })).toHaveLength(5);
  });

  it("expires actions on focus and offers recovery for stale inventory", async () => {
    const pending = deferredFetch();
    const input = props();
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    expect(screen.getAllByRole("link", { name: "Market" })).toHaveLength(5);
    vi.setSystemTime(Date.parse(EXPIRES) + 1);
    fireEvent.focus(window);
    await flush();
    expect(screen.queryByRole("link", { name: "Market" })).toBeNull();
    rerender(<BadgeWorkspace {...input} inventoryRefreshedAt="2026-09-05T10:00:00Z" />);
    await flush();
    expect(screen.getByRole("heading", { name: "Refresh inventory to plan badges" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh inventory" })[0]);
    expect(input.onRefreshInventory).toHaveBeenCalledOnce();
  });

  it("isolates prior-account responses and pauses hidden work", async () => {
    const pending = deferredFetch();
    const input = props();
    const { rerender } = render(<BadgeWorkspace {...input} isActive={false} />);
    await flush();
    expect(pending).toHaveLength(0);
    rerender(<BadgeWorkspace {...input} />);
    await flush();
    rerender(<BadgeWorkspace {...input} steamId="76561198000000002" />);
    await flush();
    pending[1].resolve(json(responseFor(pending[1].request)));
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request, "EUR")));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    expect(screen.getByRole("link", { name: /badge page/i })).toHaveAttribute("href", expect.stringContaining("76561198000000002"));
  });

  it("collects per-game collector goals and forwards exact targets", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /Collect games to chosen badge levels/ }));
    await flush();
    expect(screen.getByRole("button", { name: "Apply and recalculate" })).toBeDisabled();
    expect(screen.getByText(/Set at least one collector goal/)).toBeInTheDocument();
    expect(pending).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "Collector goal for Orbital Quest" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Target level for Orbital Quest" }), {
      target: { value: "3" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    const applied = pending[pending.length - 1].request;
    expect(applied.options.mode).toBe("collector");
    expect(applied.options.target_level).toBeNull();
    expect(applied.options.collector_targets).toEqual([{ app_id: "10", target_level: 3 }]);
    pending[pending.length - 1].resolve(json(responseFor(applied)));
    await flush();
    // The collector plan line explains the shortfall against every goal.
    expect(screen.getAllByText(/Shortfall 100 XP to reach every collector goal/)).toHaveLength(3);
    const workflow = workflowStubs[workflowStubs.length - 1];
    expect(workflow.collectorTargets).toEqual([{ app_id: "10", target_level: 3 }]);
    // The expanded game card previews real badge artwork at the chosen level.
    rerender(<BadgeWorkspace {...input} view="badges" />);
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    expect(screen.getByTestId("badge-artwork-stub")).toBeInTheDocument();
    expect(artworkStubs[artworkStubs.length - 1]).toMatchObject({ appId: "10", targetLevel: 3 });
  });

  it("requires a game before applying the selected scope and forwards it", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /Selected games/ }));
    await flush();
    expect(screen.getByRole("button", { name: "Apply and recalculate" })).toBeDisabled();
    expect(screen.getByText(/Select at least one game/)).toBeInTheDocument();
    // Checkbox selection is a draft: no request is issued until Apply.
    fireEvent.click(screen.getByRole("checkbox", { name: "Plan Orbital Quest" }));
    expect(pending).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    const applied = pending[pending.length - 1].request;
    expect(applied.options.scope).toBe("selected");
    expect(applied.options.selected_app_ids).toEqual(["10"]);
    pending[pending.length - 1].resolve(json(responseFor(applied)));
    await flush();
    rerender(<BadgeWorkspace {...input} view="badges" />);
    expect(screen.getByRole("button", { name: /Orbital Quest/ })).toBeInTheDocument();
  });

  it("discovers supported sets from an empty inventory via the catalog scope", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan", items: [], boosters: [] });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /All supported games/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    const applied = pending[pending.length - 1].request;
    expect(applied.options.scope).toBe("catalog");
    expect(applied.games).toEqual([]);
    pending[pending.length - 1].resolve(json(catalogResponseFor(applied)));
    await flush();
    rerender(<BadgeWorkspace {...input} view="badges" />);
    expect(screen.getByRole("button", { name: /Discovered Set Game/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Orbital Quest/ })).toBeInTheDocument();
  });

  it("compares selling one set on demand and explains the alternative", async () => {
    const pending = deferredFetch();
    const input = props();
    render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compare selling one set" }));
    await flush();
    expect(pending[1].request.options.compare_app_id).toBe("10");
    pending[1].resolve(json(responseFor(pending[1].request)));
    await flush();
    expect(screen.getByRole("heading", { name: /Craft vs\. sell comparison/ })).toBeInTheDocument();
    expect(screen.getByText("Net sale proceeds")).toBeInTheDocument();
    expect(screen.getByText(/This compares an alternative scenario/)).toBeInTheDocument();
    // Card table plus opportunity sales rows are marketable and fresh.
    expect(screen.getAllByRole("link", { name: "Market" })).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Clear comparison" }));
    await flush();
    expect(pending[pending.length - 1].request.options.compare_app_id).toBeNull();
  });

  it("explains an unavailable comparison without inventing quotes", async () => {
    const pending = deferredFetch();
    render(<BadgeWorkspace {...props()} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compare selling one set" }));
    await flush();
    const response = responseFor(pending[1].request);
    response.opportunity = unavailableOpportunityFor("10", "source_badge_maxed");
    pending[1].resolve(json(response));
    await flush();
    expect(screen.getByText(/already reached level five/)).toBeInTheDocument();
    expect(screen.queryByText("Net sale proceeds")).toBeNull();
  });

  it("restores a saved setup as a draft with clamped protections", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    expect(screen.getByText(/No setup is saved for this account yet/)).toBeInTheDocument();
    intentHolder.saved = intentFixture({
      mode: "budget",
      targetLevel: "",
      budgetText: "5.00",
      money: moneyFixture("USD", 2),
      protections: [{ market_hash_name: hashes[0], keep_quantity: 5, never_sell: true }],
      strategy: "preserve_cards"
    });
    rerender(<BadgeWorkspace {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore saved setup" }));
    await flush();
    expect(screen.getByLabelText("Wallet budget")).toHaveValue("5.00");
    expect(screen.getByText(/restored as a draft/)).toBeInTheDocument();
    expect(screen.getByText(/clamped to current holdings/)).toBeInTheDocument();
    expect(screen.getByText(/Plan inputs changed since the last calculation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    const applied = pending[pending.length - 1].request;
    expect(applied.options.mode).toBe("budget");
    expect(applied.options.budget_minor).toBe(500);
    expect(applied.options.protections).toEqual([
      { market_hash_name: hashes[0], keep_quantity: 2, never_sell: true }
    ]);
    pending[pending.length - 1].resolve(json(responseFor(applied)));
    await flush();
    // The remembered-policy choice carries into the workflow component.
    fireEvent.click(screen.getByRole("radio", { name: /Work with the Fewest purchases plan/ }));
    await flush();
    expect(workflowStubs[workflowStubs.length - 1].plan.strategy).toBe("fewest_purchases");
  });

  it("resets a restored budget when the saved currency no longer matches", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    intentHolder.saved = intentFixture({
      mode: "budget",
      targetLevel: "",
      budgetText: "5.00",
      money: moneyFixture("EUR", 2)
    });
    rerender(<BadgeWorkspace {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore saved setup" }));
    await flush();
    expect(screen.getByLabelText("Wallet budget")).toHaveValue("0");
    expect(screen.getByText(/different market currency/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    expect(pending[pending.length - 1].request.options.budget_minor).toBe(0);
  });

  it("keeps a restored nonzero budget disabled until the currency is confirmed", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    intentHolder.saved = intentFixture({
      mode: "budget",
      targetLevel: "",
      budgetText: "5.00",
      money: null
    });
    rerender(<BadgeWorkspace {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore saved setup" }));
    await flush();
    expect(screen.getByLabelText("Wallet budget")).toHaveValue("5.00");
    expect(screen.getByText(/cannot be applied until/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply and recalculate" })).toBeDisabled();
    pending[0].resolve(json(responseFor(pending[0].request, null)));
    await flush();
    expect(screen.getByRole("button", { name: "Apply and recalculate" })).toBeDisabled();
  });

  it("gates the workflow on applied fresh data and honors the plan choice", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    const ready = workflowStubs[workflowStubs.length - 1];
    expect(ready.plan.strategy).toBe("cheapest");
    expect(ready.canAct).toBe(true);
    expect(ready.response.scope).toBe("inventory_normal_badges");
    fireEvent.click(screen.getByRole("radio", { name: /Work with the Preserve owned cards plan/ }));
    await flush();
    expect(workflowStubs[workflowStubs.length - 1].plan.strategy).toBe("preserve_cards");
    fireEvent.change(screen.getByLabelText("Wallet budget"), { target: { value: "5.00" } });
    await flush();
    expect(workflowStubs[workflowStubs.length - 1].canAct).toBe(false);
  });

  it("compares without applying unrelated draft changes", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    // An unsaved budget edit stays a draft...
    fireEvent.change(screen.getByLabelText("Wallet budget"), { target: { value: "5.00" } });
    rerender(<BadgeWorkspace {...input} view="badges" />);
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compare selling one set" }));
    await flush();
    expect(pending[1].request.options.compare_app_id).toBe("10");
    pending[1].resolve(json(responseFor(pending[1].request)));
    await flush();
    expect(screen.getByRole("heading", { name: /Craft vs\. sell comparison/ })).toBeInTheDocument();
    rerender(<BadgeWorkspace {...input} />);
    expect(screen.getByLabelText("Wallet budget")).toHaveValue("5.00");
    expect(screen.getByText(/Plan inputs changed since the last calculation/)).toBeInTheDocument();
  });

  it("requires budget reconfirmation after an inventory refresh before paid links", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    fireEvent.change(screen.getByLabelText("Wallet budget"), { target: { value: "5.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    pending[1].resolve(json(responseFor(pending[1].request)));
    await flush();
    rerender(<BadgeWorkspace {...input} view="badges" />);
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    expect(screen.getAllByRole("link", { name: "Market" })).toHaveLength(5);
    // A badge recheck with unchanged XP keeps the intent and the budget.
    vi.setSystemTime(Date.parse("2026-09-05T12:01:00Z"));
    rerender(<BadgeWorkspace {...input} view="badges" badges={{ ...input.badges, checked_at: "2026-09-05T12:01:00Z" }} />);
    await flush();
    pending[2].resolve(json(responseFor(pending[2].request)));
    await flush();
    expect(screen.queryByRole("button", { name: "Confirm remaining Wallet budget and Apply" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Market" })).toHaveLength(5);
    // An inventory refresh unsets the confirmation until it is repeated.
    vi.setSystemTime(Date.parse("2026-09-05T12:02:00Z"));
    rerender(<BadgeWorkspace {...input} view="badges" inventoryRefreshedAt="2026-09-05T12:02:00Z" />);
    await flush();
    pending[3].resolve(json(responseFor(pending[3].request)));
    await flush();
    expect(screen.queryByRole("link", { name: "Market" })).toBeNull();
    expect(screen.getByText(/Holdings cannot tell what you already spent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm remaining Wallet budget and Apply" }));
    await flush();
    pending[4].resolve(json(responseFor(pending[4].request)));
    await flush();
    expect(screen.getAllByRole("link", { name: "Market" })).toHaveLength(5);
  });

  it("prunes collector goals that leave the chosen scope", async () => {
    deferredFetch();
    render(<BadgeWorkspace {...props({ view: "plan" })} />);
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /Collect games to chosen badge levels/ }));
    await flush();
    fireEvent.click(screen.getByRole("checkbox", { name: "Collector goal for Orbital Quest" }));
    await flush();
    expect(screen.getByRole("checkbox", { name: "Collector goal for Orbital Quest" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Selected games/ }));
    await flush();
    expect(screen.getByText(/not in this scope/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Collector goal for Orbital Quest" })).not.toBeChecked();
  });

  it("resets the on-demand comparison when the account changes", async () => {
    const pending = deferredFetch();
    const input = props();
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Orbital Quest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compare selling one set" }));
    await flush();
    expect(pending[1].request.options.compare_app_id).toBe("10");
    rerender(<BadgeWorkspace {...input} steamId="76561198000000002" />);
    await flush();
    expect(pending[pending.length - 1].request.options.compare_app_id).toBeNull();
  });

  it("persists the remembered setup on every apply via the intent hook", async () => {
    const pending = deferredFetch();
    const input = props({ view: "plan" });
    const { rerender } = render(<BadgeWorkspace {...input} />);
    await flush();
    pending[0].resolve(json(responseFor(pending[0].request)));
    await flush();
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep this setup saved/ }));
    expect(intentCalls.setRemember).toHaveBeenCalledTimes(1);
    const [, savedIntent] = intentCalls.setRemember.mock.calls[0];
    expect(savedIntent).toMatchObject({ mode: "target", scope: "inventory", budgetText: "0" });
    intentHolder.remember = true;
    // The real hook re-renders on setRemember; mirror that so the apply
    // handler observes the remembered flag.
    rerender(<BadgeWorkspace {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply and recalculate" }));
    await flush();
    expect(intentCalls.save).toHaveBeenCalledTimes(1);
  });
});
