import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPlanChecklist,
  checklistToCsv,
  checklistToJson,
  checklistToText,
  clampPlanIntentProtections,
  computePlanWantsAndSurplus,
  downloadChecklist,
  isPlanIntent,
  planIntentCurrencyBinding,
  planIntentStorageKey,
  usePlanIntent,
  PLAN_INTENT_KEY_PREFIX,
  type PlanChecklist,
  type PlanIntent
} from "./planWorkflow";
import type {
  BadgeCollectorTarget,
  BadgeGame,
  BadgeGameCard,
  BadgePlan,
  BadgePlanPurchase,
  BadgePlanningReadyResponse
} from "./badgePlanning";
import type { LevelUpInventoryItem } from "./levelUpOptimization";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const GENERATED = "2026-09-05T12:00:00Z";
const EXPIRES = "2026-09-05T12:15:00Z";
const STEAM_ID = "76561198000000001";
const OTHER_ID = "76561198000000002";
const HASHES = Array.from(
  { length: 5 },
  (_, index) => `10-Card ${index} (Trading Card)`
);
const PLAN_INTENT_KEYS = new Set([
  "mode",
  "targetLevel",
  "budgetText",
  "money",
  "scope",
  "selectedAppIds",
  "collectorTargets",
  "protections",
  "excludedAppIds",
  "strategy"
]);

const VALID_INTENT: PlanIntent = {
  mode: "target",
  targetLevel: "12",
  budgetText: "12.34",
  money: { currency_code: "USD", minor_digits: 2 },
  scope: "inventory",
  selectedAppIds: [],
  collectorTargets: [],
  protections: [
    {
      market_hash_name: "10-Card 0 (Trading Card)",
      keep_quantity: 1,
      never_sell: false
    }
  ],
  excludedAppIds: [],
  strategy: "cheapest"
};

const COLLECTOR_INTENT: PlanIntent = {
  mode: "collector",
  targetLevel: "",
  budgetText: "0",
  money: null,
  scope: "selected",
  selectedAppIds: ["10", "20"],
  collectorTargets: [{ app_id: "10", target_level: 3 }],
  protections: [],
  excludedAppIds: ["30"],
  strategy: "fewest_purchases"
};

function storageKey(steamId: string): string {
  const key = planIntentStorageKey(steamId);
  if (key === null) {
    throw new Error(`no storage key for ${steamId}`);
  }
  return key;
}

function seedEnvelope(steamId: string, value: unknown): void {
  window.localStorage.setItem(storageKey(steamId), JSON.stringify(value));
}

function readStored(steamId: string): unknown {
  const raw = window.localStorage.getItem(storageKey(steamId));
  return raw === null ? null : JSON.parse(raw);
}

function card(
  index: number,
  overrides: Partial<BadgeGameCard> = {}
): BadgeGameCard {
  return {
    market_hash_name: HASHES[index],
    card_name: `Card ${index}`,
    owned_quantity: 5,
    keep_quantity: 0,
    never_sell: false,
    available_quantity: 5,
    buy_price_minor: 5,
    buy_quantity: 10,
    quote_timestamp: GENERATED,
    ...overrides
  };
}

function game(overrides: Partial<BadgeGame> = {}): BadgeGame {
  return {
    app_id: "10",
    game_name: "Orbital Quest",
    badge_level: 0,
    set_size: 5,
    owned_unique: 5,
    owned_cards: 25,
    available_unique: 5,
    craftable_count: 5,
    missing_count: 0,
    completion_cost_minor: 25,
    status: "craftable",
    reason: "owned_set_ready",
    target_badge_level: null,
    cards: HASHES.map((_, index) => card(index)),
    ...overrides
  };
}

function planFor(
  craftCount: number,
  purchases: BadgePlanPurchase[] = [],
  overrides: Partial<BadgePlan> = {}
): BadgePlan {
  const spend = purchases.reduce((sum, row) => sum + row.total_minor, 0);
  return {
    strategy: "cheapest",
    status: craftCount > 0 ? "ready" : "no_opportunity",
    reason: craftCount > 0 ? "target_reached" : "no_crafts_available",
    target_level: 12,
    target_reached: craftCount > 0,
    craft_count: craftCount,
    xp_gain: craftCount * 100,
    projected_xp: 1250 + craftCount * 100,
    projected_level: 11 + craftCount,
    shortfall_xp: 0,
    spend_minor: spend,
    remaining_budget_minor: 1000 - spend,
    purchase_count: purchases.length,
    owned_cards_used: craftCount * 5,
    steps:
      craftCount === 0
        ? []
        : [
            {
              app_id: "10",
              game_name: "Orbital Quest",
              badge_level_before: 0,
              badge_level_after: craftCount,
              craft_count: craftCount,
              xp_gain: craftCount * 100,
              spend_minor: spend,
              owned_cards_used: craftCount * 5,
              purchases
            }
          ],
    ...overrides
  };
}

function purchase(hash: string, quantity: number): BadgePlanPurchase {
  return {
    market_hash_name: hash,
    card_name: hash.replace(/ \(Trading Card\)$/, "").replace(/^[0-9]+-/, ""),
    quantity,
    unit_price_minor: 5,
    total_minor: quantity * 5,
    quote_timestamp: GENERATED
  };
}

function item(
  marketHashName: string,
  quantity: number,
  liquid = true,
  overrides: Partial<LevelUpInventoryItem> = {}
): LevelUpInventoryItem {
  return {
    market_hash_name: marketHashName,
    quantity,
    marketable: liquid,
    tradable: liquid,
    item_type: "trading_card",
    card_border: "normal",
    game_app_id: "10",
    game_name: "Orbital Quest",
    ...overrides
  };
}

function fullInventory(
  quantityPerHash = 5,
  liquid = true
): LevelUpInventoryItem[] {
  return HASHES.map((hash) => item(hash, quantityPerHash, liquid));
}

function readyResponse(
  games: BadgeGame[] = [game()],
  currency: string | null = "USD"
): BadgePlanningReadyResponse {
  return {
    status: "ready",
    reason: "ready",
    generated_at: GENERATED,
    valid_until: EXPIRES,
    currency_code: currency,
    minor_digits: currency === null ? null : 2,
    inventory_refreshed_at: GENERATED,
    badge_refreshed_at: GENERATED,
    player_xp: 1250,
    player_level: 11,
    scope: "inventory_normal_badges",
    evaluated_game_count: games.length,
    games,
    plans: [],
    opportunity: null
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("isPlanIntent", () => {
  it("accepts a complete target-mode intent and a collector selected-scope intent", () => {
    expect(isPlanIntent(VALID_INTENT)).toBe(true);
    expect(isPlanIntent(COLLECTOR_INTENT)).toBe(true);
  });

  it("rejects unknown mode, scope, or strategy values", () => {
    expect(isPlanIntent({ ...VALID_INTENT, mode: "shop" })).toBe(false);
    expect(isPlanIntent({ ...VALID_INTENT, scope: "everything" })).toBe(false);
    expect(isPlanIntent({ ...VALID_INTENT, strategy: "greedy" })).toBe(false);
  });

  it("enforces the request-shaped list consistency", () => {
    expect(isPlanIntent({ ...VALID_INTENT, scope: "selected" })).toBe(false);
    expect(isPlanIntent({ ...COLLECTOR_INTENT, selectedAppIds: [] })).toBe(
      false
    );
    expect(
      isPlanIntent({
        ...VALID_INTENT,
        collectorTargets: [{ app_id: "10", target_level: 2 }]
      })
    ).toBe(false);
    expect(isPlanIntent({ ...COLLECTOR_INTENT, collectorTargets: [] })).toBe(
      false
    );
  });

  it("rejects malformed ids, texts, and money", () => {
    expect(isPlanIntent({ ...VALID_INTENT, targetLevel: "12.5" })).toBe(false);
    expect(isPlanIntent({ ...VALID_INTENT, targetLevel: "100001" })).toBe(
      false
    );
    expect(isPlanIntent({ ...VALID_INTENT, budgetText: "-5" })).toBe(false);
    expect(isPlanIntent({ ...VALID_INTENT, budgetText: "1,234" })).toBe(false);
    expect(
      isPlanIntent({
        ...VALID_INTENT,
        money: { currency_code: "usd", minor_digits: 2 }
      })
    ).toBe(false);
    expect(
      isPlanIntent({
        ...VALID_INTENT,
        money: { currency_code: "USD", minor_digits: 4 }
      })
    ).toBe(false);
    expect(isPlanIntent({ ...VALID_INTENT, selectedAppIds: ["0"] })).toBe(
      false
    );
    expect(isPlanIntent({ ...VALID_INTENT, selectedAppIds: ["1", "1"] })).toBe(
      false
    );
    expect(
      isPlanIntent({
        ...VALID_INTENT,
        excludedAppIds: Array.from({ length: 1001 }, (_, index) =>
          String(index + 1)
        )
      })
    ).toBe(false);
    expect(
      isPlanIntent({
        ...COLLECTOR_INTENT,
        collectorTargets: [{ app_id: "10", target_level: 6 }]
      })
    ).toBe(false);
    expect(
      isPlanIntent({
        ...COLLECTOR_INTENT,
        collectorTargets: [
          { app_id: "10", target_level: 3 },
          { app_id: "10", target_level: 4 }
        ]
      })
    ).toBe(false);
  });

  it("rejects protections outside the stored bounds", () => {
    expect(
      isPlanIntent({
        ...VALID_INTENT,
        protections: [
          {
            market_hash_name: "10-Card 0 (Trading Card)",
            keep_quantity: 1,
            never_sell: false
          },
          {
            market_hash_name: "10-Card 0 (Trading Card)",
            keep_quantity: 2,
            never_sell: true
          }
        ]
      })
    ).toBe(false);
    expect(
      isPlanIntent({
        ...VALID_INTENT,
        protections: [
          {
            market_hash_name: "10-Card 0 (Trading Card)",
            keep_quantity: -1,
            never_sell: false
          }
        ]
      })
    ).toBe(false);
    expect(
      isPlanIntent({
        ...VALID_INTENT,
        protections: [
          {
            market_hash_name: "not-a-card-hash",
            keep_quantity: 1,
            never_sell: false
          }
        ]
      })
    ).toBe(false);
  });

  it("rejects records with extra or missing keys", () => {
    expect(isPlanIntent({ ...VALID_INTENT, extra: true })).toBe(false);
    const { protections, ...rest } = VALID_INTENT;
    expect(isPlanIntent(rest)).toBe(false);
    expect(protections).toBeDefined();
  });
});

describe("planIntentStorageKey", () => {
  it("keeps accounts in separate keys and refuses unusable ids", () => {
    const key = storageKey(STEAM_ID);
    expect(key).toBe(`${PLAN_INTENT_KEY_PREFIX}:${STEAM_ID}`);
    expect(storageKey(OTHER_ID)).not.toBe(key);
    expect(planIntentStorageKey(null)).toBeNull();
    expect(planIntentStorageKey("76561198000000001;drop")).toBeNull();
  });
});

describe("usePlanIntent", () => {
  it("starts empty when nothing is stored", () => {
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    expect(result.current.saved).toBeNull();
    expect(result.current.remember).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("reads a seeded envelope for its own account only", () => {
    seedEnvelope(OTHER_ID, {
      schema: 1,
      remember: true,
      intent: COLLECTOR_INTENT
    });
    const { result, rerender } = renderHook(
      ({ steamId }: { steamId: string | null }) => usePlanIntent(steamId),
      { initialProps: { steamId: STEAM_ID } }
    );
    expect(result.current.saved).toBeNull();
    rerender({ steamId: OTHER_ID });
    expect(result.current.saved).toEqual(COLLECTOR_INTENT);
    expect(result.current.remember).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("persists exactly the bounded envelope on opt-in", () => {
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    act(() => result.current.setRemember(true, VALID_INTENT));
    expect(result.current.saved).toEqual(VALID_INTENT);
    expect(result.current.remember).toBe(true);
    expect(result.current.error).toBeNull();
    const stored = readStored(STEAM_ID);
    expect(stored).toEqual({ schema: 1, remember: true, intent: VALID_INTENT });
    if (stored !== null && typeof stored === "object" && "intent" in stored) {
      const intent = (stored as { intent: Record<string, unknown> }).intent;
      expect(Object.keys(intent).length).toBe(PLAN_INTENT_KEYS.size);
      expect(new Set(Object.keys(intent))).toEqual(PLAN_INTENT_KEYS);
    } else {
      expect.unreachable("envelope was not stored");
    }
  });

  it("reads the persisted setup back in a fresh hook", () => {
    const first = renderHook(() => usePlanIntent(STEAM_ID));
    act(() => first.result.current.setRemember(true, VALID_INTENT));
    const second = renderHook(() => usePlanIntent(STEAM_ID));
    expect(second.result.current.saved).toEqual(VALID_INTENT);
    expect(second.result.current.remember).toBe(true);
  });

  it("removes the stored data entirely when the opt-in is revoked", () => {
    seedEnvelope(STEAM_ID, { schema: 1, remember: true, intent: VALID_INTENT });
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    act(() => result.current.setRemember(false, VALID_INTENT));
    expect(window.localStorage.getItem(storageKey(STEAM_ID))).toBeNull();
    expect(result.current.saved).toBeNull();
    expect(result.current.remember).toBe(false);
  });

  it("refuses to save without the remember opt-in", () => {
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    act(() => result.current.save(VALID_INTENT));
    expect(result.current.error).toContain("remember");
    expect(window.localStorage.getItem(storageKey(STEAM_ID))).toBeNull();
  });

  it("persists updates through save once remembering is on", () => {
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    act(() => result.current.setRemember(true, VALID_INTENT));
    const updated = { ...VALID_INTENT, budgetText: "50" };
    act(() => result.current.save(updated));
    expect(result.current.saved).toEqual(updated);
    const second = renderHook(() => usePlanIntent(STEAM_ID));
    expect(second.result.current.saved).toEqual(updated);
  });

  it("applies opt-in and save chained in the same tick", () => {
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    act(() => {
      result.current.setRemember(true, VALID_INTENT);
      result.current.save(VALID_INTENT);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.saved).toEqual(VALID_INTENT);
    expect(readStored(STEAM_ID)).toEqual({
      schema: 1,
      remember: true,
      intent: VALID_INTENT
    });
  });

  it("removes the stored data on forget", () => {
    seedEnvelope(STEAM_ID, { schema: 1, remember: true, intent: VALID_INTENT });
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    act(() => result.current.forget());
    expect(window.localStorage.getItem(storageKey(STEAM_ID))).toBeNull();
    expect(result.current.saved).toBeNull();
    expect(result.current.remember).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("rejects invalid intents without writing", () => {
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    const invalid = {
      ...VALID_INTENT,
      scope: "selected"
    } as unknown as PlanIntent;
    act(() => result.current.setRemember(true, invalid));
    expect(result.current.error).toContain("bounds");
    expect(window.localStorage.getItem(storageKey(STEAM_ID))).toBeNull();
  });

  it("reports corrupt JSON explicitly and forget recovers", () => {
    window.localStorage.setItem(storageKey(STEAM_ID), "{not json");
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    expect(result.current.saved).toBeNull();
    expect(result.current.error).toContain("could not be read");
    act(() => result.current.forget());
    expect(window.localStorage.getItem(storageKey(STEAM_ID))).toBeNull();
    const second = renderHook(() => usePlanIntent(STEAM_ID));
    expect(second.result.current.error).toBeNull();
  });

  it("treats envelopes with the wrong schema or intent as corrupt", () => {
    seedEnvelope(STEAM_ID, { schema: 2, remember: true, intent: VALID_INTENT });
    const first = renderHook(() => usePlanIntent(STEAM_ID));
    expect(first.result.current.error).toContain("could not be read");
    seedEnvelope(STEAM_ID, {
      schema: 1,
      remember: true,
      intent: { mode: "shop" }
    });
    const second = renderHook(() => usePlanIntent(STEAM_ID));
    expect(second.result.current.error).toContain("could not be read");
    expect(second.result.current.saved).toBeNull();
  });

  it("reports write failures explicitly when the browser refuses writes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    const { result } = renderHook(() => usePlanIntent(STEAM_ID));
    act(() => result.current.setRemember(true, VALID_INTENT));
    expect(result.current.error).toContain("could not be saved");
    expect(result.current.saved).toBeNull();
    expect(result.current.remember).toBe(false);
  });

  it("reports unavailable storage on read and on save attempts", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("storage blocked", "SecurityError");
      }
    });
    try {
      const { result } = renderHook(() => usePlanIntent(STEAM_ID));
      expect(result.current.saved).toBeNull();
      expect(result.current.error).toContain("unavailable");
      act(() => result.current.setRemember(true, VALID_INTENT));
      expect(result.current.error).toContain("unavailable");
      expect(result.current.remember).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "localStorage", descriptor);
      }
    }
  });

  it("refuses persistence while signed out", () => {
    const { result } = renderHook(() => usePlanIntent(null));
    act(() => result.current.setRemember(true, VALID_INTENT));
    expect(result.current.error).toContain("Sign in");
    expect(result.current.saved).toBeNull();
    act(() => result.current.save(VALID_INTENT));
    expect(result.current.error).toContain("Sign in");
    act(() => result.current.forget());
    expect(result.current.saved).toBeNull();
  });
});

describe("planIntentCurrencyBinding", () => {
  it("binds only to the exact saved currency contract", () => {
    expect(
      planIntentCurrencyBinding(VALID_INTENT, {
        currency_code: "USD",
        minor_digits: 2
      })
    ).toBe(true);
    expect(
      planIntentCurrencyBinding(VALID_INTENT, {
        currency_code: "USD",
        minor_digits: 0
      })
    ).toBe(false);
    expect(
      planIntentCurrencyBinding(VALID_INTENT, {
        currency_code: "EUR",
        minor_digits: 2
      })
    ).toBe(false);
    expect(planIntentCurrencyBinding(VALID_INTENT, null)).toBe(false);
    const unbound = { ...VALID_INTENT, money: null };
    expect(planIntentCurrencyBinding(unbound, null)).toBe(true);
    expect(
      planIntentCurrencyBinding(unbound, {
        currency_code: "EUR",
        minor_digits: 2
      })
    ).toBe(true);
  });
});

describe("clampPlanIntentProtections", () => {
  it("clamps keep quantities to actual holdings and reports each reduction", () => {
    const items = [item(HASHES[0], 3), item(HASHES[1], 5)];
    const intent: PlanIntent = {
      ...VALID_INTENT,
      protections: [
        { market_hash_name: HASHES[0], keep_quantity: 5, never_sell: true },
        { market_hash_name: HASHES[1], keep_quantity: 2, never_sell: false },
        { market_hash_name: HASHES[2], keep_quantity: 4, never_sell: false }
      ]
    };
    const clamped = clampPlanIntentProtections(intent, items);
    expect(clamped.intent.protections[0]).toEqual({
      market_hash_name: HASHES[0],
      keep_quantity: 3,
      never_sell: true
    });
    expect(clamped.intent.protections[1]).toEqual({
      market_hash_name: HASHES[1],
      keep_quantity: 2,
      never_sell: false
    });
    expect(clamped.intent.protections[2]).toEqual({
      market_hash_name: HASHES[2],
      keep_quantity: 4,
      never_sell: false
    });
    expect(clamped.clampedMarketHashNames).toEqual([HASHES[0]]);
  });
});

describe("computePlanWantsAndSurplus", () => {
  function countsFor(
    plan: BadgePlan,
    items: LevelUpInventoryItem[],
    collectorTargets: BadgeCollectorTarget[] = [],
    response = readyResponse()
  ) {
    const result = computePlanWantsAndSurplus({
      response,
      plan,
      items,
      collectorTargets
    });
    expect(result.cards.length).toBeGreaterThan(0);
    for (const counts of result.cards) {
      expect(counts.ownedTotal).toBe(
        counts.reserved +
          counts.craftFromInventory +
          counts.goalFromInventory +
          counts.surplus
      );
      expect(
        counts.purchased + counts.craftFromInventory + counts.craftMissing
      ).toBe(counts.planCraftDemand);
      expect(counts.goalFromInventory + counts.goalMissing).toBe(
        counts.goalCraftDemand
      );
      expect(counts.wanted).toBe(counts.craftMissing + counts.goalMissing);
      expect(counts.suggestedTradeable).toBeGreaterThanOrEqual(0);
      expect(counts.suggestedTradeable).toBeLessThanOrEqual(counts.surplus);
      expect(counts.surplus).toBeLessThanOrEqual(
        counts.ownedTotal - counts.reserved
      );
      expect(counts.withheldSurplus).toBe(
        counts.surplus - counts.suggestedTradeable
      );
    }
    return result;
  }

  function countsByHash(result: { cards: { marketHashName: string }[] }) {
    return new Map(
      result.cards.map((counts) => [counts.marketHashName, counts])
    );
  }

  it("keeps exact quantity invariants for a plain multi-craft plan", () => {
    const result = countsFor(planFor(2), fullInventory(5));
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      ownedTotal: 5,
      reserved: 0,
      planCraftDemand: 2,
      purchased: 0,
      craftFromInventory: 2,
      craftMissing: 0,
      wanted: 0,
      surplus: 3,
      suggestedTradeable: 3,
      withheldSurplus: 0,
      withheldReason: null
    });
  });

  it("never equates duplicates with surplus when the plan consumes them", () => {
    const result = countsFor(planFor(5), fullInventory(5));
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      planCraftDemand: 5,
      craftFromInventory: 5,
      surplus: 0
    });
  });

  it("pins reserved copies away from crafts and surplus", () => {
    const response = readyResponse([
      game({
        cards: HASHES.map((_, index) =>
          card(index, { keep_quantity: 2, available_quantity: 3 })
        )
      })
    ]);
    const result = countsFor(planFor(5), fullInventory(5), [], response);
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      reserved: 2,
      planCraftDemand: 5,
      craftFromInventory: 3,
      craftMissing: 2,
      surplus: 0,
      wanted: 2
    });
  });

  it("counts tradeable surplus per copy, never by any-copy boolean", () => {
    const mixedInventory = HASHES.flatMap((hash) => [
      item(hash, 3, true),
      item(hash, 2, false)
    ]);
    const crafting = countsFor(planFor(2), mixedInventory);
    expect(countsByHash(crafting).get(HASHES[0])).toMatchObject({
      ownedTotal: 5,
      tradeableUnreserved: 3,
      surplus: 3,
      suggestedTradeable: 1,
      withheldSurplus: 2,
      withheldReason: "not_tradable"
    });
    const untouched = countsFor(planFor(0), mixedInventory);
    expect(countsByHash(untouched).get(HASHES[0])).toMatchObject({
      surplus: 5,
      suggestedTradeable: 3,
      withheldSurplus: 2,
      withheldReason: "not_tradable"
    });
  });

  it("withholds never-sell copies from suggested trades", () => {
    const response = readyResponse([
      game({
        cards: HASHES.map((_, index) => card(index, { never_sell: true }))
      })
    ]);
    const result = countsFor(planFor(0), fullInventory(3), [], response);
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      surplus: 3,
      suggestedTradeable: 0,
      withheldSurplus: 3,
      withheldReason: "never_sell"
    });
  });

  it("withholds suggestions for excluded games", () => {
    const response = readyResponse([
      game({ status: "excluded", reason: "excluded_by_options" })
    ]);
    const result = countsFor(planFor(0), fullInventory(3), [], response);
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      surplus: 3,
      suggestedTradeable: 0,
      withheldReason: "excluded"
    });
  });

  it("draws purchased copies before inventory and reports the rest as surplus", () => {
    const purchases = HASHES.map((hash) => purchase(hash, 2));
    const result = countsFor(planFor(2, purchases), fullInventory(10));
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      purchased: 2,
      planCraftDemand: 2,
      craftFromInventory: 0,
      surplus: 10,
      suggestedTradeable: 10
    });
  });

  it("extends wants with the remaining collector goal shortfall", () => {
    const targets: BadgeCollectorTarget[] = [{ app_id: "10", target_level: 3 }];
    const result = countsFor(planFor(1), fullInventory(1), targets);
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      planCraftDemand: 1,
      craftFromInventory: 1,
      goalCraftDemand: 2,
      goalFromInventory: 0,
      goalMissing: 2,
      wanted: 2,
      surplus: 0
    });
  });

  it("reports reached targets with no demand and unmatched targets explicitly", () => {
    const targets: BadgeCollectorTarget[] = [
      { app_id: "10", target_level: 3 },
      { app_id: "99", target_level: 2 },
      { app_id: "40", target_level: 5 }
    ];
    const response = readyResponse([
      game({ badge_level: 3 }),
      game({ app_id: "40", game_name: "Empty Set", cards: [] })
    ]);
    const plan = planFor(0);
    const result = computePlanWantsAndSurplus({
      response: readyResponse(),
      plan,
      items: [],
      collectorTargets: []
    });
    expect(result.unmatchedCollectorTargets).toEqual([]);
    const full = computePlanWantsAndSurplus({
      response,
      plan,
      items: [],
      collectorTargets: targets
    });
    expect(full.unmatchedCollectorTargets).toEqual([
      { app_id: "99", target_level: 2 },
      { app_id: "40", target_level: 5 }
    ]);
  });

  it("flags plan drift when the actual inventory no longer covers the plan", () => {
    const result = countsFor(planFor(5), fullInventory(2));
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      planCraftDemand: 5,
      craftFromInventory: 2,
      craftMissing: 3,
      wanted: 3,
      surplus: 0
    });
  });

  it("aggregates duplicate inventory rows per copy", () => {
    const items = HASHES.flatMap((hash) => [
      item(hash, 2, true),
      item(hash, 3, true)
    ]);
    const result = countsFor(planFor(1), items);
    const counts = countsByHash(result).get(HASHES[0]);
    expect(counts).toMatchObject({
      ownedTotal: 5,
      tradeableUnreserved: 5,
      surplus: 4
    });
  });

  it("ignores non-normal-card items and hashes outside returned games", () => {
    const items = [
      item("99-Extra (Trading Card)", 4),
      item(HASHES[0], 1, true, { item_type: "booster_pack" }),
      item(HASHES[0], 1, true, { card_border: "foil" })
    ];
    const result = computePlanWantsAndSurplus({
      response: readyResponse(),
      plan: planFor(0),
      items
    });
    expect(result.cards.length).toBe(0);
  });
});

describe("buildPlanChecklist", () => {
  function build(args: {
    plan?: BadgePlan;
    items?: LevelUpInventoryItem[];
    collectorTargets?: BadgeCollectorTarget[];
    response?: BadgePlanningReadyResponse;
    now?: number;
  }): PlanChecklist {
    return buildPlanChecklist({
      steamId: STEAM_ID,
      response: args.response ?? readyResponse(),
      plan: args.plan ?? planFor(2),
      items: args.items ?? fullInventory(5),
      collectorTargets: args.collectorTargets,
      now: args.now ?? NOW
    });
  }

  it("builds craft, purchase, want, and surplus rows with unique ids", () => {
    const drift = build({ plan: planFor(5), items: fullInventory(2) });
    const goal = build({
      plan: planFor(1),
      items: fullInventory(1),
      collectorTargets: [{ app_id: "10", target_level: 3 }]
    });
    const purchases = [purchase(HASHES[0], 2)];
    const purchased = build({
      plan: planFor(2, purchases),
      items: fullInventory(10)
    });
    expect(purchased.rows.slice(0, 2).map((row) => row.kind)).toEqual([
      "purchase",
      "craft"
    ]);
    for (const checklist of [drift, goal, purchased]) {
      const ids = checklist.rows.map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(drift.rows.some((row) => row.kind === "craft")).toBe(true);
    expect(purchased.rows.filter((row) => row.kind === "purchase").length).toBe(
      1
    );
    const sources = [drift, goal].flatMap((checklist) =>
      checklist.rows
        .filter((row) => row.kind === "want")
        .map((row) => (row.kind === "want" ? row.source : null))
    );
    expect(sources).toEqual(
      expect.arrayContaining(["plan_drift", "collector_goal"])
    );
  });

  it("expires reference exports at the quote deadline", () => {
    const deadline = Date.parse(EXPIRES);
    expect(build({ now: deadline - 1 }).reference.stale).toBe(false);
    expect(build({ now: deadline }).reference.stale).toBe(true);
  });

  it("warns about missing currency, drift, goals, and unmatched targets", () => {
    const checklist = build({
      response: readyResponse([game()], null),
      plan: planFor(2),
      items: fullInventory(1),
      collectorTargets: [
        { app_id: "10", target_level: 5 },
        { app_id: "99", target_level: 2 }
      ]
    });
    const warnings = checklist.warnings.join("\n");
    expect(warnings).toContain("No currency is confirmed");
    expect(warnings).toContain("no longer matches the plan snapshot");
    expect(warnings).toContain("Collector goal wants");
    expect(warnings).toContain("99");
  });
});

describe("checklist exports", () => {
  function checklistWith(): PlanChecklist {
    const renamed = planFor(2);
    return buildPlanChecklist({
      steamId: STEAM_ID,
      response: readyResponse([game({ game_name: "Alpha, Beta" })]),
      plan: {
        ...renamed,
        steps: renamed.steps.map((step) => ({
          ...step,
          game_name: "Alpha, Beta"
        }))
      },
      items: fullInventory(5),
      now: NOW
    });
  }

  it("renders precise text with reference stamps and marks", () => {
    const checklist = checklistWith();
    const craftId =
      checklist.rows.find((row) => row.kind === "craft")?.id ?? "";
    const text = checklistToText(checklist, new Set([craftId]));
    expect(text).toContain(
      "Reference only. Nothing is bought, sold, or crafted automatically"
    );
    expect(text).toContain(`Plan generated:`);
    expect(text).toContain(`Valid until:`);
    expect(text).toContain("Currency: USD (2 minor digit(s))");
    expect(text).toContain(`[x] Craft Alpha, Beta ×2`);
    expect(text).toContain("[ ] Surplus after commitments: 3 × Card 0");
    expect(text).toContain("3 suggested for trades");
  });

  it("renders RFC 4180 CSV with metadata, header, and checked column", () => {
    const checklist = checklistWith();
    const csv = checklistToCsv(
      checklist,
      new Set(["surplus:10-Card 0 (Trading Card)"])
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      '# reference: "Reference only. Nothing is bought, sold, or crafted automatically; prices are quotes recorded at their timestamps."'
    );
    expect(lines).toContain("# generated_at: 2026-09-05T12:00:00Z");
    expect(lines).toContain("# valid_until: 2026-09-05T12:15:00Z");
    expect(lines).toContain("# currency: USD");
    const headerIndex = lines.indexOf(
      "section,game,app_id,card,market_hash_name,quantity,unit_price_minor,total_minor,quote_timestamp,xp,detail,checked"
    );
    expect(headerIndex).toBeGreaterThan(0);
    const craftRow = lines.find((line) => line.startsWith("craft,"));
    expect(craftRow).toContain('craft,"Alpha, Beta",10');
    expect(craftRow?.endsWith(",false")).toBe(true);
    const surplusRow = lines.find((line) => line.startsWith("surplus,"));
    expect(surplusRow?.endsWith(",true")).toBe(true);
  });

  it("neutralizes formula and control-prefix text in CSV but keeps exact names in JSON", () => {
    const checklist = buildPlanChecklist({
      steamId: STEAM_ID,
      response: readyResponse([
        game({
          game_name: "=SUM(A1),x",
          cards: HASHES.map((_, index) => card(index, { card_name: "\tCard" }))
        })
      ]),
      plan: planFor(0),
      items: fullInventory(5),
      now: NOW
    });
    const csv = checklistToCsv(checklist);
    expect(csv).toContain('"\'=SUM(A1),x"');
    expect(csv).toContain("'\tCard");
    const parsed = JSON.parse(checklistToJson(checklist)) as {
      rows: { kind: string; gameName: string; cardName: string }[];
    };
    const surplus = parsed.rows.filter((row) => row.kind === "surplus");
    expect(surplus.length).toBeGreaterThan(0);
    for (const row of surplus) {
      expect(row.gameName).toBe("=SUM(A1),x");
      expect(row.cardName).toBe("\tCard");
    }
  });

  it("serializes stable JSON with checked flags and reference data", () => {
    const checklist = checklistWith();
    const parsed = JSON.parse(
      checklistToJson(checklist, new Set([checklist.rows[0].id]))
    ) as {
      schema: string;
      version: number;
      reference: {
        generated_at?: string;
        generatedAt: string;
        validUntil: string;
        currencyCode: string | null;
      };
      rows: { checked: boolean }[];
    };
    expect(parsed.schema).toBe("plan-workflow-checklist");
    expect(parsed.version).toBe(1);
    expect(parsed.reference.generatedAt).toBe(GENERATED);
    expect(parsed.reference.validUntil).toBe(EXPIRES);
    expect(parsed.reference.currencyCode).toBe("USD");
    expect(parsed.rows[0].checked).toBe(true);
    expect(parsed.rows[1].checked).toBe(false);
  });

  it("downloads CSV and JSON blobs and refuses when the browser blocks", async () => {
    const checklist = checklistWith();
    const created: string[] = [];
    const blobs: Blob[] = [];
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob) => {
        blobs.push(blob as Blob);
        created.push(`blob:${created.length}`);
        return created[created.length - 1];
      });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const appended: HTMLAnchorElement[] = [];
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = originalCreate(tag);
      if (element instanceof HTMLAnchorElement) {
        appended.push(element);
      }
      return element;
    }) as typeof document.createElement);
    expect(downloadChecklist(checklist, "csv")).toBe(true);
    expect(downloadChecklist(checklist, "json")).toBe(true);
    expect(appended[0].download).toBe(
      "badge-plan-checklist-2026-09-05T12-00-00Z.csv"
    );
    expect(appended[1].download).toBe(
      "badge-plan-checklist-2026-09-05T12-00-00Z.json"
    );
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(await blobs[0].text()).toContain("section,game,app_id");
    expect(await blobs[1].text()).toContain("plan-workflow-checklist");
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(downloadChecklist(checklist, "csv")).toBe(false);
  });
});
