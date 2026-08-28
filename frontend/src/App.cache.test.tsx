import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  clearInventoryCache: vi.fn().mockResolvedValue(undefined),
  clearInventoryCacheExcept: vi.fn().mockResolvedValue(undefined),
  readInventoryCache: vi.fn().mockResolvedValue(null),
  readInventoryCacheEpoch: vi.fn().mockResolvedValue(0),
  writeInventoryCache: vi
    .fn()
    .mockImplementation(
      async (
        _steamId: string,
        _inventory: unknown,
        _validator: unknown,
        refreshedAt?: string
      ) => refreshedAt ?? "2026-08-28T12:34:56.000Z"
    )
}));

vi.mock("./inventoryCache", () => cacheMocks);

import { App } from "./App";

const steamId = "76561198000000001";
const signedInSession = {
  authenticated: true,
  user: {
    steam_id: steamId,
    display_name: "Alyx",
    avatar_url: "https://cdn.example.test/avatar.jpg"
  },
  checks: {
    profile: {
      status: "public",
      message: "Your Steam profile is publicly visible."
    }
  }
};

const privateInventory = {
  status: "private",
  message: "Steam reports that this inventory is private.",
  retry_after_seconds: null,
  rate_limited: false,
  total_asset_count: 0,
  unique_item_count: 0,
  priceable_item_count: 0,
  priced_item_count: 0,
  price_status: "unavailable",
  price_message: "Prices are unavailable while the inventory is private.",
  gem_status: "unavailable",
  gem_message: "Gem values are unavailable while the inventory is private.",
  gem_priceable_item_count: 0,
  gem_priced_item_count: 0,
  gem_rate_limited: false,
  gem_retry_after_seconds: null,
  gem_cash_context: null,
  boosters: [],
  items: []
};

const validGemCashContext = {
  currency: null,
  basis: "lowest_sell",
  market_hash_name: "753-Sack of Gems",
  sack_gems: 1000,
  sack_price: "100.01",
  observed_at: null
};

const publicInventory = {
  status: "public",
  message: "Your Steam inventory is publicly accessible.",
  retry_after_seconds: null,
  rate_limited: false,
  total_asset_count: 1,
  unique_item_count: 1,
  priceable_item_count: 0,
  priced_item_count: 0,
  price_status: "complete",
  price_message: "No marketable item types require pricing.",
  gem_status: "complete",
  gem_message: "Gem values are current for all trading cards.",
  gem_priceable_item_count: 1,
  gem_priced_item_count: 1,
  gem_rate_limited: false,
  gem_retry_after_seconds: null,
  gem_cash_context: validGemCashContext,
  boosters: [],
  items: [
    {
      class_id: "1001",
      instance_id: "0",
      name: "Card 0001",
      market_hash_name: "Card 0001",
      quantity: 1,
      icon_url: null,
      marketable: true,
      tradable: true,
      price: {
        currency: null,
        highest_buy: "0.10",
        lowest_sell: "0.20",
        observed_at: null
      },
      item_type: "trading_card",
      game_app_id: "440",
      game_name: "Team Fortress 2",
      card_rarity: "normal",
      gem_yield: 10,
      gem_cash_value: "1.0001"
    }
  ]
};

const unavailableInventory = {
  ...privateInventory,
  status: "unavailable",
  message: "Steam inventory is temporarily unavailable."
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

function cacheRecord(inventory: unknown) {
  return {
    schema_version: 1,
    steam_id: steamId,
    refreshed_at: "2026-08-28T12:34:56.000Z",
    inventory
  };
}

function resetCacheMocks() {
  cacheMocks.clearInventoryCache.mockClear();
  cacheMocks.clearInventoryCacheExcept.mockClear();
  cacheMocks.readInventoryCache.mockReset().mockResolvedValue(null);
  cacheMocks.readInventoryCacheEpoch.mockReset().mockResolvedValue(0);
  cacheMocks.writeInventoryCache
    .mockReset()
    .mockResolvedValue("2026-08-28T12:34:56.000Z");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetCacheMocks();
});

describe("App inventory cache orchestration", () => {
  it("renders a matching valid cache without requesting inventory", async () => {
    cacheMocks.readInventoryCache.mockResolvedValueOnce(
      cacheRecord(privateInventory)
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession));

    render(<App />);

    expect(
      await screen.findByRole("definition", {
        name: "Steam inventory: Private"
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/Inventory last refreshed/i)).toHaveTextContent(
      "Aug 28, 2026"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/session",
      expect.objectContaining({ credentials: "include" })
    );
    expect(cacheMocks.writeInventoryCache).not.toHaveBeenCalled();
  });

  it.each(["cache miss", "mismatched record", "corrupt record", "old schema"])(
    "fetches exactly once for a %s and stores the result",
    async (reason) => {
      cacheMocks.readInventoryCache.mockResolvedValueOnce(null);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse(signedInSession))
        .mockResolvedValueOnce(jsonResponse(privateInventory));

      render(<App />);

      expect(
        await screen.findByRole("definition", {
          name: "Steam inventory: Private"
        })
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/auth/inventory",
        expect.objectContaining({ credentials: "include", method: "POST" })
      );
      expect(cacheMocks.clearInventoryCacheExcept).toHaveBeenCalledWith(steamId);
      expect(cacheMocks.writeInventoryCache).toHaveBeenCalledTimes(1);
      expect(reason).toMatch(/cache miss|mismatched|corrupt|old schema/);
    }
  );

  it("refreshes inventory only after the explicit Refresh inventory action", async () => {
    cacheMocks.readInventoryCache.mockResolvedValueOnce(
      cacheRecord(privateInventory)
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory));

    render(<App />);

    const refreshButton = await screen.findByRole("button", {
      name: "Refresh inventory"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(refreshButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/auth/inventory",
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          "X-Expected-Steam-ID": steamId
        }),
        method: "POST"
      })
    );
  });

  it("clears cached inventory after a successful logout", async () => {
    cacheMocks.readInventoryCache.mockResolvedValueOnce(
      cacheRecord(privateInventory)
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(<App />);

    await screen.findByRole("definition", {
      name: "Steam inventory: Private"
    });
    fireEvent.click(screen.getByLabelText("Connected Steam account: Alyx"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByRole("link", { name: /steam sign-in/i })
    ).toBeInTheDocument();
    expect(cacheMocks.clearInventoryCache).toHaveBeenCalledTimes(1);
  });

  it("preserves saved inventory when the session expires", async () => {
    cacheMocks.readInventoryCache.mockResolvedValueOnce(
      cacheRecord(privateInventory)
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));

    render(<App />);

    await screen.findByRole("definition", {
      name: "Steam inventory: Private"
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam profile" })
    );

    expect(
      await screen.findByRole("link", { name: /steam sign-in/i })
    ).toBeInTheDocument();
    expect(cacheMocks.clearInventoryCache).not.toHaveBeenCalled();
  });

  it("reconciles an expired inventory session without deleting cache", async () => {
    cacheMocks.readInventoryCache.mockResolvedValueOnce(
      cacheRecord(privateInventory)
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh inventory" })
    );

    expect(
      await screen.findByRole("link", { name: /steam sign-in/i })
    ).toBeInTheDocument();
    expect(cacheMocks.clearInventoryCache).not.toHaveBeenCalled();
  });

  it("announces an account change found during inventory refresh", async () => {
    const changedSteamId = "76561198000000002";
    const changedSession = {
      ...signedInSession,
      user: {
        ...signedInSession.user,
        steam_id: changedSteamId,
        display_name: "Barney"
      }
    };
    cacheMocks.readInventoryCache.mockResolvedValueOnce(
      cacheRecord(privateInventory)
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse(changedSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory));

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh inventory" })
    );

    expect(
      await screen.findByText(
        /Account changed\. Steam profile: Public\. Inventory check complete: Private\./
      )
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Connected Steam account: Barney")
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/auth/inventory",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Expected-Steam-ID": changedSteamId
        })
      })
    );
  });

  it("preserves cached results and announces an unavailable refresh", async () => {
    cacheMocks.readInventoryCache.mockResolvedValueOnce(
      cacheRecord(publicInventory)
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(unavailableInventory));

    render(<App />);

    expect(await screen.findByText("Card 0001")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh inventory" }));

    const message =
      "We could not refresh inventory right now. Your previous inventory results have not changed.";
    expect(await screen.findByText(message, { selector: ".action-status" }))
      .toBeInTheDocument();
    expect(screen.getByText("Card 0001")).toBeInTheDocument();
  });

  it("persists a successful gem refresh merge to the inventory cache", async () => {
    cacheMocks.readInventoryCache.mockResolvedValueOnce(
      cacheRecord(publicInventory)
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ game_app_id: "440", card_rarity: "normal", gem_yield: 100 }],
          pending_group_count: 0,
          boosters: [],
          pending_booster_count: 0,
          gem_rate_limited: false,
          gem_retry_after_seconds: null
        })
      );

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh gem values" })
    );
    expect(
      await screen.findByText("Gem values refreshed from the background cache.")
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cacheMocks.writeInventoryCache).toHaveBeenCalledWith(
      steamId,
      expect.objectContaining({
        items: [expect.objectContaining({ gem_yield: 100 })]
      }),
      expect.any(Function),
      "2026-08-28T12:34:56.000Z",
      0,
      "2026-08-28T12:34:56.000Z"
    );
    expect(
      within(screen.getByText("Card 0001").closest("tr") as HTMLElement).getByText(
        "100"
      )
    ).toBeInTheDocument();
  });
});
