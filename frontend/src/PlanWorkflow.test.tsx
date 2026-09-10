import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlanWorkflow, { type PlanWorkflowProps } from "./PlanWorkflow";
import { PLAN_CHECKLIST_RENDER_LIMIT } from "./planWorkflow";
import type {
  BadgeGame,
  BadgeGameCard,
  BadgePlan,
  BadgePlanPurchase,
  BadgePlanningReadyResponse
} from "./badgePlanning";
import type { LevelUpInventoryItem } from "./levelUpOptimization";

const NOW = "2026-09-05T12:00:00Z";
const EXPIRES = "2026-09-05T12:15:00Z";
const STEAM_ID = "76561198000000001";
const HASHES = Array.from(
  { length: 5 },
  (_, index) => `10-Card ${index} (Trading Card)`
);

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
    quote_timestamp: NOW,
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

function purchase(hash: string, quantity: number): BadgePlanPurchase {
  return {
    market_hash_name: hash,
    card_name: hash.replace(/ \(Trading Card\)$/, "").replace(/^[0-9]+-/, ""),
    quantity,
    unit_price_minor: 5,
    total_minor: quantity * 5,
    quote_timestamp: NOW
  };
}

function plan(overrides: Partial<BadgePlan> = {}): BadgePlan {
  const purchases = [purchase(HASHES[0], 2)];
  return {
    strategy: "cheapest",
    status: "ready",
    reason: "target_reached",
    target_level: 12,
    target_reached: true,
    craft_count: 2,
    xp_gain: 200,
    projected_xp: 1450,
    projected_level: 13,
    shortfall_xp: 0,
    spend_minor: 10,
    remaining_budget_minor: 990,
    purchase_count: 1,
    owned_cards_used: 10,
    steps: [
      {
        app_id: "10",
        game_name: "Orbital Quest",
        badge_level_before: 0,
        badge_level_after: 2,
        craft_count: 2,
        xp_gain: 200,
        spend_minor: 10,
        owned_cards_used: 10,
        purchases
      }
    ],
    ...overrides
  };
}

function items(): LevelUpInventoryItem[] {
  return HASHES.map((market_hash_name) => ({
    market_hash_name,
    quantity: 5,
    marketable: true,
    tradable: true,
    item_type: "trading_card",
    card_border: "normal",
    game_app_id: "10",
    game_name: "Orbital Quest"
  }));
}

function response(
  overrides: Partial<BadgePlanningReadyResponse> = {}
): BadgePlanningReadyResponse {
  const base: BadgePlanningReadyResponse = {
    status: "ready",
    reason: "ready",
    generated_at: NOW,
    valid_until: EXPIRES,
    currency_code: "USD",
    minor_digits: 2,
    inventory_refreshed_at: NOW,
    badge_refreshed_at: NOW,
    player_xp: 1250,
    player_level: 11,
    scope: "inventory_normal_badges",
    evaluated_game_count: 1,
    games: [game()],
    plans: [],
    opportunity: null
  };
  const merged = { ...base, ...overrides };
  return { ...merged, evaluated_game_count: merged.games.length };
}

function props(overrides: Partial<PlanWorkflowProps> = {}): PlanWorkflowProps {
  return {
    steamId: STEAM_ID,
    response: response(),
    plan: plan(),
    items: items(),
    canAct: true,
    onRefresh: vi.fn(),
    ...overrides
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["Date"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PlanWorkflow reference checklist", () => {
  it("renders reference timestamps and every checklist section", () => {
    render(<PlanWorkflow {...props()} />);
    expect(screen.getByText("Plan checklist")).toBeInTheDocument();
    expect(screen.getByText("Plan generated")).toBeInTheDocument();
    expect(screen.getAllByText(NOW).length).toBe(3);
    expect(screen.getByText(EXPIRES)).toBeInTheDocument();
    expect(screen.getByText("USD (2 minor digit(s))")).toBeInTheDocument();
    expect(screen.getByText(/Craft Orbital Quest ×2/)).toBeInTheDocument();
    expect(
      screen.getByText(/Buy 2 × Card 0 for Orbital Quest/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\$0\.10 total \(unit \$0\.05, buyer total/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Surplus after commitments: 3 × Card 1 \(Orbital Quest\)/
      )
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        /Reference only\. Nothing is bought, sold, or crafted automatically/
      ).length
    ).toBeGreaterThan(0);
  });

  it("marks surplus withholding with the never-sell reason", () => {
    render(
      <PlanWorkflow
        {...props({
          response: response({
            games: [
              game({
                cards: HASHES.map((_, index) =>
                  card(index, { never_sell: true })
                )
              })
            ]
          })
        })}
      />
    );
    expect(
      screen.getAllByText(/3 withheld \(never-sell protection\)/)
    ).toHaveLength(4);
    expect(
      screen.getAllByText(/5 withheld \(never-sell protection\)/)
    ).toHaveLength(1);
  });

  it("lists unmatched collector targets instead of skipping them", () => {
    render(
      <PlanWorkflow
        {...props({ collectorTargets: [{ app_id: "99", target_level: 2 }] })}
      />
    );
    expect(screen.getByText(/without usable game data/)).toBeInTheDocument();
    expect(screen.getByText(/99 \(level 2\)/)).toBeInTheDocument();
  });

  it("shows the paid-actions note only when acting is disabled", () => {
    const { rerender } = render(<PlanWorkflow {...props({ canAct: false })} />);
    expect(
      screen.getByText(/Paid market actions are disabled/)
    ).toBeInTheDocument();
    rerender(<PlanWorkflow {...props({ canAct: true })} />);
    expect(
      screen.queryByText(/Paid market actions are disabled/)
    ).not.toBeInTheDocument();
  });
});

describe("PlanWorkflow annotations", () => {
  it("tracks manual marks per row and supports clearing", () => {
    render(<PlanWorkflow {...props()} />);
    const checkboxes = screen.getAllByRole("checkbox", {
      name: /Craft Orbital Quest/
    });
    expect(checkboxes[0]).not.toBeChecked();
    expect(screen.getByText(/0 of \d+ rows marked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear marks" })).toBeDisabled();
    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0]).toBeChecked();
    expect(screen.getByText(/1 of \d+ rows marked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear marks" }));
    expect(
      screen.getByRole("checkbox", { name: /Craft Orbital Quest/ })
    ).not.toBeChecked();
  });

  it("clears marks when the snapshot changes but keeps them across rerenders", () => {
    const base = props();
    const { rerender } = render(<PlanWorkflow {...base} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Craft Orbital Quest/ })
    );
    rerender(<PlanWorkflow {...base} />);
    expect(screen.getByText(/1 of \d+ rows marked/)).toBeInTheDocument();
    rerender(
      <PlanWorkflow
        {...props({
          response: response({ inventory_refreshed_at: "2026-09-05T11:59:00Z" })
        })}
      />
    );
    expect(screen.getByText(/0 of \d+ rows marked/)).toBeInTheDocument();
  });

  it("clears marks when the account changes", () => {
    const { rerender } = render(<PlanWorkflow {...props()} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Craft Orbital Quest/ })
    );
    rerender(<PlanWorkflow {...props({ steamId: "76561198000000002" })} />);
    expect(screen.getByText(/0 of \d+ rows marked/)).toBeInTheDocument();
  });

  it("resumes opted-in marks after remount but clears them for refreshed holdings", () => {
    const original = render(<PlanWorkflow {...props()} />);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Remember checklist marks on this device"
      })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Craft Orbital Quest/ })
    );
    original.unmount();
    const restored = render(
      <PlanWorkflow
        {...props({
          response: response({
            generated_at: "2026-09-05T12:01:00Z",
            badge_refreshed_at: "2026-09-05T12:01:00Z"
          })
        })}
      />
    );
    expect(
      screen.getByRole("checkbox", { name: /Craft Orbital Quest/ })
    ).toBeChecked();
    restored.rerender(
      <PlanWorkflow
        {...props({
          response: response({ inventory_refreshed_at: "2026-09-05T11:59:00Z" })
        })}
      />
    );
    expect(
      screen.getByRole("checkbox", { name: /Craft Orbital Quest/ })
    ).not.toBeChecked();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Remember checklist marks on this device"
      })
    );
    expect(localStorage.length).toBe(0);
  });
});

describe("PlanWorkflow freshness", () => {
  it("offers a refresh action when the snapshot is stale", () => {
    const onRefresh = vi.fn();
    render(
      <PlanWorkflow
        {...props({
          response: response({ valid_until: "2026-09-05T11:50:00Z" }),
          onRefresh
        })}
      />
    );
    expect(
      screen.getByText(/Treat every price and quantity as out of date/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh plan" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("PlanWorkflow exports", () => {
  function clipboardMock(impl: (text: string) => Promise<void>) {
    const writeText = vi.fn(impl);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    return writeText;
  }

  it("copies the checklist text including marks", async () => {
    const writeText = clipboardMock(async () => {});
    render(<PlanWorkflow {...props()} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Craft Orbital Quest/ })
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy checklist" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0];
    expect(text).toContain(
      "Reference only. Nothing is bought, sold, or crafted automatically"
    );
    expect(text).toContain("[x] Craft Orbital Quest ×2");
    expect(screen.getByText(/copied to the clipboard/)).toBeInTheDocument();
  });

  it("reports clipboard failures without crashing", async () => {
    clipboardMock(async () => {
      throw new Error("denied");
    });
    render(<PlanWorkflow {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy checklist" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/clipboard refused the copy/)).toBeInTheDocument();
  });

  it("downloads CSV and JSON with the current marks", () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render(<PlanWorkflow {...props()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Buy 2 × Card 0/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/downloaded as CSV/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/downloaded as JSON/)).toBeInTheDocument();
  });

  it("caps inline rows and points to the downloads", () => {
    const manyGames = Array.from({ length: 65 }, (_, index) => {
      const appId = String(100 + index);
      return game({
        app_id: appId,
        game_name: `Game ${appId}`,
        cards: Array.from({ length: 5 }, (_, cardIndex) => {
          const hash = `${appId}-Card ${cardIndex} (Trading Card)`;
          return card(cardIndex, {
            market_hash_name: hash,
            card_name: `Card ${appId}-${cardIndex}`
          });
        })
      });
    });
    render(
      <PlanWorkflow
        {...props({
          response: response({ games: manyGames }),
          plan: plan({
            steps: [],
            craft_count: 0,
            owned_cards_used: 0,
            purchase_count: 0
          }),
          items: manyGames.flatMap((entry) =>
            entry.cards.map((entryCard) => ({
              market_hash_name: entryCard.market_hash_name,
              quantity: 1,
              marketable: true,
              tradable: true,
              item_type: "trading_card",
              card_border: "normal",
              game_app_id: entry.app_id,
              game_name: entry.game_name
            }))
          )
        })}
      />
    );
    expect(
      screen.getByText(
        new RegExp(
          `Showing the first ${PLAN_CHECKLIST_RENDER_LIMIT} of 325 rows`
        )
      )
    ).toBeInTheDocument();
  });
});
