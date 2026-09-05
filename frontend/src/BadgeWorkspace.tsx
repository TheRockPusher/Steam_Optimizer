import {
  Component,
  type ReactNode,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  buildLevelUpOptimizationRequest,
  buildSteamMarketListingUrl,
  buildSteamProfileGamecardsUrl,
  formatAbsoluteTime,
  formatMinorUnits,
  formatRelativeTime,
  isInventorySnapshotFresh,
  isLevelUpIsoTimestamp,
  levelUpSnapshotKey,
  LEVEL_UP_INVENTORY_MAX_AGE_MS
} from "./levelUpOptimization";
import type {
  LevelUpBadgeSnapshot,
  LevelUpBooster,
  LevelUpInventoryItem
} from "./levelUpOptimization";
import {
  ASSUMED_BUDGET_MINOR_DIGITS,
  BADGE_CRAFT_XP,
  BadgePlanningCurrencyChangeError,
  buildBadgePlanningRequest,
  buildSaleSwapItems,
  isBadgePlanningResponseExpired,
  MAX_BADGE_PLANNING_TARGET_LEVEL,
  parseBudgetMinorUnits,
  parseTargetLevelInput,
  requestBadgePlanning
} from "./badgePlanning";
import type {
  BadgeGame,
  BadgeGameCard,
  BadgePlanningMode,
  BadgePlanningMoney,
  BadgePlanningResponse,
  BadgePlanningReadyResponse,
  BadgeProtection,
  BadgePlan
} from "./badgePlanning";
import type {
  LevelUpInventoryStatus
} from "./LevelUpOptimizationPanel";
import "./BadgeWorkspace.css";

const LazyLevelUpPanel = lazy(() => import("./LevelUpOptimizationPanel"));

export type BadgeWorkspaceView = "badges" | "plan";

export type BadgeWorkspaceProps = {
  steamId: string | null;
  inventoryStatus: LevelUpInventoryStatus;
  items: readonly LevelUpInventoryItem[];
  boosters: readonly LevelUpBooster[];
  badges: LevelUpBadgeSnapshot;
  inventoryRefreshedAt: string | null;
  isInventoryLoading: boolean;
  isActive: boolean;
  view: BadgeWorkspaceView;
  onRefreshInventory: () => void;
  onRefreshBadges?: () => void;
};

type DraftPlanInput = {
  mode: BadgePlanningMode;
  targetLevel: number | null;
  budgetMinor: number;
};

type DraftPlanParse =
  | {
    ok: true;
    input: DraftPlanInput;
    targetMessage: null;
    budgetMessage: null;
  }
  | {
    ok: false;
    input: null;
    targetMessage: string | null;
    budgetMessage: string | null;
  };

export const BADGE_WORKSPACE_ID = "badge-workspace";
const BADGE_PLANNING_RETRY_MS = 5_000;
/** Keeps the mounted dashboard DOM bounded for very large inventories. */
const DASHBOARD_PAGE_SIZE = 50;
const CARD_NAME_PATTERN = /^([1-9][0-9]*)-(.+) \(Trading Card\)$/;

type BadgeWorkspaceState =
  | { kind: "idle"; key: string | null }
  | { kind: "loading"; key: string }
  | { kind: "response"; key: string; response: BadgePlanningResponse }
  | { kind: "expired"; key: string; response: BadgePlanningReadyResponse }
  | { kind: "error"; key: string; message: string };
type AppliedPlanInput = DraftPlanInput & {
  money: BadgePlanningMoney | null;
};

const DASHBOARD_VIEWS = [
  { key: "all", label: "All games" },
  { key: "craftable", label: "Ready to craft" },
  { key: "cheapest", label: "Cheapest next craft" },
  { key: "closest", label: "Closest to next craft" },
  { key: "maxed", label: "Maxed" },
  { key: "reserved", label: "Reserved" },
  { key: "excluded", label: "Excluded" },
  { key: "unavailable", label: "Unavailable" }
] as const;
type DashboardView = (typeof DASHBOARD_VIEWS)[number]["key"];

const GAME_STATUS_LABELS: Record<BadgeGame["status"], string> = {
  craftable: "Craftable",
  incomplete: "Incomplete",
  maxed: "Maxed",
  reserved: "Reserved",
  excluded: "Excluded",
  unavailable: "Unavailable"
};

const STRATEGY_INFO: Record<
  BadgePlan["strategy"],
  { title: string; disclosure: string }
> = {
  cheapest: {
    title: "Cheapest",
    disclosure:
      "Lowest spend found for this snapshot under your budget, protections, and market depth. Exact within this data."
  },
  fewest_purchases: {
    title: "Fewest purchases",
    disclosure:
      "Heuristic: prefers fewer purchased copies, which can cost more than the cheapest plan."
  },
  preserve_cards: {
    title: "Preserve owned cards",
    disclosure:
      "Heuristic: prefers consuming fewer owned cards, which can cost more than the cheapest plan."
  }
};

const REASON_COPY: Record<string, string> = {
  ready: "Badge planning is ready.",
  target_reached: "Your target level is reached within this budget.",
  target_already_met: "Your current XP already meets this target.",
  xp_maximized: "No additional craft fits this policy within the budget and quoted stock.",
  no_crafts_available: "No craft is available with these holdings, protections, and usable quotes.",
  budget_insufficient: "The remaining wallet budget cannot fund another craft.",
  craft_depth_insufficient: "Badge limits or available card stock prevent reaching this target.",
  owned_set_ready: "Complete sets are owned after kept copies are reserved.",
  badge_level_maxed: "This normal badge has reached level five; no further normal-badge XP is available.",
  excluded_by_options: "This game is excluded from all plans.",
  currency_contract_missing:
    "Market currency and fees are not configured. Only verified, fully owned crafts can be planned.",
  steamapi_key_missing:
    "Badge planning is unavailable because the server has no SteamApis API key.",
  badge_data_unavailable:
    "Steam badge data could not be verified. Try refreshing later.",
  inventory_snapshot_too_old:
    "This ownership snapshot is too old for safe planning.",
  price_generation_unavailable:
    "Current market prices are unavailable. Try refreshing later.",
  price_generation_refreshing:
    "Steam Optimizer is refreshing the shared market-price catalog. Planning retries automatically.",
  price_generation_stale:
    "Current market prices are stale. Try refreshing later.",
  quote_depth_unavailable:
    "Market order-book depth is unavailable. Try refreshing later."
};

function reasonCopy(reason: string): string {
  return (
    REASON_COPY[reason] ?? `Badge planning reported: ${reason.replaceAll("_", " ")}.`
  );
}

function cardDisplayName(marketHashName: string): string {
  const match = CARD_NAME_PATTERN.exec(marketHashName);
  return match === null ? marketHashName : match[2];
}

function compareAppIds(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function filterDashboardGames(
  games: readonly BadgeGame[],
  view: DashboardView,
  search: string
): BadgeGame[] {
  const needle = search.trim().toLowerCase();
  const matches = games.filter((game) => {
    if (
      needle !== "" &&
      !game.game_name.toLowerCase().includes(needle) &&
      !game.app_id.includes(needle)
    ) {
      return false;
    }
    switch (view) {
      case "all":
        return true;
      case "craftable":
        return game.status === "craftable";
      case "cheapest":
        return game.completion_cost_minor !== null;
      case "closest":
        return game.missing_count !== null;
      case "maxed":
        return game.status === "maxed";
      case "reserved":
        return game.status === "reserved";
      case "excluded":
        return game.status === "excluded";
      case "unavailable":
        return game.status === "unavailable";
    }
  });
  const byName = (left: BadgeGame, right: BadgeGame): number =>
    NAME_COLLATOR.compare(left.game_name, right.game_name) ||
    compareAppIds(left.app_id, right.app_id);
  const sorted = [...matches];
  if (view === "cheapest") {
    sorted.sort(
      (left, right) =>
        (left.completion_cost_minor ?? 0) - (right.completion_cost_minor ?? 0) ||
        byName(left, right)
    );
  } else if (view === "closest") {
    sorted.sort(
      (left, right) =>
        (left.missing_count ?? 0) - (right.missing_count ?? 0) ||
        byName(left, right)
    );
  } else {
    sorted.sort(byName);
  }
  return sorted;
}

const NAME_COLLATOR = new Intl.Collator("en-US", {
  sensitivity: "base",
  numeric: true
});
const COUNT_FORMATTER = new Intl.NumberFormat("en-US");
let xpNumberFormatter: Intl.NumberFormat | null = null;

function formatXp(value: number): string {
  if (xpNumberFormatter === null) {
    xpNumberFormatter = new Intl.NumberFormat("en-US");
  }
  return `${xpNumberFormatter.format(value)} XP`;
}

function moneyText(
  amountMinor: number,
  money: BadgePlanningMoney | null
): string | null {
  if (money === null) {
    return null;
  }
  try {
    return formatMinorUnits(amountMinor, money.currency_code, money.minor_digits);
  } catch {
    return null;
  }
}

function StatusSurface({
  status,
  title,
  children,
  action
}: {
  status: "loading" | "unavailable" | "error";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`badge-workspace-status badge-workspace-status-${status}`}>
      <h3>{title}</h3>
      {children}
      {action}
    </div>
  );
}

function KeepQuantityInput({
  cardName,
  ownedQuantity,
  committed,
  disabled,
  onCommit
}: {
  cardName: string;
  ownedQuantity: number;
  committed: number;
  disabled: boolean;
  onCommit: (keepQuantity: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(committed);
  const valid = /^[0-9]{1,7}$/.test(value) && Number(value) <= ownedQuantity;
  const commit = () => {
    if (valid) {
      onCommit(Number(value));
      setDraft(null);
    }
  };
  return (
    <input
      className="badge-workspace-keep-input"
      type="number"
      inputMode="numeric"
      min={0}
      max={ownedQuantity}
      step={1}
      value={value}
      disabled={disabled}
      aria-label={`Keep quantity for ${cardName}`}
      aria-invalid={!valid}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

function CardRow({
  card,
  money,
  protection,
  canShop,
  onKeepQuantity,
  onNeverSell
}: {
  card: BadgeGameCard;
  money: BadgePlanningMoney | null;
  protection: BadgeProtection | undefined;
  canShop: boolean;
  onKeepQuantity: (marketHashName: string, keepQuantity: number) => void;
  onNeverSell: (marketHashName: string, neverSell: boolean) => void;
}) {
  const keepQuantity = protection?.keep_quantity ?? 0;
  const neverSell = protection?.never_sell ?? false;
  const buyPrice =
    card.buy_price_minor !== null ? moneyText(card.buy_price_minor, money) : null;
  return (
    <tr>
      <th scope="row" className="badge-workspace-card-name">
        {card.card_name}
      </th>
      <td>{COUNT_FORMATTER.format(card.owned_quantity)}</td>
      <td>
        <KeepQuantityInput
          cardName={card.card_name}
          ownedQuantity={card.owned_quantity}
          committed={keepQuantity}
          disabled={card.owned_quantity === 0}
          onCommit={(quantity) => onKeepQuantity(card.market_hash_name, quantity)}
        />
      </td>
      <td>{COUNT_FORMATTER.format(card.available_quantity)}</td>
      <td>
        {buyPrice === null
          ? "No quote"
          : `${buyPrice} · ${COUNT_FORMATTER.format(card.buy_quantity ?? 0)} offered`}
      </td>
      <td>
        <label className="badge-workspace-never-sell">
          <input
            type="checkbox"
            checked={neverSell}
            disabled={card.owned_quantity === 0}
            onChange={(event) =>
              onNeverSell(card.market_hash_name, event.currentTarget.checked)
            }
          />
          <span className="badge-workspace-visually-hidden">
            Never sell {card.card_name}
          </span>
        </label>
      </td>
      <td>
        {canShop && card.buy_price_minor !== null ? (
          <a
            className="badge-workspace-link"
            href={buildSteamMarketListingUrl(card.market_hash_name)}
            target="_blank"
            rel="noreferrer"
          >
            Market
          </a>
        ) : null}
      </td>
    </tr>
  );
}

function GameCard({
  game,
  money,
  steamId,
  protectionFor,
  excluded,
  canNavigate,
  canShop,
  expanded,
  onToggle,
  onKeepQuantity,
  onNeverSell,
  onToggleExclude
}: {
  game: BadgeGame;
  money: BadgePlanningMoney | null;
  steamId: string | null;
  protectionFor: (marketHashName: string) => BadgeProtection | undefined;
  excluded: boolean;
  canNavigate: boolean;
  canShop: boolean;
  expanded: boolean;
  onToggle: () => void;
  onKeepQuantity: (marketHashName: string, keepQuantity: number) => void;
  onNeverSell: (marketHashName: string, neverSell: boolean) => void;
  onToggleExclude: () => void;
}) {
  const detailsId = `badge-workspace-game-details-${game.app_id}`;
  const gamecardsUrl =
    steamId === null
      ? null
      : buildSteamProfileGamecardsUrl(steamId, game.app_id);
  const completionCost =
    game.completion_cost_minor !== null
      ? moneyText(game.completion_cost_minor, money)
      : null;
  return (
    <article
      className={`badge-workspace-game badge-workspace-game-${game.status}`}
    >
      <h4 className="badge-workspace-game-heading">
        <button
          type="button"
          className="badge-workspace-game-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <span className="badge-workspace-game-name">{game.game_name}</span>
          <span className="badge-workspace-game-meta">
            AppID {game.app_id} · Level {game.badge_level}
            {game.set_size !== null ? ` · Set of ${game.set_size}` : ""}
          </span>
          <span
            className={`badge-workspace-chip badge-workspace-chip-${game.status}`}
          >
            {GAME_STATUS_LABELS[game.status]}
          </span>
          <span className="badge-workspace-game-facts">
            {game.craftable_count > 0 ? (
              <span>
                {COUNT_FORMATTER.format(game.craftable_count)} craft
                {game.craftable_count === 1 ? "" : "s"} ready
              </span>
            ) : null}
            {game.missing_count !== null ? (
              <span>
                {COUNT_FORMATTER.format(game.missing_count)} missing for next
                craft
              </span>
            ) : null}
            {completionCost !== null ? (
              <span>Next craft {completionCost}</span>
            ) : null}
          </span>
        </button>
      </h4>
      {expanded ? (
        <div id={detailsId} className="badge-workspace-game-details">
          <p className="badge-workspace-game-reason">{reasonCopy(game.reason)}</p>
          <dl className="badge-workspace-game-metrics">
            <div>
              <dt>Owned unique</dt>
              <dd>{COUNT_FORMATTER.format(game.owned_unique)}</dd>
            </div>
            <div>
              <dt>Usable unique</dt>
              <dd>{COUNT_FORMATTER.format(game.available_unique)}</dd>
            </div>
            <div>
              <dt>Owned cards</dt>
              <dd>{COUNT_FORMATTER.format(game.owned_cards)}</dd>
            </div>
            <div>
              <dt>XP ready to craft</dt>
              <dd>{formatXp(game.craftable_count * BADGE_CRAFT_XP)}</dd>
            </div>
          </dl>
          <div className="badge-workspace-table-scroll">
            <table className="badge-workspace-card-table">
              <caption>Card progress and protections</caption>
              <thead>
                <tr>
                  <th scope="col">Card</th>
                  <th scope="col">Owned</th>
                  <th scope="col">Keep</th>
                  <th scope="col">Usable</th>
                  <th scope="col">Buy quote</th>
                  <th scope="col">Never sell</th>
                  <th scope="col">Market</th>
                </tr>
              </thead>
              <tbody>
                {game.cards.map((card) => (
                  <CardRow
                    key={card.market_hash_name}
                    card={card}
                    money={money}
                    protection={protectionFor(card.market_hash_name)}
                    canShop={canShop}
                    onKeepQuantity={onKeepQuantity}
                    onNeverSell={onNeverSell}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="badge-workspace-game-actions">
            <button
              type="button"
              className="badge-workspace-secondary"
              onClick={onToggleExclude}
            >
              {excluded ? "Include in planning" : "Exclude from planning"}
            </button>
            {canNavigate && gamecardsUrl !== null ? (
              <a
                className="badge-workspace-link"
                href={gamecardsUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Steam badge page
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function BadgeDashboard({
  games,
  money,
  steamId,
  protections,
  excludedAppIds,
  canNavigate,
  canShop,
  search,
  onSearchChange,
  view,
  onViewChange,
  page,
  onPageChange,
  openGameId,
  onToggleGame,
  onKeepQuantity,
  onNeverSell,
  onToggleExclude
}: {
  games: readonly BadgeGame[];
  money: BadgePlanningMoney | null;
  steamId: string | null;
  protections: ReadonlyMap<string, BadgeProtection>;
  excludedAppIds: ReadonlySet<string>;
  canNavigate: boolean;
  canShop: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  view: DashboardView;
  onViewChange: (view: DashboardView) => void;
  page: number;
  onPageChange: (page: number) => void;
  openGameId: string | null;
  onToggleGame: (appId: string) => void;
  onKeepQuantity: (marketHashName: string, keepQuantity: number) => void;
  onNeverSell: (marketHashName: string, neverSell: boolean) => void;
  onToggleExclude: (appId: string) => void;
}) {
  const filtered = useMemo(
    () => filterDashboardGames(games, view, search),
    [games, search, view]
  );
  const pageCount = Math.max(
    1,
    Math.ceil(filtered.length / DASHBOARD_PAGE_SIZE)
  );
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * DASHBOARD_PAGE_SIZE;
  const pageGames = filtered.slice(startIndex, startIndex + DASHBOARD_PAGE_SIZE);
  const statusCounts = useMemo(() => {
    const counts = new Map<BadgeGame["status"], number>();
    for (const game of games) {
      counts.set(game.status, (counts.get(game.status) ?? 0) + 1);
    }
    return counts;
  }, [games]);
  const readyCrafts = games.reduce(
    (total, game) => total + game.craftable_count,
    0
  );
  if (games.length === 0) {
    return (
      <div className="badge-workspace-empty">
        <h3>No normal-badge games in this snapshot</h3>
        <p>
          No trading-card games were represented in this inventory snapshot.
          Refresh inventory after acquiring trading cards.
        </p>
      </div>
    );
  }
  return (
    <div className="badge-workspace-dashboard">
      <dl className="badge-workspace-status-summary">
        <div>
          <dt>Games</dt>
          <dd>{COUNT_FORMATTER.format(games.length)}</dd>
        </div>
        <div>
          <dt>Crafts ready</dt>
          <dd>{COUNT_FORMATTER.format(readyCrafts)}</dd>
        </div>
        <div>
          <dt>Ready XP</dt>
          <dd>{formatXp(readyCrafts * BADGE_CRAFT_XP)}</dd>
        </div>
        <div>
          <dt>Maxed</dt>
          <dd>{COUNT_FORMATTER.format(statusCounts.get("maxed") ?? 0)}</dd>
        </div>
        <div>
          <dt>Reserved</dt>
          <dd>{COUNT_FORMATTER.format(statusCounts.get("reserved") ?? 0)}</dd>
        </div>
        <div>
          <dt>Excluded</dt>
          <dd>{COUNT_FORMATTER.format(statusCounts.get("excluded") ?? 0)}</dd>
        </div>
        <div>
          <dt>Unavailable</dt>
          <dd>{COUNT_FORMATTER.format(statusCounts.get("unavailable") ?? 0)}</dd>
        </div>
      </dl>
      <div className="badge-workspace-controls">
        <label className="badge-workspace-field" htmlFor="badge-workspace-dashboard-search">
          <span>Search games</span>
          <input
            id="badge-workspace-dashboard-search"
            type="search"
            value={search}
            placeholder="Name or AppID"
            onChange={(event) => onSearchChange(event.currentTarget.value)}
          />
        </label>
        <label className="badge-workspace-field" htmlFor="badge-workspace-dashboard-view">
          <span>View</span>
          <select
            id="badge-workspace-dashboard-view"
            value={view}
            onChange={(event) =>
              onViewChange(event.currentTarget.value as DashboardView)
            }
          >
            {DASHBOARD_VIEWS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pageGames.length === 0 ? (
        <div className="badge-workspace-empty">
          <h3>No games match this view</h3>
          <p>
            Adjust the search or choose another view. Everything in the current
            snapshot stays visible under All games.
          </p>
        </div>
      ) : (
        <>
          <ul className="badge-workspace-games">
            {pageGames.map((game) => (
              <li key={game.app_id}>
                <GameCard
                  game={game}
                  money={money}
                  steamId={steamId}
                  protectionFor={(hash) => protections.get(hash)}
                  excluded={excludedAppIds.has(game.app_id)}
                  canNavigate={canNavigate}
                  canShop={canShop}
                  expanded={openGameId === game.app_id}
                  onToggle={() => onToggleGame(game.app_id)}
                  onKeepQuantity={onKeepQuantity}
                  onNeverSell={onNeverSell}
                  onToggleExclude={() => onToggleExclude(game.app_id)}
                />
              </li>
            ))}
          </ul>
          <nav
            className="badge-workspace-pagination"
            aria-label="Dashboard pages"
          >
            <p role="status">
              Showing {COUNT_FORMATTER.format(startIndex + 1)}–
              {COUNT_FORMATTER.format(startIndex + pageGames.length)} of{" "}
              {COUNT_FORMATTER.format(filtered.length)} games
            </p>
            <div className="badge-workspace-pagination-buttons">
              <button
                type="button"
                className="badge-workspace-secondary"
                onClick={() => onPageChange(safePage - 1)}
                disabled={safePage <= 1}
              >
                Previous page
              </button>
              <span>
                Page {COUNT_FORMATTER.format(safePage)} of{" "}
                {COUNT_FORMATTER.format(pageCount)}
              </span>
              <button
                type="button"
                className="badge-workspace-secondary"
                onClick={() => onPageChange(safePage + 1)}
                disabled={safePage >= pageCount}
              >
                Next page
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}

function PlanStepCard({
  step,
  money,
  steamId,
  canNavigate,
  canShop
}: {
  step: BadgePlan["steps"][number];
  money: BadgePlanningMoney | null;
  steamId: string | null;
  canNavigate: boolean;
  canShop: boolean;
}) {
  const spend = moneyText(step.spend_minor, money);
  const gamecardsUrl =
    steamId === null
      ? null
      : buildSteamProfileGamecardsUrl(steamId, step.app_id);
  return (
    <article className="badge-workspace-step">
      <h5>
        {step.game_name}: craft {COUNT_FORMATTER.format(step.craft_count)}× ·
        level {step.badge_level_before} → {step.badge_level_after}
      </h5>
      <p className="badge-workspace-step-facts">
        {formatXp(step.xp_gain)} · Spend {spend ?? "unpriced"} · Uses{" "}
        {COUNT_FORMATTER.format(step.owned_cards_used)} owned card
        {step.owned_cards_used === 1 ? "" : "s"}
      </p>
      {step.purchases.length > 0 ? (
        <ul className="badge-workspace-purchases">
          {step.purchases.map((purchase) => {
            const total = moneyText(purchase.total_minor, money);
            const unit = moneyText(purchase.unit_price_minor, money);
            return (
              <li
                key={`${purchase.market_hash_name}-${purchase.quote_timestamp}`}
              >
                <span>
                  {COUNT_FORMATTER.format(purchase.quantity)} ×{" "}
                  {purchase.card_name} — {unit ?? "unpriced"} each,{" "}
                  {total ?? "unpriced"} total
                </span>
                {canShop ? (
                  <a
                    className="badge-workspace-link"
                    href={buildSteamMarketListingUrl(purchase.market_hash_name)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Steam Market
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="badge-workspace-no-sale">
          No purchases needed — this step is funded by cards you already hold
          after protections.
        </p>
      )}
      {canNavigate && gamecardsUrl !== null ? (
        <a
          className="badge-workspace-link"
          href={gamecardsUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open Steam badge page
        </a>
      ) : null}
    </article>
  );
}

function PolicyCard({
  plan,
  money,
  steamId,
  canNavigate,
  canShop
}: {
  plan: BadgePlan;
  money: BadgePlanningMoney | null;
  steamId: string | null;
  canNavigate: boolean;
  canShop: boolean;
}) {
  const info = STRATEGY_INFO[plan.strategy];
  const spend = moneyText(plan.spend_minor, money);
  const remaining = moneyText(plan.remaining_budget_minor, money);
  return (
    <article
      className={`badge-workspace-policy badge-workspace-policy-${plan.status}`}
    >
      <header className="badge-workspace-policy-header">
        <h4>{info.title}</h4>
        <span
          className={`badge-workspace-chip badge-workspace-chip-plan-${plan.status}`}
        >
          {plan.status === "ready"
            ? "Within budget"
            : plan.status === "partial"
              ? "Partial"
              : "No opportunity"}
        </span>
      </header>
      <p className="badge-workspace-policy-disclosure">{info.disclosure}</p>
      <p className="badge-workspace-policy-reason">{reasonCopy(plan.reason)}</p>
      <dl className="badge-workspace-policy-metrics">
        <div>
          <dt>XP gain</dt>
          <dd>{formatXp(plan.xp_gain)}</dd>
        </div>
        <div>
          <dt>Projected level</dt>
          <dd>{COUNT_FORMATTER.format(plan.projected_level)}</dd>
        </div>
        <div>
          <dt>Crafts</dt>
          <dd>{COUNT_FORMATTER.format(plan.craft_count)}</dd>
        </div>
        <div>
          <dt>Purchase copies</dt>
          <dd>{COUNT_FORMATTER.format(plan.purchase_count)}</dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>{spend ?? "No purchases"}</dd>
        </div>
        <div>
          <dt>Remaining budget</dt>
          <dd>{remaining ?? "Not applicable"}</dd>
        </div>
        <div>
          <dt>Owned cards used</dt>
          <dd>{COUNT_FORMATTER.format(plan.owned_cards_used)}</dd>
        </div>
      </dl>
      {plan.target_level !== null ? (
        plan.target_reached ? (
          <p className="badge-workspace-policy-target">
            Target level {COUNT_FORMATTER.format(plan.target_level)} reached.
          </p>
        ) : (
          <p className="badge-workspace-policy-target badge-workspace-policy-shortfall">
            Shortfall {formatXp(plan.shortfall_xp)} to reach level{" "}
            {COUNT_FORMATTER.format(plan.target_level)} with this snapshot and
            budget.
          </p>
        )
      ) : null}
      {plan.craft_count > 0 && plan.purchase_count === 0 ? (
        <p className="badge-workspace-no-sale">
          No-sale cashflow: nothing to buy — every craft is funded by cards you
          already hold after protections.
        </p>
      ) : null}
      {plan.steps.length > 0 ? (
        <div className="badge-workspace-steps">
          {plan.steps.map((step) => (
            <PlanStepCard
              key={step.app_id}
              step={step}
              money={money}
              steamId={steamId}
              canNavigate={canNavigate}
              canShop={canShop}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function BadgePlannerView({
  response,
  money,
  steamId,
  canNavigate,
  canShop,
  protections,
  excludedAppIds,
  holdingsByHash,
  gameNamesById,
  moneyContract,
  playerLevel,
  planMode,
  targetLevelText,
  budgetText,
  draftParse,
  unappliedChanges,
  onModeChange,
  onTargetChange,
  onBudgetChange,
  onApply,
  onRemoveProtection,
  onToggleExclude
}: {
  response: BadgePlanningResponse | null;
  money: BadgePlanningMoney | null;
  steamId: string | null;
  canNavigate: boolean;
  canShop: boolean;
  protections: ReadonlyMap<string, BadgeProtection>;
  excludedAppIds: ReadonlySet<string>;
  holdingsByHash: ReadonlyMap<string, number>;
  gameNamesById: ReadonlyMap<string, string>;
  moneyContract: BadgePlanningMoney | null;
  playerLevel: number | null;
  planMode: BadgePlanningMode;
  targetLevelText: string;
  budgetText: string;
  draftParse: DraftPlanParse;
  unappliedChanges: boolean;
  onModeChange: (mode: BadgePlanningMode) => void;
  onTargetChange: (value: string) => void;
  onBudgetChange: (value: string) => void;
  onApply: () => void;
  onRemoveProtection: (marketHashName: string) => void;
  onToggleExclude: (appId: string) => void;
}) {
  const protectionEntries = [...protections.values()];
  const exclusionEntries = [...excludedAppIds];
  return (
    <div className="badge-workspace-planner">
      <section className="badge-workspace-plan-input" aria-labelledby="badge-workspace-plan-input-title">
        <h3 id="badge-workspace-plan-input-title">Plan target and budget</h3>
        <form
          className="badge-workspace-plan-form"
          onSubmit={(event) => {
            event.preventDefault();
            onApply();
          }}
        >
          <fieldset className="badge-workspace-mode-fieldset">
            <legend>Planning mode</legend>
            <label className="badge-workspace-radio">
              <input
                type="radio"
                name="badge-workspace-plan-mode"
                value="target"
                checked={planMode === "target"}
                onChange={() => onModeChange("target")}
              />
              <span>Reach a target level with minimum spend</span>
            </label>
            <label className="badge-workspace-radio">
              <input
                type="radio"
                name="badge-workspace-plan-mode"
                value="budget"
                checked={planMode === "budget"}
                onChange={() => onModeChange("budget")}
              />
              <span>Most XP for a wallet budget</span>
            </label>
          </fieldset>
          {planMode === "target" ? (
            <div className="badge-workspace-field">
              <label htmlFor="badge-workspace-target-level">
                <span>Target level</span>
              </label>
              <input
                id="badge-workspace-target-level"
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_BADGE_PLANNING_TARGET_LEVEL}
                step={1}
                value={targetLevelText}
                aria-invalid={draftParse.targetMessage !== null}
                aria-describedby={
                  draftParse.targetMessage !== null
                    ? "badge-workspace-target-error"
                    : "badge-workspace-target-hint"
                }
                onChange={(event) => onTargetChange(event.currentTarget.value)}
              />
              <small
                className="badge-workspace-field-hint"
                id="badge-workspace-target-hint"
              >
                Current level{" "}
                {playerLevel === null
                  ? "unknown"
                  : COUNT_FORMATTER.format(playerLevel)}
                . Up to {COUNT_FORMATTER.format(MAX_BADGE_PLANNING_TARGET_LEVEL)}.
              </small>
            </div>
          ) : null}
          <div className="badge-workspace-field">
            <label htmlFor="badge-workspace-budget">
              <span>Wallet budget</span>
            </label>
            <input
              id="badge-workspace-budget"
              type="text"
              inputMode="decimal"
              value={budgetText}
              aria-invalid={draftParse.budgetMessage !== null}
              aria-describedby={
                draftParse.budgetMessage !== null
                  ? "badge-workspace-budget-error badge-workspace-budget-hint"
                  : "badge-workspace-budget-hint"
              }
              onChange={(event) => onBudgetChange(event.currentTarget.value)}
            />
            <small
              className="badge-workspace-field-hint"
              id="badge-workspace-budget-hint"
            >
              {moneyContract === null
                ? "The server has not confirmed a currency yet. The first plan uses a 0 budget."
                : `Amounts in ${moneyContract.currency_code} (${moneyContract.minor_digits === 0
                  ? "no fractional digits"
                  : `${COUNT_FORMATTER.format(moneyContract.minor_digits)} fractional digit(s)`
                }).`}
            </small>
          </div>
          {draftParse.targetMessage !== null ? (
            <p id="badge-workspace-target-error" className="badge-workspace-error" role="alert">
              {draftParse.targetMessage}
            </p>
          ) : null}
          {draftParse.budgetMessage !== null ? (
            <p id="badge-workspace-budget-error" className="badge-workspace-error" role="alert">
              {draftParse.budgetMessage}
            </p>
          ) : null}
          <button
            type="submit"
            className="badge-workspace-primary"
            disabled={!draftParse.ok}
          >
            Apply and recalculate
          </button>
          {unappliedChanges ? (
            <p className="badge-workspace-unapplied" role="status">
              Plan inputs changed since the last calculation. Apply to update
              the dashboard and plans.
            </p>
          ) : null}
          <p className="badge-workspace-budget-note">
            The budget is a Steam Wallet spending ceiling. Sale proceeds are
            never counted here; sale-funded swaps remain a separate advanced
            workflow.
          </p>
        </form>
      </section>
      <section className="badge-workspace-constraints" aria-labelledby="badge-workspace-constraints-title">
        <h3 id="badge-workspace-constraints-title">Protections and exclusions</h3>
        <p className="badge-workspace-session-note">
          Protections, exclusions, and plan inputs apply to this account in
          this browser tab session only. They are not saved to your account or
          across sessions.
        </p>
        <h4>Card protections</h4>
        {protectionEntries.length === 0 ? (
          <p>
            No card protections yet. Set keep quantities and never-sell flags
            from the Badges tab card lists.
          </p>
        ) : (
          <ul className="badge-workspace-protection-list">
            {protectionEntries.map((protection) => {
              const active = holdingsByHash.has(protection.market_hash_name);
              return (
                <li
                  key={protection.market_hash_name}
                  className={
                    active ? undefined : "badge-workspace-protection-inactive"
                  }
                >
                  <span>
                    {cardDisplayName(protection.market_hash_name)} — keep{" "}
                    {COUNT_FORMATTER.format(protection.keep_quantity)}
                    {protection.never_sell ? " · never sell" : ""}
                    {active ? "" : " · card not in current inventory"}
                  </span>
                  <button
                    type="button"
                    className="badge-workspace-secondary"
                    onClick={() => onRemoveProtection(protection.market_hash_name)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <h4>Excluded games</h4>
        {exclusionEntries.length === 0 ? (
          <p>No games are excluded from planning.</p>
        ) : (
          <ul className="badge-workspace-exclusion-list">
            {exclusionEntries.map((appId) => (
              <li key={appId}>
                <span>{gameNamesById.get(appId) ?? `AppID ${appId}`}</span>
                <button
                  type="button"
                  className="badge-workspace-secondary"
                  onClick={() => onToggleExclude(appId)}
                >
                  Include again
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="badge-workspace-policies" aria-labelledby="badge-workspace-policies-title">
        <h3 id="badge-workspace-policies-title">Policy comparison</h3>
        {response === null ? (
          <p role="status">Plans appear after the first calculation.</p>
        ) : response.status === "unavailable" ? (
          <div className="badge-workspace-status badge-workspace-status-unavailable">
            <h4>Planning unavailable</h4>
            <p>{reasonCopy(response.reason)}</p>
          </div>
        ) : (
          <div className="badge-workspace-policy-grid">
            {response.plans.map((plan) => (
              <PolicyCard
                key={plan.strategy}
                plan={plan}
                money={money}
                steamId={steamId}
                canNavigate={canNavigate}
                canShop={canShop}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

class BadgeSwapBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <p className="badge-workspace-advanced-error" role="status">
        Sale-funded swaps could not load. Your badge workspace is still
        available.
      </p>
    );
  }
}

export default function BadgeWorkspace(props: BadgeWorkspaceProps) {
  return <AccountBadgeWorkspace key={props.steamId ?? "signed-out"} {...props} />;
}

function AccountBadgeWorkspace({
  steamId,
  inventoryStatus,
  items,
  boosters,
  badges,
  inventoryRefreshedAt,
  isInventoryLoading,
  isActive,
  view,
  onRefreshInventory,
  onRefreshBadges = onRefreshInventory
}: BadgeWorkspaceProps) {
  const [state, setState] = useState<BadgeWorkspaceState>({ kind: "idle", key: null });
  const [clockNow, setClockNow] = useState(Date.now);
  const [revision, setRevision] = useState(0);
  const [protections, setProtections] = useState<ReadonlyMap<string, BadgeProtection>>(new Map());
  const [excludedAppIds, setExcludedAppIds] = useState<ReadonlySet<string>>(new Set());
  const [planMode, setPlanMode] = useState<BadgePlanningMode>("target");
  const [targetInput, setTargetInput] = useState<string | null>(null);
  const defaultTarget = Math.min(MAX_BADGE_PLANNING_TARGET_LEVEL, (badges.player_level ?? 0) + 1);
  const targetLevelText = targetInput ?? String(defaultTarget);
  const [budgetText, setBudgetText] = useState("0");
  const [applied, setApplied] = useState<AppliedPlanInput | null>(null);
  const [moneyContract, setMoneyContract] = useState<BadgePlanningMoney | null>(null);
  const [currencyMessage, setCurrencyMessage] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [dashboardView, setDashboardView] = useState<DashboardView>("all");
  const [dashboardPage, setDashboardPage] = useState(1);
  const [openGameId, setOpenGameId] = useState<string | null>(null);
  const retryRef = useRef({ key: "", count: 0 });

  const requestInput = useMemo(() => {
    try {
      return {
        base: buildLevelUpOptimizationRequest(items, boosters, badges, inventoryRefreshedAt ?? ""),
        message: null
      };
    } catch {
      return { base: null, message: "Steam badge or game identity data is unavailable. Refresh inventory and badge data." };
    }
  }, [badges, boosters, inventoryRefreshedAt, items]);
  const committedPlanInput = useMemo<AppliedPlanInput>(() => applied ?? {
    mode: "target", targetLevel: defaultTarget, budgetMinor: 0, money: null
  }, [applied, defaultTarget]);
  const draftParse = useMemo<DraftPlanParse>(() => {
    const budget = parseBudgetMinorUnits(budgetText, moneyContract?.minor_digits ?? ASSUMED_BUDGET_MINOR_DIGITS);
    if (!budget.ok) {
      return { ok: false, input: null, targetMessage: null, budgetMessage: budget.message };
    }
    if (budget.minor > 0 && moneyContract === null) {
      return { ok: false, input: null, targetMessage: null, budgetMessage: "The server has not confirmed a currency yet. Only a zero budget can be used." };
    }
    const target = parseTargetLevelInput(targetLevelText);
    if (planMode === "target" && !target.ok) {
      return { ok: false, input: null, targetMessage: target.message, budgetMessage: null };
    }
    return {
      ok: true,
      input: { mode: planMode, targetLevel: planMode === "target" && target.ok ? target.level : null, budgetMinor: budget.minor },
      targetMessage: null, budgetMessage: null
    };
  }, [budgetText, moneyContract, planMode, targetLevelText]);
  const unappliedChanges = !draftParse.ok ||
    draftParse.input.mode !== committedPlanInput.mode ||
    draftParse.input.targetLevel !== committedPlanInput.targetLevel ||
    draftParse.input.budgetMinor !== committedPlanInput.budgetMinor;

  const badgeRequest = useMemo(() => {
    const base = requestInput.base;
    if (base === null) return { request: null, message: null };
    const knownGameIds = new Set(base.games.map((game) => game.app_id));
    const ownedByHash = new Map(base.cards.map((card) => [card.market_hash_name, card.owned_quantity]));
    const activeProtections = [...protections.values()]
      .filter((protection) => ownedByHash.has(protection.market_hash_name))
      .map((protection) => ({
        ...protection,
        keep_quantity: Math.min(protection.keep_quantity, ownedByHash.get(protection.market_hash_name) ?? 0)
      }))
      .sort((left, right) => left.market_hash_name.localeCompare(right.market_hash_name));
    try {
      return {
        request: buildBadgePlanningRequest(base, {
          mode: committedPlanInput.mode,
          target_level: committedPlanInput.targetLevel,
          budget_minor: committedPlanInput.budgetMinor,
          excluded_app_ids: [...excludedAppIds].filter((id) => knownGameIds.has(id)).sort(compareAppIds),
          protections: activeProtections
        }),
        message: null
      };
    } catch {
      return { request: null, message: "Review protections and exclusions before planning." };
    }
  }, [committedPlanInput, excludedAppIds, protections, requestInput.base]);
  const inputKey = useMemo(() => levelUpSnapshotKey(
    steamId, inventoryRefreshedAt, badges.checked_at, badgeRequest.request
  ), [badgeRequest, badges.checked_at, inventoryRefreshedAt, steamId]);
  const snapshotKey = inputKey === null ? null : `${revision}:${inputKey}`;
  const inventoryIsFresh = isInventorySnapshotFresh(inventoryRefreshedAt, clockNow);
  const badgeIsFresh = isInventorySnapshotFresh(badges.checked_at, clockNow);

  useEffect(() => {
    let current = true;
    queueMicrotask(() => {
      if (current) setClockNow(Date.now());
    });
    return () => { current = false; };
  }, [badges.checked_at, inventoryRefreshedAt, isActive]);

  useEffect(() => {
    const request = badgeRequest.request;
    if (!isActive || isInventoryLoading || inventoryStatus !== "public" ||
      !inventoryIsFresh || !badgeIsFresh || steamId === null || request === null || snapshotKey === null) return;
    const controller = new AbortController();
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      setState({ kind: "loading", key: snapshotKey });
      void requestBadgePlanning(steamId, request, committedPlanInput.money, controller.signal)
        .then((response) => {
          if (!current) return;
          setMoneyContract(response.currency_code === null || response.minor_digits === null ? null : {
            currency_code: response.currency_code, minor_digits: response.minor_digits
          });
          setState({ kind: "response", key: snapshotKey, response });
        })
        .catch((error: unknown) => {
          if (!current || controller.signal.aborted) return;
          if (error instanceof BadgePlanningCurrencyChangeError) {
            setMoneyContract(null);
            setApplied(null);
            setBudgetText("0");
            setPlanMode("target");
            setTargetInput(null);
            setCurrencyMessage("The market currency changed. Your spending budget was reset to zero; enter and confirm it again.");
            setRevision((value) => value + 1);
          } else {
            setState({ kind: "error", key: snapshotKey, message: "The badge planning service could not be reached or returned inconsistent data. Try again." });
          }
        });
    });
    return () => { current = false; controller.abort(); };
  }, [badgeIsFresh, badgeRequest, committedPlanInput.money, inventoryIsFresh, inventoryStatus, isActive, isInventoryLoading, snapshotKey, steamId]);

  const activeState: BadgeWorkspaceState = state.key === snapshotKey ? state : { kind: "idle", key: snapshotKey };
  const activeResponse = activeState.kind === "response" || activeState.kind === "expired" ? activeState.response : null;
  const validUntil = activeResponse?.status === "ready" ? activeResponse.valid_until : null;
  useEffect(() => {
    const updateClock = () => setClockNow(Date.now());
    const transitions = [inventoryRefreshedAt, badges.checked_at]
      .filter(isLevelUpIsoTimestamp)
      .flatMap((timestamp) => [Date.parse(timestamp), Date.parse(timestamp) + LEVEL_UP_INVENTORY_MAX_AGE_MS]);
    if (validUntil !== null) transitions.push(Date.parse(validUntil));
    const next = Math.min(...transitions.filter((time) => time > Date.now()));
    const timer = Number.isFinite(next) ? window.setTimeout(updateClock, next - Date.now() + 1) : undefined;
    window.addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateClock);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, [badges.checked_at, clockNow, inventoryRefreshedAt, validUntil]);
  useEffect(() => {
    if (inputKey !== retryRef.current.key) retryRef.current = { key: inputKey ?? "", count: 0 };
    if (!isActive || activeResponse?.reason !== "price_generation_refreshing" || retryRef.current.count >= 3) return;
    const timer = window.setTimeout(() => {
      retryRef.current.count += 1;
      setRevision((value) => value + 1);
    }, BADGE_PLANNING_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [activeResponse, inputKey, isActive]);
  const expiredNow = activeResponse?.status === "ready" &&
    (isBadgePlanningResponseExpired(activeResponse, clockNow) || !inventoryIsFresh || !badgeIsFresh);
  const money = activeResponse?.currency_code && activeResponse.minor_digits !== null
    ? { currency_code: activeResponse.currency_code, minor_digits: activeResponse.minor_digits } : null;
  const canNavigate = activeResponse?.status === "ready" && inventoryIsFresh && badgeIsFresh &&
    !expiredNow && (view === "badges" || !unappliedChanges);
  const canShop = canNavigate && money !== null;

  const setKeepQuantity = useCallback((hash: string, quantity: number) => {
    setProtections((current) => {
      const next = new Map(current);
      const neverSell = current.get(hash)?.never_sell ?? false;
      if (quantity === 0 && !neverSell) next.delete(hash);
      else next.set(hash, { market_hash_name: hash, keep_quantity: quantity, never_sell: neverSell });
      return next;
    });
  }, []);
  const setNeverSell = useCallback((hash: string, neverSell: boolean) => {
    setProtections((current) => {
      const next = new Map(current);
      const keep = current.get(hash)?.keep_quantity ?? 0;
      if (keep === 0 && !neverSell) next.delete(hash);
      else next.set(hash, { market_hash_name: hash, keep_quantity: keep, never_sell: neverSell });
      return next;
    });
  }, []);
  const removeProtection = useCallback((hash: string) => {
    setProtections((current) => { const next = new Map(current); next.delete(hash); return next; });
  }, []);
  const toggleExcluded = useCallback((id: string) => {
    setExcludedAppIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const toggleOpenGame = useCallback((id: string) => setOpenGameId((current) => current === id ? null : id), []);
  const applyPlanInput = () => {
    if (!draftParse.ok) return;
    setApplied({ ...draftParse.input, money: moneyContract });
    setCurrencyMessage(null);
    setRevision((value) => value + 1);
  };
  const refreshPlan = () => {
    retryRef.current.count = 0;
    setClockNow(Date.now());
    setRevision((value) => value + 1);
  };
  const refreshInventory = () => {
    setRevision((value) => value + 1);
    onRefreshInventory();
  };
  const swapItems = useMemo(() => buildSaleSwapItems(items, protections, excludedAppIds), [excludedAppIds, items, protections]);
  const gameNamesById = useMemo(() => new Map((requestInput.base?.games ?? []).map((game) => [game.app_id, game.game_name])), [requestInput.base]);
  const holdingsByHash = useMemo(() => new Map((requestInput.base?.cards ?? []).map((card) => [card.market_hash_name, card.owned_quantity])), [requestInput.base]);
  const canMountAdvanced = inventoryStatus === "public" && !isInventoryLoading &&
    inventoryIsFresh && badgeIsFresh && requestInput.base !== null && steamId !== null;

  if (!isActive) {
    return null;
  }

  let content: ReactNode;
  if (isInventoryLoading) {
    content = (
      <StatusSurface
        status="loading"
        title="Checking inventory and badge data…"
      >
        <p>
          Ownership, badge progress, and market quotes are being verified
          before anything is calculated.
        </p>
      </StatusSurface>
    );
  } else if (inventoryStatus !== "public") {
    content = (
      <StatusSurface
        status="unavailable"
        title="Badge workspace needs a public inventory"
        action={
          <button
            type="button"
            className="badge-workspace-secondary"
            onClick={refreshInventory}
          >
            Refresh inventory
          </button>
        }
      >
        <p>
          {inventoryStatus === "private"
            ? "Your Steam inventory is private. Badge planning stays read-only and needs inventory visibility."
            : "Steam inventory data is unavailable. Refresh when the service is available."}
        </p>
      </StatusSurface>
    );
  } else if (!inventoryIsFresh) {
    content = (
      <StatusSurface status="unavailable" title="Refresh inventory to plan badges"
        action={<button type="button" className="badge-workspace-primary" onClick={refreshInventory}>Refresh inventory</button>}>
        <p>This inventory snapshot is too old. Refresh ownership before using any plan.</p>
      </StatusSurface>
    );
  } else if (!badgeIsFresh || badges.status !== "public") {
    content = (
      <StatusSurface
        status="unavailable"
        title="Refresh badge data to plan badges"
        action={
          <button
            type="button"
            className="badge-workspace-secondary"
            onClick={onRefreshBadges}
          >
            Refresh badge data
          </button>
        }
      >
        <p>
          {badges.status === "public"
            ? "Steam badge data is missing or too old for safe planning."
            : badges.message}
        </p>
      </StatusSurface>
    );
  } else if (requestInput.base === null) {
    content = (
      <StatusSurface
        status="unavailable"
        title="Game metadata unavailable"
        action={
          <button
            type="button"
            className="badge-workspace-secondary"
            onClick={refreshInventory}
          >
            Refresh inventory
          </button>
        }
      >
        <p>
          {requestInput.message ??
            "Refresh inventory to load game identity data."}
        </p>
      </StatusSurface>
    );
  } else if (badgeRequest.request === null) {
    content = (
      <StatusSurface
        status="unavailable"
        title="Planning constraints are invalid"
        action={
          <button
            type="button"
            className="badge-workspace-secondary"
            onClick={refreshInventory}
          >
            Refresh inventory
          </button>
        }
      >
        <p>
          {badgeRequest.message ??
            "Review planning constraints and refresh to try again."}
        </p>
      </StatusSurface>
    );
  } else if (
    activeState.kind === "idle" ||
    activeState.kind === "loading"
  ) {
    content = (
      <StatusSurface
        status="loading"
        title="Calculating badge dashboard and plans…"
      >
        <p>
          Checking ownership after protections, current quotes, and badge
          levels for all three policies.
        </p>
      </StatusSurface>
    );
  } else if (activeState.kind === "error") {
    content = (
      <StatusSurface
        status="error"
        title="Badge planning failed"
        action={
          <button
            type="button"
            className="badge-workspace-primary"
            onClick={refreshPlan}
          >
            Try again
          </button>
        }
      >
        <p>{activeState.message}</p>
      </StatusSurface>
    );
  } else {
    const response = activeState.response;
    content = (
      <>
        <div className="badge-workspace-summary">
          <dl className="badge-workspace-summary-metrics">
            <div>
              <dt>Level</dt>
              <dd>{COUNT_FORMATTER.format(response.player_level)}</dd>
            </div>
            <div>
              <dt>Total XP</dt>
              <dd>{formatXp(response.player_xp)}</dd>
            </div>
            <div>
              <dt>Data from</dt>
              <dd>{formatRelativeTime(response.generated_at, clockNow)}</dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd>
                {response.status === "ready"
                  ? formatAbsoluteTime(response.valid_until)
                  : "Not applicable"}
              </dd>
            </div>
          </dl>
          <div className="badge-workspace-summary-actions">
            <button
              type="button"
              className="badge-workspace-secondary"
              onClick={refreshPlan}
            >
              Refresh plan
            </button>
            <button
              type="button"
              className="badge-workspace-secondary"
              onClick={refreshInventory}
            >
              Refresh inventory
            </button>
            <button
              type="button"
              className="badge-workspace-secondary"
              onClick={onRefreshBadges}
            >
              Refresh badge data
            </button>
          </div>
        </div>
        {expiredNow ? (
          <div className="badge-workspace-expiry" role="status">
            <p>
              The current plan expired. Market links are disabled until you
              refresh so no action is taken against stale prices.
            </p>
            <button
              type="button"
              className="badge-workspace-primary"
              onClick={refreshPlan}
            >
              Refresh plan
            </button>
          </div>
        ) : null}
        {response.reason !== "ready" ? (
          <div className="badge-workspace-status badge-workspace-status-unavailable">
            <h3>{response.status === "unavailable" ? "Planning unavailable" : "Market data limited"}</h3>
            <p>{reasonCopy(response.reason)}</p>
            <button
              type="button"
              className="badge-workspace-secondary"
              onClick={refreshPlan}
            >
              Try again
            </button>
          </div>
        ) : null}
        {view === "badges" ? (
          <BadgeDashboard
            games={response.games}
            money={money}
            steamId={steamId}
            protections={protections}
            excludedAppIds={excludedAppIds}
            canNavigate={canNavigate}
            canShop={canShop}
            search={searchText}
            onSearchChange={(value) => { setSearchText(value); setDashboardPage(1); }}
            view={dashboardView}
            onViewChange={(value) => { setDashboardView(value); setDashboardPage(1); }}
            page={dashboardPage}
            onPageChange={setDashboardPage}
            openGameId={openGameId}
            onToggleGame={toggleOpenGame}
            onKeepQuantity={setKeepQuantity}
            onNeverSell={setNeverSell}
            onToggleExclude={toggleExcluded}
          />
        ) : null}
      </>
    );
  }

  let announcement: string;
  if (isInventoryLoading) {
    announcement = "Checking inventory and badge data.";
  } else if (inventoryStatus !== "public") {
    announcement = "Badge workspace unavailable without a public inventory.";
  } else if (!badgeIsFresh || badges.status !== "public") {
    announcement = "Refresh badge data to plan badges.";
  } else if (requestInput.base === null || badgeRequest.request === null) {
    announcement = "Game data or planning constraints are unavailable.";
  } else if (
    activeState.kind === "idle" ||
    activeState.kind === "loading"
  ) {
    announcement = "Calculating badge dashboard and plans.";
  } else if (activeState.kind === "error") {
    announcement = "Badge planning failed. Try refreshing.";
  } else if (expiredNow) {
    announcement = "The badge plan expired. Refresh to continue.";
  } else {
    announcement =
      activeResponse?.status === "ready"
        ? "Badge dashboard and plans ready."
        : "Badge planning unavailable.";
  }

  const response = activeResponse;
  return (
    <section
      id={BADGE_WORKSPACE_ID}
      className="badge-workspace"
      aria-labelledby="badge-workspace-title"
    >
      <header className="badge-workspace-heading">
        <h2 id="badge-workspace-title">Badge workspace</h2>
        <p className="badge-workspace-scope">
          Covers normal game badges for trading-card games in this inventory
          snapshot. Foil, event, and community badges are out of scope.
          Protections and plan inputs last for this browser tab session only.
        </p>
      </header>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="badge-workspace-live-region"
      >
        {announcement}
      </div>
      {currencyMessage !== null && <p className="badge-workspace-expiry" role="alert">{currencyMessage}</p>}
      <div className="badge-workspace-content">{content}</div>
      {view === "plan" && (
        <BadgePlannerView
          response={response}
          money={money}
          steamId={steamId}
          canNavigate={canNavigate}
          canShop={canShop}
          protections={protections}
          excludedAppIds={excludedAppIds}
          holdingsByHash={holdingsByHash}
          gameNamesById={gameNamesById}
          moneyContract={moneyContract}
          playerLevel={badges.player_level}
          planMode={planMode}
          targetLevelText={targetLevelText}
          budgetText={budgetText}
          draftParse={draftParse}
          unappliedChanges={unappliedChanges}
          onModeChange={(mode) => setPlanMode(mode)}
          onTargetChange={setTargetInput}
          onBudgetChange={(value) => setBudgetText(value)}
          onApply={applyPlanInput}
          onRemoveProtection={removeProtection}
          onToggleExclude={toggleExcluded}
        />
      )}
      <section className="badge-workspace-advanced" aria-labelledby="badge-workspace-advanced-title">
        <h3 id="badge-workspace-advanced-title">
          Advanced: sale-funded swaps
        </h3>
        <p>
          A separate workflow that funds one-card level-up swaps by selling a
          single card. Sale proceeds never count toward the planner budget.
          Kept copies and never-sell cards are withheld from sales, and
          excluded games are removed.
        </p>
        <button
          type="button"
          className="badge-workspace-secondary"
          aria-expanded={advancedOpen}
          aria-controls="badge-workspace-advanced-panel"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen ? "Hide sale-funded swaps" : "Show sale-funded swaps"}
        </button>
        <div id="badge-workspace-advanced-panel" hidden={!advancedOpen}>
          {advancedOpen ? (
            canMountAdvanced ? (
              <BadgeSwapBoundary>
                <Suspense
                  fallback={
                    <p className="badge-workspace-advanced-loading" role="status">
                      Loading sale-funded swaps…
                    </p>
                  }
                >
                  <LazyLevelUpPanel
                    steamId={steamId}
                    inventoryStatus={inventoryStatus}
                    items={swapItems}
                    boosters={boosters}
                    badges={badges}
                    inventoryRefreshedAt={inventoryRefreshedAt}
                    isInventoryLoading={isInventoryLoading}
                    isActive={isActive && advancedOpen && canMountAdvanced}
                    onRefreshInventory={refreshInventory}
                    onRefreshBadges={onRefreshBadges}
                  />
                </Suspense>
              </BadgeSwapBoundary>
            ) : (
              <p role="status">
                Refresh inventory and badge data to use sale-funded swaps.
              </p>
            )
          ) : null}
        </div>
      </section>
    </section>
  );
}
