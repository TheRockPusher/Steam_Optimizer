import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  assertBadgePlanningResponse,
  BADGE_CRAFT_XP,
  buildBadgePlanningRequest,
  isBadgePlanningOptions,
  isBadgePlanningRequest,
  isBadgePlanningResponse,
  isBadgePlanningResponseExpired,
  MAX_BADGE_PLANNING_CATALOG_GAME_ROWS,
  MAX_BADGE_PLANNING_SCOPE_IDS,
  parseBudgetMinorUnits,
  parseTargetLevelInput,
  requestBadgePlanning,
  responseMatchesRequest,
  BadgePlanningCurrencyChangeError,
  type BadgeGame,
  type BadgeGameCard,
  type BadgeGameStatus,
  type BadgeOpportunity,
  type BadgePlan,
  type BadgePlanPurchase,
  type BadgePlanStep,
  type BadgePlanningOptions,
  type BadgePlanningReadyResponse,
  type BadgePlanningRequest,
  type BadgePlanningResponseScope,
  type BadgePlanStrategy,
  type BadgeSale,
  type BadgePlanningUnavailableResponse
} from "./badgePlanning";
import {
  levelForXp,
  minimumXpForLevel,
  type LevelUpCardOwnership,
  type LevelUpGame,
  type LevelUpNormalBadgeLevel,
  type LevelUpOptimizationRequest
} from "./levelUpOptimization";

const GENERATED_AT = "2026-09-05T12:00:00Z";
const QUOTE_TS = "2026-09-05T11:50:00Z";
const FUTURE_TS = "2026-09-05T12:05:00Z";
const VALID_UNTIL = "2026-09-05T12:05:00Z";
const INVENTORY_TS = "2026-09-05T11:30:00Z";
const STEAM_ID = "76561198000000001";
const PLAYER_XP = 1250; // level 11: minimumXpForLevel(11) = 1200
const PLAYER_LEVEL = 11;

const sourceHashes = Array.from({ length: 5 }, (_, i) => `10-Card ${i} (Trading Card)`);
const otherHashes = Array.from({ length: 5 }, (_, i) => `20-Card ${i} (Trading Card)`);
const thirdHashes = Array.from({ length: 5 }, (_, i) => `30-Card ${i} (Trading Card)`);

function cardNameOf(hash: string): string {
  return hash.slice(hash.indexOf("-") + 1).replace(/ \(Trading Card\)$/, "");
}

function baseRequest(
  games: LevelUpGame[],
  cards: LevelUpCardOwnership[]
): LevelUpOptimizationRequest {
  return {
    inventory_refreshed_at: INVENTORY_TS,
    badge_refreshed_at: INVENTORY_TS,
    player_xp: PLAYER_XP,
    player_level: PLAYER_LEVEL,
    games,
    cards
  };
}

function makeOptions(overrides: Partial<BadgePlanningOptions> = {}): BadgePlanningOptions {
  return {
    mode: "target",
    target_level: 12,
    budget_minor: 10_000,
    scope: "inventory",
    selected_app_ids: [],
    collector_targets: [],
    compare_app_id: null,
    excluded_app_ids: [],
    protections: [],
    ...overrides
  };
}

const SNAPSHOT: LevelUpNormalBadgeLevel[] = [
  { app_id: 10, level: 0 },
  { app_id: 20, level: 0 }
];

const inventoryGames: LevelUpGame[] = [
  { app_id: "10", game_name: "Orbital Quest", card_set_size: 5, badge_level: 0 }
];
const inventoryCards: LevelUpCardOwnership[] = sourceHashes.map((hash) => ({
  market_hash_name: hash,
  owned_quantity: 2,
  sellable_quantity: 2
}));

const defaultRequest: BadgePlanningRequest = buildBadgePlanningRequest(
  baseRequest(inventoryGames, inventoryCards),
  makeOptions(),
  SNAPSHOT
);

function cardRow(
  hash: string,
  owned: number,
  price: number | null = 10,
  depth: number | null = 3,
  keep = 0
): BadgeGameCard {
  return {
    market_hash_name: hash,
    card_name: cardNameOf(hash),
    owned_quantity: owned,
    keep_quantity: keep,
    never_sell: false,
    available_quantity: owned - keep,
    buy_price_minor: price,
    buy_quantity: price === null ? null : depth,
    quote_timestamp: price === null ? null : QUOTE_TS
  };
}

function gameRow(
  appId: string,
  name: string,
  cards: BadgeGameCard[],
  opts: {
    badgeLevel?: number;
    setSize?: number | null;
    status?: BadgeGameStatus;
    reason?: string;
    target?: number | null;
    missing?: number | null;
    completion?: number | null;
  } = {}
): BadgeGame {
  const badgeLevel = opts.badgeLevel ?? 0;
  const minAvailable =
    cards.length === 0 ? 0 : Math.min(...cards.map((card) => card.available_quantity));
  const setSize =
    opts.setSize === undefined ? (cards.length >= 5 && cards.length <= 15 ? cards.length : null) : opts.setSize;
  return {
    app_id: appId,
    game_name: name,
    badge_level: badgeLevel,
    set_size: setSize,
    owned_unique: cards.filter((card) => card.owned_quantity > 0).length,
    owned_cards: cards.reduce((sum, card) => sum + card.owned_quantity, 0),
    available_unique: cards.filter((card) => card.available_quantity > 0).length,
    craftable_count: minAvailable <= 0 ? 0 : Math.min(5 - badgeLevel, minAvailable),
    missing_count: opts.missing === undefined ? null : opts.missing,
    completion_cost_minor: opts.completion === undefined ? null : opts.completion,
    status: opts.status ?? "craftable",
    reason: opts.reason ?? "owned_set_ready",
    cards,
    target_badge_level: opts.target === undefined ? null : opts.target
  };
}

function stepFor(appId: string, game: BadgeGame, crafts: number): BadgePlanStep {
  const purchases: BadgePlanPurchase[] = [];
  let spend = 0;
  let ownedUsed = 0;
  for (const card of game.cards) {
    const used = Math.min(card.available_quantity, crafts);
    ownedUsed += used;
    const needed = crafts - used;
    if (needed === 0 || card.buy_price_minor === null || card.quote_timestamp === null) {
      continue;
    }
    purchases.push({
      market_hash_name: card.market_hash_name,
      card_name: card.card_name,
      quantity: needed,
      unit_price_minor: card.buy_price_minor,
      total_minor: needed * card.buy_price_minor,
      quote_timestamp: card.quote_timestamp
    });
    spend += needed * card.buy_price_minor;
  }
  return {
    app_id: appId,
    game_name: game.game_name,
    badge_level_before: game.badge_level,
    badge_level_after: game.badge_level + crafts,
    craft_count: crafts,
    xp_gain: crafts * BADGE_CRAFT_XP,
    spend_minor: spend,
    owned_cards_used: ownedUsed,
    purchases
  };
}

type PlanSpec = {
  strategy: BadgePlanStrategy;
  executed: Array<[string, number]>;
  games: BadgeGame[];
  targetLevel: number | null;
  budgetMinor: number;
  status?: "ready" | "partial" | "no_opportunity";
  reason?: string;
  shortfallXp?: number;
  targetReached?: boolean;
};

function planFor(spec: PlanSpec): BadgePlan {
  const gamesById = new Map(spec.games.map((game) => [game.app_id, game]));
  const steps = spec.executed.map(([appId, crafts]) => {
    const game = gamesById.get(appId);
    if (game === undefined) {
      throw new Error(`fixture: unknown game ${appId}`);
    }
    return stepFor(appId, game, crafts);
  });
  const craftCount = steps.reduce((sum, step) => sum + step.craft_count, 0);
  const xpGain = steps.reduce((sum, step) => sum + step.xp_gain, 0);
  const spend = steps.reduce((sum, step) => sum + step.spend_minor, 0);
  const purchaseCount = steps.reduce(
    (sum, step) => sum + step.purchases.reduce((n, purchase) => n + purchase.quantity, 0),
    0
  );
  const ownedUsed = steps.reduce((sum, step) => sum + step.owned_cards_used, 0);
  const projectedXp = PLAYER_XP + xpGain;
  const projectedLevel = levelForXp(projectedXp);
  const needed = spec.targetLevel === null
    ? null
    : Math.max(0, Math.ceil((minimumXpForLevel(spec.targetLevel) - PLAYER_XP) / BADGE_CRAFT_XP));
  const status =
    spec.status ??
    (craftCount === 0
      ? "no_opportunity"
      : needed !== null && craftCount < needed
        ? "partial"
        : "ready");
  return {
    strategy: spec.strategy,
    status,
    reason: spec.reason ?? (status === "ready" ? "target_reached" : status === "partial" ? "budget_insufficient" : "no_crafts_available"),
    target_level: spec.targetLevel,
    target_reached:
      spec.targetReached ?? (spec.targetLevel === null ? false : projectedLevel >= spec.targetLevel),
    craft_count: craftCount,
    xp_gain: xpGain,
    projected_xp: projectedXp,
    projected_level: projectedLevel,
    shortfall_xp:
      spec.shortfallXp ??
      (spec.targetLevel === null ? 0 : Math.max(0, minimumXpForLevel(spec.targetLevel) - projectedXp)),
    spend_minor: spend,
    remaining_budget_minor: spec.budgetMinor - spend,
    purchase_count: purchaseCount,
    owned_cards_used: ownedUsed,
    steps
  };
}

function threePlans(
  games: BadgeGame[],
  executed: Array<[string, number]>,
  opts: Omit<PlanSpec, "strategy" | "executed" | "games">
): BadgePlan[] {
  return (["cheapest", "fewest_purchases", "preserve_cards"] as const).map((strategy) =>
    planFor({ ...opts, strategy, executed, games })
  );
}

type ResponseSpec = {
  games: BadgeGame[];
  plans: BadgePlan[];
  scope: BadgePlanningResponseScope;
  money?: [string, number] | null;
  validUntil?: string;
  opportunity?: BadgeOpportunity | null;
  reason?: string;
};

function readyResponse(spec: ResponseSpec): BadgePlanningReadyResponse {
  const money = spec.money === undefined ? (["USD", 2] as [string, number]) : spec.money;
  return {
    status: "ready",
    reason: spec.reason ?? "ready",
    generated_at: GENERATED_AT,
    valid_until: spec.validUntil ?? VALID_UNTIL,
    currency_code: money === null ? null : money[0],
    minor_digits: money === null ? null : money[1],
    inventory_refreshed_at: defaultRequest.inventory_refreshed_at,
    badge_refreshed_at: defaultRequest.badge_refreshed_at,
    player_xp: PLAYER_XP,
    player_level: PLAYER_LEVEL,
    scope: spec.scope,
    evaluated_game_count: spec.games.length,
    games: structuredClone(spec.games),
    plans: structuredClone(spec.plans),
    opportunity: spec.opportunity === undefined ? null : spec.opportunity
  };
}

function unavailableResponse(
  spec: Omit<ResponseSpec, "plans" | "validUntil" | "opportunity"> & { opportunity?: null }
): BadgePlanningUnavailableResponse {
  const money = spec.money === undefined ? (["USD", 2] as [string, number]) : spec.money;
  return {
    status: "unavailable",
    reason: spec.reason ?? "price_generation_stale",
    generated_at: GENERATED_AT,
    valid_until: null,
    currency_code: money === null ? null : money[0],
    minor_digits: money === null ? null : money[1],
    inventory_refreshed_at: defaultRequest.inventory_refreshed_at,
    badge_refreshed_at: defaultRequest.badge_refreshed_at,
    player_xp: PLAYER_XP,
    player_level: PLAYER_LEVEL,
    scope: spec.scope,
    evaluated_game_count: spec.games.length,
    games: structuredClone(spec.games),
    plans: [],
    opportunity: null
  };
}

const defaultGames: BadgeGame[] = [
  gameRow("10", "Orbital Quest", sourceHashes.map((hash) => cardRow(hash, 2)))
];
const defaultPlans = threePlans(defaultGames, [["10", 2]], {
  targetLevel: 12,
  budgetMinor: 10_000
});

function defaultResponse(): BadgePlanningReadyResponse {
  return readyResponse({
    games: defaultGames,
    plans: defaultPlans,
    scope: "inventory_normal_badges"
  });
}

function saleRow(
  hash: string,
  buyer = 12,
  receipt = 10,
  timestamp = QUOTE_TS
): BadgeSale {
  return {
    market_hash_name: hash,
    card_name: cardNameOf(hash),
    quantity: 1,
    buyer_total_minor: buyer,
    seller_receipt_minor: receipt,
    quote_timestamp: timestamp
  };
}

function catalogRequest(compareAppId: string | null): BadgePlanningRequest {
  return buildBadgePlanningRequest(
    baseRequest(inventoryGames, inventoryCards),
    makeOptions({ scope: "catalog", compare_app_id: compareAppId }),
    SNAPSHOT
  );
}

const catalogGames: BadgeGame[] = [
  defaultGames[0],
  gameRow(
    "20",
    "Nebula Drift",
    otherHashes.map((hash) => cardRow(hash, 0, 5, 2)),
    { status: "incomplete", reason: "set_incomplete", missing: 5, completion: 25 }
  )
];

const catalogPlans = threePlans(catalogGames, [["10", 2]], {
  targetLevel: 12,
  budgetMinor: 10_000
});

describe("buildBadgePlanningRequest", () => {
  it("normalizes the session snapshot into sorted unique wire rows", () => {
    const request = buildBadgePlanningRequest(
      baseRequest(inventoryGames, inventoryCards),
      makeOptions(),
      [{ app_id: 20, level: 0 }, { app_id: 10, level: 0 }]
    );
    expect(request.normal_badge_levels).toEqual([
      { app_id: 10, level: 0 },
      { app_id: 20, level: 0 }
    ]);
    expect(isBadgePlanningRequest(request)).toBe(true);
  });

  it("rejects scope/mode pairing violations", () => {
    const base = baseRequest(inventoryGames, inventoryCards);
    expect(() =>
      buildBadgePlanningRequest(base, makeOptions({ mode: "collector" }), SNAPSHOT)
    ).toThrow();
    expect(() =>
      buildBadgePlanningRequest(base, makeOptions({ mode: "collector", target_level: null, collector_targets: [{ app_id: "10", target_level: 2 }] }), SNAPSHOT)
    ).not.toThrow();
    expect(() =>
      buildBadgePlanningRequest(base, makeOptions({ scope: "selected" }), SNAPSHOT)
    ).toThrow();
    expect(() =>
      buildBadgePlanningRequest(base, makeOptions({ selected_app_ids: ["10"] }), SNAPSHOT)
    ).toThrow();
    expect(() =>
      buildBadgePlanningRequest(base, makeOptions({ target_level: null }), SNAPSHOT)
    ).toThrow();
    expect(() =>
      buildBadgePlanningRequest(
        base,
        makeOptions({ mode: "budget", target_level: 12, collector_targets: [] }),
        SNAPSHOT
      )
    ).toThrow();
  });

  it("rejects inventory badge levels that disagree with the snapshot", () => {
    expect(() =>
      buildBadgePlanningRequest(
        baseRequest(inventoryGames, inventoryCards),
        makeOptions(),
        [{ app_id: 10, level: 1 }, { app_id: 20, level: 0 }]
      )
    ).toThrow();
    expect(() =>
      buildBadgePlanningRequest(baseRequest(inventoryGames, inventoryCards), makeOptions(), [
        { app_id: 10, level: 0 },
        { app_id: 10, level: 1 }
      ])
    ).toThrow();
  });
});

describe("isBadgePlanningOptions", () => {
  it("rejects unknown keys, bad ids and out-of-bounds numbers", () => {
    expect(isBadgePlanningOptions({ ...makeOptions(), extra: true }, inventoryCards)).toBe(false);
    expect(isBadgePlanningOptions(makeOptions({ compare_app_id: "10x" }), inventoryCards)).toBe(false);
    expect(isBadgePlanningOptions(makeOptions({ compare_app_id: "0123" }), inventoryCards)).toBe(false);
    expect(isBadgePlanningOptions(makeOptions({ budget_minor: 1_000_000_001 }), inventoryCards)).toBe(false);
    expect(isBadgePlanningOptions(makeOptions({ target_level: 100_001 }), inventoryCards)).toBe(false);
  });

  it("bounds and pairs the selection and collector id scopes", () => {
    expect(
      isBadgePlanningOptions(
        makeOptions({ selected_app_ids: Array.from({ length: MAX_BADGE_PLANNING_SCOPE_IDS + 1 }, (_, i) => String(i + 1)) }),
        inventoryCards
      )
    ).toBe(false);
    expect(
      isBadgePlanningOptions(
        makeOptions({
          mode: "collector",
          target_level: null,
          collector_targets: [
            { app_id: "10", target_level: 0 },
            { app_id: "20", target_level: 6 }
          ]
        }),
        inventoryCards
      )
    ).toBe(false);
    expect(
      isBadgePlanningOptions(
        makeOptions({
          mode: "collector",
          target_level: null,
          collector_targets: [
            { app_id: "10", target_level: 2 },
            { app_id: "10", target_level: 3 }
          ]
        }),
        inventoryCards
      )
    ).toBe(false);
  });

  it("still anchors protections to owned cards", () => {
    expect(
      isBadgePlanningOptions(
        makeOptions({
          protections: [{ market_hash_name: "30-Card 0 (Trading Card)", keep_quantity: 1, never_sell: false }]
        }),
        inventoryCards
      )
    ).toBe(false);
    expect(
      isBadgePlanningOptions(
        makeOptions({
          protections: [{ market_hash_name: sourceHashes[0], keep_quantity: 3, never_sell: false }]
        }),
        inventoryCards
      )
    ).toBe(false);
    expect(
      isBadgePlanningOptions(
        makeOptions({
          protections: [{ market_hash_name: sourceHashes[0], keep_quantity: 1, never_sell: true }]
        }),
        inventoryCards
      )
    ).toBe(true);
  });
});

describe("isBadgePlanningRequest", () => {
  it("requires the complete normal badge snapshot on the wire", () => {
    const { normal_badge_levels, ...withoutSnapshot } = defaultRequest;
    expect(normal_badge_levels.length).toBeGreaterThan(0);
    expect(isBadgePlanningRequest(withoutSnapshot)).toBe(false);
    expect(
      isBadgePlanningRequest({ ...defaultRequest, normal_badge_levels: [{ app_id: 20, level: 0 }, { app_id: 10, level: 0 }] })
    ).toBe(false);
    expect(
      isBadgePlanningRequest({ ...defaultRequest, normal_badge_levels: [{ app_id: 10, level: 0 }, { app_id: 10, level: 1 }] })
    ).toBe(false);
    expect(
      isBadgePlanningRequest({ ...defaultRequest, normal_badge_levels: [{ app_id: 10, level: 6 }] })
    ).toBe(false);
    expect(
      isBadgePlanningRequest({ ...defaultRequest, normal_badge_levels: [{ app_id: 0, level: 0 }] })
    ).toBe(false);
    expect(isBadgePlanningRequest(defaultRequest)).toBe(true);
  });

  it("cross-checks inventory badge levels against the snapshot", () => {
    const staleGames = inventoryGames.map((game) => ({ ...game, badge_level: 1 }));
    expect(() => buildBadgePlanningRequest(
      baseRequest(staleGames, inventoryCards),
      makeOptions(),
      SNAPSHOT
    )).toThrow();
    expect(isBadgePlanningRequest({ ...defaultRequest, games: staleGames })).toBe(false);
  });
});

describe("isBadgePlanningResponse", () => {
  it("accepts a coherent ready inventory response", () => {
    const response = defaultResponse();
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, defaultRequest)).toBe(true);
  });

  it("rejects stale quote timestamps", () => {
    const response = defaultResponse();
    response.games[0].cards[0].quote_timestamp = FUTURE_TS;
    expect(isBadgePlanningResponse(response)).toBe(false);
  });

  it("rejects inconsistent purchase money", () => {
    const request = buildBadgePlanningRequest(
      baseRequest(inventoryGames, inventoryCards),
      makeOptions({ mode: "target", target_level: 13, budget_minor: 60 }),
      SNAPSHOT
    );
    const games = defaultGames;
    const plans = threePlans(games, [["10", 3]], {
      targetLevel: 13,
      budgetMinor: 60,
      status: "partial",
      reason: "budget_insufficient"
    });
    const response = readyResponse({ games, plans, scope: "inventory_normal_badges" });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, request)).toBe(true);
    const tampered = structuredClone(response);
    tampered.plans[0].steps[0].purchases[0].total_minor += 1;
    expect(isBadgePlanningResponse(tampered)).toBe(false);
    const staleQuote = structuredClone(response);
    staleQuote.plans[0].steps[0].purchases[0].quote_timestamp = FUTURE_TS;
    expect(isBadgePlanningResponse(staleQuote)).toBe(false);
  });

  it("rejects snapshot-stale game rows against the request snapshot", () => {
    const games = structuredClone(defaultGames);
    games[0].badge_level = 1;
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "inventory_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, defaultRequest)).toBe(false);
  });

  it("rejects an explicit count that disagrees with the returned rows", () => {
    const response = defaultResponse();
    const tampered: unknown = { ...response, evaluated_game_count: 2 };
    expect(isBadgePlanningResponse(tampered)).toBe(false);
  });

  it("rejects unknown response scopes", () => {
    const tampered: unknown = { ...defaultResponse(), scope: "everything_badges" };
    expect(isBadgePlanningResponse(tampered)).toBe(false);
  });

  it("rejects rows outside the request inventory in inventory scope", () => {
    const games = [
      defaultGames[0],
      gameRow("30", "Aster Run", thirdHashes.map((hash) => cardRow(hash, 0, 5, 2)), {
        status: "incomplete",
        reason: "set_incomplete"
      })
    ];
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "inventory_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, defaultRequest)).toBe(false);
  });

  it("rejects ready responses with wrong plan counts or windows", () => {
    expect(
      isBadgePlanningResponse({ ...defaultResponse(), plans: defaultPlans.slice(0, 2) })
    ).toBe(false);
    expect(
      isBadgePlanningResponse({ ...defaultResponse(), valid_until: "2026-09-05T11:00:00Z" })
    ).toBe(false);
  });

  it("rejects unavailable responses that carry plans or an opportunity", () => {
    const response = unavailableResponse({ games: defaultGames, scope: "inventory_normal_badges" });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(isBadgePlanningResponse({ ...response, plans: defaultPlans })).toBe(false);
    expect(isBadgePlanningResponse({ ...response, opportunity: null })).toBe(true);
  });
});

describe("selected scope contract", () => {
  const selectedRequest = buildBadgePlanningRequest(
    baseRequest(inventoryGames, inventoryCards),
    makeOptions({ scope: "selected", selected_app_ids: ["10", "30"] }),
    SNAPSHOT
  );

  function selectedGames(): BadgeGame[] {
    return [
      defaultGames[0],
      gameRow("30", "Aster Run", thirdHashes.map((hash) => cardRow(hash, 0, 5, 2)), {
        status: "incomplete",
        reason: "set_incomplete",
        missing: 5,
        completion: 25
      })
    ];
  }

  it("accepts legitimate zero-owned rows for selected candidates", () => {
    const games = selectedGames();
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "selected_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, selectedRequest)).toBe(true);
  });

  it("rejects plans that craft unselected games", () => {
    const games = selectedGames();
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 1]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "selected_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    const onlyUnowned = structuredClone(selectedRequest);
    onlyUnowned.options.selected_app_ids = ["30"];
    expect(responseMatchesRequest(response, onlyUnowned)).toBe(false);
  });

  it("rejects extra zero-owned rows outside the selection", () => {
    const games = selectedGames();
    const restrictive = buildBadgePlanningRequest(
      baseRequest(inventoryGames, inventoryCards),
      makeOptions({ scope: "selected", selected_app_ids: ["10"] }),
      SNAPSHOT
    );
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "selected_normal_badges"
    });
    expect(responseMatchesRequest(response, restrictive)).toBe(false);
  });
});

describe("collector scope contract", () => {
  const collectorHashes = [...sourceHashes, ...otherHashes, ...thirdHashes];
  const collectorGames: LevelUpGame[] = [
    { app_id: "10", game_name: "Orbital Quest", card_set_size: 5, badge_level: 0 },
    { app_id: "20", game_name: "Nebula Drift", card_set_size: 5, badge_level: 0 },
    { app_id: "30", game_name: "Aster Run", card_set_size: 5, badge_level: 0 }
  ];
  const collectorCards: LevelUpCardOwnership[] = collectorHashes.map((hash) => ({
    market_hash_name: hash,
    owned_quantity: hash.startsWith("10-") ? 2 : 1,
    sellable_quantity: hash.startsWith("10-") ? 2 : 1
  }));
  const collectorSnapshot: LevelUpNormalBadgeLevel[] = [
    { app_id: 10, level: 0 },
    { app_id: 20, level: 0 },
    { app_id: 30, level: 0 }
  ];
  const collectorRequest = buildBadgePlanningRequest(
    baseRequest(collectorGames, collectorCards),
    makeOptions({
      mode: "collector",
      target_level: null,
      collector_targets: [
        { app_id: "10", target_level: 2 },
        { app_id: "20", target_level: 1 }
      ]
    }),
    collectorSnapshot
  );

  function collectorResponseGames(): BadgeGame[] {
    return [
      gameRow("10", "Orbital Quest", sourceHashes.map((hash) => cardRow(hash, 2)), { target: 2 }),
      gameRow("20", "Nebula Drift", otherHashes.map((hash) => cardRow(hash, 1, 5, 2)), { target: 1 }),
      gameRow("30", "Aster Run", thirdHashes.map((hash) => cardRow(hash, 1, 5, 2)))
    ];
  }

  it("accepts collector plans that reach every target goal", () => {
    const games = collectorResponseGames();
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 5], ["20", 2]], {
        targetLevel: null,
        budgetMinor: 10_000,
        targetReached: true
      }),
      scope: "inventory_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, collectorRequest)).toBe(true);
  });

  it("rejects collector rows whose target badge level disagrees", () => {
    const games = collectorResponseGames();
    games[0].target_badge_level = 3;
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 5], ["20", 2]], {
        targetLevel: null,
        budgetMinor: 10_000,
        targetReached: true
      }),
      scope: "inventory_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, collectorRequest)).toBe(false);
  });

  it("rejects inconsistent shortfall and target-reached reporting", () => {
    const games = collectorResponseGames();
    const wrongShortfall = threePlans(games, [["10", 5], ["20", 2]], {
      targetLevel: null,
      budgetMinor: 10_000,
      targetReached: true,
      shortfallXp: 100
    });
    const wrongReached = threePlans(games, [["10", 5], ["20", 2]], {
      targetLevel: null,
      budgetMinor: 10_000,
      targetReached: false
    });
    for (const plans of [wrongShortfall, wrongReached]) {
      const response = readyResponse({
        games,
        plans,
        scope: "inventory_normal_badges"
      });
      expect(isBadgePlanningResponse(response)).toBe(true);
      expect(responseMatchesRequest(response, collectorRequest)).toBe(false);
    }
  });

  it("rejects collector plans that craft untargeted games", () => {
    const games = collectorResponseGames();
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 5], ["20", 2], ["30", 1]], {
        targetLevel: null,
        budgetMinor: 10_000,
        targetReached: true
      }),
      scope: "inventory_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, collectorRequest)).toBe(false);
  });
});

describe("catalog scope contract", () => {
  it("accepts catalog rows the player does not own", () => {
    const request = catalogRequest(null);
    const response = readyResponse({
      games: catalogGames,
      plans: catalogPlans,
      scope: "catalog_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, request)).toBe(true);
  });

  it("rejects phantom ownership and snapshot-stale catalog rows", () => {
    const request = catalogRequest(null);
    const phantom = structuredClone(catalogGames);
    phantom[1].cards[0].owned_quantity = 1;
    phantom[1].cards[0].available_quantity = 1;
    phantom[1].owned_unique = 1;
    phantom[1].owned_cards = 1;
    phantom[1].available_unique = 1;
    const phantomResponse = readyResponse({
      games: phantom,
      plans: catalogPlans,
      scope: "catalog_normal_badges"
    });
    expect(isBadgePlanningResponse(phantomResponse)).toBe(true);
    expect(responseMatchesRequest(phantomResponse, request)).toBe(false);

    const staleRow = structuredClone(catalogGames);
    staleRow[1].badge_level = 1;
    const staleResponse = readyResponse({
      games: staleRow,
      plans: catalogPlans,
      scope: "catalog_normal_badges"
    });
    expect(responseMatchesRequest(staleResponse, request)).toBe(false);
  });

  it("rejects a response scope that does not map the request scope", () => {
    const request = catalogRequest(null);
    const response = readyResponse({
      games: catalogGames,
      plans: catalogPlans,
      scope: "selected_normal_badges"
    });
    expect(responseMatchesRequest(response, request)).toBe(false);
  });

  it("rejects discovery responses that discard owned inventory rows", () => {
    const response = readyResponse({
      games: [],
      plans: threePlans([], [], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, catalogRequest(null))).toBe(false);
  });

  it("admits a full-size catalog and rejects rows beyond the coordinated bound", () => {
    const rows = Array.from({ length: MAX_BADGE_PLANNING_CATALOG_GAME_ROWS }, (_, i) =>
      gameRow(String(i + 1), `Game ${i + 1}`, [])
    );
    const plans = threePlans(rows, [], { targetLevel: 12, budgetMinor: 10_000 });
    const full = readyResponse({
      games: rows,
      plans,
      scope: "catalog_normal_badges"
    });
    expect(isBadgePlanningResponse(full)).toBe(true);
    const tooLarge = readyResponse({
      games: [...rows, gameRow("99999999", "One Too Many", [])],
      plans,
      scope: "catalog_normal_badges"
    });
    expect(isBadgePlanningResponse(tooLarge)).toBe(false);
  });
});

describe("complete-set opportunity contract", () => {
  const opportunityBaseGames: LevelUpGame[] = [
    { app_id: "10", game_name: "Orbital Quest", card_set_size: 5, badge_level: 0 },
    { app_id: "30", game_name: "Aster Run", card_set_size: 5, badge_level: 0 }
  ];
  const opportunityBaseCards: LevelUpCardOwnership[] = [
    ...sourceHashes.map((hash) => ({ market_hash_name: hash, owned_quantity: 2, sellable_quantity: 2 })),
    ...thirdHashes.map((hash) => ({ market_hash_name: hash, owned_quantity: 1, sellable_quantity: 1 }))
  ];
  const opportunityRequest = buildBadgePlanningRequest(
    baseRequest(opportunityBaseGames, opportunityBaseCards),
    makeOptions({ scope: "catalog", compare_app_id: "10" }),
    SNAPSHOT
  );
  const plainCatalogRequest = buildBadgePlanningRequest(
    baseRequest(opportunityBaseGames, opportunityBaseCards),
    makeOptions({ scope: "catalog" }),
    SNAPSHOT
  );
  const opportunityGames: BadgeGame[] = [
    defaultGames[0],
    gameRow("30", "Aster Run", thirdHashes.map((hash) => cardRow(hash, 1, 5, 2)))
  ];

  function replacementPlan(): BadgePlan {
    return planFor({
      strategy: "cheapest",
      executed: [["30", 3]],
      games: opportunityGames,
      targetLevel: null,
      budgetMinor: 50
    });
  }

  function opportunity(overrides: Partial<BadgeOpportunity> = {}): BadgeOpportunity {
    const replacement = replacementPlan();
    const baseline = planFor({
      strategy: "cheapest",
      executed: [["10", 2], ["30", 1]],
      games: opportunityGames,
      targetLevel: null,
      budgetMinor: 0
    });
    return {
      app_id: "10",
      status: "ready",
      reason: "complete_set_sale",
      net_proceeds_minor: 50,
      craft_xp: BADGE_CRAFT_XP,
      sales: sourceHashes.map((hash) => saleRow(hash)),
      replacement_plan: replacement,
      baseline_plan: baseline,
      additional_xp: replacement.xp_gain - baseline.xp_gain,
      valid_until: GENERATED_AT,
      ...overrides
    };
  }

  it("accepts sale-funded crafts alongside the original free-craft baseline", () => {
    const response = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: opportunity()
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, opportunityRequest)).toBe(true);
  });

  it("rejects replacements that ignore available non-source cards", () => {
    const games = structuredClone(opportunityGames);
    games[1].cards[0].owned_quantity += 1;
    games[1].cards[0].available_quantity += 1;
    games[1].owned_cards += 1;
    const response = readyResponse({
      games,
      plans: threePlans(games, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: opportunity()
    });
    expect(isBadgePlanningResponse(response)).toBe(false);
  });

  it("rejects replacements that craft or purchase the source game", () => {
    const replacement = planFor({
      strategy: "cheapest",
      executed: [["10", 1]],
      games: opportunityGames,
      targetLevel: null,
      budgetMinor: 0
    });
    const response = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: opportunity({ replacement_plan: replacement, additional_xp: replacement.xp_gain - 200 })
    });
    expect(isBadgePlanningResponse(response)).toBe(false);
  });

  it("rejects unconserved sales and stale bid quotes", () => {
    const cases: Array<Partial<BadgeOpportunity>> = [
      { net_proceeds_minor: 51 },
      { sales: sourceHashes.map((hash) => saleRow(hash, 12, 10)).slice(0, 4) },
      { sales: [...sourceHashes.map((hash) => saleRow(hash)), saleRow(otherHashes[0])] },
      { sales: sourceHashes.map((hash, i) => saleRow(hash, 12, 10, i === 0 ? FUTURE_TS : QUOTE_TS)) }
    ];
    for (const overrides of cases) {
      const response = readyResponse({
        games: opportunityGames,
        plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
        scope: "catalog_normal_badges",
        opportunity: opportunity(overrides)
      });
      expect(isBadgePlanningResponse(response)).toBe(false);
    }
  });

  it("rejects a partial-set sale even when every monetary total balances", () => {
    const replacement = planFor({
      strategy: "cheapest",
      executed: [["30", 1]],
      games: opportunityGames,
      targetLevel: null,
      budgetMinor: 40
    });
    const response = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: opportunity({
        sales: sourceHashes.slice(0, 4).map((hash) => saleRow(hash)),
        net_proceeds_minor: 40,
        replacement_plan: replacement,
        additional_xp: replacement.xp_gain - 300
      })
    });
    expect(isBadgePlanningResponse(response)).toBe(false);
  });

  it("rejects replacement funding beyond the net receipts", () => {
    const comparison = opportunity();
    comparison.replacement_plan!.remaining_budget_minor += 1;
    const response = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: comparison
    });
    expect(isBadgePlanningResponse(response)).toBe(false);
  });

  it("rejects sale advice for a card with no marketable copies", () => {
    const request = structuredClone(opportunityRequest);
    request.cards[0].sellable_quantity = 0;
    const response = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: opportunity()
    });
    expect(responseMatchesRequest(response, request)).toBe(false);
  });

  it("rejects sale rows with non-unit quantity", () => {
    const sales = sourceHashes.map((hash, i) =>
      i === 0 ? { ...saleRow(hash), quantity: 2 } : saleRow(hash)
    );
    const response = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: opportunity({ sales, net_proceeds_minor: 50 })
    });
    expect(isBadgePlanningResponse(response)).toBe(false);
  });

  it("rejects craft xp, additional xp and validity window violations", () => {
    const cases: Array<Partial<BadgeOpportunity>> = [
      { craft_xp: 50 },
      { additional_xp: 1 },
      { valid_until: "2026-09-05T12:10:00Z" },
      { valid_until: "2026-09-05T11:55:00Z" }
    ];
    for (const overrides of cases) {
      const response = readyResponse({
        games: opportunityGames,
        plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
        scope: "catalog_normal_badges",
        opportunity: opportunity(overrides)
      });
      expect(isBadgePlanningResponse(response)).toBe(false);
    }
  });

  it("rejects an unavailable comparison that carries quotes or plans", () => {
    const blocked = opportunity({
      status: "unavailable",
      reason: "source_badge_maxed",
      net_proceeds_minor: null,
      sales: [],
      replacement_plan: null,
      baseline_plan: null,
      additional_xp: null,
      valid_until: null
    });
    const clean = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: blocked
    });
    expect(isBadgePlanningResponse(clean)).toBe(true);
    expect(responseMatchesRequest(clean, opportunityRequest)).toBe(true);
    expect(
      isBadgePlanningResponse({
        ...clean,
        opportunity: { ...blocked, net_proceeds_minor: 50 }
      })
    ).toBe(false);
  });

  it("pairs the opportunity strictly with the on-demand compare id", () => {
    const plainRequest = plainCatalogRequest;
    const withOpportunity = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      opportunity: opportunity()
    });
    expect(responseMatchesRequest(withOpportunity, plainRequest)).toBe(false);
    const withoutOpportunity = readyResponse({
      games: opportunityGames,
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges"
    });
    expect(responseMatchesRequest(withoutOpportunity, opportunityRequest)).toBe(false);
  });

  it("accepts an unavailable comparison without a confirmed currency", () => {
    const response = readyResponse({
      games: [
        gameRow("10", "Orbital Quest", sourceHashes.map((hash) => cardRow(hash, 2, null))),
        gameRow("30", "Aster Run", thirdHashes.map((hash) => cardRow(hash, 1, null)))
      ],
      plans: threePlans(opportunityGames, [["10", 2]], { targetLevel: 12, budgetMinor: 10_000 }),
      scope: "catalog_normal_badges",
      money: null,
      opportunity: opportunity({
        status: "unavailable",
        reason: "currency_contract_missing",
        net_proceeds_minor: null,
        sales: [],
        replacement_plan: null,
        baseline_plan: null,
        additional_xp: null,
        valid_until: null
      })
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, opportunityRequest)).toBe(true);
  });
});

describe("budget mode contract", () => {
  it("rejects budget plans that report a shortfall", () => {
    const request = buildBadgePlanningRequest(
      baseRequest(inventoryGames, inventoryCards),
      makeOptions({ mode: "budget", target_level: null }),
      SNAPSHOT
    );
    const response = readyResponse({
      games: defaultGames,
      plans: threePlans(defaultGames, [["10", 2]], {
        targetLevel: null,
        budgetMinor: 10_000,
        shortfallXp: 100
      }),
      scope: "inventory_normal_badges"
    });
    expect(isBadgePlanningResponse(response)).toBe(true);
    expect(responseMatchesRequest(response, request)).toBe(false);
  });
});

describe("requestBadgePlanning", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(payload: unknown, ok = true): Mock {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(ok ? JSON.stringify(payload) : "boom", { status: ok ? 200 : 502 })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts the validated request and returns the parsed response", async () => {
    const response = defaultResponse();
    const fetchMock = stubFetch(response);
    const parsed = await requestBadgePlanning(STEAM_ID, defaultRequest, null);
    expect(parsed).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/badge-planning");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Expected-Steam-ID")).toBe(STEAM_ID);
    expect(JSON.parse(String(init?.body))).toEqual(defaultRequest);
  });

  it("throws when the response breaks request identity or structure", async () => {
    const stale = defaultResponse();
    stale.games[0].badge_level = 1;
    stubFetch(stale);
    await expect(requestBadgePlanning(STEAM_ID, defaultRequest, null)).rejects.toThrow(
      "The badge planning service returned an invalid response."
    );
    stubFetch({ nope: true });
    await expect(requestBadgePlanning(STEAM_ID, defaultRequest, null)).rejects.toThrow(
      "The badge planning service returned an invalid response."
    );
  });

  it("throws on transport errors and currency contract changes", async () => {
    stubFetch(defaultResponse(), false);
    await expect(requestBadgePlanning(STEAM_ID, defaultRequest, null)).rejects.toThrow(
      "The badge planning service returned an error."
    );
    const european = { ...defaultResponse(), currency_code: "EUR" };
    stubFetch(european);
    await expect(
      requestBadgePlanning(STEAM_ID, defaultRequest, { currency_code: "USD", minor_digits: 2 })
    ).rejects.toBeInstanceOf(BadgePlanningCurrencyChangeError);
  });
});

describe("expiry and input parsing", () => {
  it("treats the validity window as half-open", () => {
    expect(isBadgePlanningResponseExpired(defaultResponse(), Date.parse(VALID_UNTIL))).toBe(true);
    expect(isBadgePlanningResponseExpired(defaultResponse(), Date.parse(VALID_UNTIL) - 1)).toBe(false);
  });

  it("rejects invalid steam ids before any network call", async () => {
    await expect(requestBadgePlanning("0x123", defaultRequest, null)).rejects.toThrow(
      "The SteamID is invalid."
    );
  });

  it("parses budgets without floating point error", () => {
    expect(parseBudgetMinorUnits("12.34", 2)).toEqual({ ok: true, minor: 1234 });
    expect(parseBudgetMinorUnits("12.345", 2).ok).toBe(false);
    expect(parseBudgetMinorUnits("12.3", 0).ok).toBe(false);
    expect(parseBudgetMinorUnits("", 2).ok).toBe(false);
  });

  it("parses target levels", () => {
    expect(parseTargetLevelInput("12")).toEqual({ ok: true, level: 12 });
    expect(parseTargetLevelInput("abc").ok).toBe(false);
    expect(parseTargetLevelInput("100001").ok).toBe(false);
  });

  it("asserts responses loudly", () => {
    expect(() => assertBadgePlanningResponse({})).toThrow();
  });
});
