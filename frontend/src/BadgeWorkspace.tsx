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
  LEVEL_UP_INVENTORY_MAX_AGE_MS,
  normalCardName
} from "./levelUpOptimization";
import type {
  LevelUpBadgeSnapshot,
  LevelUpBooster,
  LevelUpGame,
  LevelUpInventoryItem
} from "./levelUpOptimization";
import {
  ASSUMED_BUDGET_MINOR_DIGITS,
  BADGE_CRAFT_XP,
  BadgePlanningCurrencyChangeError,
  buildBadgePlanningRequest,
  buildSaleSwapItems,
  isBadgePlanningResponseExpired,
  MAX_BADGE_CRAFT_LEVEL,
  MAX_BADGE_PLANNING_SCOPE_IDS,
  MAX_BADGE_PLANNING_TARGET_LEVEL,
  parseBudgetMinorUnits,
  parseTargetLevelInput,
  requestBadgePlanning
} from "./badgePlanning";
import type {
  BadgeCollectorTarget,
  BadgeGame,
  BadgeGameCard,
  BadgeOpportunity,
  BadgePlan,
  BadgePlanStrategy,
  BadgePlanningMode,
  BadgePlanningMoney,
  BadgePlanningResponse,
  BadgePlanningReadyResponse,
  BadgePlanningScope,
  BadgeProtection
} from "./badgePlanning";
import {
  clampPlanIntentProtections,
  planIntentCurrencyBinding,
  usePlanIntent,
  type PlanIntent
} from "./planWorkflow";
import BadgeArtwork from "./BadgeArtwork";
import PlanWorkflow from "./PlanWorkflow";
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
  scope: BadgePlanningScope;
  selectedAppIds: string[];
  collectorTargets: BadgeCollectorTarget[];
  compareAppId: string | null;
};

type DraftPlanParse =
  | {
    ok: true;
    input: DraftPlanInput;
    targetMessage: null;
    budgetMessage: null;
    scopeMessage: null;
    collectorMessage: null;
  }
  | {
    ok: false;
    input: null;
    targetMessage: string | null;
    budgetMessage: string | null;
    scopeMessage: string | null;
    collectorMessage: string | null;
  };

export const BADGE_WORKSPACE_ID = "badge-workspace";
const BADGE_PLANNING_RETRY_MS = 5_000;
/** Keeps the mounted dashboard DOM bounded for very large inventories. */
const DASHBOARD_PAGE_SIZE = 50;
/** Keeps picker lists bounded for very large catalogs. */
const PICKER_ROW_LIMIT = 50;

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

const BADGE_PLANNING_SCOPES = [
  {
    key: "inventory",
    label: "Inventory games",
    hint: "Plan only the trading-card games in this inventory snapshot."
  },
  {
    key: "selected",
    label: "Selected games",
    hint: "Plan only the games you pick below. Your inventory rows stay for ownership and protections."
  },
  {
    key: "catalog",
    label: "All supported games",
    hint: "Discover every supported complete set, including games you do not own yet."
  }
] as const;

const SCOPE_INFO: Record<
  BadgePlanningScope,
  { label: string; hint: string }
> = {
  inventory: {
    label: "Inventory games",
    hint: "Only the trading-card games in this inventory snapshot are planned."
  },
  selected: {
    label: "Selected games",
    hint: "Only the games you pick are planned; inventory rows stay for ownership and protections."
  },
  catalog: {
    label: "All supported games",
    hint: "Every supported complete set is considered, including games you do not own."
  }
};

const MODE_LABELS: Record<BadgePlanningMode, string> = {
  target: "target level",
  budget: "wallet budget",
  collector: "collector goals"
};

/** A game available for scope selection and collector goal editing. */
type CandidateGame = {
  app_id: string;
  game_name: string;
  badge_level: number | null;
};

const OPPORTUNITY_DISCLOSURE =
  "This compares an alternative scenario, not an instruction: crafts funded by " +
  "the sale can use other cards you own. The source game, including retained " +
  "copies, is excluded from replacement crafting. Collector targets do not constrain " +
  "this XP comparison. Your wallet budget is unchanged; " +
  "Steam rewards and level effects are ignored, and this is not a cash-profit estimate.";

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
  set_incomplete: "You do not own every card of this set yet.",
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
    "Market order-book depth is unavailable. Try refreshing later.",
  selected_app_unknown:
    "A selected game is not a known supported game. Remove it from the selection or refresh to rediscover supported games.",
  collector_target_unknown:
    "A collector goal references a game the planner does not know. Remove that goal or refresh to rediscover supported games.",
  collector_target_out_of_scope:
    "A collector goal references a game outside the current plan scope. Align the selection and goals, or switch scope.",
  compare_app_unknown:
    "The compared game is not part of this snapshot. Clear the comparison and pick a game from the current list.",
  compare_source_excluded:
    "The compared game is excluded from planning. Include it again to compare selling one set.",
  source_badge_maxed:
    "This badge already reached level five, so there is no craft XP left to weigh against selling.",
  source_set_composition_unknown:
    "The set composition for this game is unknown, so one complete set cannot be verified.",
  source_set_incomplete:
    "You do not own one complete unreserved set of this game, so there is nothing to sell and compare.",
  source_set_protected:
    "A never-sell card blocks selling a complete set of this game.",
  source_set_reserved:
    "Every owned copy of at least one card is protected, so no complete set can be sold.",
  source_set_unmarketable:
    "At least one card of this set currently has no sellable copies, so a complete set cannot be sold.",
  inventory_snapshot_stale:
    "This ownership snapshot is too old for safe planning.",
  inventory_snapshot_in_future:
    "The inventory snapshot timestamp is ahead of this device's clock. Refresh inventory to resolve it.",
  badge_snapshot_stale:
    "Steam badge data is stale. Refresh badge data to plan.",
  badge_snapshot_in_future:
    "The badge snapshot timestamp is ahead of this device's clock. Refresh badge data to resolve it."
};

function reasonCopy(reason: string): string {
  return (
    REASON_COPY[reason] ?? `Badge planning reported: ${reason.replaceAll("_", " ")}.`
  );
}

function cardDisplayName(marketHashName: string): string {
  return normalCardName(marketHashName) ?? marketHashName;
}

function compareAppIds(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeAppIds(appIds: readonly string[]): string[] {
  const unique = new Set(appIds);
  const sorted = [...unique];
  sorted.sort(compareAppIds);
  return sorted;
}

function normalizeCollectorTargets(
  targets: readonly BadgeCollectorTarget[]
): BadgeCollectorTarget[] {
  const byAppId = new Map<string, BadgeCollectorTarget>();
  for (const target of targets) {
    byAppId.set(target.app_id, target);
  }
  return [...byAppId.values()].sort(
    (left, right) =>
      compareAppIds(left.app_id, right.app_id) ||
      left.target_level - right.target_level
  );
}

function sameCollectorTargets(
  left: readonly BadgeCollectorTarget[],
  right: readonly BadgeCollectorTarget[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.app_id === right[index].app_id &&
        target.target_level === right[index].target_level
    )
  );
}

/** Splits targets into in-scope keeps and out-of-scope removals. */
function clampCollectorTargets(
  targets: readonly BadgeCollectorTarget[],
  allowedAppIds: ReadonlySet<string>
): { kept: BadgeCollectorTarget[]; removed: string[] } {
  const kept: BadgeCollectorTarget[] = [];
  const removed: string[] = [];
  for (const target of targets) {
    if (allowedAppIds.has(target.app_id)) {
      kept.push(target);
    } else {
      removed.push(target.app_id);
    }
  }
  return { kept, removed };
}

/** Inventory games first, then discovered response games, name-sorted. */
function mergeCandidateGames(
  inventoryGames: readonly LevelUpGame[],
  discoveredGames: readonly BadgeGame[]
): CandidateGame[] {
  const byAppId = new Map<string, CandidateGame>();
  for (const game of inventoryGames) {
    byAppId.set(game.app_id, {
      app_id: game.app_id,
      game_name: game.game_name,
      badge_level: game.badge_level
    });
  }
  for (const game of discoveredGames) {
    if (!byAppId.has(game.app_id)) {
      byAppId.set(game.app_id, {
        app_id: game.app_id,
        game_name: game.game_name,
        badge_level: game.badge_level
      });
    }
  }
  return [...byAppId.values()].sort(
    (left, right) =>
      NAME_COLLATOR.compare(left.game_name, right.game_name) ||
      compareAppIds(left.app_id, right.app_id)
  );
}

function defaultCollectorTargetLevel(game: CandidateGame): number {
  if (game.badge_level === null) {
    return 1;
  }
  return Math.min(MAX_BADGE_CRAFT_LEVEL, Math.max(1, game.badge_level + 1));
}

function buildPlanIntent(
  input: DraftPlanInput,
  targetLevelText: string,
  budgetText: string,
  money: BadgePlanningMoney | null,
  protections: ReadonlyMap<string, BadgeProtection>,
  excludedAppIds: ReadonlySet<string>,
  strategy: BadgePlanStrategy
): PlanIntent {
  return {
    mode: input.mode,
    targetLevel: targetLevelText,
    budgetText,
    money:
      money === null
        ? null
        : { currency_code: money.currency_code, minor_digits: money.minor_digits },
    scope: input.scope,
    selectedAppIds: [...input.selectedAppIds],
    collectorTargets: input.collectorTargets.map((target) => ({ ...target })),
    protections: [...protections.values()]
      .map((protection) => ({ ...protection }))
      .sort((left, right) =>
        left.market_hash_name.localeCompare(right.market_hash_name)
      ),
    excludedAppIds: normalizeAppIds([...excludedAppIds]),
    strategy
  };
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
  compareActive,
  collectorTargetLevel,
  onToggle,
  onKeepQuantity,
  onNeverSell,
  onToggleExclude,
  onCompare
}: {
  game: BadgeGame;
  money: BadgePlanningMoney | null;
  steamId: string | null;
  protectionFor: (marketHashName: string) => BadgeProtection | undefined;
  excluded: boolean;
  canNavigate: boolean;
  canShop: boolean;
  expanded: boolean;
  compareActive: boolean;
  collectorTargetLevel: number | null;
  onToggle: () => void;
  onKeepQuantity: (marketHashName: string, keepQuantity: number) => void;
  onNeverSell: (marketHashName: string, neverSell: boolean) => void;
  onToggleExclude: () => void;
  onCompare: () => void;
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
            {game.target_badge_level !== null ? (
              <span>
                Collector target level{" "}
                {COUNT_FORMATTER.format(game.target_badge_level)}
              </span>
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
          {steamId !== null ? (
            <section className="badge-workspace-game-artwork">
              <h5>Badge artwork</h5>
              <BadgeArtwork
                appId={game.app_id}
                steamId={steamId}
                gameName={game.game_name}
                targetLevel={collectorTargetLevel ?? game.target_badge_level ?? null}
              />
            </section>
          ) : null}
          <div className="badge-workspace-game-actions">
            <button
              type="button"
              className="badge-workspace-secondary"
              onClick={onCompare}
            >
              {compareActive ? "Clear set comparison" : "Compare selling one set"}
            </button>
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
  scope,
  compareAppId,
  collectorTargetsByAppId,
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
  onToggleExclude,
  onCompare
}: {
  games: readonly BadgeGame[];
  money: BadgePlanningMoney | null;
  steamId: string | null;
  protections: ReadonlyMap<string, BadgeProtection>;
  excludedAppIds: ReadonlySet<string>;
  canNavigate: boolean;
  canShop: boolean;
  scope: BadgePlanningScope;
  compareAppId: string | null;
  collectorTargetsByAppId: ReadonlyMap<string, number>;
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
  onCompare: (appId: string) => void;
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
    if (scope === "catalog") {
      return (
        <div className="badge-workspace-empty">
          <h3>No supported sets are available yet</h3>
          <p>
            The complete-set catalog is empty right now. Try refreshing later —
            discovery does not depend on your inventory.
          </p>
        </div>
      );
    }
    if (scope === "selected") {
      return (
        <div className="badge-workspace-empty">
          <h3>None of the selected games is available</h3>
          <p>
            The selected games resolved to nothing in this snapshot. Check the
            selection in the plan tab or switch back to Inventory games.
          </p>
        </div>
      );
    }
    return (
      <div className="badge-workspace-empty">
        <h3>No normal-badge games in this snapshot</h3>
        <p>
          No trading-card games were represented in this inventory snapshot.
          Refresh inventory after acquiring trading cards, or use the All
          supported games scope to discover games you do not own yet.
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
                  compareActive={compareAppId === game.app_id}
                  collectorTargetLevel={
                    collectorTargetsByAppId.get(game.app_id) ?? null
                  }
                  onToggle={() => onToggleGame(game.app_id)}
                  onKeepQuantity={onKeepQuantity}
                  onNeverSell={onNeverSell}
                  onToggleExclude={() => onToggleExclude(game.app_id)}
                  onCompare={() => onCompare(game.app_id)}
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
  canShop,
  collectorMode,
  selected,
  onChoose
}: {
  plan: BadgePlan;
  money: BadgePlanningMoney | null;
  steamId: string | null;
  canNavigate: boolean;
  canShop: boolean;
  collectorMode: boolean;
  selected: boolean;
  onChoose: () => void;
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
        <label className="badge-workspace-plan-choice">
          <input
            type="radio"
            name="badge-workspace-plan-choice"
            checked={selected}
            onChange={onChoose}
            aria-label={`Work with the ${info.title} plan`}
          />
          <span>Work with this plan</span>
        </label>
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
      {collectorMode && plan.target_level === null ? (
        plan.target_reached ? (
          <p className="badge-workspace-policy-target">
            Every collector goal is reached with this snapshot and budget.
          </p>
        ) : (
          <p className="badge-workspace-policy-target badge-workspace-policy-shortfall">
            Shortfall {formatXp(plan.shortfall_xp)} to reach every collector
            goal with this snapshot and budget.
          </p>
        )
      ) : plan.target_level !== null ? (
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

function ScopePicker({
  scope,
  onChange
}: {
  scope: BadgePlanningScope;
  onChange: (scope: BadgePlanningScope) => void;
}) {
  return (
    <fieldset className="badge-workspace-mode-fieldset">
      <legend>Plan scope</legend>
      {BADGE_PLANNING_SCOPES.map((entry) => (
        <label
          key={entry.key}
          className="badge-workspace-radio badge-workspace-scope-radio"
        >
          <input
            type="radio"
            name="badge-workspace-plan-scope"
            value={entry.key}
            checked={scope === entry.key}
            onChange={() => onChange(entry.key)}
          />
          <span>
            {entry.label}
            <small className="badge-workspace-scope-hint">{entry.hint}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function PickerRows({
  candidates,
  selected,
  atCap,
  onToggle,
  renderLevelControl
}: {
  candidates: readonly CandidateGame[];
  selected: (appId: string) => boolean;
  atCap: boolean;
  onToggle: (appId: string, checked: boolean, defaultLevel: number) => void;
  renderLevelControl: ((game: CandidateGame) => ReactNode) | null;
}) {
  return (
    <ul className="badge-workspace-picker-list">
      {candidates.map((game) => {
        const checked = selected(game.app_id);
        return (
          <li key={game.app_id}>
            <div className="badge-workspace-picker-row">
              <input
                type="checkbox"
                checked={checked}
                disabled={atCap && !checked}
                aria-label={
                  renderLevelControl === null
                    ? `Plan ${game.game_name}`
                    : `Collector goal for ${game.game_name}`
                }
                onChange={(event) =>
                  onToggle(game.app_id, event.currentTarget.checked, defaultCollectorTargetLevel(game))
                }
              />
              <span className="badge-workspace-picker-name">{game.game_name}</span>
              <span className="badge-workspace-game-meta">AppID {game.app_id}</span>
              {renderLevelControl === null ? null : renderLevelControl(game)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function filterCandidates(
  candidates: readonly CandidateGame[],
  search: string
): CandidateGame[] {
  const needle = search.trim().toLowerCase();
  if (needle === "") {
    return [...candidates];
  }
  return candidates.filter(
    (game) =>
      game.game_name.toLowerCase().includes(needle) ||
      game.app_id.includes(needle)
  );
}

function SelectedGamesPicker({
  candidates,
  selectedAppIds,
  search,
  onSearchChange,
  onToggle,
  message
}: {
  candidates: readonly CandidateGame[];
  selectedAppIds: readonly string[];
  search: string;
  onSearchChange: (value: string) => void;
  onToggle: (appId: string, checked: boolean, defaultLevel: number) => void;
  message: string | null;
}) {
  const selectedSet = new Set(selectedAppIds);
  const matches = filterCandidates(candidates, search);
  const visible = matches.slice(0, PICKER_ROW_LIMIT);
  const atCap = selectedAppIds.length >= MAX_BADGE_PLANNING_SCOPE_IDS;
  return (
    <div className="badge-workspace-picker">
      <p className="badge-workspace-picker-count" role="status">
        {COUNT_FORMATTER.format(selectedAppIds.length)} of{" "}
        {COUNT_FORMATTER.format(MAX_BADGE_PLANNING_SCOPE_IDS)} games selected
        {matches.length !== candidates.length
          ? ` · ${COUNT_FORMATTER.format(matches.length)} match the filter`
          : ""}
      </p>
      <label
        className="badge-workspace-field"
        htmlFor="badge-workspace-selection-search"
      >
        <span>Filter games</span>
        <input
          id="badge-workspace-selection-search"
          type="search"
          value={search}
          placeholder="Name or AppID"
          onChange={(event) => onSearchChange(event.currentTarget.value)}
        />
      </label>
      {message !== null ? (
        <p id="badge-workspace-scope-error" className="badge-workspace-error" role="alert">
          {message}
        </p>
      ) : null}
      {candidates.length === 0 ? (
        <p className="badge-workspace-picker-empty">
          No games are known yet. Apply the All supported games scope once to
          discover games, then switch back here to pick from them.
        </p>
      ) : visible.length === 0 ? (
        <p className="badge-workspace-picker-empty">No games match this filter.</p>
      ) : (
        <>
          <PickerRows
            candidates={visible}
            selected={(appId) => selectedSet.has(appId)}
            atCap={atCap}
            onToggle={onToggle}
            renderLevelControl={null}
          />
          {matches.length > visible.length ? (
            <p className="badge-workspace-picker-count">
              Showing {COUNT_FORMATTER.format(visible.length)} of{" "}
              {COUNT_FORMATTER.format(matches.length)} matching games. Refine
              the filter to see more.
            </p>
          ) : null}
        </>
      )}
      <p className="badge-workspace-session-note">
        Selecting games only changes what the next Apply plans. Nothing is
        bought or crafted automatically.
      </p>
    </div>
  );
}

function CollectorTargetsEditor({
  candidates,
  targets,
  search,
  onSearchChange,
  onSetTarget,
  message
}: {
  candidates: readonly CandidateGame[];
  targets: readonly BadgeCollectorTarget[];
  search: string;
  onSearchChange: (value: string) => void;
  onSetTarget: (appId: string, level: number | null) => void;
  message: string | null;
}) {
  const targetByAppId = new Map(
    targets.map((target) => [target.app_id, target] as const)
  );
  const matches = filterCandidates(candidates, search);
  const visible = matches.slice(0, PICKER_ROW_LIMIT);
  const atCap = targets.length >= MAX_BADGE_PLANNING_SCOPE_IDS;
  return (
    <div className="badge-workspace-picker">
      <p className="badge-workspace-picker-count" role="status">
        {COUNT_FORMATTER.format(targets.length)} collector goal
        {targets.length === 1 ? "" : "s"} set · games without a goal stay
        untouched
      </p>
      <label
        className="badge-workspace-field"
        htmlFor="badge-workspace-collector-search"
      >
        <span>Filter games</span>
        <input
          id="badge-workspace-collector-search"
          type="search"
          value={search}
          placeholder="Name or AppID"
          onChange={(event) => onSearchChange(event.currentTarget.value)}
        />
      </label>
      {message !== null ? (
        <p id="badge-workspace-collector-error" className="badge-workspace-error" role="alert">
          {message}
        </p>
      ) : null}
      {candidates.length === 0 ? (
        <p className="badge-workspace-picker-empty">
          No games are known yet. Apply the All supported games scope once to
          discover games, then set collector goals for them.
        </p>
      ) : visible.length === 0 ? (
        <p className="badge-workspace-picker-empty">No games match this filter.</p>
      ) : (
        <>
          <PickerRows
            candidates={visible}
            selected={(appId) => targetByAppId.has(appId)}
            atCap={atCap}
            onToggle={(appId, checked, defaultLevel) =>
              onSetTarget(appId, checked ? defaultLevel : null)
            }
            renderLevelControl={(game) => {
              const target = targetByAppId.get(game.app_id);
              return (
                <label
                  className="badge-workspace-collector-level"
                  htmlFor={`badge-workspace-collector-level-${game.app_id}`}
                >
                  <span>Level</span>
                  <select
                    id={`badge-workspace-collector-level-${game.app_id}`}
                    value={String(
                      target === undefined
                        ? defaultCollectorTargetLevel(game)
                        : target.target_level
                    )}
                    disabled={target === undefined}
                    onChange={(event) =>
                      onSetTarget(game.app_id, Number(event.currentTarget.value))
                    }
                    aria-label={`Target level for ${game.game_name}`}
                  >
                    {Array.from(
                      { length: MAX_BADGE_CRAFT_LEVEL },
                      (_, index) => index + 1
                    ).map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }}
          />
          {matches.length > visible.length ? (
            <p className="badge-workspace-picker-count">
              Showing {COUNT_FORMATTER.format(visible.length)} of{" "}
              {COUNT_FORMATTER.format(matches.length)} matching games. Refine
              the filter to see more.
            </p>
          ) : null}
        </>
      )}
      <p className="badge-workspace-session-note">
        A collector goal is a target badge level for that game. Games without a
        goal are never crafted in collector mode.
      </p>
    </div>
  );
}

function IntentToolbar({
  saved,
  remember,
  error,
  restoreNote,
  canSave,
  onRemember,
  onSave,
  onRestore,
  onForget
}: {
  saved: PlanIntent | null;
  remember: boolean;
  error: string | null;
  restoreNote: string | null;
  canSave: boolean;
  onRemember: (remember: boolean) => void;
  onSave: () => void;
  onRestore: () => void;
  onForget: () => void;
}) {
  let savedSummary: string | null = null;
  if (saved !== null) {
    const parts = [
      MODE_LABELS[saved.mode],
      SCOPE_INFO[saved.scope].label,
      `budget ${saved.budgetText}`,
      `${STRATEGY_INFO[saved.strategy].title} plan`
    ];
    if (saved.scope === "selected") {
      parts.push(`${COUNT_FORMATTER.format(saved.selectedAppIds.length)} selected`);
    }
    if (saved.mode === "collector") {
      parts.push(`${COUNT_FORMATTER.format(saved.collectorTargets.length)} goals`);
    }
    if (saved.protections.length > 0) {
      parts.push(`${COUNT_FORMATTER.format(saved.protections.length)} protections`);
    }
    if (saved.excludedAppIds.length > 0) {
      parts.push(`${COUNT_FORMATTER.format(saved.excludedAppIds.length)} excluded`);
    }
    savedSummary = parts.join(" · ");
  }
  return (
    <section
      className="badge-workspace-intent"
      aria-labelledby="badge-workspace-intent-title"
    >
      <h3 id="badge-workspace-intent-title">Saved setup on this device</h3>
      <p className="badge-workspace-session-note">
        A saved setup stays in this browser on this device, separately per Steam
        account. It never stores holdings, quotes, or calculated plans and is
        never sent to a server. Restoring only fills the draft inputs — nothing
        is planned until you apply.
      </p>
      {error !== null ? (
        <p className="badge-workspace-error" role="alert">
          {error}
        </p>
      ) : null}
      {saved === null ? (
        <p>No setup is saved for this account yet.</p>
      ) : (
        <div className="badge-workspace-intent-saved">
          <p>Saved setup: {savedSummary}</p>
          <div className="badge-workspace-intent-actions">
            <button
              type="button"
              className="badge-workspace-primary"
              onClick={onRestore}
            >
              Restore saved setup
            </button>
            <button
              type="button"
              className="badge-workspace-secondary"
              onClick={onForget}
            >
              Forget saved setup
            </button>
          </div>
        </div>
      )}
      <div className="badge-workspace-intent-keep">
        <label className="badge-workspace-radio">
          <input
            type="checkbox"
            checked={remember}
            disabled={!canSave}
            onChange={(event) => onRemember(event.currentTarget.checked)}
          />
          <span>Keep this setup saved and update it whenever you apply</span>
        </label>
        <button
          type="button"
          className="badge-workspace-secondary"
          disabled={!canSave}
          onClick={onSave}
        >
          Save current setup
        </button>
      </div>
      {restoreNote !== null ? (
        <p className="badge-workspace-intent-note" role="status">
          {restoreNote}
        </p>
      ) : null}
    </section>
  );
}

function OpportunityPanel({
  opportunity,
  gameName,
  money,
  canNavigate,
  onClear
}: {
  opportunity: BadgeOpportunity | null;
  gameName: string | null;
  money: BadgePlanningMoney | null;
  canNavigate: boolean;
  onClear: () => void;
}) {
  const ready = opportunity !== null && opportunity.status === "ready" ? opportunity : null;
  const netProceeds =
    ready !== null && ready.net_proceeds_minor !== null
      ? moneyText(ready.net_proceeds_minor, money)
      : null;
  const replacement = ready?.replacement_plan ?? null;
  const baseline = ready?.baseline_plan ?? null;
  return (
    <section
      className="badge-workspace-opportunity"
      aria-labelledby="badge-workspace-opportunity-title"
    >
      <div className="badge-workspace-opportunity-header">
        <h3 id="badge-workspace-opportunity-title">
          Craft vs. sell comparison
          {gameName !== null ? ` — ${gameName}` : ""}
        </h3>
        <span
          className={`badge-workspace-chip badge-workspace-chip-plan-${ready !== null ? "ready" : "no_opportunity"
            }`}
        >
          {ready !== null ? "Ready" : "Unavailable"}
        </span>
      </div>
      {opportunity === null ? (
        <p role="status">
          The comparison did not come back with this snapshot. Refresh the plan
          to try again.
        </p>
      ) : ready !== null ? (
        <>
          <p className="badge-workspace-opportunity-summary">
            Exactly one complete unreserved set of this game is compared as if
            you sold it and crafted replacements. This never sells, buys, or
            crafts anything on its own.
          </p>
          <dl className="badge-workspace-opportunity-metrics">
            <div>
              <dt>Net sale proceeds</dt>
              <dd>{netProceeds ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>XP from crafting the sold set</dt>
              <dd>{formatXp(ready.craft_xp)}</dd>
            </div>
            <div>
              <dt>Additional XP vs free crafts</dt>
              <dd>
                {ready.additional_xp === null
                  ? "Unavailable"
                  : formatXp(ready.additional_xp)}
              </dd>
            </div>
            <div>
              <dt>Comparison valid until</dt>
              <dd>
                {ready.valid_until !== null
                  ? formatAbsoluteTime(ready.valid_until)
                  : "Unknown"}
              </dd>
            </div>
          </dl>
          {ready.sales.length > 0 ? (
            <div className="badge-workspace-table-scroll">
              <table className="badge-workspace-card-table">
                <caption>Sales in this comparison</caption>
                <thead>
                  <tr>
                    <th scope="col">Card</th>
                    <th scope="col">Buyer pays</th>
                    <th scope="col">You receive</th>
                    <th scope="col">Quoted</th>
                    <th scope="col">Market</th>
                  </tr>
                </thead>
                <tbody>
                  {ready.sales.map((sale) => (
                    <tr key={sale.market_hash_name}>
                      <th scope="row" className="badge-workspace-card-name">
                        {sale.card_name}
                      </th>
                      <td>
                        {moneyText(sale.buyer_total_minor, money) ?? "Unpriced"}
                      </td>
                      <td>
                        {moneyText(sale.seller_receipt_minor, money) ?? "Unpriced"}
                      </td>
                      <td>{formatAbsoluteTime(sale.quote_timestamp)}</td>
                      <td>
                        {canNavigate ? (
                          <a
                            className="badge-workspace-link"
                            href={buildSteamMarketListingUrl(sale.market_hash_name)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Market
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No marketable sales are part of this comparison.</p>
          )}
          <dl className="badge-workspace-opportunity-plans">
            <div>
              <dt>Rebuild after the sale</dt>
              <dd>
                {replacement === null
                  ? "No replacement plan"
                  : `${moneyText(replacement.spend_minor, money) ?? "unpriced"} for ${formatXp(replacement.xp_gain)} · ${COUNT_FORMATTER.format(replacement.craft_count)} craft${replacement.craft_count === 1 ? "" : "s"}`}
              </dd>
            </div>
            <div>
              <dt>Free crafts without selling</dt>
              <dd>
                {baseline === null
                  ? "No baseline plan"
                  : `${moneyText(baseline.spend_minor, money) ?? "unpriced"} for ${formatXp(baseline.xp_gain)}`}
              </dd>
            </div>
          </dl>
          <p className="badge-workspace-session-note">{OPPORTUNITY_DISCLOSURE}</p>
        </>
      ) : (
        <p className="badge-workspace-opportunity-reason">
          {reasonCopy(opportunity.reason)}
        </p>
      )}
      <div className="badge-workspace-opportunity-actions">
        <button
          type="button"
          className="badge-workspace-secondary"
          onClick={onClear}
        >
          Clear comparison
        </button>
      </div>
    </section>
  );
}

function BadgePlannerView({
  response,
  readyResponse,
  money,
  steamId,
  canNavigate,
  canAct,
  canShop,
  protections,
  excludedAppIds,
  holdingsByHash,
  gameNamesById,
  moneyContract,
  playerLevel,
  items,
  planMode,
  committedMode,
  committedCompareAppId,
  committedCollectorTargets,
  targetLevelText,
  budgetText,
  draftParse,
  pruneNote,
  unappliedChanges,
  candidates,
  scope,
  selectedAppIds,
  selectionSearch,
  collectorTargets,
  collectorSearch,
  selectedPlanStrategy,
  opportunity,
  compareGameName,
  intent,
  onModeChange,
  onTargetChange,
  onBudgetChange,
  onScopeChange,
  onToggleSelected,
  onSelectionSearchChange,
  onCollectorTargetChange,
  onCollectorSearchChange,
  onApply,
  onPlanStrategyChange,
  onClearCompare,
  onRefreshPlan,
  onRemoveProtection,
  onToggleExclude
}: {
  response: BadgePlanningResponse | null;
  readyResponse: BadgePlanningReadyResponse | null;
  money: BadgePlanningMoney | null;
  steamId: string | null;
  canNavigate: boolean;
  canAct: boolean;
  canShop: boolean;
  protections: ReadonlyMap<string, BadgeProtection>;
  excludedAppIds: ReadonlySet<string>;
  holdingsByHash: ReadonlyMap<string, number>;
  gameNamesById: ReadonlyMap<string, string>;
  moneyContract: BadgePlanningMoney | null;
  playerLevel: number | null;
  items: readonly LevelUpInventoryItem[];
  planMode: BadgePlanningMode;
  committedMode: BadgePlanningMode;
  committedCompareAppId: string | null;
  committedCollectorTargets: readonly BadgeCollectorTarget[];
  targetLevelText: string;
  budgetText: string;
  draftParse: DraftPlanParse;
  pruneNote: string | null;
  unappliedChanges: boolean;
  candidates: readonly CandidateGame[];
  scope: BadgePlanningScope;
  selectedAppIds: readonly string[];
  selectionSearch: string;
  collectorTargets: readonly BadgeCollectorTarget[];
  collectorSearch: string;
  selectedPlanStrategy: BadgePlanStrategy | null;
  opportunity: BadgeOpportunity | null;
  compareGameName: string | null;
  intent: {
    saved: PlanIntent | null;
    remember: boolean;
    error: string | null;
    restoreNote: string | null;
    canSave: boolean;
    onRemember: (remember: boolean) => void;
    onSave: () => void;
    onRestore: () => void;
    onForget: () => void;
  };
  onModeChange: (mode: BadgePlanningMode) => void;
  onTargetChange: (value: string) => void;
  onBudgetChange: (value: string) => void;
  onScopeChange: (scope: BadgePlanningScope) => void;
  onToggleSelected: (
    appId: string,
    checked: boolean,
    defaultLevel: number
  ) => void;
  onSelectionSearchChange: (value: string) => void;
  onCollectorTargetChange: (appId: string, level: number | null) => void;
  onCollectorSearchChange: (value: string) => void;
  onApply: () => void;
  onPlanStrategyChange: (strategy: BadgePlanStrategy) => void;
  onClearCompare: () => void;
  onRefreshPlan: () => void;
  onRemoveProtection: (marketHashName: string) => void;
  onToggleExclude: (appId: string) => void;
}) {
  const protectionEntries = [...protections.values()];
  const exclusionEntries = [...excludedAppIds];
  const plans = readyResponse?.plans ?? [];
  const selectedPlan =
    plans.find((plan) => plan.strategy === selectedPlanStrategy) ??
    plans.find((plan) => plan.strategy === "cheapest") ??
    plans[0] ??
    null;
  return (
    <div className="badge-workspace-planner">
      <IntentToolbar
        saved={intent.saved}
        remember={intent.remember}
        error={intent.error}
        restoreNote={intent.restoreNote}
        canSave={intent.canSave}
        onRemember={intent.onRemember}
        onSave={intent.onSave}
        onRestore={intent.onRestore}
        onForget={intent.onForget}
      />
      <section
        className="badge-workspace-plan-input"
        aria-labelledby="badge-workspace-plan-input-title"
      >
        <h3 id="badge-workspace-plan-input-title">Plan mode, scope, and budget</h3>
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
            <label className="badge-workspace-radio">
              <input
                type="radio"
                name="badge-workspace-plan-mode"
                value="collector"
                checked={planMode === "collector"}
                onChange={() => onModeChange("collector")}
              />
              <span>Collect games to chosen badge levels</span>
            </label>
          </fieldset>
          <ScopePicker scope={scope} onChange={onScopeChange} />
          {scope === "selected" ? (
            <SelectedGamesPicker
              candidates={candidates}
              selectedAppIds={selectedAppIds}
              search={selectionSearch}
              onSearchChange={onSelectionSearchChange}
              onToggle={onToggleSelected}
              message={draftParse.scopeMessage}
            />
          ) : null}
          {planMode === "collector" ? (
            <CollectorTargetsEditor
              candidates={candidates}
              targets={collectorTargets}
              search={collectorSearch}
              onSearchChange={onCollectorSearchChange}
              onSetTarget={onCollectorTargetChange}
              message={draftParse.collectorMessage}
            />
          ) : null}
          {pruneNote !== null ? (
            <p className="badge-workspace-unapplied" role="status">
              {pruneNote}
            </p>
          ) : null}
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
      <section
        className="badge-workspace-constraints"
        aria-labelledby="badge-workspace-constraints-title"
      >
        <h3 id="badge-workspace-constraints-title">Protections and exclusions</h3>
        <p className="badge-workspace-session-note">
          Protections, exclusions, and plan inputs apply to this account in
          this browser tab session only. They are not saved to your Steam
          account. A saved setup, if you create one above, stays on this device
          in this browser only.
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
      <section
        className="badge-workspace-policies"
        aria-labelledby="badge-workspace-policies-title"
      >
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
                collectorMode={committedMode === "collector"}
                selected={selectedPlan !== null && plan.strategy === selectedPlan.strategy}
                onChoose={() => onPlanStrategyChange(plan.strategy)}
              />
            ))}
          </div>
        )}
      </section>
      {committedCompareAppId !== null ? (
        <OpportunityPanel
          opportunity={opportunity}
          gameName={compareGameName}
          money={money}
          canNavigate={canNavigate}
          onClear={onClearCompare}
        />
      ) : null}
      {steamId !== null && readyResponse !== null && selectedPlan !== null ? (
        <PlanWorkflow
          steamId={steamId}
          response={readyResponse}
          plan={selectedPlan}
          items={items}
          canAct={canAct}
          onRefresh={onRefreshPlan}
          collectorTargets={
            committedMode === "collector" && committedCollectorTargets.length > 0
              ? committedCollectorTargets
              : undefined
          }
        />
      ) : null}
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
  const [planScope, setPlanScope] = useState<BadgePlanningScope>("inventory");
  const [selectedAppIds, setSelectedAppIds] = useState<readonly string[]>([]);
  const [selectionSearch, setSelectionSearch] = useState("");
  const [collectorTargets, setCollectorTargets] = useState<readonly BadgeCollectorTarget[]>([]);
  const [collectorSearch, setCollectorSearch] = useState("");
  const [pruneNote, setPruneNote] = useState<string | null>(null);
  const [planStrategy, setPlanStrategy] = useState<BadgePlanStrategy | null>(null);
  const [applied, setApplied] = useState<AppliedPlanInput | null>(null);
  const [moneyContract, setMoneyContract] = useState<BadgePlanningMoney | null>(null);
  const [currencyMessage, setCurrencyMessage] = useState<string | null>(null);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  /** Inventory timestamp at the last explicit budget confirmation. */
  const [confirmedInventoryAt, setConfirmedInventoryAt] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [dashboardView, setDashboardView] = useState<DashboardView>("all");
  const [dashboardPage, setDashboardPage] = useState(1);
  const [openGameId, setOpenGameId] = useState<string | null>(null);
  const retryRef = useRef({ key: "", count: 0 });

  const planIntent = usePlanIntent(steamId);

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
    mode: "target",
    targetLevel: defaultTarget,
    budgetMinor: 0,
    scope: "inventory",
    selectedAppIds: [],
    collectorTargets: [],
    compareAppId: null,
    money: null
  }, [applied, defaultTarget]);
  const draftParse = useMemo<DraftPlanParse>(() => {
    const budget = parseBudgetMinorUnits(budgetText, moneyContract?.minor_digits ?? ASSUMED_BUDGET_MINOR_DIGITS);
    if (!budget.ok) {
      return { ok: false, input: null, targetMessage: null, budgetMessage: budget.message, scopeMessage: null, collectorMessage: null };
    }
    if (budget.minor > 0 && moneyContract === null) {
      return { ok: false, input: null, targetMessage: null, budgetMessage: "The server has not confirmed a currency yet. Only a zero budget can be used.", scopeMessage: null, collectorMessage: null };
    }
    const target = parseTargetLevelInput(targetLevelText);
    if (planMode === "target" && !target.ok) {
      return { ok: false, input: null, targetMessage: target.message, budgetMessage: null, scopeMessage: null, collectorMessage: null };
    }
    if (planScope === "selected" && selectedAppIds.length === 0) {
      return { ok: false, input: null, targetMessage: null, budgetMessage: null, scopeMessage: "Select at least one game, or choose another scope.", collectorMessage: null };
    }
    if (selectedAppIds.length > MAX_BADGE_PLANNING_SCOPE_IDS) {
      return { ok: false, input: null, targetMessage: null, budgetMessage: null, scopeMessage: `Select at most ${COUNT_FORMATTER.format(MAX_BADGE_PLANNING_SCOPE_IDS)} games.`, collectorMessage: null };
    }
    if (planMode === "collector") {
      if (collectorTargets.length === 0) {
        return { ok: false, input: null, targetMessage: null, budgetMessage: null, scopeMessage: null, collectorMessage: "Set at least one collector goal, or choose another planning mode." };
      }
      if (collectorTargets.length > MAX_BADGE_PLANNING_SCOPE_IDS) {
        return { ok: false, input: null, targetMessage: null, budgetMessage: null, scopeMessage: null, collectorMessage: `Set at most ${COUNT_FORMATTER.format(MAX_BADGE_PLANNING_SCOPE_IDS)} collector goals.` };
      }
    }
    return {
      ok: true,
      input: {
        mode: planMode,
        targetLevel: planMode === "target" && target.ok ? target.level : null,
        budgetMinor: budget.minor,
        scope: planScope,
        selectedAppIds: planScope === "selected" ? normalizeAppIds(selectedAppIds) : [],
        collectorTargets: planMode === "collector" ? normalizeCollectorTargets(collectorTargets) : [],
        compareAppId: committedPlanInput.compareAppId
      },
      targetMessage: null, budgetMessage: null, scopeMessage: null, collectorMessage: null
    };
  }, [budgetText, collectorTargets, committedPlanInput.compareAppId, moneyContract, planMode, planScope, selectedAppIds, targetLevelText]);
  const draftSelectedChanged =
    draftParse.ok &&
    (draftParse.input.selectedAppIds.length !== committedPlanInput.selectedAppIds.length ||
      draftParse.input.selectedAppIds.some(
        (appId, index) => appId !== committedPlanInput.selectedAppIds[index]
      ));
  const draftTargetsChanged =
    draftParse.ok && !sameCollectorTargets(draftParse.input.collectorTargets, committedPlanInput.collectorTargets);
  const unappliedChanges = !draftParse.ok ||
    draftParse.input.mode !== committedPlanInput.mode ||
    draftParse.input.targetLevel !== committedPlanInput.targetLevel ||
    draftParse.input.budgetMinor !== committedPlanInput.budgetMinor ||
    draftParse.input.scope !== committedPlanInput.scope ||
    draftSelectedChanged ||
    draftTargetsChanged;

  const normalBadgeLevels = useMemo(() => {
    const levels = [...badges.normal_badge_levels];
    levels.sort((left, right) => left.app_id - right.app_id);
    return levels;
  }, [badges.normal_badge_levels]);

  const badgeRequest = useMemo(() => {
    const base = requestInput.base;
    if (base === null) return { request: null, message: null };
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
          excluded_app_ids: normalizeAppIds([...excludedAppIds]),
          protections: activeProtections,
          scope: committedPlanInput.scope,
          selected_app_ids: committedPlanInput.selectedAppIds,
          collector_targets: committedPlanInput.collectorTargets,
          compare_app_id: committedPlanInput.compareAppId
        }, normalBadgeLevels),
        message: null
      };
    } catch {
      return { request: null, message: "Review protections and exclusions before planning." };
    }
  }, [committedPlanInput, excludedAppIds, normalBadgeLevels, protections, requestInput.base]);
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
  const budgetConfirmationRequired =
    committedPlanInput.budgetMinor > 0 &&
    inventoryRefreshedAt !== null &&
    inventoryRefreshedAt !== confirmedInventoryAt;
  const canNavigate = activeResponse?.status === "ready" && inventoryIsFresh && badgeIsFresh &&
    !expiredNow && (view === "badges" || !unappliedChanges);
  const canShop = canNavigate && money !== null && !budgetConfirmationRequired;

  const readyResponse =
    activeResponse !== null && activeResponse.status === "ready" ? activeResponse : null;
  const candidateGames = useMemo(
    () =>
      mergeCandidateGames(
        requestInput.base?.games ?? [],
        activeResponse?.games ?? []
      ),
    [activeResponse, requestInput.base]
  );
  const candidateById = useMemo(
    () => new Map(candidateGames.map((game) => [game.app_id, game] as const)),
    [candidateGames]
  );
  const baseGameIds = useMemo(
    () => new Set((requestInput.base?.games ?? []).map((game) => game.app_id)),
    [requestInput.base]
  );
  const collectorTargetsByAppId = useMemo(
    () =>
      new Map(
        collectorTargets.map(
          (target) => [target.app_id, target.target_level] as const
        )
      ),
    [collectorTargets]
  );
  const compareGameName =
    committedPlanInput.compareAppId === null
      ? null
      : candidateById.get(committedPlanInput.compareAppId)?.game_name ??
      `AppID ${committedPlanInput.compareAppId}`;

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
  const currentIntent = draftParse.ok
    ? buildPlanIntent(
      draftParse.input,
      targetLevelText,
      budgetText,
      moneyContract,
      protections,
      excludedAppIds,
      planStrategy ?? "cheapest"
    )
    : null;
  const applyPlanInput = () => {
    if (!draftParse.ok) return;
    const draft = draftParse.input;
    setConfirmedInventoryAt(inventoryRefreshedAt);
    setApplied({ ...draft, money: moneyContract });
    setCurrencyMessage(null);
    setPruneNote(null);
    setRevision((value) => value + 1);
    if (planIntent.remember && currentIntent !== null) {
      planIntent.save(currentIntent);
    }
  };
  const changeScope = (nextScope: BadgePlanningScope) => {
    setPlanScope(nextScope);
    if (nextScope === "catalog") return;
    const allowed =
      nextScope === "inventory" ? baseGameIds : new Set(selectedAppIds);
    const { kept, removed } = clampCollectorTargets(collectorTargets, allowed);
    if (removed.length === 0) return;
    setCollectorTargets(kept);
    setPruneNote(
      `Removed ${COUNT_FORMATTER.format(removed.length)} collector goal${removed.length === 1 ? "" : "s"} — ${removed
        .map((appId) => candidateById.get(appId)?.game_name ?? `AppID ${appId}`)
        .join(", ")} ${removed.length === 1 ? "is" : "are"} not in this scope.`
    );
  };
  const toggleSelectedApp = (appId: string, checked: boolean) => {
    const nextSelection = checked
      ? selectedAppIds.includes(appId) ||
        selectedAppIds.length >= MAX_BADGE_PLANNING_SCOPE_IDS
        ? selectedAppIds
        : [...selectedAppIds, appId]
      : selectedAppIds.filter((id) => id !== appId);
    setSelectedAppIds(nextSelection);
    if (planScope === "selected") {
      const { kept, removed } = clampCollectorTargets(
        collectorTargets,
        new Set(nextSelection)
      );
      if (removed.length > 0) {
        setCollectorTargets(kept);
        setPruneNote(
          `Removed ${COUNT_FORMATTER.format(removed.length)} collector goal${removed.length === 1 ? "" : "s"} — ${removed
            .map((id) => candidateById.get(id)?.game_name ?? `AppID ${id}`)
            .join(", ")} ${removed.length === 1 ? "is" : "is no longer"} selected.`
        );
      }
    }
  };
  const setCollectorTarget = (appId: string, level: number | null) => {
    setPruneNote(null);
    if (level === null) {
      setCollectorTargets((current) =>
        current.filter((target) => target.app_id !== appId)
      );
      return;
    }
    setCollectorTargets((current) => {
      const next = current.filter((target) => target.app_id !== appId);
      next.push({ app_id: appId, target_level: level });
      return next;
    });
  };
  const requestCompare = (appId: string) => {
    // Compare extends the currently applied plan only; unsaved draft edits
    // (scope, collector goals, budget) stay unapplied and visible.
    setApplied((current) => {
      const base = current ?? {
        mode: "target" as BadgePlanningMode,
        targetLevel: defaultTarget,
        budgetMinor: 0,
        scope: "inventory" as BadgePlanningScope,
        selectedAppIds: [] as string[],
        collectorTargets: [] as BadgeCollectorTarget[],
        compareAppId: null,
        money: null
      };
      return {
        ...base,
        compareAppId: base.compareAppId === appId ? null : appId
      };
    });
    setRevision((value) => value + 1);
  };
  const clearCompare = () => {
    setApplied((current) =>
      current === null ? null : { ...current, compareAppId: null }
    );
    setRevision((value) => value + 1);
  };
  const restoreSetup = () => {
    const saved = planIntent.saved;
    if (saved === null) return;
    const notes: string[] = [
      "The saved setup was restored as a draft. Apply to recalculate before market links unlock."
    ];
    setPlanMode(saved.mode);
    setTargetInput(saved.targetLevel);
    let nextBudget = saved.budgetText;
    if (!planIntentCurrencyBinding(saved, moneyContract)) {
      nextBudget = "0";
      notes.push(
        `The saved setup was stored under a different market currency${saved.money === null ? "" : ` (${saved.money.currency_code})`}; the budget was reset to zero. Confirm the current currency with Apply before spending.`
      );
    } else if (saved.money === null && moneyContract !== null) {
      notes.push(
        `The saved setup had no confirmed currency; the restored budget now uses ${moneyContract.currency_code}.`
      );
    } else if (moneyContract === null) {
      notes.push(
        "The server has not confirmed a currency yet, so a restored spending budget cannot be applied until it is."
      );
    }
    setBudgetText(nextBudget);
    setPlanScope(saved.scope);
    const nextSelection = normalizeAppIds(saved.selectedAppIds);
    setSelectedAppIds(nextSelection);
    const { intent: clampedIntent, clampedMarketHashNames } =
      clampPlanIntentProtections(saved, items);
    setProtections(
      new Map(
        clampedIntent.protections.map(
          (protection) => [protection.market_hash_name, protection] as const
        )
      )
    );
    if (clampedMarketHashNames.length > 0) {
      notes.push(
        `${COUNT_FORMATTER.format(clampedMarketHashNames.length)} keep quantit${clampedMarketHashNames.length === 1 ? "y was" : "ies were"} clamped to current holdings.`
      );
    }
    setExcludedAppIds(new Set(saved.excludedAppIds));
    setPlanStrategy(saved.strategy);
    const allowed =
      saved.scope === "inventory"
        ? baseGameIds
        : saved.scope === "selected"
          ? new Set(nextSelection)
          : null;
    let nextTargets = normalizeCollectorTargets(saved.collectorTargets);
    if (allowed !== null) {
      const { kept, removed } = clampCollectorTargets(nextTargets, allowed);
      if (removed.length > 0) {
        notes.push(
          `${COUNT_FORMATTER.format(removed.length)} saved collector goal${removed.length === 1 ? "" : "s"} referenced games outside the restored scope and ${removed.length === 1 ? "was" : "were"} removed.`
        );
        nextTargets = kept;
      }
    }
    setCollectorTargets(nextTargets);
    setSelectionSearch("");
    setCollectorSearch("");
    setRestoreNote(notes.join(" "));
  };
  const rememberSetup = (remember: boolean) => {
    if (currentIntent !== null) {
      planIntent.setRemember(remember, currentIntent);
    }
  };
  const saveSetup = () => {
    if (currentIntent !== null) {
      planIntent.save(currentIntent);
    }
  };
  const forgetSetup = () => {
    planIntent.forget();
    setRestoreNote(null);
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
              <dt>Games evaluated</dt>
              <dd>{COUNT_FORMATTER.format(response.evaluated_game_count)}</dd>
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
            scope={committedPlanInput.scope}
            compareAppId={committedPlanInput.compareAppId}
            collectorTargetsByAppId={collectorTargetsByAppId}
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
            onCompare={requestCompare}
          />
        ) : null}
        {view === "badges" && committedPlanInput.compareAppId !== null ? (
          <OpportunityPanel
            opportunity={readyResponse?.opportunity ?? null}
            gameName={compareGameName}
            money={money}
            canNavigate={canNavigate}
            onClear={clearCompare}
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
  } else if (budgetConfirmationRequired) {
    announcement = "Confirm the remaining Wallet budget to unlock market links.";
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
          Covers normal game badges for trading-card games. Plan your
          inventory games, a hand-picked selection, or every supported
          complete set — including games you do not own yet. Foil, event, and
          community badges are out of scope. Protections and plan inputs are
          never saved to your Steam account; they stay in this browser tab
          unless you explicitly save a setup on this device.
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
      {budgetConfirmationRequired ? (
        <div className="badge-workspace-expiry" role="status">
          <p>
            Your inventory was refreshed since this Wallet budget was last
            confirmed. Holdings cannot tell what you already spent. The draft
            amount stays in the plan form — confirm the remaining budget to
            unlock market links.
          </p>
          <button
            type="button"
            className="badge-workspace-primary"
            disabled={!draftParse.ok}
            onClick={applyPlanInput}
          >
            Confirm remaining Wallet budget and Apply
          </button>
        </div>
      ) : null}
      <div className="badge-workspace-content">{content}</div>
      {view === "plan" && (
        <BadgePlannerView
          response={response}
          readyResponse={readyResponse}
          money={money}
          steamId={steamId}
          canNavigate={canNavigate}
          canAct={canNavigate && !budgetConfirmationRequired}
          canShop={canShop}
          protections={protections}
          excludedAppIds={excludedAppIds}
          holdingsByHash={holdingsByHash}
          gameNamesById={gameNamesById}
          moneyContract={moneyContract}
          playerLevel={badges.player_level}
          items={items}
          planMode={planMode}
          committedMode={committedPlanInput.mode}
          committedCompareAppId={committedPlanInput.compareAppId}
          committedCollectorTargets={committedPlanInput.collectorTargets}
          targetLevelText={targetLevelText}
          budgetText={budgetText}
          draftParse={draftParse}
          pruneNote={pruneNote}
          unappliedChanges={unappliedChanges}
          candidates={candidateGames}
          scope={planScope}
          selectedAppIds={selectedAppIds}
          selectionSearch={selectionSearch}
          collectorTargets={collectorTargets}
          collectorSearch={collectorSearch}
          selectedPlanStrategy={planStrategy}
          opportunity={readyResponse?.opportunity ?? null}
          compareGameName={compareGameName}
          intent={{
            saved: planIntent.saved,
            remember: planIntent.remember,
            error: planIntent.error,
            restoreNote,
            canSave: currentIntent !== null,
            onRemember: rememberSetup,
            onSave: saveSetup,
            onRestore: restoreSetup,
            onForget: forgetSetup
          }}
          onModeChange={(mode) => setPlanMode(mode)}
          onTargetChange={setTargetInput}
          onBudgetChange={(value) => setBudgetText(value)}
          onScopeChange={changeScope}
          onToggleSelected={toggleSelectedApp}
          onSelectionSearchChange={setSelectionSearch}
          onCollectorTargetChange={setCollectorTarget}
          onCollectorSearchChange={setCollectorSearch}
          onApply={applyPlanInput}
          onPlanStrategyChange={setPlanStrategy}
          onClearCompare={clearCompare}
          onRefreshPlan={refreshPlan}
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
