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
import { clearInventoryCache } from "./inventoryCache";

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
  gem_message: "Gem-convertible values are unavailable while the inventory is private.",
  gem_priceable_item_count: 0,
  gem_priced_item_count: 0,
  gem_rate_limited: false,
  gem_retry_after_seconds: null,
  gem_cash_context: null,
  boosters: [],
  items: []

};

const badgeCheckedAt = new Date().toISOString();
const changedBadgeCheckedAt = new Date(Date.parse(badgeCheckedAt) - 1_000).toISOString();

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
    badges: {
      status: "public",
      message: "Steam badge data is available.",
      player_xp: 1_250,
      player_level: 11,
      checked_at: badgeCheckedAt,
      normal_badge_levels: []
    }
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
    rarity: null,
    card_border: null,
    gem_key: null,
    gem_yield: null,
    gem_cash_value: null
  };
}

function tradingCardItem(
  index: number,
  overrides: Record<string, unknown> = {}
) {
  const cardBorder =
    "card_border" in overrides ? overrides.card_border : "normal";
  const gameAppId =
    "game_app_id" in overrides ? overrides.game_app_id : "440";
  const gemKey =
    "gem_key" in overrides
      ? overrides.gem_key
      : typeof gameAppId === "string"
        ? {
          app_id: gameAppId,
          item_type: 2,
          border_color: cardBorder === "foil" ? 1 : 0
        }
        : null;

  return {
    ...inventoryItem(index),
    name: `Card ${String(index).padStart(4, "0")}`,
    market_hash_name: `Card ${String(index).padStart(4, "0")}`,
    item_type: "trading_card",
    game_app_id: "440",
    game_name: "Team Fortress 2",
    rarity: null,
    card_border: cardBorder,
    gem_key: gemKey,
    gem_yield: 10,
    gem_cash_value: null,
    ...overrides
  };

}
const validInventoryPrice = {
  currency: "USD",
  highest_buy: "0.10",
  lowest_sell: "0.20",
  observed_at: null
};

const validGemCashContext = {
  currency: "USD",
  basis: "lowest_sell",
  market_hash_name: "753-Sack of Gems",
  sack_gems: 1000,
  sack_price: "100.01",
  highest_buy: "50.01",
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
    gem_message: "No gem-convertible items require gem prices.",
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
function levelUpNoOpportunityResponse(
  reason: "no_sellable_card" | "no_positive_xp_swap" = "no_sellable_card",
  inventoryRefreshedAt = "2026-08-29T11:30:00Z"
) {
  return {
    status: "no_opportunity",
    reason,
    generated_at: "2026-08-29T12:00:00Z",
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
  };
}

function levelUpNoOpportunityForRequest(
  reason: "no_sellable_card" | "no_positive_xp_swap" = "no_sellable_card"
) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      inventory_refreshed_at: string;
    };
    const response = levelUpNoOpportunityResponse(
      reason,
      request.inventory_refreshed_at
    );
    response.generated_at = new Date().toISOString();
    return jsonResponse(response);
  };
}



function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

function inventoryWithRetry(retryAfterSeconds: number | null) {
  return {
    ...privateInventory,
    retry_after_seconds: retryAfterSeconds
  };
}
afterEach(async () => {
  await clearInventoryCache();
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

describe("FAQ", () => {
  it("renders the dedicated FAQ route without loading a Steam session", () => {
    window.history.replaceState({}, "", "/faq");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    render(<App />);
    expect(document.title).toBe("FAQ | Steam Optimizer");

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Steam inventory questions, answered."
      })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Primary navigation" }))
        .getByRole("link", { name: "FAQ" })
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Steam Optimizer home" })
    ).toHaveAttribute("href", "/");
    expect(
      screen.getByRole("heading", { name: "Can Steam Optimizer change my account?" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "How are gem values calculated?" })
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("App", () => {
  it("loads the session before offering the compact Steam sign-in", async () => {
    let resolveSession!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSession = resolve;
        })
    );

    render(<App />);

    expect(
      screen.getByRole("region", { name: "Steam session" })
    ).toHaveTextContent("Checking your Steam session");
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toHaveTextContent("Checking session");
    expect(
      screen.queryByRole("link", { name: /steam sign-in/i })
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveSession(jsonResponse({ authenticated: false }));
    });

    const loginLink = await screen.findByRole("link", {
      name: /steam sign-in/i
    });
    expect(screen.getByRole("status")).toBe(statusRegion);
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
    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: "FAQ" })
    ).toHaveAttribute("href", "/faq");
    expect(screen.queryByText("Read-only workspace")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/cannot trade, sell, craft, or change/i)
    ).not.toBeInTheDocument();
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
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory));
    render(<App />);

    expect(
      await screen.findByLabelText("Connected Steam account: Alyx")
    ).toBeInTheDocument();
    expect(screen.getByText("Steam ID 76561198000000001")).toBeInTheDocument();

    const profileStatus = screen.getByRole("definition", {
      name: "Steam profile: Public"
    });
    expect(profileStatus).toBeInTheDocument();

    const inventoryStatus = screen.getByRole("definition", {
      name: "Steam inventory: Private"
    });
    expect(inventoryStatus).toBeInTheDocument();

    const faq = screen.getByRole("region", { name: "About these results" });
    expect(
      within(faq).getByText("Your Steam profile is publicly visible.")
    ).toBeInTheDocument();
    expect(
      within(faq).getByText("Steam reports that this inventory is private.")
    ).toBeInTheDocument();
    expect(
      within(faq).getByRole("link", {
        name: /open Steam privacy settings/i
      })
    ).toHaveAttribute("href", "https://steamcommunity.com/my/edit/settings");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/session",
      expect.objectContaining({
        credentials: "include",
        headers: { Accept: "application/json" }
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/auth/inventory",
      expect.objectContaining({
        credentials: "include",
        method: "POST"
      })
    );
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
        currency: "USD",
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const inventoryRegion = await screen.findByRole("region", {
      name: "Inventory and level-up planning"
    });
    const pricingSummary = within(inventoryRegion).getByLabelText(
      "Inventory pricing summary"
    );
    expect(within(pricingSummary).getByText("Items")).toBeInTheDocument();
    expect(within(pricingSummary).getByText("4")).toBeInTheDocument();
    expect(within(pricingSummary).getByText("1/1")).toBeInTheDocument();
    expect(
      within(pricingSummary).getByRole("button", {
        name: "Refresh gem values"
      })
    ).toBeDisabled();
    const faq = screen.getByRole("region", { name: "About these results" });
    expect(
      within(faq).getByText(
        "SteamApis price data is available for 1 of 1 marketable item type."
      )
    ).toBeInTheDocument();
    expect(
      within(faq).getByText(
        "SteamApis market prices are USD decimal amounts. Numeric values are preserved exactly as received and labeled USD."
      )
    ).toBeInTheDocument();

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
    expect(within(pricedRow as HTMLElement).getByText("USD 0.12")).toBeInTheDocument();
    expect(within(pricedRow as HTMLElement).getByText("USD 1.005")).toBeInTheDocument();
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
  it("computes quantity-aware market totals with exact mixed-scale decimals and coverage", async () => {
    const pricedCard = tradingCardItem(1, {
      market_hash_name: "Priced card",
      quantity: 3,
      marketable: true,
      tradable: true,
      gem_key: null,
      gem_yield: null,
      gem_cash_value: null,
      price: {
        currency: "USD",
        highest_buy: "0.1",
        lowest_sell: "1.005",
        observed_at: null
      }
    });
    const partiallyPricedItem = {
      ...inventoryItem(2),
      name: "Partially priced item",
      market_hash_name: "Partially priced item",
      quantity: 2,
      marketable: true,
      tradable: true,
      price: {
        currency: "USD",
        highest_buy: null,
        lowest_sell: "0.20",
        observed_at: null
      }
    };
    const missingPriceItem = {
      ...inventoryItem(3),
      name: "Missing price item",
      market_hash_name: "Missing price item",
      quantity: 4,
      marketable: true,
      tradable: true,
      price: null
    };
    const inventory = publicInventory(
      [pricedCard, partiallyPricedItem, missingPriceItem],
      {
        total_asset_count: 9,
        priceable_item_count: 3,
        priced_item_count: 2,
        price_status: "partial",
        price_message: "One marketable item type is still waiting for a quote.",
        boosters: [
          {
            game_app_id: "440",
            game_name: "Team Fortress 2",
            market_hash_name: "440-Team Fortress 2 Booster Pack",
            card_count: 3,
            card_set_size: null,
            gem_cost: null,
            price: {
              currency: "USD",
              highest_buy: "100",
              lowest_sell: "200",
              observed_at: null
            }
          }
        ]
      }
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const pricingSummary = await screen.findByLabelText(
      "Inventory pricing summary"
    );
    expect(
      within(pricingSummary).getByText("USD 0.3")
    ).toBeInTheDocument();
    expect(
      within(pricingSummary).getByText("USD 3.415")
    ).toBeInTheDocument();
    expect(
      within(pricingSummary).getByText("Coverage 1/3 item types")
    ).toBeInTheDocument();
    expect(
      within(pricingSummary).getByText("Coverage 2/3 item types")
    ).toBeInTheDocument();
    expect(
      within(pricingSummary).queryByText("USD 100")
    ).not.toBeInTheDocument();
  });

  it("renders zero market totals when no inventory item needs a quote", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(publicInventory([])));

    render(<App />);

    const pricingSummary = await screen.findByLabelText(
      "Inventory pricing summary"
    );
    expect(within(pricingSummary).getAllByText("USD 0")).toHaveLength(2);
    expect(
      within(pricingSummary).getAllByText("Coverage 0/0 item types")
    ).toHaveLength(2);
  });

  it("does not report zero value when inventory ownership is unknown", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory));

    render(<App />);

    const pricingSummary = await screen.findByLabelText(
      "Inventory pricing summary"
    );
    expect(within(pricingSummary).queryByText("USD 0")).not.toBeInTheDocument();
    expect(within(pricingSummary).getAllByText("Unavailable")).toHaveLength(2);
  });

  it("keeps the Level-up page available when inventory loading fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(within(tablist).getByRole("tab", { name: "Level-up" }));

    const calculator = await screen.findByRole("region", {
      name: "Level-up calculator"
    });
    expect(within(calculator).getByText("1,250 XP")).toBeInTheDocument();
    expect(
      within(calculator).getByRole("spinbutton", { name: "Target level" })
    ).toHaveValue(11);
  });

  it("renders the initial badge session XP and level in the Level-up calculator", async () => {
    const inventory = publicInventory([inventoryItem(1)]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(jsonResponse(levelUpNoOpportunityResponse()));

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(within(tablist).getByRole("tab", { name: "Level-up" }));
    const calculator = await screen.findByRole("region", {
      name: "Level-up calculator"
    });

    expect(within(calculator).getByText("1,250 XP")).toBeInTheDocument();
    expect(within(calculator).getByText("11")).toBeInTheDocument();
    const targetInput = within(calculator).getByRole("spinbutton", {
      name: "Target level"
    });
    expect(targetInput).toHaveValue(11);
    expect(targetInput).toHaveAttribute("min", "11");
    expect(targetInput).toHaveAttribute("max", "100000");
    expect(within(calculator).getByText("0 XP")).toBeInTheDocument();
    expect(within(calculator).getByText("Badges needed")).toBeInTheDocument();
  });

  it("calculates XP and whole-badge requirements from the target level", async () => {
    const inventory = publicInventory([inventoryItem(1)]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(jsonResponse(levelUpNoOpportunityResponse()));

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(within(tablist).getByRole("tab", { name: "Level-up" }));
    const calculator = await screen.findByRole("region", {
      name: "Level-up calculator"
    });
    const targetInput = within(calculator).getByRole("spinbutton", {
      name: "Target level"
    });

    fireEvent.change(targetInput, { target: { value: "12" } });
    expect(within(calculator).getByText("150 XP")).toBeInTheDocument();
    expect(within(calculator).getByText("2")).toBeInTheDocument();
    expect(
      within(calculator).queryByRole("alert")
    ).not.toBeInTheDocument();
  });

  it("rejects invalid Level-up targets without showing computed totals", async () => {
    const inventory = publicInventory([inventoryItem(1)]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(jsonResponse(levelUpNoOpportunityResponse()));

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(within(tablist).getByRole("tab", { name: "Level-up" }));
    const calculator = await screen.findByRole("region", {
      name: "Level-up calculator"
    });
    const targetInput = within(calculator).getByRole("spinbutton", {
      name: "Target level"
    });

    fireEvent.change(targetInput, { target: { value: "10" } });
    expect(within(calculator).getByRole("alert")).toHaveTextContent(
      "Target level cannot be below your current level (11)."
    );
    expect(within(calculator).queryByText("XP needed")).not.toBeInTheDocument();

    fireEvent.change(targetInput, { target: { value: "100001" } });
    expect(within(calculator).getByRole("alert")).toHaveTextContent(
      "Target level cannot exceed 100000."
    );
    expect(within(calculator).queryByText("XP needed")).not.toBeInTheDocument();

    fireEvent.change(targetInput, { target: { value: "12.5" } });
    expect(within(calculator).getByRole("alert")).toHaveTextContent(
      "Target level must be a whole number"
    );
    expect(within(calculator).queryByText("Badges needed")).not.toBeInTheDocument();
  });

  it("renders badge-unavailable null state and provider message", async () => {
    const unavailableBadgeSession = {
      ...signedInSession,
      checks: {
        ...signedInSession.checks,
        badges: {
          status: "unavailable",
          message: "Steam badge check is unavailable.",
          player_xp: null,
          player_level: null,
          checked_at: null,
          normal_badge_levels: []
        }
      }
    };
    const inventory = publicInventory([inventoryItem(1)]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(unavailableBadgeSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(jsonResponse(levelUpNoOpportunityResponse()));

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(within(tablist).getByRole("tab", { name: "Level-up" }));
    const calculator = await screen.findByRole("region", {
      name: "Level-up calculator"
    });

    expect(
      within(calculator).getByText(
        "Badge data is unavailable: Steam badge check is unavailable."
      )
    ).toBeInTheDocument();
    expect(within(calculator).getAllByText("Unavailable")).toHaveLength(2);
    expect(
      within(calculator).getByRole("spinbutton", { name: "Target level" })
    ).toBeDisabled();
    expect(
      within(calculator).queryByText("XP needed")
    ).not.toBeInTheDocument();
  });

  it("synchronizes the target when same-account badge data changes", async () => {
    const unavailableBadgeSession = {
      ...signedInSession,
      checks: {
        ...signedInSession.checks,
        badges: {
          status: "unavailable",
          message: "Steam badge check is unavailable.",
          player_xp: null,
          player_level: null,
          checked_at: null,
          normal_badge_levels: []
        }
      }
    };
    const levelTwelveSession = {
      ...signedInSession,
      checks: {
        ...signedInSession.checks,
        badges: {
          status: "public",
          message: "Steam badge data is available.",
          player_xp: 1_450,
          player_level: 12,
          checked_at: changedBadgeCheckedAt,
          normal_badge_levels: []
        }
      }
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(unavailableBadgeSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory))
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(levelTwelveSession));

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(within(tablist).getByRole("tab", { name: "Level-up" }));
    const calculator = await screen.findByRole("region", {
      name: "Level-up calculator"
    });
    const targetInput = within(calculator).getByRole("spinbutton", {
      name: "Target level"
    });
    expect(targetInput).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );
    await waitFor(() => {
      expect(targetInput).toBeEnabled();
      expect(targetInput).toHaveValue(11);
    });

    fireEvent.change(targetInput, { target: { value: "20" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );
    await waitFor(() => {
      expect(
        within(calculator).getByText("Current level").closest("div")
      ).toHaveTextContent("12");
      expect(targetInput).toHaveValue(20);
    });
  });

  it("invalidates optimizer results when rechecked badge state changes", async () => {
    const levelTwelveSession = {
      ...signedInSession,
      checks: {
        ...signedInSession.checks,
        badges: {
          status: "public",
          message: "Steam badge data is available.",
          player_xp: 1_450,
          player_level: 12,
          checked_at: changedBadgeCheckedAt,
          normal_badge_levels: []
        }
      }
    };
    const inventory = publicInventory([inventoryItem(1)]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockImplementationOnce(
        levelUpNoOpportunityForRequest("no_sellable_card")
      )
      .mockResolvedValueOnce(jsonResponse(levelTwelveSession))
      .mockImplementationOnce(levelUpNoOpportunityForRequest("no_positive_xp_swap"));

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(within(tablist).getByRole("tab", { name: "Level-up" }));
    expect(
      await screen.findByText(
        "No sellable normal card with a usable current bid is available in this inventory snapshot."
      )
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );

    expect(
      await screen.findByText(
        "No one-card sale funds a badge path with more XP than the immediate craft opportunity it gives up."
      )
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/api\/auth\/level-up$/);
    expect(fetchMock.mock.calls[4][0]).toMatch(/\/api\/auth\/level-up$/);
  });

  it("filters gem-convertible items by exact per-item gem cash value above lowest sell", async () => {
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
        gem_message: "One gem-convertible item does not have a current gem value.",
        gem_priceable_item_count: 7,
        gem_priced_item_count: 6,
        gem_cash_context: validGemCashContext
      }
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const allTab = await screen.findByRole("tab", { name: /^All items/ });
    const worthMoreTab = screen.getByRole("tab", {
      name: /^Worth more as gems/
    });
    fireEvent.click(worthMoreTab);

    expect(worthMoreTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText(
        /Worth more as gems compares each gem-convertible item.*current lowest-sell market price/i
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
      gem_message: "Gem values were found for every gem-convertible item.",
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_cash_context: validGemCashContext
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

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
      gem_message: "Gem values were found for every gem-convertible item.",
      gem_priceable_item_count: cards.length,
      gem_priced_item_count: cards.length,
      gem_cash_context: validGemCashContext
    });
    let resolveShrink!: (response: Response) => void;
    const shrinkResponse = new Promise<Response>((resolve) => {
      resolveShrink = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockImplementationOnce(() => shrinkResponse)
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              app_id: "440",
              item_type: 2,
              border_color: 0,
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
      "101 gem-convertible item types are currently worth more as gems."
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
              app_id: "440",
              item_type: 2,
              border_color: 0,
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
      "No gem-convertible item types are currently worth more as gems."
    );
    expect(document.getElementById("inventory-panel-worth-gems")).toHaveFocus();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh gem values" })
    );

    await screen.findByRole("table", { name: "Inventory items" });
    expect(resultStatus).toHaveTextContent(
      "101 gem-convertible item types are currently worth more as gems."
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
      gem_message: "Gem values were found for every gem-convertible item.",
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_cash_context: validGemCashContext
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

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
        /No marketable gem-convertible item with both a gem cash value and a current lowest-sell market price currently qualifies/i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Worth more as gems compares each gem-convertible item.*current lowest-sell market price/i
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
      gem_message: "Gem values are current for all gem-convertible items.",
      boosters: [
        {
          game_app_id: "440",
          game_name: "Team Fortress 2",
          market_hash_name: "440-Team Fortress 2 Booster Pack",
          card_count: 3,
          card_set_size: 8,
          gem_cost: 750,
          price: {
            currency: "USD",
            highest_buy: "0.11",
            lowest_sell: "0.13",
            observed_at: "2026-08-27T00:00:00Z"
          }
        }
      ]
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);


    const section = await screen.findByRole("region", {
      name: "Booster details by game"
    });
    const boosterCard = within(section).getByRole("article", {
      name: "Team Fortress 2"
    });
    expect(within(boosterCard).getByText("USD 0.13")).toBeInTheDocument();
    expect(within(boosterCard).getByText("USD 0.11")).toBeInTheDocument();
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);


    const boosterCard = within(
      await screen.findByRole("region", { name: "Booster details by game" })
    ).getByRole("article", { name: "Team Fortress 2" });
    expect(within(boosterCard).getByText("Gem cost")).toBeInTheDocument();
    expect(within(boosterCard).getByText("Cards in set")).toBeInTheDocument();
    expect(within(boosterCard).getAllByText("Unavailable")).toHaveLength(2);
    expect(within(boosterCard).getByText("USD 0.20")).toBeInTheDocument();
    expect(within(boosterCard).getByText("USD 0.10")).toBeInTheDocument();
  });
  it("switches between Inventory and Level-up result panels with manual keyboard activation", async () => {
    const inventory = publicInventory([tradingCardItem(10)], {
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_status: "complete",
      gem_message: "Gem values are current for all gem-convertible items.",
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
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockImplementationOnce(levelUpNoOpportunityForRequest());
    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    const inventoryTab = within(tablist).getByRole("tab", { name: "Inventory" });
    const levelUpTab = within(tablist).getByRole("tab", { name: "Level-up" });
    const inventoryPanel = document.getElementById(
      "inventory-results-panel-inventory"
    );
    const levelUpPanel = document.getElementById(
      "inventory-results-panel-level-up"
    );

    expect(within(tablist).getAllByRole("tab")).toHaveLength(2);
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");
    expect(levelUpTab).toHaveAttribute("aria-selected", "false");
    expect(inventoryTab).toHaveAttribute(
      "aria-controls",
      "inventory-results-panel-inventory"
    );
    expect(levelUpTab).toHaveAttribute(
      "aria-controls",
      "inventory-results-panel-level-up"
    );
    expect(inventoryPanel).not.toHaveAttribute("hidden");
    expect(levelUpPanel).toHaveAttribute("hidden");
    expect(
      screen.getByRole("table", { name: "Inventory items" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Booster details by game" })
    ).toBeInTheDocument();

    inventoryTab.focus();
    fireEvent.keyDown(inventoryTab, { key: "ArrowRight" });
    expect(levelUpTab).toHaveFocus();
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(levelUpTab, { key: " " });
    expect(levelUpTab).toHaveAttribute("aria-selected", "true");
    expect(inventoryTab).toHaveAttribute("aria-selected", "false");
    expect(inventoryPanel).toHaveAttribute("hidden");
    expect(levelUpPanel).not.toHaveAttribute("hidden");
    expect(
      screen.queryByRole("table", { name: "Inventory items" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Booster details by game" })
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText(/No sellable normal card with a usable current bid/)
    ).toBeInTheDocument();

    fireEvent.click(inventoryTab);
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");
    expect(inventoryPanel).not.toHaveAttribute("hidden");
    expect(levelUpPanel).toHaveAttribute("hidden");
    expect(
      screen.getByRole("table", { name: "Inventory items" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Booster details by game" })
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("adds a lazy Level-up tab with stable ARIA wiring and manual activation", async () => {
    const inventory = publicInventory([inventoryItem(1)]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockImplementationOnce(levelUpNoOpportunityForRequest());

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    const inventoryTab = within(tablist).getByRole("tab", { name: "Inventory" });
    const levelUpTab = within(tablist).getByRole("tab", { name: "Level-up" });
    const inventoryPanel = document.getElementById(
      "inventory-results-panel-inventory"
    );
    const levelUpPanel = document.getElementById(
      "inventory-results-panel-level-up"
    );
    const optimizerPanel = document.getElementById(
      "level-up-optimization-panel"
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/api/auth/level-up")
      )
    ).toBe(false);
    expect(inventoryTab).toHaveAttribute(
      "id",
      "inventory-results-tab-inventory"
    );
    expect(inventoryTab).toHaveAttribute(
      "aria-controls",
      "inventory-results-panel-inventory"
    );
    expect(levelUpTab).toHaveAttribute("id", "inventory-results-tab-level-up");
    expect(levelUpTab).toHaveAttribute(
      "aria-controls",
      "inventory-results-panel-level-up"
    );
    expect(levelUpTab).toHaveAttribute("aria-selected", "false");
    expect(levelUpTab).toHaveAttribute("tabindex", "-1");
    expect(levelUpPanel).toHaveAttribute("role", "tabpanel");
    expect(levelUpPanel).toHaveAttribute(
      "aria-labelledby",
      "inventory-results-tab-level-up"
    );
    expect(levelUpPanel).toHaveAttribute("hidden");
    expect(optimizerPanel).not.toHaveAttribute("role", "tabpanel");
    expect(optimizerPanel).not.toHaveAttribute("aria-labelledby");
    expect(inventoryPanel).not.toBeNull();

    inventoryTab.focus();
    fireEvent.keyDown(inventoryTab, { key: "ArrowLeft" });
    expect(levelUpTab).toHaveFocus();
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(levelUpTab, { key: "Home" });
    expect(inventoryTab).toHaveFocus();
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(inventoryTab, { key: "End" });
    expect(levelUpTab).toHaveFocus();
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(levelUpTab, { key: "Enter" });
    expect(levelUpTab).toHaveAttribute("aria-selected", "true");
    expect(inventoryTab).toHaveAttribute("aria-selected", "false");
    expect(levelUpPanel).not.toHaveAttribute("hidden");
    expect(
      await screen.findByText(/No sellable normal card with a usable current bid/)
    ).toBeInTheDocument();
    expect(screen.getByText("Current total XP")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fireEvent.click(inventoryTab);
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");
    expect(levelUpPanel).toHaveAttribute("hidden");
    levelUpTab.focus();
    fireEvent.keyDown(levelUpTab, { key: " " });
    expect(levelUpTab).toHaveAttribute("aria-selected", "true");
    expect(levelUpPanel).not.toHaveAttribute("hidden");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fireEvent.keyDown(levelUpTab, { key: "ArrowRight" });
    expect(inventoryTab).toHaveFocus();
    fireEvent.keyDown(inventoryTab, { key: "ArrowLeft" });
    expect(levelUpTab).toHaveFocus();
  });

  it("reaches private inventory recovery without requesting level-up data", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory));

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    const levelUpTab = within(tablist).getByRole("tab", {
      name: "Level-up"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(levelUpTab);

    expect(
      await screen.findByText(/Make your Steam inventory public/)
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/api/auth/level-up")
      )
    ).toBe(false);
  });

  it("invalidates a cached recommendation when ownership is refreshed", async () => {
    const sourceCard = tradingCardItem(1, {
      market_hash_name: "440-Card 0001 (Trading Card)",
      gem_key: null,
      gem_yield: null
    });
    const initialInventory = publicInventory([sourceCard]);
    const refreshedInventory = publicInventory(
      [{ ...sourceCard, quantity: 2 }],
      { total_asset_count: 2 }
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(initialInventory))
      .mockImplementationOnce(levelUpNoOpportunityForRequest("no_sellable_card"))
      .mockResolvedValueOnce(jsonResponse(refreshedInventory))
      .mockImplementationOnce(
        levelUpNoOpportunityForRequest("no_positive_xp_swap")
      );

    render(<App />);

    const tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    const levelUpTab = within(tablist).getByRole("tab", {
      name: "Level-up"
    });
    fireEvent.click(levelUpTab);
    expect(
      await screen.findByText(/No sellable normal card with a usable current bid/)
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh inventory" })
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    expect(
      await screen.findByText(/No one-card sale funds a badge path with more XP/)
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      screen.queryByText(/No sellable normal card with a usable current bid/)
    ).not.toBeInTheDocument();
  });

  it("does not expose a prior-account recommendation after the session changes", async () => {
    const changedSteamId = "76561198000000002";
    const changedSession = {
      ...signedInSession,
      user: {
        ...signedInSession.user,
        steam_id: changedSteamId,
        display_name: "Barney"
      }
    };
    const initialInventory = publicInventory([inventoryItem(1)]);
    const changedInventory = publicInventory([inventoryItem(2)]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(initialInventory))
      .mockImplementationOnce(levelUpNoOpportunityForRequest("no_sellable_card"))
      .mockResolvedValueOnce(jsonResponse(changedSession))
      .mockResolvedValueOnce(jsonResponse(changedInventory))
      .mockImplementationOnce(
        levelUpNoOpportunityForRequest("no_positive_xp_swap")
      );

    render(<App />);

    let tablist = await screen.findByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(
      within(tablist).getByRole("tab", { name: "Level-up" })
    );
    expect(
      await screen.findByText(/No sellable normal card with a usable current bid/)
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );
    expect(
      await screen.findByText(/Account changed\. Steam profile: Public\./)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No sellable normal card with a usable current bid/)
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Connected Steam account: Barney")
    ).toBeInTheDocument();

    tablist = screen.getByRole("tablist", {
      name: "Inventory result views"
    });
    fireEvent.click(
      within(tablist).getByRole("tab", { name: "Level-up" })
    );
    expect(
      await screen.findByText(/No one-card sale funds a badge path with more XP/)
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/auth/level-up",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Expected-Steam-ID": changedSteamId
        })
      })
    );
  });

  it("shows an empty booster section inside the Inventory panel", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(publicInventory([])));

    render(<App />);


    expect(
      await screen.findByRole("heading", { name: "No booster packs to display" })
    ).toBeInTheDocument();
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
        currency: "USD",
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
        currency: "USD",
        highest_buy: "0.02",
        lowest_sell: "0.20",
        observed_at: "2026-08-26T12:00:00Z"
      }
    };
    const inventory = publicInventory([charlie, alpha, bravo], {
      total_asset_count: 13,
      priceable_item_count: 2,
      priced_item_count: 2
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const inventoryTable = await screen.findByRole("table", {
      name: "Inventory items"
    });
    const renderedNames = () =>
      Array.from(inventoryTable.querySelectorAll("tr.inventory-item")).map(
        (row) => row.querySelector("strong")?.textContent ?? null
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(
        jsonResponse(publicInventory([{ ...inventoryItem(1), quantity: 0 }]))
      );

    render(<App />);

    expect(
      await screen.findByRole("definition", {
        name: "Steam inventory: Unavailable"
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Inventory items" })
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      label: "an unsupported currency",
      price: { ...validInventoryPrice, currency: "EUR" }
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
        currency: "USD",
        lowest_sell: "0.20",
        observed_at: null
      }
    },
    {
      label: "a missing lowest sell field",
      price: {
        currency: "USD",
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
        currency: "USD",
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(
        jsonResponse(
          publicInventory([item], {
            priceable_item_count: 1,
            priced_item_count: 1
          })
        )
      );

    render(<App />);

    expect(
      await screen.findByRole("definition", {
        name: "Steam inventory: Unavailable"
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Inventory items" })
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    expect(
      await screen.findByRole("definition", {
        name: "Steam inventory: Unavailable"
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Inventory items" })
    ).not.toBeInTheDocument();
  });

  it("shows partial price coverage and marks a marketable unpriced item unavailable", async () => {
    const pricedItem = {
      ...inventoryItem(1),
      market_hash_name: "Item 0001",
      marketable: true,
      price: {
        currency: "USD",
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const faq = await screen.findByRole("region", {
      name: "About these results"
    });
    const pricingSummary = screen.getByLabelText("Inventory pricing summary");
    expect(within(pricingSummary).getByText("1/2")).toBeInTheDocument();
    expect(
      within(faq).getByText(
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const faq = await screen.findByRole("region", {
      name: "About these results"
    });
    expect(
      within(faq).getByText(
        "The inventory is public, but current Steam market prices are unavailable."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("definition", { name: "Steam inventory: Public" })
    ).toBeInTheDocument();
    expect(
      within(faq).queryByRole("link", {
        name: /open Steam privacy settings/i
      })
    ).not.toBeInTheDocument();
  });

  it("paginates a 2,001-item inventory without rendering more than one page", async () => {
    const items = Array.from({ length: 2001 }, (_, index) =>
      inventoryItem(index + 1)
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(publicInventory(items)));

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

  it("clamps the stored inventory page after an explicit refresh shrinks the result", async () => {
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
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(publicInventory(initialItems)))
      .mockResolvedValueOnce(jsonResponse(publicInventory(shrunkenItems)))
      .mockResolvedValueOnce(jsonResponse(publicInventory(grownItems)));

    render(<App />);

    const inventoryTable = await screen.findByRole("table", {
      name: "Inventory items"
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Inventory page" }), {
      target: { value: "3" }
    });
    expect(within(inventoryTable).getByText("Item 0101")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh inventory" })
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
      await screen.findByRole("button", { name: "Refresh inventory" })
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("preserves good inventory data and announces an unavailable refresh", async () => {
    const inventory = publicInventory([inventoryItem(1)]);
    const failureMessage =
      "Steam could not provide the inventory right now.";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(
        jsonResponse({
          ...privateInventory,
          status: "unavailable",
          message: failureMessage
        })
      );

    render(<App />);

    await screen.findByRole("heading", { name: "Inventory and level-up planning" });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh inventory" })
    );

    const message =
      "We could not refresh inventory right now. Your previous inventory results have not changed.";
    expect(await screen.findByText(message, { selector: ".action-status" }))
      .toBeInTheDocument();
    expect(screen.getByText("Item 0001")).toBeInTheDocument();
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
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse(signedInSession))
        .mockResolvedValueOnce(
          jsonResponse({
            ...privateInventory,
            retry_after_seconds: retryAfterSeconds
          })
        );

      render(<App />);

      expect(
        await screen.findByRole("definition", {
          name: "Steam inventory: Unavailable"
        })
      ).toBeInTheDocument();
    }
  );

  it.each([undefined, null, 0, "true"])(
    "rejects an invalid inventory rate-limit marker (%j)",
    async (rateLimited) => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse(signedInSession))
        .mockResolvedValueOnce(
          jsonResponse({
            ...privateInventory,
            rate_limited: rateLimited
          })
        );

      render(<App />);

      expect(
        await screen.findByRole("definition", {
          name: "Steam inventory: Unavailable"
        })
      ).toBeInTheDocument();
    }
  );
  it("labels an unavailable upstream check separately from privacy", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          ...signedInSession,
          checks: {
            ...signedInSession.checks,
            profile: {
              status: "unavailable",
              message: "The Steam Web API is not configured."
            }
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse(publicInventory([])));

    render(<App />);

    await screen.findByLabelText("Connected Steam account: Alyx");
    const profileStatus = screen.getByRole("definition", {
      name: "Steam profile: Unavailable"
    });
    expect(profileStatus).toBeInTheDocument();
    const faq = screen.getByRole("region", { name: "About these results" });
    expect(
      within(faq).getByText("The Steam Web API is not configured.")
    ).toBeInTheDocument();
    expect(within(faq).getByText(/not a privacy result/i)).toBeInTheDocument();
    expect(profileStatus).not.toHaveTextContent("Private");
  });

  it("shows the backend 429 copy and rate-limit guidance instead of privacy guidance", async () => {
    const rateLimitMessage =
      "Steam is temporarily limiting inventory checks. Try again in 30 seconds.";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(
        jsonResponse({
          ...privateInventory,
          status: "unavailable",
          message: rateLimitMessage,
          retry_after_seconds: 30,
          rate_limited: true
        })
      );

    render(<App />);

    await screen.findByLabelText("Connected Steam account: Alyx");
    const inventoryStatus = screen.getByRole("definition", {
      name: "Steam inventory: Try later"
    });
    expect(inventoryStatus).toBeInTheDocument();
    const faq = screen.getByRole("region", { name: "About these results" });
    expect(within(faq).getByText(rateLimitMessage)).toBeInTheDocument();
    expect(
      within(faq).getByText(
        /Steam is temporarily limiting automated checks/i
      )
    ).toHaveTextContent(/does not mean the inventory is private/i);
    expect(
      within(faq).queryByRole("link", {
        name: /open Steam privacy settings/i
      })
    ).not.toBeInTheDocument();
    expect(
      within(faq).queryByText(/Recheck when the service is available/i)
    ).not.toBeInTheDocument();
  });

  it("applies an authoritative initial cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventoryWithRetry(3)));

    render(<App />);
    await act(async () => { });

    expect(
      screen.getByLabelText("Connected Steam account: Alyx")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Repeated immediate inventory refreshes are disabled. Try again in 3s."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh inventory" })
    ).toBeDisabled();
  });

  it("updates the authoritative cooldown from an inventory refresh response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory))
      .mockResolvedValueOnce(jsonResponse(inventoryWithRetry(4)));

    render(<App />);
    await act(async () => { });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh inventory" })
    );
    await act(async () => { });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      screen.getByText(
        "Repeated immediate inventory refreshes are disabled. Try again in 4s."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh inventory" })
    ).toBeDisabled();
  });
  it("guards inventory refresh without fetching during cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventoryWithRetry(5)));

    render(<App />);
    await act(async () => { });

    const refreshButton = screen.getByRole("button", {
      name: "Refresh inventory"
    });
    expect(refreshButton).toBeDisabled();

    refreshButton.removeAttribute("disabled");
    fireEvent.click(refreshButton);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores wall-clock jumps while enforcing cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventoryWithRetry(5)));

    render(<App />);
    await act(async () => { });

    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    const refreshButton = screen.getByRole("button", {
      name: "Refresh inventory"
    });
    refreshButton.removeAttribute("disabled");
    fireEvent.click(refreshButton);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("counts down with ceil and enables refresh at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventoryWithRetry(2)));

    render(<App />);
    await act(async () => { });

    const refreshButton = screen.getByRole("button", {
      name: "Refresh inventory"
    });
    expect(screen.getByText(/Try again in 2s\./i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/Try again in 1s\./i)).toBeInTheDocument();
    expect(refreshButton).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.queryByText(/Repeated immediate inventory refreshes are disabled/i)
    ).not.toBeInTheDocument();
    expect(refreshButton).toBeEnabled();
  });
  it("keeps logout available throughout an inventory cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventoryWithRetry(30)));

    render(<App />);
    await act(async () => { });

    expect(
      screen.getByRole("button", { name: "Refresh inventory" })
    ).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText("Connected Steam account: Alyx")
    );
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("rechecks profile access separately from cached inventory", async () => {
    const refreshedSession = {
      ...signedInSession,
      checks: {
        ...signedInSession.checks,
        profile: {
          status: "private",
          message: "Profile access was checked again."
        }
      }
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory))
      .mockResolvedValueOnce(jsonResponse(refreshedSession));

    render(<App />);

    await screen.findByLabelText("Connected Steam account: Alyx");
    const statusRegion = screen.getByRole("status");
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Steam access" })
    );

    await waitFor(() => {
      expect(screen.getByText("Profile access was checked again.")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("definition", {
        name: "Steam profile: Private"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("definition", {
        name: "Steam inventory: Private"
      })
    ).toBeInTheDocument();

    expect(statusRegion).toHaveTextContent(
      "Steam access recheck complete. Profile: Private. Badges: Public."
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/auth/session",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("keeps profile recheck failures visible and announced without replacing prior results", async () => {
    const message =
      "We could not recheck Steam access. The service is unavailable, and your previous results have not changed.";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    render(<App />);

    await screen.findByLabelText("Connected Steam account: Alyx");
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
      screen.getByRole("definition", {
        name: "Steam inventory: Private"
      })
    ).toBeInTheDocument();
  });

  it("groups items by game metadata, keeps fallback and Other groups, and sorts within groups", async () => {
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
      card_border: "foil",
      gem_yield: 5,
      gem_cash_value: "0.0025"
    });
    const fallbackCard = tradingCardItem(4, {
      name: "Unknown card",
      game_app_id: null,
      game_name: null,
      card_border: null,
      gem_yield: null,
      gem_cash_value: null
    });
    const otherItem = inventoryItem(5);
    const inventory = publicInventory(
      [zetaCard, otherItem, fallbackCard, alphaCard, zetaLowCard],
      {
        gem_status: "complete",
        gem_message: "Gem values are current for all gem-convertible items.",
        gem_priceable_item_count: 3,
        gem_priced_item_count: 3,
        gem_cash_context: {
          currency: "USD",
          basis: "lowest_sell",
          market_hash_name: "753-Sack of Gems",
          sack_gems: 1000,
          sack_price: "0.5",
          highest_buy: "0.25",
          observed_at: "2026-08-27T08:15:00Z"
        }
      }
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

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
      "Items (game unavailable)",
      "Other inventory items"
    ]);
    const faq = screen.getByRole("region", { name: "About these results" });
    expect(
      within(faq).getByText(
        "Gem cash value uses the SteamApis USD lowest-sell basis for 753-Sack of Gems (1000 gems). Each value is a per-item replacement-cost estimate."
      )
    ).toBeInTheDocument();
    expect(
      within(faq).getByRole("link", { name: "How gem values work" })
    ).toHaveAttribute("href", "/faq#gem-values");
    expect(
      within(screen.getByText("Unknown card").closest("tr") as HTMLElement)
        .getAllByText("Not applicable")
    ).toHaveLength(5);
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
      "Items (game unavailable)",
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
      "Items (game unavailable)",
      "Other inventory items"
    ]);
  });

  it("reports partial gem coverage, rate limiting, and per-item cash provenance", async () => {
    const pricedCard = tradingCardItem(1, {
      gem_yield: 0,
      gem_cash_value: null
    });
    const pendingCard = tradingCardItem(2, {
      card_border: "foil",
      gem_yield: null,
      gem_cash_value: null
    });
    const inventory = publicInventory([pricedCard, pendingCard], {
      gem_status: "partial",
      gem_message: "One gem-convertible group is still pending.",
      gem_priceable_item_count: 2,
      gem_priced_item_count: 1,
      gem_rate_limited: true,
      gem_retry_after_seconds: 30,
      gem_cash_context: null
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const faq = await screen.findByRole("region", {
      name: "About these results"
    });
    const pricingSummary = screen.getByLabelText("Inventory pricing summary");
    expect(within(pricingSummary).getByText("1/2")).toBeInTheDocument();
    expect(
      within(faq).getByText(
        "Gem values are available for 1 of 2 gem-convertible item types."
      )
    ).toBeInTheDocument();
    expect(
      within(faq).getByText("One gem-convertible group is still pending.")
    ).toBeInTheDocument();
    expect(
      within(faq).getByText(/rate-limiting gem lookups/i)
    ).toHaveTextContent("try again in 30s");
    expect(
      within(faq).getByText(/USD lowest-sell basis/i)
    ).toBeInTheDocument();
    const pricedRow = screen.getByText("Card 0001").closest("tr");
    expect(pricedRow).not.toBeNull();
    expect(within(pricedRow as HTMLElement).getByText("0")).toBeInTheDocument();
    const pendingRow = screen.getByText("Card 0002").closest("tr");
    expect(pendingRow).not.toBeNull();
    expect(
      within(pendingRow as HTMLElement).getAllByText("Unavailable")
    ).toHaveLength(2);
  });

  it("switches gem cash valuation between lowest sell and highest buy", async () => {
    const card = tradingCardItem(1, {
      marketable: true,
      price: { ...validInventoryPrice, lowest_sell: "0.75" },
      gem_cash_value: "1.0001"
    });
    const inventory = publicInventory([card], {
      priceable_item_count: 1,
      priced_item_count: 1,
      price_status: "complete",
      gem_status: "complete",
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_cash_context: validGemCashContext
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    await screen.findByRole("table", {
      name: "Inventory items"
    });
    const pricingSummary = screen.getByLabelText("Inventory pricing summary");
    const basisSelect = within(pricingSummary).getByRole("combobox", {
      name: "Gem cash basis"
    });
    const row = () => screen.getByText("Card 0001").closest("tr");

    expect(basisSelect).toHaveValue("lowest_sell");
    expect(within(row() as HTMLElement).getByText("USD 1.0001")).toBeInTheDocument();

    fireEvent.change(basisSelect, { target: { value: "highest_buy" } });

    expect(basisSelect).toHaveValue("highest_buy");
    expect(within(row() as HTMLElement).getByText("USD 0.5001")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "About these results" }))
        .getByText(/highest-buy basis/i)
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("tab", { name: /^Worth more as gems/ })
    );
    expect(screen.queryByRole("table", { name: "Inventory items" })).toBeNull();

    fireEvent.change(basisSelect, { target: { value: "lowest_sell" } });

    expect(
      screen.getByRole("table", { name: "Inventory items" })
    ).toBeInTheDocument();
    expect(within(row() as HTMLElement).getByText("USD 1.0001")).toBeInTheDocument();
  });
  it("does not use the other sack quote when selected basis is unavailable", async () => {
    const card = tradingCardItem(1, {
      gem_cash_value: "1.0001"
    });
    const inventory = publicInventory([card], {
      gem_status: "complete",
      gem_priceable_item_count: 1,
      gem_priced_item_count: 1,
      gem_cash_context: {
        ...validGemCashContext,
        highest_buy: null
      }
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const row = (await screen.findByText("Card 0001")).closest(
      "tr"
    ) as HTMLElement;
    const pricingSummary = screen.getByLabelText("Inventory pricing summary");
    const basisSelect = within(pricingSummary).getByRole("combobox", {
      name: "Gem cash basis"
    });

    fireEvent.change(basisSelect, { target: { value: "highest_buy" } });

    expect(within(row).getByText("Unavailable")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "About these results" }))
        .getByText(/Current sack price \(Highest buy\): Unavailable/)
    ).toBeInTheDocument();
  });


  it("refreshes cached gem values without refetching the inventory", async () => {
    const normalCard = tradingCardItem(1, {
      gem_yield: 10,
      gem_cash_value: null
    });
    const foilCard = tradingCardItem(2, {
      card_border: "foil",
      gem_yield: null,
      gem_cash_value: null
    });
    const inventory = publicInventory([normalCard, foilCard], {
      gem_status: "partial",
      gem_message: "Background gem pricing is still processing gem-convertible item groups.",
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
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              app_id: "440",
              item_type: 2,
              border_color: 1,
              gem_yield: 100
            },
            {
              app_id: "440",
              item_type: 2,
              border_color: 0,
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
        "Gem values are available for 2 of 2 gem-convertible item types."
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByText("Card 0002").closest("tr") as HTMLElement)
        .getByText("100")
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Booster details by game" })).toBeInTheDocument();
    const boosterCard = within(
      await screen.findByRole("region", { name: "Booster details by game" })
    ).getByRole("article", { name: "Team Fortress 2" });
    expect(
      within(boosterCard).getByText("750", { selector: "dd" })
    ).toBeInTheDocument();
    expect(
      within(boosterCard).getByText("8", { selector: "dd" })
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/auth/gems",
      expect.objectContaining({
        credentials: "include",
        method: "POST"
      })
    );
    const request = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      groups: [
        { app_id: "440", item_type: 2, border_color: 0 },
        { app_id: "440", item_type: 2, border_color: 1 }
      ],
      booster_game_app_ids: ["440"]
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    expect(
      await screen.findByRole("definition", {
        name: "Steam inventory: Unavailable"
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Inventory items" })
    ).not.toBeInTheDocument();
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
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              app_id: "440",
              item_type: 2,
              border_color: 0,
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects gem values without a semantic gem key", async () => {
    const malformedItem = {
      ...inventoryItem(1),
      item_type: "badge",
      gem_yield: 1,
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(
        jsonResponse(publicInventory([malformedItem]))
      );

    render(<App />);

    expect(
      await screen.findByRole("definition", {
        name: "Steam inventory: Unavailable"
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Inventory items" })
    ).not.toBeInTheDocument();
  });
  it("rejects an invalid semantic gem key", async () => {
    const malformedCard = tradingCardItem(1, {
      gem_key: {
        app_id: "440",
        item_type: 1.5,
        border_color: 0
      },
    });
    const inventory = publicInventory([malformedCard], {
      gem_status: "unavailable",
      gem_message: "Gem prices are unavailable.",
      gem_priceable_item_count: 1,
      gem_priced_item_count: 0
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    expect(
      await screen.findByRole("definition", {
        name: "Steam inventory: Unavailable"
      })
    ).toBeInTheDocument();
  });


  it("renders the exact label for every supported item type", async () => {
    const itemTypes = [
      ["badge", "Badge"],
      ["trading_card", "Trading card"],
      ["profile_background", "Profile background"],
      ["emoticon", "Emoticon"],
      ["booster_pack", "Booster pack"],
      ["consumable", "Consumable"],
      ["game_goo", "Game goo"],
      ["profile_modifier", "Profile modifier"],
      ["scene", "Scene"],
      ["sale_item", "Sale item"],
      ["sticker", "Sticker"],
      ["chat_effect", "Chat effect"],
      ["mini_profile_background", "Mini profile background"],
      ["avatar_frame", "Avatar frame"],
      ["animated_avatar", "Animated avatar"],
      ["steam_deck_keyboard_skin", "Steam Deck keyboard skin"],
      ["steam_deck_startup_movie", "Steam Deck startup movie"],
      ["other", "Other"]
    ] as const;
    const items = itemTypes.map(([itemType], index) => ({
      ...inventoryItem(index + 1),
      item_type: itemType
    }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(
        jsonResponse(
          publicInventory(items, {
            total_asset_count: items.length,
            unique_item_count: items.length
          })
        )
      );

    render(<App />);

    const table = await screen.findByRole("table", { name: "Inventory items" });
    for (const [, label] of itemTypes) {
      expect(within(table).getByText(label, { exact: true })).toBeInTheDocument();
    }
  });

  it("shows independent game, rarity, and card-border metadata for named types", async () => {
    const background = {
      ...inventoryItem(1),
      name: "Aurora background",
      item_type: "profile_background",
      game_app_id: "753",
      game_name: null,
      rarity: "Rare",
      card_border: "foil"
    };
    const badge = {
      ...inventoryItem(2),
      name: "Community badge",
      item_type: "badge",
      game_app_id: null,
      game_name: "Community assets"
    };
    const inventory = publicInventory([background, badge], {
      total_asset_count: 2,
      unique_item_count: 2
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const table = await screen.findByRole("table", { name: "Inventory items" });
    expect(within(table).getByText("Community assets")).toBeInTheDocument();
    const row = within(table)
      .getByText("Aurora background")
      .closest("tr") as HTMLElement;
    expect(within(row).getByText("Profile background")).toBeInTheDocument();
    expect(within(row).getByText("Rarity: Rare")).toBeInTheDocument();
    expect(within(row).getByText("Foil card border")).toBeInTheDocument();
    const badgeRow = within(table)
      .getByText("Community badge")
      .closest("tr") as HTMLElement;
    expect(within(badgeRow).getByText("Badge")).toBeInTheDocument();
    expect(
      badgeRow.querySelector(".inventory-gem-value")
    ).toHaveTextContent("Not applicable");
    expect(
      badgeRow.querySelector(".inventory-gem-cash-value")
    ).toHaveTextContent("Not applicable");
  });

  it("uses collision-free heading IDs for name-only game groups", async () => {
    const items = ["A/B", "A:B"].map((gameName, index) => ({
      ...inventoryItem(index + 1),
      name: `Named item ${index + 1}`,
      item_type: "badge",
      game_name: gameName
    }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(publicInventory(items)));

    render(<App />);

    const table = await screen.findByRole("table", { name: "Inventory items" });
    const headingIds = Array.from(
      table.querySelectorAll(".inventory-group-header th")
    ).map((heading) => heading.id);
    expect(headingIds).toHaveLength(2);
    expect(new Set(headingIds).size).toBe(2);
  });


  it("includes keyed backgrounds and emoticons in gem comparisons", async () => {
    const background = {
      ...inventoryItem(1),
      name: "Keyed background",
      market_hash_name: "500-Keyed background",
      item_type: "profile_background",
      game_app_id: "500",
      game_name: "Keyed game",
      gem_key: { app_id: "500", item_type: 4, border_color: 0 },
      gem_yield: 7,
      gem_cash_value: "0.70007",
      marketable: true,
      price: { ...validInventoryPrice, lowest_sell: "0.5000" }
    };
    const emoticon = {
      ...inventoryItem(2),
      name: "Keyed emoticon",
      market_hash_name: "500-Keyed emoticon",
      item_type: "emoticon",
      game_app_id: "500",
      game_name: "Keyed game",
      gem_key: { app_id: "500", item_type: 5, border_color: 1 },
      gem_yield: null,
      gem_cash_value: null,
      marketable: true,
      price: { ...validInventoryPrice, lowest_sell: "0.8000" }
    };
    const inventory = publicInventory([background, emoticon], {
      total_asset_count: 2,
      unique_item_count: 2,
      priceable_item_count: 2,
      priced_item_count: 2,
      gem_status: "partial",
      gem_message: "One gem-convertible item is still pending.",
      gem_priceable_item_count: 2,
      gem_priced_item_count: 1,
      gem_cash_context: validGemCashContext
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory));

    render(<App />);

    const faq = await screen.findByRole("region", {
      name: "About these results"
    });
    expect(faq).toHaveTextContent(
      "Gem values are available for 1 of 2 gem-convertible item types."
    );
    fireEvent.click(
      screen.getByRole("tab", { name: /^Worth more as gems/ })
    );
    const filtered = screen.getByRole("table", { name: "Inventory items" });
    expect(within(filtered).getByText("Keyed background")).toBeInTheDocument();
    expect(
      within(filtered).queryByText("Keyed emoticon")
    ).not.toBeInTheDocument();
  });

  it("refreshes and merges yields by the complete semantic gem key", async () => {
    const background = {
      ...inventoryItem(1),
      name: "Refresh background",
      item_type: "profile_background",
      gem_key: { app_id: "500", item_type: 4, border_color: 0 },
      gem_yield: null,
      gem_cash_value: null
    };
    const emoticon = {
      ...inventoryItem(2),
      name: "Refresh emoticon",
      item_type: "emoticon",
      gem_key: { app_id: "500", item_type: 5, border_color: 0 },
      gem_yield: null,
      gem_cash_value: null
    };
    const inventory = publicInventory([background, emoticon], {
      total_asset_count: 2,
      unique_item_count: 2,
      gem_status: "unavailable",
      gem_message: "Gem prices are unavailable for these items.",
      gem_priceable_item_count: 2,
      gem_priced_item_count: 0
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            { app_id: "500", item_type: 4, border_color: 0, gem_yield: 12 }
          ],
          pending_group_count: 1,
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
    await screen.findByText("Gem values refreshed from the background cache.");
    const backgroundRow = screen
      .getByText("Refresh background")
      .closest("tr") as HTMLElement;
    const emoticonRow = screen
      .getByText("Refresh emoticon")
      .closest("tr") as HTMLElement;
    expect(backgroundRow.querySelector(".inventory-gem-value")).toHaveTextContent(
      "12"
    );
    expect(emoticonRow.querySelector(".inventory-gem-value")).toHaveTextContent(
      "Unavailable"
    );
    const request = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      groups: [
        { app_id: "500", item_type: 4, border_color: 0 },
        { app_id: "500", item_type: 5, border_color: 0 }
      ],
      booster_game_app_ids: []
    });
  });

  it("batches refreshes at the backend group limit", async () => {
    const items = Array.from({ length: 10_001 }, (_, index) => ({
      ...inventoryItem(index + 1),
      gem_key: { app_id: "500", item_type: index, border_color: 0 }
    }));
    const inventory = publicInventory(items, {
      gem_status: "unavailable",
      gem_message: "Gem prices are pending.",
      gem_priceable_item_count: items.length,
      gem_priced_item_count: 0
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [],
          pending_group_count: 10_000,
          boosters: [],
          pending_booster_count: 0,
          gem_rate_limited: false,
          gem_retry_after_seconds: null
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          values: [],
          pending_group_count: 1,
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
    await screen.findByText("Gem values refreshed from the background cache.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstRequest = fetchMock.mock.calls[2][1] as RequestInit;
    const secondRequest = fetchMock.mock.calls[3][1] as RequestInit;
    expect(JSON.parse(firstRequest.body as string).groups).toHaveLength(10_000);
    expect(JSON.parse(secondRequest.body as string).groups).toEqual([
      { app_id: "500", item_type: 10_000, border_color: 0 }
    ]);
  });
  it("clears the local session with a credentialed logout POST", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(signedInSession))
      .mockResolvedValueOnce(jsonResponse(privateInventory))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<App />);

    fireEvent.click(
      await screen.findByLabelText("Connected Steam account: Alyx")
    );
    const statusRegion = screen.getByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByRole("link", { name: /steam sign-in/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toBe(statusRegion);
    expect(statusRegion).toHaveTextContent("Signed out successfully.");
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/auth/logout", {
      credentials: "include",
      method: "POST"
    });
  });
});
