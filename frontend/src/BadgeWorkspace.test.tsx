import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BadgeWorkspace, { type BadgeWorkspaceProps } from "./BadgeWorkspace";
import {
  buildSaleSwapItems, isBadgePlanningResponse, parseBudgetMinorUnits,
  responseMatchesRequest, type BadgeGame, type BadgePlan,
  type BadgePlanningRequest, type BadgePlanningResponse
} from "./badgePlanning";
import { aggregateNormalCardOwnership, levelForXp, minimumXpForLevel } from "./levelUpOptimization";

const NOW = "2026-09-05T12:00:00Z";
const EXPIRES = "2026-09-05T12:15:00Z";
const STEAM_ID = "76561198000000001";
const hashes = Array.from({ length: 5 }, (_, index) => `10-Card ${index} (Trading Card)`);
const baseRequest: BadgePlanningRequest = {
  inventory_refreshed_at: NOW, badge_refreshed_at: NOW, player_xp: 1250, player_level: 11,
  games: [{ app_id: "10", game_name: "Orbital Quest", card_set_size: 5, badge_level: 0 }],
  cards: hashes.map((market_hash_name) => ({ market_hash_name, owned_quantity: 2, sellable_quantity: 2 })),
  options: { mode: "target", target_level: 12, budget_minor: 0, excluded_app_ids: [], protections: [] }
};

// A complete, owned two-set snapshot. Every response preserves real per-card
// conservation; paid purchase cases below construct their own coherent rows.
function responseFor(request = baseRequest, currency: string | null = "USD"): BadgePlanningResponse {
  const protections = new Map(request.options.protections.map((row) => [row.market_hash_name, row]));
  const cards = request.cards.map((row, index) => ({
    market_hash_name: row.market_hash_name, card_name: `Card ${index}`,
    owned_quantity: row.owned_quantity,
    keep_quantity: protections.get(row.market_hash_name)?.keep_quantity ?? 0,
    never_sell: protections.get(row.market_hash_name)?.never_sell ?? false,
    available_quantity: row.owned_quantity - (protections.get(row.market_hash_name)?.keep_quantity ?? 0),
    buy_price_minor: currency === null ? null : 5,
    buy_quantity: currency === null ? null : 10,
    quote_timestamp: currency === null ? null : NOW
  }));
  const available = Math.min(...cards.map((card) => card.available_quantity));
  const excluded = request.options.excluded_app_ids.includes("10");
  const game: BadgeGame = {
    app_id: "10", game_name: "Orbital Quest", badge_level: 0, set_size: 5,
    owned_unique: 5, owned_cards: 10,
    available_unique: cards.filter((card) => card.available_quantity > 0).length,
    craftable_count: available, missing_count: cards.filter((card) => card.available_quantity === 0).length,
    completion_cost_minor: available > 0 ? 0 : currency === null ? null : 5,
    status: excluded ? "excluded" : available > 0 ? "craftable" : "reserved",
    reason: excluded ? "excluded_by_options" : "owned_set_ready", cards
  };
  const target = request.options.target_level;
  const needed = target === null ? available : Math.max(0, Math.ceil((minimumXpForLevel(target) - 1250) / 100));
  const crafts = excluded ? 0 : Math.min(available, needed);
  const xp = 1250 + crafts * 100;
  const shortfall = target === null ? 0 : Math.max(0, minimumXpForLevel(target) - xp);
  const plan: BadgePlan = {
    strategy: "cheapest", status: crafts === 0 ? "no_opportunity" : shortfall > 0 ? "partial" : "ready",
    reason: crafts === 0 ? "no_crafts_available" : "target_reached", target_level: target,
    target_reached: target !== null && shortfall === 0, craft_count: crafts, xp_gain: crafts * 100,
    projected_xp: xp, projected_level: levelForXp(xp), shortfall_xp: shortfall,
    spend_minor: 0, remaining_budget_minor: request.options.budget_minor,
    purchase_count: 0, owned_cards_used: crafts * 5,
    steps: crafts === 0 ? [] : [{
      app_id: "10", game_name: "Orbital Quest", badge_level_before: 0, badge_level_after: crafts,
      craft_count: crafts, xp_gain: crafts * 100, spend_minor: 0, owned_cards_used: crafts * 5, purchases: []
    }]
  };
  return {
    status: "ready", reason: currency === null ? "currency_contract_missing" : "ready",
    generated_at: NOW, valid_until: EXPIRES, currency_code: currency, minor_digits: currency === null ? null : 2,
    inventory_refreshed_at: NOW, badge_refreshed_at: NOW, player_xp: 1250, player_level: 11,
    scope: "inventory_normal_badges", games: [game],
    plans: [plan, { ...plan, strategy: "fewest_purchases" }, { ...plan, strategy: "preserve_cards" }]
  };
}

function props(overrides: Partial<BadgeWorkspaceProps> = {}): BadgeWorkspaceProps {
  return {
    steamId: STEAM_ID, inventoryStatus: "public",
    items: hashes.map((market_hash_name) => ({ market_hash_name, quantity: 2, marketable: true, tradable: true })),
    boosters: [{ game_app_id: "10", game_name: "Orbital Quest", card_set_size: 5 }],
    badges: { status: "public", message: "Public", player_xp: 1250, player_level: 11, checked_at: NOW, normal_badge_levels: [] },
    inventoryRefreshedAt: NOW, isInventoryLoading: false, isActive: true, view: "badges",
    onRefreshInventory: vi.fn(), onRefreshBadges: vi.fn(), ...overrides
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
beforeEach(() => vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["Date", "setTimeout", "clearTimeout"] }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
      { market_hash_name: hashes[0], quantity: 2, marketable: false, tradable: false },
      { market_hash_name: hashes[0], quantity: 3, marketable: true, tradable: true },
      { market_hash_name: hashes[1], quantity: 1, marketable: true, tradable: true }
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
});
