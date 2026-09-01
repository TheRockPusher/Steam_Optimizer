import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LevelUpOptimizationPanel,
  type LevelUpOptimizationPanelProps
} from "./LevelUpOptimizationPanel";
import {
  aggregateNormalCardOwnership,
  buildLevelUpOptimizationRequest,
  buildSteamMarketListingUrl,
  buildSteamProfileGamecardsUrl,
  formatMinorUnits,
  isLevelUpOptimizationResponse,
  levelUpSnapshotKey,
  requestLevelUpOptimization,
  type LevelUpOptimizationResponse,
  type LevelUpReadyResponse
} from "./levelUpOptimization";

const generatedAt = "2026-08-29T12:00:00Z";
const inventoryRefreshedAt = "2026-08-29T11:30:00Z";
const badgeRefreshedAt = "2026-08-29T11:45:00Z";
const steamId = "76561198000000001";

const badges = {
  status: "public" as const,
  message: "Steam badge data is available.",
  player_xp: 1_250,
  player_level: 11,
  checked_at: badgeRefreshedAt,
  normal_badge_levels: []
};

const boosters = [
  {
    game_app_id: "440",
    game_name: "Team Fortress 2",
    card_set_size: 5
  },
  {
    game_app_id: "570",
    game_name: "Dota 2",
    card_set_size: 5
  }
];

function sellRow(appId: string, index: number) {
  return {
    market_hash_name: `${appId}-Source ${index} (Trading Card)`,
    card_name: `Source ${index}`,
    quantity: 1 as const,
    buyer_total: 15,
    steam_fee: 1,
    publisher_fee: 1,
    seller_receipt: 13,
    top_bid_quantity: 2,
    quote_timestamp: "2026-08-29T11:59:00Z"
  };
}

function buyRow(appId: string, index: number) {
  return {
    market_hash_name: `${appId}-Destination ${index} (Trading Card)`,
    card_name: `Destination ${index}`,
    quantity: 1 as const,
    buyer_total: 6,
    top_ask_quantity: 3,
    quote_timestamp: "2026-08-29T11:59:00Z"
  };
}

function readyResponse(): LevelUpReadyResponse {
  const sourceRows = [sellRow("440", 0)];
  const destinationRows = Array.from({ length: 2 }, (_, index) =>
    buyRow("570", index)
  );
  return {
    status: "ready",
    reason: "ready",
    generated_at: generatedAt,
    inventory_refreshed_at: inventoryRefreshedAt,
    currency_code: "USD",
    minor_digits: 2,
    price_basis: "instant_top_of_book",
    steam_fee_bps: 500,
    publisher_fee_bps: 1_000,
    min_fee_minor: 1,
    taxes_included: false,
    scope_limited: false,
    valid_until: "2026-08-29T12:15:00Z",
    player: {
      current_xp: 1_250,
      current_level: 11,
      xp_to_next_level: 150,
      projected_xp: 1_350,
      projected_level: 11,
      projected_xp_to_next_level: 50
    },
    source: {
      app_id: "440",
      game_name: "Team Fortress 2",
      badge_level: 0,
      set_size: 5,
      rows: sourceRows
    },
    destinations: [
      {
        app_id: "570",
        game_name: "Dota 2",
        badge_level_before: 0,
        badge_level_after: 1,
        set_size: 5,
        owned_card_count: 3,
        rows: destinationRows,
        missing_cards_total: 12,
        craft_xp: 100
      }
    ],
    totals: {
      source_buyer_total: 15,
      steam_fee_total: 1,
      publisher_fee_total: 1,
      seller_receipt_total: 13,
      purchase_total: 12,
      unspent_swap_proceeds: 1,
      foregone_craft_xp: 0,
      funded_craft_xp: 100,
      xp_advantage: 100,
      destination_count: 1,
      scope_limited: false
    }
  };
}

function responseWithStatus(
  status: "no_opportunity" | "unavailable",
  reason:
    | "no_sellable_card"
    | "no_positive_xp_swap"
    | "price_generation_stale"
    | "badge_data_unavailable"
    | "steamapi_key_missing"
): LevelUpOptimizationResponse {
  return {
    status,
    reason,
    generated_at: generatedAt,
    inventory_refreshed_at: inventoryRefreshedAt,
    currency_code: "USD",
    minor_digits: 2,
    price_basis: "instant_top_of_book",
    steam_fee_bps: 500,
    publisher_fee_bps: 1_000,
    min_fee_minor: 1,
    taxes_included: false,
    scope_limited: false,
    valid_until: null,
    player: null,
    source: null,
    destinations: [],
    totals: null
  } as LevelUpOptimizationResponse;
}

const inventoryItems = [
  {
    market_hash_name: "440-Source 0 (Trading Card)",
    quantity: 2,
    marketable: true,
    tradable: true,
    item_type: "trading_card",
    game_app_id: "440",
    game_name: "Team Fortress 2",
    icon_url: "https://community.cloudflare.steamstatic.com/economy/image/source-0"
  },
  {
    market_hash_name: "440-Source 0 (Trading Card)",
    quantity: 1,
    marketable: true,
    tradable: false,
    item_type: "trading_card"
  },
  {
    market_hash_name: "440-Source 1 (Trading Card)",
    quantity: 1,
    marketable: false,
    tradable: true,
    item_type: "trading_card"
  },
  {
    market_hash_name: "570-Owned 0 (Trading Card)",
    quantity: 1,
    marketable: false,
    tradable: true,
    item_type: "trading_card",
    game_app_id: "570",
    game_name: "Dota 2"
  },
  {
    market_hash_name: "570-Owned 1 (Trading Card)",
    quantity: 1,
    marketable: false,
    tradable: true,
    item_type: "trading_card",
    game_app_id: "570",
    game_name: "Dota 2"
  },
  {
    market_hash_name: "570-Owned 2 (Trading Card)",
    quantity: 1,
    marketable: false,
    tradable: true,
    item_type: "trading_card",
    game_app_id: "570",
    game_name: "Dota 2"
  },
  {
    market_hash_name: "440-Foil (Foil Trading Card)",
    quantity: 1,
    marketable: true,
    tradable: true,
    item_type: "trading_card"
  },
  {
    market_hash_name: "440-Background (Profile Background)",
    quantity: 2,
    marketable: true,
    tradable: true,
    item_type: "profile_background"
  }
];

function renderPanel(
  fetchResponse: LevelUpOptimizationResponse = readyResponse(),
  overrides: Partial<LevelUpOptimizationPanelProps> = {}
) {
  vi.mocked(globalThis.fetch).mockResolvedValue(
    new Response(JSON.stringify(fetchResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  );
  return render(
    <LevelUpOptimizationPanel
      steamId={steamId}
      inventoryStatus="public"
      items={inventoryItems}
      boosters={boosters}
      badges={badges}
      inventoryRefreshedAt={inventoryRefreshedAt}
      isInventoryLoading={false}
      isActive
      onRefreshInventory={vi.fn()}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(generatedAt));
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function flushPanelEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("normal-card ownership snapshots", () => {
  it("deduplicates exact normal hashes and counts every marketable copy", () => {
    expect(aggregateNormalCardOwnership(inventoryItems)).toEqual([
      {
        market_hash_name: "440-Source 0 (Trading Card)",
        owned_quantity: 3,
        sellable_quantity: 3
      },
      {
        market_hash_name: "440-Source 1 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      },
      {
        market_hash_name: "570-Owned 0 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      },
      {
        market_hash_name: "570-Owned 1 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      },
      {
        market_hash_name: "570-Owned 2 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      }
    ]);
  });
  it("includes every normal-card game and joins loaded badge and booster metadata", () => {
    const request = buildLevelUpOptimizationRequest(
      [
        ...inventoryItems,
        {
          market_hash_name: "730-Other Card (Trading Card)",
          quantity: 1,
          marketable: false,
          tradable: false,
          item_type: "trading_card",
          game_app_id: "730",
          game_name: "Counter-Strike 2"
        }
      ],
      [
        ...boosters,
        {
          game_app_id: "730",
          game_name: "Counter-Strike 2",
          card_set_size: null
        }
      ],
      {
        ...badges,
        normal_badge_levels: [{ app_id: 440, level: 3 }]
      },
      inventoryRefreshedAt
    );

    expect(request.games).toEqual([
      {
        app_id: "440",
        game_name: "Team Fortress 2",
        card_set_size: 5,
        badge_level: 3
      },
      {
        app_id: "570",
        game_name: "Dota 2",
        card_set_size: 5,
        badge_level: 0
      },
      {
        app_id: "730",
        game_name: "Counter-Strike 2",
        card_set_size: null,
        badge_level: 0
      }
    ]);
    expect(request.cards).toEqual([
      {
        market_hash_name: "440-Source 0 (Trading Card)",
        owned_quantity: 3,
        sellable_quantity: 3
      },
      {
        market_hash_name: "440-Source 1 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      },
      {
        market_hash_name: "570-Owned 0 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      },
      {
        market_hash_name: "570-Owned 1 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      },
      {
        market_hash_name: "570-Owned 2 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      },
      {
        market_hash_name: "730-Other Card (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      }
    ]);
  });
  it("rejects game names that exceed the inventory wire limit", () => {
    const item = {
      ...inventoryItems[0],
      game_name: "x".repeat(8193)
    };
    expect(() =>
      buildLevelUpOptimizationRequest(
        [item],
        [],
        badges,
        inventoryRefreshedAt
      )
    ).toThrow("Inventory game metadata is unavailable.");
  });
});

describe("strict response validation", () => {
  it("accepts a singular, partial, one-destination plan and rejects contradictory totals", () => {
    const response = readyResponse();
    expect(isLevelUpOptimizationResponse(response)).toBe(true);
    response.totals.purchase_total = 13;
    expect(isLevelUpOptimizationResponse(response)).toBe(false);
  });

  it("requires exactly one source row and consistent owned/missing destination counts", () => {
    const multipleSources = readyResponse();
    multipleSources.source.rows.push(sellRow("440", 1));
    multipleSources.totals.source_buyer_total = 30;
    multipleSources.totals.steam_fee_total = 2;
    multipleSources.totals.publisher_fee_total = 2;
    multipleSources.totals.seller_receipt_total = 26;
    multipleSources.totals.unspent_swap_proceeds = 14;
    expect(isLevelUpOptimizationResponse(multipleSources)).toBe(false);

    const contradictoryProgress = readyResponse();
    contradictoryProgress.destinations[0].owned_card_count = 2;
    expect(isLevelUpOptimizationResponse(contradictoryProgress)).toBe(false);
  });

  it("allows a sell source from a maxed badge game", () => {
    const response = readyResponse();
    response.source.badge_level = 5;
    expect(isLevelUpOptimizationResponse(response)).toBe(true);

    const contradictoryOpportunityCost = readyResponse();
    contradictoryOpportunityCost.source.badge_level = 5;
    contradictoryOpportunityCost.destinations.push({
      app_id: "580",
      game_name: "Left 4 Dead 2",
      badge_level_before: 0,
      badge_level_after: 1,
      set_size: 5,
      owned_card_count: 4,
      rows: [{ ...buyRow("580", 0), buyer_total: 1 }],
      missing_cards_total: 1,
      craft_xp: 100
    });
    contradictoryOpportunityCost.player.projected_xp = 1_450;
    contradictoryOpportunityCost.player.projected_level = 12;
    contradictoryOpportunityCost.player.projected_xp_to_next_level = 150;
    contradictoryOpportunityCost.totals.purchase_total = 13;
    contradictoryOpportunityCost.totals.unspent_swap_proceeds = 0;
    contradictoryOpportunityCost.totals.foregone_craft_xp = 100;
    contradictoryOpportunityCost.totals.funded_craft_xp = 200;
    contradictoryOpportunityCost.totals.xp_advantage = 100;
    contradictoryOpportunityCost.totals.destination_count = 2;
    expect(isLevelUpOptimizationResponse(contradictoryOpportunityCost)).toBe(false);
  });

  it("allows consistent post-sale destinations in the source app", () => {
    function sameAppResponse(): LevelUpReadyResponse {
      const response = readyResponse();
      response.destinations[0].app_id = "440";
      response.destinations[0].game_name = "Team Fortress 2";
      response.destinations[0].rows = [
        {
          ...buyRow("440", 0),
          market_hash_name: response.source.rows[0].market_hash_name,
          card_name: response.source.rows[0].card_name
        },
        buyRow("440", 1)
      ];
      return response;
    }

    const response = sameAppResponse();
    expect(isLevelUpOptimizationResponse(response)).toBe(true);
    response.destinations[0].badge_level_before = 1;
    response.destinations[0].badge_level_after = 2;
    expect(isLevelUpOptimizationResponse(response)).toBe(false);

    const wrongName = sameAppResponse();
    wrongName.destinations[0].game_name = "Different game";
    expect(isLevelUpOptimizationResponse(wrongName)).toBe(false);

    const wrongSetSize = sameAppResponse();
    wrongSetSize.destinations[0].set_size = 6;
    wrongSetSize.destinations[0].owned_card_count = 4;
    expect(isLevelUpOptimizationResponse(wrongSetSize)).toBe(false);
  });

  it("rejects a funded badge that does not exceed foregone craft XP", () => {
    const response = readyResponse();
    response.totals.foregone_craft_xp = 100;
    response.totals.xp_advantage = 0;
    expect(isLevelUpOptimizationResponse(response)).toBe(false);
  });

  it("accepts two funded badges when one immediate craft is foregone", () => {
    const response = readyResponse();
    const secondMissingRow = {
      ...buyRow("580", 0),
      buyer_total: 1
    };
    response.destinations.push({
      app_id: "580",
      game_name: "Left 4 Dead 2",
      badge_level_before: 2,
      badge_level_after: 3,
      set_size: 5,
      owned_card_count: 4,
      rows: [secondMissingRow],
      missing_cards_total: 1,
      craft_xp: 100
    });
    response.player.projected_xp = 1_450;
    response.player.projected_level = 12;
    response.player.projected_xp_to_next_level = 150;
    response.totals.purchase_total = 13;
    response.totals.unspent_swap_proceeds = 0;
    response.totals.foregone_craft_xp = 100;
    response.totals.funded_craft_xp = 200;
    response.totals.xp_advantage = 100;
    response.totals.destination_count = 2;
    expect(isLevelUpOptimizationResponse(response)).toBe(true);
  });

  it("accepts current no-opportunity and unavailable states", () => {
    expect(
      isLevelUpOptimizationResponse(
        responseWithStatus("no_opportunity", "no_sellable_card")
      )
    ).toBe(true);
    expect(
      isLevelUpOptimizationResponse(
        responseWithStatus("no_opportunity", "no_positive_xp_swap")
      )
    ).toBe(true);
    expect(
      isLevelUpOptimizationResponse(
        responseWithStatus("unavailable", "price_generation_stale")
      )
    ).toBe(true);
    expect(
      isLevelUpOptimizationResponse(
        responseWithStatus("unavailable", "steamapi_key_missing")
      )
    ).toBe(true);

    const staleReason = {
      ...responseWithStatus("no_opportunity", "no_sellable_card"),
      reason: "no_complete_sellable_set"
    };
    expect(isLevelUpOptimizationResponse(staleReason)).toBe(false);
  });

  it("rejects a scope-limited response that does not contain five destinations", () => {
    const response = readyResponse();
    response.scope_limited = true;
    response.totals.scope_limited = true;
    expect(isLevelUpOptimizationResponse(response)).toBe(false);
  });

  it("rejects obsolete catalog progress fields", () => {
    const response = {
      ...readyResponse(),
      catalog_total_sets: 1,
      catalog_resolved_sets: 1,
      catalog_pending_sets: 0
    };
    expect(isLevelUpOptimizationResponse(response)).toBe(false);
  });
});

describe("request and safe navigation helpers", () => {
  it("sends the expected SteamID header and snake_case body", async () => {
    renderPanel();
    await flushPanelEffects();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toMatch(/\/api\/auth\/level-up$/);
    expect(options?.method).toBe("POST");
    expect(options?.credentials).toBe("include");
    expect(new Headers(options?.headers).get("x-expected-steam-id")).toBe(steamId);
    expect(JSON.parse(String(options?.body))).toEqual({
      inventory_refreshed_at: inventoryRefreshedAt,
      badge_refreshed_at: badgeRefreshedAt,
      player_xp: 1_250,
      player_level: 11,
      games: [
        {
          app_id: "440",
          game_name: "Team Fortress 2",
          card_set_size: 5,
          badge_level: 0
        },
        {
          app_id: "570",
          game_name: "Dota 2",
          card_set_size: 5,
          badge_level: 0
        }
      ],
      cards: [
        {
          market_hash_name: "440-Source 0 (Trading Card)",
          owned_quantity: 3,
          sellable_quantity: 3
        },
        {
          market_hash_name: "440-Source 1 (Trading Card)",
          owned_quantity: 1,
          sellable_quantity: 0
        },
        {
          market_hash_name: "570-Owned 0 (Trading Card)",
          owned_quantity: 1,
          sellable_quantity: 0
        },
        {
          market_hash_name: "570-Owned 1 (Trading Card)",
          owned_quantity: 1,
          sellable_quantity: 0
        },
        {
          market_hash_name: "570-Owned 2 (Trading Card)",
          owned_quantity: 1,
          sellable_quantity: 0
        }
      ]
    });
  });
  it("rejects a response for a different submitted snapshot", async () => {
    const request = buildLevelUpOptimizationRequest(
      inventoryItems,
      boosters,
      badges,
      inventoryRefreshedAt
    );
    const response = readyResponse();
    response.inventory_refreshed_at = "2026-08-29T11:29:00Z";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(
      requestLevelUpOptimization(steamId, request)
    ).rejects.toThrow(
      "The level-up optimization service returned an invalid response."
    );
  });

  it("uses fixed Steam origins and encodes path segments", () => {
    expect(buildSteamMarketListingUrl("440-A/B?C (Trading Card)")).toBe(
      "https://steamcommunity.com/market/listings/753/440-A%2FB%3FC%20(Trading%20Card)"
    );
    expect(buildSteamMarketListingUrl("440-Literal%20Name (Trading Card)")).toBe(
      "https://steamcommunity.com/market/listings/753/440-Literal%2520Name%20(Trading%20Card)"
    );
    expect(buildSteamProfileGamecardsUrl(steamId, "440")).toBe(
      `https://steamcommunity.com/profiles/${steamId}/gamecards/440/`
    );
  });

  it("formats integer minor units with the configured currency", () => {
    expect(formatMinorUnits(1_234, "USD", 2)).toBe("$12.34");
  });
});

describe("lazy panel lifecycle and state surfaces", () => {
  it("shows pending inventory as loading before unavailable recovery", () => {
    renderPanel(readyResponse(), {
      inventoryStatus: "unavailable",
      isInventoryLoading: true
    });

    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Calculating a one-card level-up plan…"
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh inventory" })
    ).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("deduplicates the lazy request for an unchanged snapshot", async () => {
    renderPanel();
    await flushPanelEffects();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Instant top-of-book estimate.")).toBeInTheDocument();
  });
  it("rechecks a future snapshot when it becomes current", async () => {
    const futureInventoryRefreshedAt = "2026-08-29T12:01:00Z";
    const response = readyResponse();
    response.generated_at = "2026-08-29T12:01:01Z";
    response.inventory_refreshed_at = futureInventoryRefreshedAt;
    response.valid_until = "2026-08-29T13:00:00Z";
    renderPanel(response, {
      inventoryRefreshedAt: futureInventoryRefreshedAt
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Refresh inventory" })
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    await flushPanelEffects();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Instant top-of-book estimate.")).toBeInTheDocument();
  });
  it("refreshes badge data when the submitted badge snapshot is unavailable", async () => {
    const onRefreshBadges = vi.fn();
    renderPanel(
      responseWithStatus("unavailable", "badge_data_unavailable"),
      { onRefreshBadges }
    );
    await flushPanelEffects();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh badge data" })
    );
    expect(onRefreshBadges).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not POST when a normal-card game has no identity metadata", async () => {
    const missingGameNameItems = inventoryItems.map((item) =>
      item.item_type === "trading_card"
        ? { ...item, game_name: null }
        : item
    );
    renderPanel(undefined, {
      items: missingGameNameItems,
      boosters: []
    });
    await flushPanelEffects();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Game metadata unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh inventory" })).toBeInTheDocument();
  });

  it("keys the recommendation cache by the badge snapshot timestamp", () => {
    const originalKey = levelUpSnapshotKey(
      steamId,
      inventoryRefreshedAt,
      badgeRefreshedAt
    );
    const changedKey = levelUpSnapshotKey(
      steamId,
      inventoryRefreshedAt,
      "2026-08-29T11:46:00Z"
    );
    expect(originalKey).not.toBeNull();
    expect(changedKey).not.toBe(originalKey);
  });

  it("retains the same-key in-flight request while switching tabs", async () => {
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.mocked(globalThis.fetch).mockReturnValue(pendingResponse);
    const panelProps: LevelUpOptimizationPanelProps = {
      steamId,
      inventoryStatus: "public",
      items: inventoryItems,
      boosters,
      badges,
      inventoryRefreshedAt,
      isInventoryLoading: false,
      isActive: true,
      onRefreshInventory: vi.fn()
    };
    const view = render(<LevelUpOptimizationPanel {...panelProps} />);
    await flushPanelEffects();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const signal = (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit)
      .signal as AbortSignal;

    await act(async () => {
      view.rerender(<LevelUpOptimizationPanel {...panelProps} isActive={false} />);
    });
    await act(async () => {
      view.rerender(<LevelUpOptimizationPanel {...panelProps} isActive />);
    });

    expect(signal.aborted).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    resolveResponse(
      new Response(JSON.stringify(readyResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await flushPanelEffects();
    expect(screen.getByText("Instant top-of-book estimate.")).toBeInTheDocument();
  });

  it("rechecks inventory freshness when activating the tab", async () => {
    const view = renderPanel(readyResponse(), { isActive: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-08-29T12:30:01Z"));
    await act(async () => {
      view.rerender(
        <LevelUpOptimizationPanel
          steamId={steamId}
          inventoryStatus="public"
          items={inventoryItems}
          boosters={boosters}
          badges={badges}
          inventoryRefreshedAt={inventoryRefreshedAt}
          isInventoryLoading={false}
          isActive
          onRefreshInventory={vi.fn()}
        />
      );
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Refresh inventory" })
    ).toBeInTheDocument();
  });

  it("does not POST a recommendation refresh after the inventory gate expires", async () => {
    const response = readyResponse();
    response.valid_until = "2026-08-29T13:00:00Z";
    renderPanel(response);
    await flushPanelEffects();
    vi.setSystemTime(new Date("2026-08-29T12:30:01Z"));
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh recommendation" })
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Refresh inventory" })
    ).toBeInTheDocument();
  });

  it("expires the one-hour inventory snapshot gate once the clock crosses it", async () => {
    const response = readyResponse();
    response.valid_until = "2026-08-29T13:00:00Z";
    renderPanel(response);
    await flushPanelEffects();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    });
    expect(
      screen.getByRole("button", { name: "Refresh inventory" })
    ).toBeInTheDocument();
    expect(screen.getByText("Source 0")).toBeInTheDocument();
    expect(screen.getByText("Quote expired.")).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("renders the buyer-total basis and configured fee contract", async () => {
    renderPanel();
    await flushPanelEffects();
    expect(
      screen.getByText("Buyer total at instant top of book")
    ).toBeInTheDocument();
    const feeContract = document.querySelector(".level-up-fee-contract");
    expect(feeContract).toBeInTheDocument();
    expect(within(feeContract as HTMLElement).getByText("5%")).toBeInTheDocument();
    expect(within(feeContract as HTMLElement).getByText("10%")).toBeInTheDocument();
    expect(within(feeContract as HTMLElement).getByText("$0.01")).toBeInTheDocument();
    const sourceRow = screen.getByText("Source 0").closest("tr");
    expect(sourceRow).not.toBeNull();
    expect(within(sourceRow as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(sourceRow?.querySelector(".level-up-sell-card-icon")).toHaveAttribute(
      "src",
      "https://community.cloudflare.steamstatic.com/economy/image/source-0"
    );
    const panel = document.getElementById("level-up-optimization-panel");
    expect(panel).not.toHaveAttribute("role", "tabpanel");
    expect(panel).not.toHaveAttribute("aria-labelledby");
  });

  it("renders one manual sale and only the missing destination cards", async () => {
    renderPanel();
    await flushPanelEffects();

    expect(
      screen.getByRole("heading", { level: 4, name: "Sell one Team Fortress 2 card" })
    ).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Card to sell" })).toBeInTheDocument();
    expect(screen.getByText(/one card from a 5-card set/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 4,
        name: "Buy missing cards for 1 badge"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/3 of 5 cards already owned; buy 2 missing cards/)
    ).toBeInTheDocument();
    expect(screen.getByText("Missing-card total: $0.12")).toBeInTheDocument();
    expect(screen.getByText("Destination 0")).toBeInTheDocument();
    expect(screen.getByText("Destination 1")).toBeInTheDocument();
    expect(screen.getByText("Foregone craft XP")).toBeInTheDocument();
    expect(screen.getByText("Funded badge XP")).toBeInTheDocument();
    expect(screen.getByText("Missing-card purchase total")).toBeInTheDocument();
    expect(
      screen.getByText(/Owned destination cards are reused; only missing cards/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/replacement sets/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sell one owned .* set/i)).not.toBeInTheDocument();
  });

  it("uses one polite live region without status or alert surfaces", async () => {
    renderPanel();
    await flushPanelEffects();
    const panel = document.getElementById("level-up-optimization-panel");
    expect(panel).not.toBeNull();
    expect(panel!.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(panel!.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "One-card level-up recommendation ready."
    );
  });

  it("announces optimizer request failures", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    render(
      <LevelUpOptimizationPanel
        steamId={steamId}
        inventoryStatus="public"
        items={inventoryItems}
        boosters={boosters}
        badges={badges}
        inventoryRefreshedAt={inventoryRefreshedAt}
        isInventoryLoading={false}
        isActive
        onRefreshInventory={vi.fn()}
      />
    );

    await flushPanelEffects();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Level-up optimization unavailable."
    );
    expect(
      screen.getByText(
        "The recommendation service could not be reached. Try again later."
      )
    ).toBeInTheDocument();
  });

  it("renders no-opportunity and unavailable recovery copy", async () => {
    renderPanel(responseWithStatus("no_opportunity", "no_sellable_card"));
    await flushPanelEffects();
    expect(
      screen.getByText(/No sellable normal card with a usable current bid/)
    ).toBeInTheDocument();
  });

  it("renders the SteamApis key configuration failure", async () => {
    renderPanel(responseWithStatus("unavailable", "steamapi_key_missing"));
    await flushPanelEffects();

    expect(screen.getByText(/server has no SteamApis API key/)).toBeInTheDocument();
    expect(screen.getByText(/operator configuration issue/)).toBeInTheDocument();
  });

  it("changes a ready surface to expired once, without polling", async () => {
    renderPanel();
    await flushPanelEffects();
    expect(screen.getByText("Instant top-of-book estimate.")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Quote expired.");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("shows the public-inventory recovery path without requesting the optimizer", () => {
    render(
      <LevelUpOptimizationPanel
        steamId={steamId}
        inventoryStatus="private"
        items={inventoryItems}
        boosters={boosters}
        badges={badges}
        inventoryRefreshedAt={inventoryRefreshedAt}
        isInventoryLoading={false}
        onRefreshInventory={vi.fn()}
        isActive
      />
    );
    expect(screen.getByText(/Make your Steam inventory public/)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
