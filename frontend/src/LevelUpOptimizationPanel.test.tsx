import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LevelUpOptimizationPanel,
  type LevelUpOptimizationPanelProps
} from "./LevelUpOptimizationPanel";
import {
  aggregateNormalCardOwnership,
  buildSteamMarketListingUrl,
  buildSteamProfileGamecardsUrl,
  formatMinorUnits,
  isLevelUpOptimizationResponse,
  type LevelUpOptimizationResponse
} from "./levelUpOptimization";

const generatedAt = "2026-08-29T12:00:00Z";
const inventoryRefreshedAt = "2026-08-29T11:30:00Z";
const steamId = "76561198000000001";

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

function readyResponse(): LevelUpOptimizationResponse {
  const sourceRows = Array.from({ length: 5 }, (_, index) => sellRow("440", index));
  const destinationRows = Array.from({ length: 5 }, (_, index) => buyRow("570", index));
  const secondRows = Array.from({ length: 5 }, (_, index) => buyRow("580", index));
  return {
    status: "ready",
    reason: "ready",
    generated_at: generatedAt,
    inventory_refreshed_at: inventoryRefreshedAt,
    catalog_total_sets: 3,
    catalog_resolved_sets: 3,
    catalog_pending_sets: 0,
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
      projected_xp: 1_450,
      projected_level: 12,
      projected_xp_to_next_level: 150
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
        rows: destinationRows,
        set_subtotal: 30,
        craft_xp: 100
      },
      {
        app_id: "580",
        game_name: "Left 4 Dead 2",
        badge_level_before: 0,
        badge_level_after: 1,
        set_size: 5,
        rows: secondRows,
        set_subtotal: 30,
        craft_xp: 100
      }
    ],
    totals: {
      source_buyer_total: 75,
      steam_fee_total: 5,
      publisher_fee_total: 5,
      seller_receipt_total: 65,
      purchase_total: 60,
      unspent_swap_proceeds: 5,
      direct_craft_xp: 100,
      swap_path_xp: 200,
      xp_advantage: 100,
      destination_count: 2,
      scope_limited: false
    }
  };
}

function responseWithStatus(
  status: "no_opportunity" | "warming" | "unavailable",
  reason:
    | "no_complete_sellable_set"
    | "catalog_warming"
    | "price_generation_stale"
    | "steamapi_key_missing"
): LevelUpOptimizationResponse {
  return {
    status,
    reason,
    generated_at: generatedAt,
    inventory_refreshed_at: inventoryRefreshedAt,
    catalog_total_sets: 3,
    catalog_resolved_sets: status === "warming" ? 2 : 3,
    catalog_pending_sets: status === "warming" ? 1 : 0,
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
  it("deduplicates exact normal hashes and sums only marketable/tradable copies", () => {
    expect(aggregateNormalCardOwnership(inventoryItems)).toEqual([
      {
        market_hash_name: "440-Source 0 (Trading Card)",
        owned_quantity: 3,
        sellable_quantity: 2
      },
      {
        market_hash_name: "440-Source 1 (Trading Card)",
        owned_quantity: 1,
        sellable_quantity: 0
      }
    ]);
  });
});

describe("strict response validation", () => {
  it("accepts a complete ready response and rejects contradictory totals", () => {
    const response = readyResponse();
    expect(isLevelUpOptimizationResponse(response)).toBe(true);
    response.totals!.purchase_total = 61;
    expect(isLevelUpOptimizationResponse(response)).toBe(false);
  });

  it("accepts no-opportunity, warming, and unavailable states", () => {
    expect(isLevelUpOptimizationResponse(responseWithStatus("no_opportunity", "no_complete_sellable_set"))).toBe(true);
    expect(isLevelUpOptimizationResponse(responseWithStatus("warming", "catalog_warming"))).toBe(true);
    expect(isLevelUpOptimizationResponse(responseWithStatus("unavailable", "price_generation_stale"))).toBe(true);
    expect(
      isLevelUpOptimizationResponse(
        responseWithStatus("unavailable", "steamapi_key_missing")
      )
    ).toBe(true);
  });

  it("rejects a scope-limited response that does not contain five destinations", () => {
    const response = readyResponse();
    response.scope_limited = true;
    response.totals!.scope_limited = true;
    expect(isLevelUpOptimizationResponse(response)).toBe(false);
  });
  it("rejects conclusive responses with unresolved catalog sets", () => {
    const readyWithPending = readyResponse();
    readyWithPending.catalog_total_sets = 4;
    readyWithPending.catalog_pending_sets = 1;
    expect(isLevelUpOptimizationResponse(readyWithPending)).toBe(false);
    const noOpportunityWithPending = responseWithStatus(
      "no_opportunity",
      "no_complete_sellable_set"
    );
    noOpportunityWithPending.catalog_total_sets = 4;
    noOpportunityWithPending.catalog_pending_sets = 1;
    expect(isLevelUpOptimizationResponse(noOpportunityWithPending)).toBe(false);
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
      cards: [
        {
          market_hash_name: "440-Source 0 (Trading Card)",
          owned_quantity: 3,
          sellable_quantity: 2
        },
        {
          market_hash_name: "440-Source 1 (Trading Card)",
          owned_quantity: 1,
          sellable_quantity: 0
        }
      ]
    });
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
  it("deduplicates the lazy request for an unchanged snapshot", async () => {
    renderPanel();
    await flushPanelEffects();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Instant top-of-book estimate.")).toBeInTheDocument();
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
    expect(document.getElementById("level-up-optimization-panel")).toHaveAttribute(
      "tabindex",
      "0"
    );
  });

  it("uses one polite live region without status or alert surfaces", async () => {
    renderPanel();
    await flushPanelEffects();
    const panel = document.getElementById("level-up-optimization-panel");
    expect(panel).not.toBeNull();
    expect(panel!.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(panel!.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(1);
  });

  it("renders no-opportunity, warming, and unavailable recovery copy", async () => {
    renderPanel(responseWithStatus("no_opportunity", "no_complete_sellable_set"));
    await flushPanelEffects();
    expect(screen.getByText(/No complete sellable normal-card set/)).toBeInTheDocument();
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
        inventoryRefreshedAt={inventoryRefreshedAt}
        isInventoryLoading={false}
        isActive
        onRefreshInventory={vi.fn()}
      />
    );
    expect(screen.getByText(/Make your Steam inventory public/)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
