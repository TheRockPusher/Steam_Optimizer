import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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

const signedInSession = {
  authenticated: true,
  user: {
    steam_id: "76561198000000001",
    display_name: "Alyx",
    avatar_url: "https://cdn.example.test/avatar.jpg"
  },
  checks: {
    profile: {
      status: "public",
      message: "Your Steam profile is publicly visible."
    },
    inventory: privateInventory
  }
};

function inventoryItem(index: number) {
  return {
    class_id: String(1000 + index),
    instance_id: "0",
    name: `Item ${String(index).padStart(4, "0")}`,
    market_hash_name: null,
    quantity: 1,
    icon_url: null,
    marketable: false,
    tradable: false,
    price: null,
    item_type: "other",
    game_app_id: null,
    game_name: null,
    card_rarity: null,
    gem_yield: null,
    gem_cash_value: null
  };
}

function tradingCardItem(
  index: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    ...inventoryItem(index),
    name: `Card ${String(index).padStart(4, "0")}`,
    market_hash_name: `Card ${String(index).padStart(4, "0")}`,
    item_type: "trading_card",
    game_app_id: "440",
    game_name: "Team Fortress 2",
    card_rarity: "normal",
    gem_yield: 10,
    gem_cash_value: null,
    ...overrides
  };
}
const validInventoryPrice = {
  currency: null,
  highest_buy: "0.10",
  lowest_sell: "0.20",
  observed_at: null
};

const validGemCashContext = {
  currency: null,
  basis: "lowest_sell",
  market_hash_name: "753-Sack of Gems",
  sack_gems: 1000,
  sack_price: "100.01",
  observed_at: null
};

function publicInventory(
  items: unknown[],
  overrides: Record<string, unknown> = {}
) {
  return {
    status: "public",
    message: "Your Steam inventory is publicly accessible.",
    retry_after_seconds: null,
    rate_limited: false,
    total_asset_count: items.length,
    unique_item_count: items.length,
    priceable_item_count: 0,
    priced_item_count: 0,
    price_status: "complete",
    price_message: "No marketable item types require pricing.",
    gem_status: "complete",
    gem_message: "No trading cards require gem prices.",
    gem_priceable_item_count: 0,
    gem_priced_item_count: 0,
    gem_rate_limited: false,
    gem_retry_after_seconds: null,
    gem_cash_context: null,
    boosters: [],
    items,
    ...overrides
  };
}

function publicInventorySession(inventory: Record<string, unknown>) {
  return {
    ...signedInSession,
    checks: {
      ...signedInSession.checks,
      inventory
    }
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

function sessionWithRetry(retryAfterSeconds: number | null) {
  return {
    ...signedInSession,
    checks: {
      ...signedInSession.checks,
      inventory: {
        ...signedInSession.checks.inventory,
        retry_after_seconds: retryAfterSeconds
      }
    }
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("App", () => {
  it("loads the session before offering normal navigation through both official Steam images", async () => {
    let resolveSession!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSession = resolve;
        })
    );

    const { container } = render(<App />);

    expect(
      screen.getByRole("heading", { name: "Checking your connection" })
    ).toBeInTheDocument();
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toHaveTextContent("Checking session");
    expect(
      screen.queryByRole("link", { name: /steam sign-in/i })
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveSession(jsonResponse({ authenticated: false }));
    });

    expect(
      await screen.findByRole("heading", {
        name: "Connect Steam to check public access."
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toBe(statusRegion);

    const loginLink = screen.getByRole("link", { name: /steam sign-in/i });
    expect(loginLink.closest("header")).toHaveClass("site-header");
    expect(loginLink).toHaveAccessibleName(
      "Steam sign-in; Steam Optimizer is not affiliated with Valve"
    );
    expect(loginLink).toHaveAttribute("href", "/api/auth/steam/start");
    expect(loginLink).not.toHaveAttribute("target");
    const signInImage = within(loginLink).getByRole("img");
    expect(signInImage.getAttribute("src")).toContain("sits_01.png");
    expect(signInImage).toHaveAttribute("width", "180");
    expect(signInImage).toHaveAttribute("height", "35");
    const compactSource = container.querySelector("picture source");
    expect(compactSource?.getAttribute("srcset")).toContain("sits_02.png");
    expect(compactSource).toHaveAttribute("media", "(max-width: 40rem)");
    expect(compactSource).toHaveAttribute("width", "109");
    expect(compactSource).toHaveAttribute("height", "66");
    expect(screen.getByText(/your password never comes here/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot trade, sell, craft, or change/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /privacy & steam data terms/i })
    ).toHaveAttribute(
      "href",
      "https://github.com/TheRockPusher/Steam_Optimizer#privacy-and-steam-data-policy"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("shows an API-unavailable state without calling it a privacy result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 503 })
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Steam connection is unavailable."
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Steam connection is unavailable."
    );
    expect(screen.getByText(/not a Steam privacy result/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("renders Steam identity and independent public and private results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(signedInSession)
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Alyx" })
    ).toBeInTheDocument();
    expect(screen.getByText("Steam ID 76561198000000001")).toBeInTheDocument();

    const profileCard = screen.getByRole("article", { name: "Steam profile" });
    expect(within(profileCard).getByText("Public")).toBeInTheDocument();
    expect(
      within(profileCard).getByText("Your Steam profile is publicly visible.")
    ).toBeInTheDocument();

    const inventoryCard = screen.getByRole("article", {
      name: "Steam inventory"
    });
    expect(within(inventoryCard).getByText("Private")).toBeInTheDocument();
    expect(
      within(inventoryCard).getByText(
        "Steam reports that this inventory is private."
      )
    ).toBeInTheDocument();
    expect(
      within(inventoryCard).getByRole("link", {
        name: /open Steam privacy settings/i
      })
    ).toHaveAttribute("href", "https://steamcommunity.com/my/edit/settings");
  });

  it("accepts the complete inventory contract and renders exact provider price strings", async () => {
    const pricedItem = {
      ...inventoryItem(1),
      name: "Prismatic Trading Card",
      market_hash_name: "Prismatic Trading Card",
      quantity: 3,
      icon_url: "https://cdn.example.test/items/prismatic.png",
      marketable: true,
      tradable: true,
      price: {
        currency: null,
        highest_buy: "0.12",
        lowest_sell: "1.005",
        observed_at: "2026-08-27T08:15:00Z"
      }
    };
    const nonmarketableItem = {
      ...inventoryItem(2),
      name: "Community Contributor Badge",
      quantity: 1
    };
    const inventory = publicInventory(
      [pricedItem, nonmarketableItem],
      {
        total_asset_count: 4,
        priceable_item_count: 1,
        priced_item_count: 1,
        price_status: "complete",
        price_message: "Current prices were found for every marketable type."
      }
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "What is in your inventory" })
    ).toBeInTheDocument();
    const coverage = screen.getByRole("region", {
      name: "Current market snapshot"
    });
    expect(within(coverage).getByText("Complete pricing")).toBeInTheDocument();
    expect(
      within(coverage).getByText(
        "SteamApis price data is available for 1 of 1 marketable item type."
      )
    ).toBeInTheDocument();
    expect(
      within(coverage).getByText(
        "SteamApis does not specify the currency for this feed. Values are shown exactly as received, without a currency symbol."
      )
    ).toBeInTheDocument();
    expect(coverage).not.toHaveTextContent("USD");
    expect(within(coverage).getByText("Total assets").parentElement).toHaveTextContent(
      "4"
    );

    const inventoryTable = screen.getByRole("table", { name: "Inventory items" });
    const pricedRow = within(inventoryTable)
      .getByText("Prismatic Trading Card")
      .closest("tr");
    expect(pricedRow).not.toBeNull();
    expect(pricedRow?.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.example.test/items/prismatic.png/64fx64f"
    );
    expect(within(pricedRow as HTMLElement).getByText("3")).toBeInTheDocument();
    expect(
      within(pricedRow as HTMLElement).getByText("Marketable")
    ).toBeInTheDocument();
    expect(within(pricedRow as HTMLElement).getByText("0.12")).toBeInTheDocument();
    expect(within(pricedRow as HTMLElement).getByText("1.005")).toBeInTheDocument();
    expect(pricedRow).not.toHaveTextContent("$");
    expect(
      within(pricedRow as HTMLElement).getByText(/Aug 27, 2026/)
    ).toHaveAttribute("datetime", "2026-08-27T08:15:00Z");

    const nonmarketableRow = within(inventoryTable)
      .getByText("Community Contributor Badge")
      .closest("tr");
    expect(nonmarketableRow).not.toBeNull();
    expect(
      within(nonmarketableRow as HTMLElement).getByText("Nonmarketable")
    ).toBeInTheDocument();
    expect(
      within(nonmarketableRow as HTMLElement).getAllByText("Not applicable")
    ).toHaveLength(5);
  });

  it("filters cards by exact per-card gem cash value above lowest sell", async () => {
    const eligibleCard = tradingCardItem(1, {
      name: "Gem-positive card",
      market_hash_name: "Gem-positive card",
      game_app_id: "1001",
      game_name: "Gem-positive game",
      gem_yield: 20,
      gem_cash_value: "2.0002",
      marketable: true,
      price: {
        ...validInventoryPrice,
        highest_buy: "0.1000",
        lowest_sell: "2.0000"
      }
    });
    const highestBuyOnlyCard = tradingCardItem(2, {
      name: "Highest-buy-only card",
      market_hash_name: "Highest-buy-only card",
      game_app_id: "1002",
      game_name: "Highest-buy-only game",
      gem_yield: 11,
      gem_cash_value: "1.10011",
      marketable: true,
      price: {
        ...validInventoryPrice,
        highest_buy: "1.0000",
        lowest_sell: "2.0000"
      }
    });
    const equalValueCard = tradingCardItem(3, {
      name: "Equal-value card",
      market_hash_name: "Equal-value card",
      game_app_id: "1003",
      game_name: "Equal-value game",
      gem_yield: 10,
      gem_cash_value: "1.0001",
      marketable: true,
      price: {
        ...validInventoryPrice,
        highest_buy: "0.1000",
        lowest_sell: "1.00010"
      }
    });
    const lowerValueCard = tradingCardItem(4, {
      name: "Lower-value card",
      market_hash_name: "Lower-value card",
      game_app_id: "1004",
      game_name: "Lower-value game",
      gem_yield: 9,
      gem_cash_value: "0.90009",
      marketable: true,
      price: {
        ...validInventoryPrice,
        highest_buy: "0.1000",
        lowest_sell: "0.9001"
      }
    });
    const missingGemValueCard = tradingCardItem(5, {
      name: "Missing-gem-value card",
      market_hash_name: "Missing-gem-value card",
      game_app_id: "1005",
      game_name: "Missing-gem-value game",
      gem_yield: null,
      gem_cash_value: null,
      marketable: true,
      price: {
        ...validInventoryPrice,
        highest_buy: "0.1000",
        lowest_sell: "0.0100"
      }
    });
    const missingLowestSellCard = tradingCardItem(6, {
      name: "Missing-lowest-sell card",
      market_hash_name: "Missing-lowest-sell card",
      game_app_id: "1006",
      game_name: "Missing-lowest-sell game",
      gem_yield: 10,
      gem_cash_value: "1.0001",
      marketable: true,
      price: {
        ...validInventoryPrice,
        highest_buy: "0.0100",
        lowest_sell: null
      }
    });
    const nonmarketableCard = tradingCardItem(9, {
      name: "Nonmarketable gem-rich card",
      market_hash_name: "Nonmarketable gem-rich card",
      game_app_id: "1007",
      game_name: "Nonmarketable game",
      gem_yield: 20,
      gem_cash_value: "2.0002",
      marketable: false,
      price: null
    });

    const inventory = publicInventory(
      [
        eligibleCard,
        highestBuyOnlyCard,
        equalValueCard,
        lowerValueCard,
        missingGemValueCard,
        missingLowestSellCard,
        nonmarketableCard
      ],
      {
        total_asset_count: 7,
        unique_item_count: 7,
        priceable_item_count: 6,
        priced_item_count: 6,
        price_status: "complete",
        price_message: "Current prices were found for every marketable type.",
        gem_status: "partial",
        gem_message: "One trading card does not have a current gem value.",
        gem_priceable_item_count: 7,
        gem_priced_item_count: 6,
        gem_cash_context: validGemCashContext
      }
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    const allTab = await screen.findByRole("tab", { name: /^All items/ });
    const worthMoreTab = screen.getByRole("tab", {
      name: /^Worth more as gems/
    });
    fireEvent.click(worthMoreTab);

    expect(worthMoreTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText(
        /Worth more as gems compares each trading card.*current lowest-sell market price/i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Missing values are excluded from this view/i)
    ).toBeInTheDocument();
    const filteredTable = screen.getByRole("table", {
      name: "Inventory items"
    });
    const filteredRows = filteredTable.querySelectorAll("tr.inventory-item");
    expect(filteredRows).toHaveLength(1);
    expect(
      within(filteredRows[0] as HTMLElement).getByText("Gem-positive card")
    ).toBeInTheDocument();
    for (const excludedName of [
      "Highest-buy-only card",
      "Equal-value card",
      "Lower-value card",
      "Missing-gem-value card",
      "Missing-lowest-sell card",
      "Nonmarketable gem-rich card"
    ]) {
      expect(
        within(filteredTable).queryByText(excludedName, { exact: true })
      ).not.toBeInTheDocument();
    }

    fireEvent.click(allTab);

    expect(allTab).toHaveAttribute("aria-selected", "true");
    const restoredTable = screen.getByRole("table", {
      name: "Inventory items"
    });
    expect(restoredTable.querySelectorAll("tr.inventory-item")).toHaveLength(7);
    expect(
      within(restoredTable).getByText("Highest-buy-only card")
    ).toBeInTheDocument();
    expect(
      within(restoredTable).getByText("Equal-value card")
    ).toBeInTheDocument();
  });

  it("connects inventory tabs to panels and activates wrapped keyboard focus", async () => {
    const accessibleCard = tradingCardItem(7, {
      name: "Accessible card",
      market_hash_name: "Accessible card",
      game_app_id: "2001",
      game_name: "Accessible game",
      gem_yield: 10,
      gem_cash_value: "1.0001",
      marketable: true,
      price: {
        ...validInventoryPrice,
        highest_buy: "0.1000",
        lowest_sell: "0.5000"
      }
    });
    const inventory = publicInventory([accessibleCard], {
      total_asset_count: 1,
      unique_item_count: 1,
      priceable_item_count: 1,
      priced_item_count: 1,
      price_status: "complete",
      price_message: "Current prices were found for every marketable type.",
      gem_status: "complete",
      gem_message: "Gem values were found for every trading card.",
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_cash_context: validGemCashContext
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory views"
    });
    const allTab = within(tablist).getByRole("tab", { name: /^All items/ });
    const worthMoreTab = within(tablist).getByRole("tab", {
      name: /^Worth more as gems/
    });
    const allPanel = document.getElementById("inventory-panel-all");
    const worthMorePanel = document.getElementById(
      "inventory-panel-worth-gems"
    );

    expect(allPanel).not.toBeNull();
    expect(worthMorePanel).not.toBeNull();
    expect(allTab).toHaveAttribute("id", "inventory-tab-all");
    expect(allTab).toHaveAttribute("aria-controls", "inventory-panel-all");
    expect(allTab).toHaveAttribute("aria-selected", "true");
    expect(allTab).toHaveAttribute("tabindex", "0");
    expect(worthMoreTab).toHaveAttribute("id", "inventory-tab-worth-gems");
    expect(worthMoreTab).toHaveAttribute(
      "aria-controls",
      "inventory-panel-worth-gems"
    );
    expect(worthMoreTab).toHaveAttribute("aria-selected", "false");
    expect(worthMoreTab).toHaveAttribute("tabindex", "-1");
    expect(allPanel).toHaveAttribute("role", "tabpanel");
    expect(allPanel).toHaveAttribute("aria-labelledby", "inventory-tab-all");
    expect(allPanel).toHaveAttribute("tabindex", "0");
    expect(allPanel).not.toHaveAttribute("hidden");
    expect(worthMorePanel).toHaveAttribute("role", "tabpanel");
    expect(worthMorePanel).toHaveAttribute(
      "aria-labelledby",
      "inventory-tab-worth-gems"
    );
    expect(worthMorePanel).toHaveAttribute("hidden");
    expect(worthMorePanel?.querySelector("table")).toBeNull();

    fireEvent.click(worthMoreTab);

    expect(worthMoreTab).toHaveAttribute("aria-selected", "true");
    expect(allTab).toHaveAttribute("aria-selected", "false");
    expect(allPanel).toHaveAttribute("hidden");
    expect(worthMorePanel).not.toHaveAttribute("hidden");
    expect(worthMorePanel).toHaveAttribute("tabindex", "0");
    expect(screen.getAllByRole("table", { name: "Inventory items" })).toHaveLength(
      1
    );
    expect(document.querySelectorAll("table.inventory-table")).toHaveLength(1);

    allTab.focus();
    fireEvent.keyDown(allTab, { key: "ArrowLeft" });
    expect(worthMoreTab).toHaveAttribute("aria-selected", "true");
    expect(worthMoreTab).toHaveFocus();

    fireEvent.keyDown(worthMoreTab, { key: "Home" });
    expect(allTab).toHaveAttribute("aria-selected", "true");
    expect(allTab).toHaveFocus();

    fireEvent.keyDown(allTab, { key: "End" });
    expect(worthMoreTab).toHaveAttribute("aria-selected", "true");
    expect(worthMoreTab).toHaveFocus();

    fireEvent.keyDown(worthMoreTab, { key: "ArrowRight" });
    expect(allTab).toHaveAttribute("aria-selected", "true");
    expect(allTab).toHaveFocus();
  });

  it("normalizes filtered pagination and announces refresh-driven result changes", async () => {
    const cards = Array.from({ length: 101 }, (_, index) =>
      tradingCardItem(100 + index, {
        name: `Refresh card ${index + 1}`,
        market_hash_name: `Refresh card ${index + 1}`,
        game_app_id: "440",
        game_name: "Refresh game",
        gem_yield: 20,
        gem_cash_value: "2.0002",
        marketable: true,
        price: {
          ...validInventoryPrice,
          highest_buy: "0.5000",
          lowest_sell: "1.0000"
        }
      })
    );
    const inventory = publicInventory(cards, {
      total_asset_count: cards.length,
      unique_item_count: cards.length,
      priceable_item_count: cards.length,
      priced_item_count: cards.length,
      price_status: "complete",
      price_message: "Current prices were found for every marketable type.",
      gem_status: "complete",
      gem_message: "Gem values were found for every trading card.",
      gem_priceable_item_count: cards.length,
      gem_priced_item_count: cards.length,
      gem_cash_context: validGemCashContext
    });
    let resolveShrink!: (response: Response) => void;
    const shrinkResponse = new Promise<Response>((resolve) => {
      resolveShrink = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(publicInventorySession(inventory)))
      .mockImplementationOnce(() => shrinkResponse)
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              game_app_id: "440",
              card_rarity: "normal",
              gem_yield: 20
            }
          ],
          pending_group_count: 0,
          boosters: [],
          pending_booster_count: 0,
          gem_rate_limited: false,
          gem_retry_after_seconds: null
        })
      );

    render(<App />);

    fireEvent.click(
      await screen.findByRole("tab", { name: /^Worth more as gems/ })
    );
    const resultStatus = screen.getByRole("status", {
      name: "Worth more as gems result count"
    });
    expect(resultStatus).toHaveTextContent(
      "101 item types are currently worth more as gems."
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Inventory page" }),
      { target: { value: "3" } }
    );
    expect(
      screen.getByRole("status", { name: "Inventory pagination status" })
    ).toHaveTextContent("Page 3 of 3.");

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh gem values" })
    );
    const sortButton = screen.getByRole("button", {
      name: "Sort by Item, ascending"
    });
    sortButton.focus();
    expect(sortButton).toHaveFocus();
    await act(async () => {
      resolveShrink(
        jsonResponse({
          values: [
            {
              game_app_id: "440",
              card_rarity: "normal",
              gem_yield: 0
            }
          ],
          pending_group_count: 0,
          boosters: [],
          pending_booster_count: 0,
          gem_rate_limited: false,
          gem_retry_after_seconds: null
        })
      );
    });

    expect(
      await screen.findByRole("heading", {
        name: "No items are worth more as gems"
      })
    ).toBeInTheDocument();
    expect(resultStatus).toHaveTextContent(
      "No item types are currently worth more as gems."
    );
    expect(document.getElementById("inventory-panel-worth-gems")).toHaveFocus();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh gem values" })
    );

    await screen.findByRole("table", { name: "Inventory items" });
    expect(resultStatus).toHaveTextContent(
      "101 item types are currently worth more as gems."
    );
    expect(
      screen.getByRole("status", { name: "Inventory pagination status" })
    ).toHaveTextContent("Page 1 of 3.");
    expect(screen.getByRole("combobox", { name: "Inventory page" })).toHaveValue(
      "1"
    );
  });

  it("shows a filtered empty view without a table or pagination for zero matches", async () => {
    const nonQualifyingCard = tradingCardItem(8, {
      name: "No-match card",
      market_hash_name: "No-match card",
      game_app_id: "3001",
      game_name: "No-match game",
      gem_yield: 10,
      gem_cash_value: "1.0001",
      marketable: true,
      price: {
        ...validInventoryPrice,
        highest_buy: "0.1000",
        lowest_sell: "2.0000"
      }
    });
    const inventory = publicInventory([nonQualifyingCard], {
      total_asset_count: 1,
      unique_item_count: 1,
      priceable_item_count: 1,
      priced_item_count: 1,
      price_status: "complete",
      price_message: "Current prices were found for every marketable type.",
      gem_status: "complete",
      gem_message: "Gem values were found for every trading card.",
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_cash_context: validGemCashContext
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    fireEvent.click(
      await screen.findByRole("tab", { name: /^Worth more as gems/ })
    );

    expect(
      await screen.findByRole("heading", {
        name: "No items are worth more as gems"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /No marketable trading card with both a gem cash value and a current lowest-sell market price currently qualifies/i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Worth more as gems compares each trading card.*current lowest-sell market price/i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Missing values are excluded from this view/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Inventory items" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Inventory pages" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Inventory pagination status" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Inventory page" })
    ).not.toBeInTheDocument();
    expect(document.querySelector("table.inventory-table")).toBeNull();
    expect(document.querySelector("nav.inventory-pagination")).toBeNull();
    expect(
      document.querySelector('[aria-label="Inventory pagination status"]')
    ).toBeNull();
  });

  it("renders a game's booster prices, gem cost, and card counts", async () => {
    const inventory = publicInventory([tradingCardItem(1)], {
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_status: "complete",
      gem_message: "Gem values are current for all trading cards.",
      boosters: [
        {
          game_app_id: "440",
          game_name: "Team Fortress 2",
          market_hash_name: "440-Team Fortress 2 Booster Pack",
          card_count: 3,
          card_set_size: 8,
          gem_cost: 750,
          price: {
            currency: null,
            highest_buy: "0.11",
            lowest_sell: "0.13",
            observed_at: "2026-08-27T00:00:00Z"
          }
        }
      ]
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Boosters" }));

    const section = await screen.findByRole("region", {
      name: "Booster details by game"
    });
    const boosterCard = within(section).getByRole("article", {
      name: "Team Fortress 2"
    });
    expect(within(boosterCard).getByText("0.13")).toBeInTheDocument();
    expect(within(boosterCard).getByText("0.11")).toBeInTheDocument();
    expect(within(boosterCard).getByText("Gem cost")).toBeInTheDocument();
    expect(within(boosterCard).getByText("750", { selector: "dd" })).toBeInTheDocument();
    expect(within(boosterCard).getByText("Cards in set")).toBeInTheDocument();
    expect(within(boosterCard).getByText("8", { selector: "dd" })).toBeInTheDocument();
    expect(within(boosterCard).getByText("Cards per booster")).toBeInTheDocument();
    expect(within(boosterCard).getByText("3 cards")).toBeInTheDocument();
    expect(
      within(boosterCard).getByText("3", { selector: "dd" })
    ).toBeInTheDocument();

    expect(
      within(boosterCard).getByText(/Aug 27, 2026/)
    ).toHaveAttribute("datetime", "2026-08-27T00:00:00Z");
  });
  it("renders unavailable derived booster values without changing market prices", async () => {
    const inventory = publicInventory([tradingCardItem(1)], {
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      boosters: [
        {
          game_app_id: "440",
          game_name: "Team Fortress 2",
          market_hash_name: "440-Team Fortress 2 Booster Pack",
          card_count: 3,
          card_set_size: null,
          gem_cost: null,
          price: validInventoryPrice
        }
      ]
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Boosters" }));

    const boosterCard = within(
      await screen.findByRole("region", { name: "Booster details by game" })
    ).getByRole("article", { name: "Team Fortress 2" });
    expect(within(boosterCard).getByText("Gem cost")).toBeInTheDocument();
    expect(within(boosterCard).getByText("Cards in set")).toBeInTheDocument();
    expect(within(boosterCard).getAllByText("Unavailable")).toHaveLength(2);
    expect(within(boosterCard).getByText("0.20")).toBeInTheDocument();
    expect(within(boosterCard).getByText("0.10")).toBeInTheDocument();
  });
  it("switches between item and booster result panels with manual keyboard activation", async () => {
    const inventory = publicInventory([tradingCardItem(10)], {
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_status: "complete",
      gem_message: "Gem values are current for all trading cards.",
      boosters: [
        {
          game_app_id: "440",
          game_name: "Team Fortress 2",
          market_hash_name: "440-Team Fortress 2 Booster Pack",
          card_count: 3,
          card_set_size: null,
          gem_cost: null,
          price: validInventoryPrice
        }
      ]
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    const itemsTab = within(tablist).getByRole("tab", { name: "Items" });
    const boostersTab = within(tablist).getByRole("tab", { name: "Boosters" });
    const itemsPanel = document.getElementById("inventory-results-panel-items");
    const boostersPanel = document.getElementById(
      "inventory-results-panel-boosters"
    );

    expect(itemsTab).toHaveAttribute("aria-selected", "true");
    expect(boostersTab).toHaveAttribute("aria-selected", "false");
    expect(itemsPanel).not.toBeNull();
    expect(boostersPanel).not.toBeNull();
    expect(itemsPanel).not.toHaveAttribute("hidden");
    expect(boostersPanel).toHaveAttribute("hidden");
    expect(
      screen.getByRole("table", { name: "Inventory items" })
    ).toBeInTheDocument();
    const groupByGame = screen.getByRole("checkbox", {
      name: "Group by game"
    });
    fireEvent.click(groupByGame);
    expect(groupByGame).not.toBeChecked();
    expect(
      screen.queryByRole("region", { name: "Booster details by game" })
    ).not.toBeInTheDocument();
    expect(
      boostersPanel?.querySelector("section[aria-labelledby=booster-coverage-title]")
    ).not.toBeNull();

    fireEvent.keyDown(itemsTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(boostersTab);
    expect(itemsTab).toHaveAttribute("aria-selected", "true");
    expect(boostersTab).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(boostersTab, { key: " " });
    expect(boostersTab).toHaveAttribute("aria-selected", "true");
    expect(itemsTab).toHaveAttribute("aria-selected", "false");
    expect(itemsPanel).toHaveAttribute("hidden");
    expect(boostersPanel).not.toHaveAttribute("hidden");
    expect(
      screen.getByRole("region", { name: "Booster details by game" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Inventory items" })
    ).not.toBeInTheDocument();
    expect(
      itemsPanel?.querySelector("table.inventory-table")
    ).not.toBeNull();

    fireEvent.click(itemsTab);
    expect(itemsTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("table", { name: "Inventory items" })
    ).toBeInTheDocument();
    expect(groupByGame).not.toBeChecked();
  });

  it("keeps an empty booster view selectable and explains the missing data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(publicInventory([])))
    );

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    const boostersTab = within(tablist).getByRole("tab", { name: "Boosters" });
    fireEvent.click(boostersTab);

    expect(
      await screen.findByRole("heading", { name: "No booster packs to display" })
    ).toBeInTheDocument();
    expect(boostersTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText(
        "No trading-card games were identified in this inventory, so there are no related booster packs to display."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Booster details by game" })
    ).not.toBeInTheDocument();
  });
  it("sorts every inventory field in both directions and keeps unavailable values last", async () => {
    const charlie = {
      ...inventoryItem(1),
      name: "Charlie",
      market_hash_name: "Charlie",
      quantity: 2,
      marketable: true,
      price: {
        currency: null,
        highest_buy: "0.10",
        lowest_sell: "0.30",
        observed_at: "2026-08-27T12:00:00Z"
      }
    };
    const alpha = {
      ...inventoryItem(2),
      name: "Alpha",
      quantity: 10
    };
    const bravo = {
      ...inventoryItem(3),
      name: "Bravo",
      market_hash_name: "Bravo",
      quantity: 1,
      marketable: true,
      price: {
        currency: null,
        highest_buy: "0.02",
        lowest_sell: "0.20",
        observed_at: "2026-08-26T12:00:00Z"
      }
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        publicInventorySession(
          publicInventory([charlie, alpha, bravo], {
            total_asset_count: 13,
            priceable_item_count: 2,
            priced_item_count: 2
          })
        )
      )
    );

    render(<App />);

    const inventoryTable = await screen.findByRole("table", {
      name: "Inventory items"
    });
    const renderedNames = () =>
      Array.from(inventoryTable.querySelectorAll("tr.inventory-item")).map(
        (row) => within(row as HTMLElement).getByRole("rowheader").textContent
      );
    const assertSort = (
      label: string,
      ascending: string[],
      descending: string[]
    ) => {
      fireEvent.click(
        screen.getByRole("button", { name: `Sort by ${label}, ascending` })
      );
      expect(renderedNames()).toEqual(ascending);
      expect(
        screen
          .getByRole("button", { name: `Sort by ${label}, descending` })
          .closest("th")
      ).toHaveAttribute("aria-sort", "ascending");

      fireEvent.click(
        screen.getByRole("button", { name: `Sort by ${label}, descending` })
      );
      expect(renderedNames()).toEqual(descending);
      expect(
        screen
          .getByRole("button", { name: `Sort by ${label}, ascending` })
          .closest("th")
      ).toHaveAttribute("aria-sort", "descending");
    };

    assertSort("Item", ["Alpha", "Bravo", "Charlie"], ["Charlie", "Bravo", "Alpha"]);
    assertSort(
      "Quantity",
      ["Bravo", "Charlie", "Alpha"],
      ["Alpha", "Charlie", "Bravo"]
    );
    assertSort(
      "Marketability",
      ["Charlie", "Bravo", "Alpha"],
      ["Alpha", "Charlie", "Bravo"]
    );
    assertSort(
      "Highest buy",
      ["Bravo", "Charlie", "Alpha"],
      ["Charlie", "Bravo", "Alpha"]
    );
    assertSort(
      "Lowest sell",
      ["Bravo", "Charlie", "Alpha"],
      ["Charlie", "Bravo", "Alpha"]
    );
    assertSort(
      "Price timestamp",
      ["Bravo", "Charlie", "Alpha"],
      ["Charlie", "Bravo", "Alpha"]
    );
  });

  it("rejects a malformed nested item", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        publicInventorySession(
          publicInventory([{ ...inventoryItem(1), quantity: 0 }])
        )
      )
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Steam connection is unavailable."
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "What is in your inventory" })
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      label: "a known currency",
      price: { ...validInventoryPrice, currency: "USD" }
    },
    {
      label: "a missing currency field",
      price: {
        highest_buy: "0.10",
        lowest_sell: "0.20",
        observed_at: null
      }
    },
    {
      label: "a missing highest buy field",
      price: {
        currency: null,
        lowest_sell: "0.20",
        observed_at: null
      }
    },
    {
      label: "a missing lowest sell field",
      price: {
        currency: null,
        highest_buy: "0.10",
        observed_at: null
      }
    },
    {
      label: "a numeric highest buy",
      price: { ...validInventoryPrice, highest_buy: 0.1 }
    },
    {
      label: "a negative lowest sell",
      price: { ...validInventoryPrice, lowest_sell: "-0.01" }
    },
    {
      label: "an exponent-form amount",
      price: { ...validInventoryPrice, highest_buy: "1e3" }
    },
    {
      label: "a noncanonical leading zero",
      price: { ...validInventoryPrice, lowest_sell: "01.00" }
    },
    {
      label: "legacy minor-unit fields",
      price: {
        currency: null,
        highest_buy_minor: 10,
        lowest_sell_minor: 20,
        observed_at: null
      }
    }
  ])("rejects a nested price with $label", async ({ price }) => {
    const item = {
      ...inventoryItem(1),
      market_hash_name: "Item 0001",
      marketable: true,
      price
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        publicInventorySession(
          publicInventory([item], {
            priceable_item_count: 1,
            priced_item_count: 1
          })
        )
      )
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Steam connection is unavailable."
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "What is in your inventory" })
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      label: "duplicate class and instance rows",
      inventory: publicInventory([inventoryItem(1), inventoryItem(1)])
    },
    {
      label: "unique item count that differs from the returned rows",
      inventory: publicInventory([inventoryItem(1)], {
        unique_item_count: 2
      })
    },
    {
      label: "total asset count that differs from summed quantities",
      inventory: publicInventory(
        [{ ...inventoryItem(1), quantity: 2 }],
        { total_asset_count: 1 }
      )
    },
    {
      label: "quantity sum outside the safe integer range",
      inventory: publicInventory(
        [
          { ...inventoryItem(1), quantity: Number.MAX_SAFE_INTEGER },
          inventoryItem(2)
        ],
        { total_asset_count: Number.MAX_SAFE_INTEGER }
      )
    },
    {
      label: "priced count above the priceable count",
      inventory: publicInventory(
        [
          {
            ...inventoryItem(1),
            market_hash_name: "Item 0001",
            marketable: true,
            price: validInventoryPrice
          }
        ],
        { priced_item_count: 1 }
      )
    },
    {
      label: "priceable count above the unique item count",
      inventory: publicInventory(
        [{ ...inventoryItem(1), marketable: true }],
        { priceable_item_count: 2 }
      )
    },
    {
      label: "priceable count that differs from marketable rows",
      inventory: publicInventory(
        [{ ...inventoryItem(1), marketable: true }],
        { priceable_item_count: 0 }
      )
    },
    {
      label: "priced count that differs from rows with prices",
      inventory: publicInventory(
        [
          {
            ...inventoryItem(1),
            market_hash_name: "Item 0001",
            marketable: true,
            price: validInventoryPrice
          }
        ],
        { priceable_item_count: 1, priced_item_count: 0 }
      )
    },
    {
      label: "price attached to a nonmarketable row",
      inventory: publicInventory(
        [
          {
            ...inventoryItem(1),
            market_hash_name: "Item 0001",
            price: validInventoryPrice
          },
          {
            ...inventoryItem(2),
            market_hash_name: "Item 0002",
            marketable: true
          }
        ],
        { priceable_item_count: 1, priced_item_count: 1 }
      )
    },
    {
      label: "price attached without a market hash name",
      inventory: publicInventory(
        [
          {
            ...inventoryItem(1),
            marketable: true,
            price: validInventoryPrice
          }
        ],
        { priceable_item_count: 1, priced_item_count: 1 }
      )
    }
  ])("rejects $label", async ({ inventory }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Steam connection is unavailable."
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "What is in your inventory" })
    ).not.toBeInTheDocument();
  });

  it("shows partial price coverage and marks a marketable unpriced item unavailable", async () => {
    const pricedItem = {
      ...inventoryItem(1),
      market_hash_name: "Item 0001",
      marketable: true,
      price: {
        currency: null,
        highest_buy: "1.00",
        lowest_sell: "1.25",
        observed_at: "2026-08-27T08:15:00Z"
      }
    };
    const unpricedItem = {
      ...inventoryItem(2),
      name: "Marketable without a price",
      market_hash_name: "Marketable without a price",
      marketable: true
    };
    const inventory = publicInventory([pricedItem, unpricedItem], {
      priceable_item_count: 2,
      priced_item_count: 1,
      price_status: "partial",
      price_message: "One marketable type did not have a current order book."
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    const coverage = await screen.findByRole("region", {
      name: "Current market snapshot"
    });
    expect(within(coverage).getByText("Partial pricing")).toBeInTheDocument();
    expect(
      within(coverage).getByText(
        "SteamApis price data is available for 1 of 2 marketable item types."
      )
    ).toBeInTheDocument();
    const unpricedRow = screen
      .getByText("Marketable without a price")
      .closest("tr");
    expect(unpricedRow).not.toBeNull();
    expect(
      within(unpricedRow as HTMLElement).getAllByText("Unavailable")
    ).toHaveLength(3);
  });

  it("distinguishes an unavailable price feed from inventory privacy", async () => {
    const unpricedItem = {
      ...inventoryItem(1),
      market_hash_name: "Item 0001",
      marketable: true
    };
    const inventory = publicInventory([unpricedItem], {
      priceable_item_count: 1,
      price_status: "unavailable",
      price_message:
        "The inventory is public, but current Steam market prices are unavailable."
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    const coverage = await screen.findByRole("region", {
      name: "Current market snapshot"
    });
    expect(within(coverage).getByText("Pricing unavailable")).toBeInTheDocument();
    expect(
      within(coverage).getByText(
        "The inventory is public, but current Steam market prices are unavailable."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "Steam inventory" })
    ).toHaveTextContent("Public");
    expect(
      screen.queryByRole("link", { name: /open Steam privacy settings/i })
    ).not.toBeInTheDocument();
  });

  it("paginates a 2,001-item inventory without rendering more than one page", async () => {
    const items = Array.from({ length: 2001 }, (_, index) =>
      inventoryItem(index + 1)
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(publicInventory(items)))
    );

    render(<App />);

    const inventoryTable = await screen.findByRole("table", {
      name: "Inventory items"
    });
    expect(inventoryTable.querySelectorAll("tr.inventory-item")).toHaveLength(50);
    expect(within(inventoryTable).getByText("Item 0050")).toBeInTheDocument();
    expect(
      within(inventoryTable).queryByText("Item 0051")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Inventory pagination status" })
    ).toHaveTextContent("Showing 1–50 of 2,001. Page 1 of 41.");
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Item, ascending" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Item, descending" })
    );
    expect(within(inventoryTable).getByText("Item 2001")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Item, ascending" })
    );
    expect(within(inventoryTable).getByText("Item 0001")).toBeInTheDocument();

    const previousButton = screen.getByRole("button", {
      name: "Previous inventory page"
    });
    const nextButton = screen.getByRole("button", {
      name: "Next inventory page"
    });
    expect(previousButton).toBeDisabled();
    expect(nextButton).toBeEnabled();
    fireEvent.click(nextButton);
    expect(within(inventoryTable).getByText("Item 0051")).toBeInTheDocument();
    expect(inventoryTable.querySelectorAll("tr.inventory-item")).toHaveLength(50);
    expect(within(inventoryTable).queryByText("Item 0001")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Inventory page" }), {
      target: { value: "41" }
    });
    expect(within(inventoryTable).getByText("Item 2001")).toBeInTheDocument();
    expect(inventoryTable.querySelectorAll("tr.inventory-item")).toHaveLength(1);
    expect(
      screen.getByRole("status", { name: "Inventory pagination status" })
    ).toHaveTextContent("Showing 2,001–2,001 of 2,001. Page 41 of 41.");
    expect(nextButton).toBeDisabled();
    expect(previousButton).toBeEnabled();
  });

  it("clamps the stored inventory page after a recheck shrinks the result", async () => {
    const initialItems = Array.from({ length: 101 }, (_, index) =>
      inventoryItem(index + 1)
    );
    const shrunkenItems = Array.from({ length: 10 }, (_, index) =>
      inventoryItem(index + 201)
    );
    const grownItems = Array.from({ length: 100 }, (_, index) =>
      inventoryItem(index + 301)
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(publicInventorySession(publicInventory(initialItems)))
      )
      .mockResolvedValueOnce(
        jsonResponse(publicInventorySession(publicInventory(shrunkenItems)))
      )
      .mockResolvedValueOnce(
        jsonResponse(publicInventorySession(publicInventory(grownItems)))
      );

    render(<App />);

    const inventoryTable = await screen.findByRole("table", {
      name: "Inventory items"
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Inventory page" }), {
      target: { value: "3" }
    });
    expect(within(inventoryTable).getByText("Item 0101")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );

    await waitFor(() => {
      expect(
        screen.getByRole("status", { name: "Inventory pagination status" })
      ).toHaveTextContent("Showing 1–10 of 10. Page 1 of 1.");
    });
    expect(
      within(screen.getByRole("table", { name: "Inventory items" })).getByText(
        "Item 0201"
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Inventory page" })
    ).not.toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "Recheck Steam access" })
    );

    await waitFor(() => {
      expect(
        screen.getByRole("status", { name: "Inventory pagination status" })
      ).toHaveTextContent("Showing 1–50 of 100. Page 1 of 2.");
    });
    const refreshedInventoryTable = screen.getByRole("table", {
      name: "Inventory items"
    });
    expect(
      within(refreshedInventoryTable).getByText("Item 0301")
    ).toBeInTheDocument();
    expect(
      within(refreshedInventoryTable).queryByText("Item 0351")
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["", " ", "123\n", "76561198000000001abc", "１２３", "١٢٣", "+123"])(
    "rejects a non-ASCII decimal Steam ID (%j)",
    async (steamId) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          ...signedInSession,
          user: { ...signedInSession.user, steam_id: steamId }
        })
      );

      render(<App />);

      expect(
        await screen.findByRole("heading", {
          name: "Steam connection is unavailable."
        })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: signedInSession.user.display_name })
      ).not.toBeInTheDocument();
    }
  );

  it.each([undefined, "30", -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid inventory retry envelope (%j)",
    async (retryAfterSeconds) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          ...signedInSession,
          checks: {
            ...signedInSession.checks,
            inventory: {
              ...signedInSession.checks.inventory,
              retry_after_seconds: retryAfterSeconds
            }
          }
        })
      );

      render(<App />);

      expect(
        await screen.findByRole("heading", {
          name: "Steam connection is unavailable."
        })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: signedInSession.user.display_name })
      ).not.toBeInTheDocument();
    }
  );

  it.each([undefined, null, 0, "true"])(
    "rejects an invalid inventory rate-limit marker (%j)",
    async (rateLimited) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          ...signedInSession,
          checks: {
            ...signedInSession.checks,
            inventory: {
              ...signedInSession.checks.inventory,
              rate_limited: rateLimited
            }
          }
        })
      );

      render(<App />);

      expect(
        await screen.findByRole("heading", {
          name: "Steam connection is unavailable."
        })
      ).toBeInTheDocument();
    }
  );

  it("labels an unavailable upstream check separately from privacy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ...signedInSession,
        checks: {
          profile: {
            status: "unavailable",
            message: "The Steam Web API is not configured."
          },
          inventory: {
            ...signedInSession.checks.inventory,
            status: "public",
            message: "Your Steam inventory is publicly accessible.",
            retry_after_seconds: null,
            rate_limited: false,
            gem_status: "complete",
            gem_message: "No trading cards require gem prices."
          }
        }
      })
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const profileCard = screen.getByRole("article", { name: "Steam profile" });

    expect(within(profileCard).getByText("Unavailable")).toBeInTheDocument();
    expect(
      within(profileCard).getByText("The Steam Web API is not configured.")
    ).toBeInTheDocument();
    expect(within(profileCard).getByText(/not a privacy result/i)).toBeInTheDocument();
    expect(within(profileCard).queryByText("Private")).not.toBeInTheDocument();
  });

  it("shows the backend 429 copy and rate-limit guidance instead of privacy guidance", async () => {
    const rateLimitMessage =
      "Steam is temporarily limiting inventory checks. Try again in 30 seconds.";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ...sessionWithRetry(30),
        checks: {
          ...sessionWithRetry(30).checks,
          inventory: {
            ...signedInSession.checks.inventory,
            status: "unavailable",
            message: rateLimitMessage,
            retry_after_seconds: 30,
            rate_limited: true
          }
        }
      })
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const inventoryCard = screen.getByRole("article", {
      name: "Steam inventory"
    });
    expect(within(inventoryCard).getByText(rateLimitMessage)).toBeInTheDocument();
    expect(within(inventoryCard).getByText("Try later")).toBeInTheDocument();
    expect(
      within(inventoryCard).getByText(
        /Steam is temporarily limiting automated checks/i
      )
    ).toHaveTextContent(/does not mean your inventory is private/i);
    expect(
      within(inventoryCard).queryByRole("link", {
        name: /open Steam privacy settings/i
      })
    ).not.toBeInTheDocument();
    expect(
      within(inventoryCard).queryByText(
        /Recheck when the service is available/i
      )
    ).not.toBeInTheDocument();
  });

  it("applies an authoritative initial cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(3))
    );

    render(<App />);
    await act(async () => { });

    expect(screen.getByRole("heading", { name: "Alyx" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Repeated immediate recheck requests are disabled. Try again in 3s."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recheck Steam access" })
    ).toBeDisabled();
  });

  it("updates the authoritative cooldown from a recheck response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(sessionWithRetry(4)));

    render(<App />);
    await act(async () => { });
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );
    await act(async () => { });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(
        "Repeated immediate recheck requests are disabled. Try again in 4s."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recheck Steam access" })
    ).toBeDisabled();
  });

  it("guards recheck without fetching during cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(5))
    );

    render(<App />);
    await act(async () => { });

    const recheckButton = screen.getByRole("button", {
      name: "Recheck Steam access"
    });
    expect(recheckButton).toBeDisabled();

    recheckButton.removeAttribute("disabled");
    fireEvent.click(recheckButton);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores wall-clock jumps while enforcing cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(5))
    );

    render(<App />);
    await act(async () => { });

    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    const recheckButton = screen.getByRole("button", {
      name: "Recheck Steam access"
    });
    recheckButton.removeAttribute("disabled");
    fireEvent.click(recheckButton);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts down with ceil and enables recheck at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(2))
    );

    render(<App />);
    await act(async () => { });

    const recheckButton = screen.getByRole("button", {
      name: "Recheck Steam access"
    });
    expect(screen.getByText(/Try again in 2s\./i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/Try again in 1s\./i)).toBeInTheDocument();
    expect(recheckButton).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.queryByText(/Repeated immediate recheck requests are disabled/i)
    ).not.toBeInTheDocument();
    expect(recheckButton).toBeEnabled();
  });

  it("keeps logout available throughout an inventory cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(sessionWithRetry(30))
    );

    render(<App />);
    await act(async () => { });

    expect(
      screen.getByRole("button", { name: "Recheck Steam access" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sign out on this device" })
    ).toBeEnabled();
  });

  it("rechecks both access results with credentials and announces both current labels", async () => {
    const refreshedSession = {
      ...signedInSession,
      checks: {
        profile: {
          status: "private",
          message: "Profile access was checked again."
        },
        inventory: {
          ...signedInSession.checks.inventory,
          status: "unavailable",
          message: "Inventory access was checked again.",
          retry_after_seconds: null,
          rate_limited: false
        }
      }
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(refreshedSession));

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const statusRegion = screen.getByRole("status");
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );

    await waitFor(() => {
      expect(screen.getByText("Inventory access was checked again.")).toBeInTheDocument();
    });
    expect(
      within(
        screen.getByRole("article", { name: "Steam inventory" })
      ).getByText("Unavailable")
    ).toBeInTheDocument();
    expect(statusRegion).toHaveTextContent(
      "Recheck complete. Steam profile: Private. Steam inventory: Unavailable."
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/auth/session",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("keeps recheck failures visible and announced without replacing prior results", async () => {
    const message =
      "We could not recheck Steam access. The service is unavailable, and your previous results have not changed.";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const statusRegion = screen.getByRole("status");
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );

    await waitFor(() => {
      expect(statusRegion).toHaveTextContent(message);
    });
    expect(
      screen.getByText(message, { selector: ".action-status" })
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("article", { name: "Steam inventory" })
      ).getByText("Private")
    ).toBeInTheDocument();
  });

  it("groups trading cards by game, keeps fallback and Other groups, and sorts within groups", async () => {
    const alphaCard = tradingCardItem(1, {
      name: "Alpha card",
      game_app_id: "10",
      game_name: "Alpha game",
      gem_yield: 20,
      gem_cash_value: "0.01"
    });
    const zetaCard = tradingCardItem(2, {
      name: "Zeta high card",
      game_app_id: "20",
      game_name: "Zeta game",
      gem_yield: 30,
      gem_cash_value: "0.015"
    });
    const zetaLowCard = tradingCardItem(3, {
      name: "Zeta low card",
      game_app_id: "20",
      game_name: "Zeta game",
      card_rarity: "foil",
      gem_yield: 5,
      gem_cash_value: "0.0025"
    });
    const fallbackCard = tradingCardItem(4, {
      name: "Unknown card",
      game_app_id: null,
      game_name: null,
      card_rarity: null,
      gem_yield: null,
      gem_cash_value: null
    });
    const otherItem = inventoryItem(5);
    const inventory = publicInventory(
      [zetaCard, otherItem, fallbackCard, alphaCard, zetaLowCard],
      {
        gem_status: "partial",
        gem_message: "One unknown trading-card group has no metadata.",
        gem_priceable_item_count: 4,
        gem_priced_item_count: 3,
        gem_cash_context: {
          currency: null,
          basis: "lowest_sell",
          market_hash_name: "753-Sack of Gems",
          sack_gems: 1000,
          sack_price: "0.5",
          observed_at: "2026-08-27T08:15:00Z"
        }
      }
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    const table = (await screen.findByRole("table", {
      name: "Inventory items"
    })) as HTMLTableElement;
    const groupLabels = () =>
      Array.from(table.tBodies).map(
        (body) => body.querySelector(".inventory-group-header th")?.textContent
      );
    expect(groupLabels()).toEqual([
      "Alpha game",
      "Zeta game",
      "Trading cards (game unavailable)",
      "Other inventory items"
    ]);
    expect(
      screen.getByRole("region", { name: "Trading-card gem values" })
    ).toHaveTextContent(
      "Gem cash value uses the SteamApis lowest-sell basis for 753-Sack of Gems (1000 gems). This feed has unknown currency. Each value is a per-card replacement-cost estimate."
    );
    expect(
      within(screen.getByText("Unknown card").closest("tr") as HTMLElement)
        .getAllByText("Unavailable")
    ).toHaveLength(2);
    expect(
      within(screen.getByText("Item 0005").closest("tr") as HTMLElement)
        .getAllByText("Not applicable")
    ).toHaveLength(5);

    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Gem value, ascending" })
    );
    expect(groupLabels()).toEqual([
      "Alpha game",
      "Zeta game",
      "Trading cards (game unavailable)",
      "Other inventory items"
    ]);
    const zetaRowNames = () =>
      Array.from(
        table.tBodies[1].querySelectorAll("tr.inventory-item")
      ).map((row) => row.querySelector(".inventory-item-name strong")?.textContent);
    expect(zetaRowNames()).toEqual(["Zeta low card", "Zeta high card"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Gem value, descending" })
    );
    expect(zetaRowNames()).toEqual(["Zeta high card", "Zeta low card"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Gem cash value, ascending" })
    );
    expect(zetaRowNames()).toEqual(["Zeta low card", "Zeta high card"]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Sort by Gem cash value, descending"
      })
    );
    expect(zetaRowNames()).toEqual(["Zeta high card", "Zeta low card"]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Group by game" }));
    expect(table.tBodies).toHaveLength(1);
    expect(
      table.querySelector(".inventory-group-header")
    ).not.toBeInTheDocument();
    expect(
      Array.from(table.querySelectorAll("tr.inventory-item"))
        .slice(0, 3)
        .map(
          (row) => row.querySelector(".inventory-item-name strong")?.textContent
        )
    ).toEqual(["Zeta high card", "Alpha card", "Zeta low card"]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Group by game" }));
    expect(groupLabels()).toEqual([
      "Alpha game",
      "Zeta game",
      "Trading cards (game unavailable)",
      "Other inventory items"
    ]);
  });

  it("reports partial gem coverage, rate limiting, and per-card cash provenance", async () => {
    const pricedCard = tradingCardItem(1, {
      gem_yield: 0,
      gem_cash_value: null
    });
    const pendingCard = tradingCardItem(2, {
      card_rarity: "foil",
      gem_yield: null,
      gem_cash_value: null
    });
    const inventory = publicInventory([pricedCard, pendingCard], {
      gem_status: "partial",
      gem_message: "One trading-card group is still pending.",
      gem_priceable_item_count: 2,
      gem_priced_item_count: 1,
      gem_rate_limited: true,
      gem_retry_after_seconds: 30,
      gem_cash_context: null
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    const coverage = await screen.findByRole("region", {
      name: "Trading-card gem values"
    });
    expect(within(coverage).getByText("Partial gem pricing")).toBeInTheDocument();
    expect(
      within(coverage).getByText(
        "Gem values are available for 1 of 2 trading-card item types."
      )
    ).toBeInTheDocument();
    expect(
      within(coverage).getByText("One trading-card group is still pending.")
    ).toBeInTheDocument();
    expect(
      within(coverage).getByText(/rate-limiting gem lookups/i)
    ).toHaveTextContent("try again in 30s");
    expect(
      within(coverage).getByText(/lowest-sell basis/i)
    ).toHaveTextContent(/unknown currency/i);
    const pricedRow = screen.getByText("Card 0001").closest("tr");
    expect(pricedRow).not.toBeNull();
    expect(within(pricedRow as HTMLElement).getByText("0")).toBeInTheDocument();
    const pendingRow = screen.getByText("Card 0002").closest("tr");
    expect(pendingRow).not.toBeNull();
    expect(
      within(pendingRow as HTMLElement).getAllByText("Unavailable")
    ).toHaveLength(2);
  });
  it("refreshes cached gem values without refetching the inventory", async () => {
    const normalCard = tradingCardItem(1, {
      gem_yield: 10,
      gem_cash_value: null
    });
    const foilCard = tradingCardItem(2, {
      card_rarity: "foil",
      gem_yield: null,
      gem_cash_value: null
    });
    const inventory = publicInventory([normalCard, foilCard], {
      gem_status: "partial",
      gem_message: "Background gem pricing is still processing card groups.",
      gem_priceable_item_count: 2,
      gem_priced_item_count: 1,
      boosters: [
        {
          game_app_id: "440",
          game_name: "Team Fortress 2",
          market_hash_name: "440-Team Fortress 2 Booster Pack",
          card_count: 3,
          card_set_size: null,
          gem_cost: null,
          price: validInventoryPrice
        }
      ],
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(publicInventorySession(inventory)))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              game_app_id: "440",
              card_rarity: "foil",
              gem_yield: 100
            },
            {
              game_app_id: "440",
              card_rarity: "normal",
              gem_yield: 10
            }
          ],
          pending_group_count: 0,
          boosters: [
            {
              game_app_id: "440",
              card_set_size: 8,
              gem_cost: 750
            }
          ],
          pending_booster_count: 0,
          gem_rate_limited: false,
          gem_retry_after_seconds: null
        })
      );

    render(<App />);

    const refresh = await screen.findByRole("button", {
      name: "Refresh gem values"
    });
    expect(refresh).toHaveTextContent("↻");
    fireEvent.click(refresh);

    expect(
      await screen.findByText("Gem values refreshed from the background cache.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Gem values are available for 2 of 2 trading-card item types."
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByText("Card 0002").closest("tr") as HTMLElement)
        .getByText("100")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Boosters" }));
    const boosterCard = within(
      await screen.findByRole("region", { name: "Booster details by game" })
    ).getByRole("article", { name: "Team Fortress 2" });
    expect(within(boosterCard).getByText("750", { selector: "dd" })).toBeInTheDocument();
    expect(within(boosterCard).getByText("8", { selector: "dd" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/auth/gems",
      expect.objectContaining({
        credentials: "include",
        method: "POST"
      })
    );
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      groups: [
        { game_app_id: "440", card_rarity: "foil" },
        { game_app_id: "440", card_rarity: "normal" }
      ]
    });
  });


  it.each([
    { card_set_size: 5, gem_cost: null },
    { card_set_size: null, gem_cost: 1200 },
    { card_set_size: 4, gem_cost: 1500 },
    { card_set_size: 16, gem_cost: 375 },
    { card_set_size: 5, gem_cost: 1199 },
    { card_set_size: 5.5, gem_cost: 1091 }
  ])("rejects malformed booster derivation values %j", async (derivedValues) => {
    const malformedBooster = {
      game_app_id: "440",
      game_name: "Team Fortress 2",
      market_hash_name: "440-Team Fortress 2 Booster Pack",
      card_count: 3,
      ...derivedValues,
      price: null
    };
    const inventory = publicInventory([tradingCardItem(1)], {
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      boosters: [malformedBooster]
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Steam connection is unavailable."
      })
    ).toBeInTheDocument();
  });

  it.each([
    {
      boosters: [{ game_app_id: "440", card_set_size: 8, gem_cost: 749 }],
      pending_booster_count: 0
    },
    {
      boosters: [
        { game_app_id: "440", card_set_size: null, gem_cost: null },
        { game_app_id: "440", card_set_size: null, gem_cost: null }
      ],
      pending_booster_count: 0
    },
    {
      boosters: [{ game_app_id: "999", card_set_size: null, gem_cost: null }],
      pending_booster_count: 0
    },
    {
      boosters: [{ game_app_id: "440", card_set_size: null, gem_cost: null }],
      pending_booster_count: -1
    },
    {
      boosters: [{ game_app_id: "440", card_set_size: null, gem_cost: null }],
      pending_booster_count: undefined
    }
  ])("rejects malformed booster refresh envelopes %j", async (refreshFields) => {
    const inventory = publicInventory([tradingCardItem(1)], {
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      boosters: [
        {
          game_app_id: "440",
          game_name: "Team Fortress 2",
          market_hash_name: "440-Team Fortress 2 Booster Pack",
          card_count: 3,
          card_set_size: null,
          gem_cost: null,
          price: null
        }
      ]
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(publicInventorySession(inventory)))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              game_app_id: "440",
              card_rarity: "normal",
              gem_yield: 10
            }
          ],
          pending_group_count: 0,
          ...refreshFields,
          gem_rate_limited: false,
          gem_retry_after_seconds: null
        })
      );

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh gem values" })
    );
    expect(
      await screen.findAllByText(
        "We could not refresh cached gem values. Your inventory results have not changed."
      )
    ).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects card metadata that violates the item-type invariants", async () => {
    const malformedItem = {
      ...inventoryItem(1),
      item_type: "other",
      game_app_id: "440"
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        publicInventorySession(publicInventory([malformedItem]))
      )
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Steam connection is unavailable."
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "What is in your inventory" })
    ).not.toBeInTheDocument();
  });
  it("rejects partially populated trading-card metadata", async () => {
    const malformedCard = tradingCardItem(1, {
      card_rarity: null,
      gem_yield: null,
      gem_cash_value: null
    });
    const inventory = publicInventory([malformedCard], {
      gem_status: "unavailable",
      gem_message: "Gem prices are unavailable.",
      gem_priceable_item_count: 1,
      gem_priced_item_count: 0
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(publicInventorySession(inventory))
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Steam connection is unavailable."
      })
    ).toBeInTheDocument();
  });


  it("clears the local session with a credentialed logout POST", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(<App />);

    await screen.findByRole("heading", { name: "Alyx" });
    const statusRegion = screen.getByRole("status");
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out on this device" })
    );

    expect(
      await screen.findByRole("heading", {
        name: "Connect Steam to check public access."
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toBe(statusRegion);
    expect(statusRegion).toHaveTextContent("Signed out successfully.");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/logout", {
      credentials: "include",
      method: "POST"
    });
  });
});
