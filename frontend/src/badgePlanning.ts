import {
  isLevelUpIsoTimestamp,
  isLevelUpOptimizationRequest,
  isNormalCardMarketHashName,
  levelForXp,
  MAX_APP_ID_LENGTH,
  MAX_CARD_QUANTITY,
  MAX_GAME_NAME_LENGTH,
  MAX_LEVEL,
  MAX_LEVEL_UP_CARD_ROWS,
  MAX_MINOR_AMOUNT,
  MAX_NORMAL_BADGE_LEVEL_ROWS,
  MAX_NORMAL_GAME_ROWS,
  MAX_SET_SIZE,
  MAX_STEAM_ID_LENGTH,
  MAX_XP,
  MIN_SET_SIZE,
  minimumXpForLevel,
  normalCardAppId,
  type LevelUpCardOwnership,
  type LevelUpInventoryItem,
  type LevelUpNormalBadgeLevel,
  type LevelUpOptimizationRequest
} from "./levelUpOptimization";

export const BADGE_PLANNING_URL = `${(
  import.meta.env.VITE_API_BASE_URL ?? ""
).replace(/\/+$/, "")}/api/auth/badge-planning`;
export const MAX_BADGE_PLANNING_TARGET_LEVEL = 100_000;
export const MAX_BADGE_PLANNING_BUDGET_MINOR = 1_000_000_000;
export const BADGE_CRAFT_XP = 100;
export const MAX_BADGE_CRAFT_LEVEL = 5;
/** Lowest selectable per-game collector goal. */
export const MIN_BADGE_COLLECTOR_TARGET_LEVEL = 1;
/** Shared bound for selected candidates and collector targets. */
export const MAX_BADGE_PLANNING_SCOPE_IDS = 1_000;
/** Supported catalog sets/cards plus unsupported original inventory rows. */
export const MAX_BADGE_PLANNING_CATALOG_GAME_ROWS = 50_000 + MAX_NORMAL_GAME_ROWS;
export const MAX_BADGE_PLANNING_CATALOG_CARD_ROWS = 250_000 + MAX_LEVEL_UP_CARD_ROWS;
/** Matches the backend options bound for exclusion lists. */
const MAX_BADGE_PLANNING_EXCLUDED_IDS = 10_000;
/**
 * Backend MAX_APP_ID: normal badge snapshot AppIDs stay inside the signed
 * 32-bit Steam AppID range.
 */
const MAX_BADGE_APP_ID = 2_147_483_647;
/**
 * Only zero-budget discovery may use this parsing scale before the server
 * confirms currency. Nonzero budgets always require the confirmed scale.
 */
export const ASSUMED_BUDGET_MINOR_DIGITS = 2;

export type BadgePlanningMode = "target" | "budget" | "collector";

export type BadgePlanningScope = "inventory" | "selected" | "catalog";

export type BadgeCollectorTarget = {
  app_id: string;
  target_level: number;
};

export type BadgeProtection = {
  market_hash_name: string;
  keep_quantity: number;
  never_sell: boolean;
};

export type BadgePlanningOptions = {
  mode: BadgePlanningMode;
  target_level: number | null;
  budget_minor: number;
  scope: BadgePlanningScope;
  selected_app_ids: string[];
  collector_targets: BadgeCollectorTarget[];
  compare_app_id: string | null;
  excluded_app_ids: string[];
  protections: BadgeProtection[];
};

export type BadgePlanningRequest = LevelUpOptimizationRequest & {
  options: BadgePlanningOptions;
  /** Complete validated session snapshot, sorted by ascending AppID. */
  normal_badge_levels: LevelUpNormalBadgeLevel[];
};

export type BadgeGameStatus =
  | "craftable"
  | "incomplete"
  | "maxed"
  | "reserved"
  | "excluded"
  | "unavailable";

export type BadgeGameCard = {
  market_hash_name: string;
  card_name: string;
  owned_quantity: number;
  keep_quantity: number;
  never_sell: boolean;
  available_quantity: number;
  buy_price_minor: number | null;
  buy_quantity: number | null;
  quote_timestamp: string | null;
};

export type BadgeGame = {
  app_id: string;
  game_name: string;
  badge_level: number;
  set_size: number | null;
  owned_unique: number;
  owned_cards: number;
  available_unique: number;
  craftable_count: number;
  missing_count: number | null;
  completion_cost_minor: number | null;
  status: BadgeGameStatus;
  reason: string;
  cards: BadgeGameCard[];
  /** Per-game collector goal; null outside collector mode. */
  target_badge_level: number | null;
};

export type BadgePlanStrategy =
  | "cheapest"
  | "fewest_purchases"
  | "preserve_cards";

export type BadgePlanStatus = "ready" | "partial" | "no_opportunity";

export type BadgePlanPurchase = {
  market_hash_name: string;
  card_name: string;
  quantity: number;
  unit_price_minor: number;
  total_minor: number;
  quote_timestamp: string;
};

export type BadgePlanStep = {
  app_id: string;
  game_name: string;
  badge_level_before: number;
  badge_level_after: number;
  craft_count: number;
  xp_gain: number;
  spend_minor: number;
  owned_cards_used: number;
  purchases: BadgePlanPurchase[];
};

export type BadgePlan = {
  strategy: BadgePlanStrategy;
  status: BadgePlanStatus;
  reason: string;
  target_level: number | null;
  target_reached: boolean;
  craft_count: number;
  xp_gain: number;
  projected_xp: number;
  projected_level: number;
  shortfall_xp: number;
  spend_minor: number;
  remaining_budget_minor: number;
  purchase_count: number;
  owned_cards_used: number;
  steps: BadgePlanStep[];
};

export type BadgePlanningMoney = {
  currency_code: string;
  minor_digits: number;
};

export type BadgePlanningResponseScope =
  | "inventory_normal_badges"
  | "selected_normal_badges"
  | "catalog_normal_badges";

/** One marketable card sold from the compared complete set. */
export type BadgeSale = {
  market_hash_name: string;
  card_name: string;
  quantity: number;
  buyer_total_minor: number;
  seller_receipt_minor: number;
  quote_timestamp: string;
};

/**
 * On-demand complete-set comparison. A ready opportunity prices selling one
 * complete owned unreserved set of `app_id` and re-planning replacements from
 * the hypothetical receipts only; an unavailable one carries no quotes,
 * proceeds or plans and names the blocking reason.
 */
export type BadgeOpportunity = {
  app_id: string;
  status: "ready" | "unavailable";
  reason: string;
  net_proceeds_minor: number | null;
  craft_xp: number;
  sales: BadgeSale[];
  replacement_plan: BadgePlan | null;
  baseline_plan: BadgePlan | null;
  additional_xp: number | null;
  valid_until: string | null;
};

export type BadgePlanningReadyResponse = {
  status: "ready";
  reason: string;
  generated_at: string;
  valid_until: string;
  currency_code: string | null;
  minor_digits: number | null;
  inventory_refreshed_at: string;
  badge_refreshed_at: string;
  player_xp: number;
  player_level: number;
  scope: BadgePlanningResponseScope;
  /** Explicit candidate count; equals `games.length`. */
  evaluated_game_count: number;
  games: BadgeGame[];
  plans: BadgePlan[];
  opportunity: BadgeOpportunity | null;
};

export type BadgePlanningUnavailableResponse = {
  status: "unavailable";
  reason: string;
  generated_at: string;
  valid_until: null;
  currency_code: string | null;
  minor_digits: number | null;
  inventory_refreshed_at: string;
  badge_refreshed_at: string;
  player_xp: number;
  player_level: number;
  scope: BadgePlanningResponseScope;
  evaluated_game_count: number;
  games: BadgeGame[];
  plans: [];
  opportunity: null;
};

export type BadgePlanningResponse =
  | BadgePlanningReadyResponse
  | BadgePlanningUnavailableResponse;

const POSITIVE_DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const BUDGET_INPUT_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;
const TARGET_LEVEL_INPUT_PATTERN = /^[0-9]{1,7}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const MAX_INPUT_TEXT_LENGTH = 32;
const MAX_MARKET_HASH_NAME_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[]
): boolean {
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function isSafeInteger(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isPositiveDecimalId(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    POSITIVE_DECIMAL_ID_PATTERN.test(value)
  );
}

function isNonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isGameName(value: unknown): value is string {
  return (
    isNonEmptyText(value, MAX_GAME_NAME_LENGTH) && value === value.trim()
  );
}

function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && CURRENCY_CODE_PATTERN.test(value);
}

function timestampMilliseconds(value: string): number {
  return Date.parse(value);
}

function isBadgeCollectorTarget(value: unknown): value is BadgeCollectorTarget {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["app_id", "target_level"]) &&
    isPositiveDecimalId(value.app_id, MAX_APP_ID_LENGTH) &&
    isSafeInteger(
      value.target_level,
      MIN_BADGE_COLLECTOR_TARGET_LEVEL,
      MAX_BADGE_CRAFT_LEVEL
    )
  );
}

export function isBadgePlanningOptions(
  value: unknown,
  cards: readonly LevelUpCardOwnership[]
): value is BadgePlanningOptions {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "mode",
      "target_level",
      "budget_minor",
      "scope",
      "selected_app_ids",
      "collector_targets",
      "compare_app_id",
      "excluded_app_ids",
      "protections"
    ])
  ) {
    return false;
  }
  if (
    value.mode !== "target" &&
    value.mode !== "budget" &&
    value.mode !== "collector"
  ) {
    return false;
  }
  if (value.mode === "target") {
    if (!isSafeInteger(value.target_level, 0, MAX_BADGE_PLANNING_TARGET_LEVEL)) {
      return false;
    }
  } else if (value.target_level !== null) {
    return false;
  }
  if (!isSafeInteger(value.budget_minor, 0, MAX_BADGE_PLANNING_BUDGET_MINOR)) {
    return false;
  }
  if (
    value.scope !== "inventory" &&
    value.scope !== "selected" &&
    value.scope !== "catalog"
  ) {
    return false;
  }
  if (
    !Array.isArray(value.selected_app_ids) ||
    value.selected_app_ids.length > MAX_BADGE_PLANNING_SCOPE_IDS
  ) {
    return false;
  }
  if (
    value.scope === "selected"
      ? value.selected_app_ids.length === 0
      : value.selected_app_ids.length !== 0
  ) {
    return false;
  }
  const selectedSeen = new Set<string>();
  for (const appId of value.selected_app_ids) {
    if (
      !isPositiveDecimalId(appId, MAX_APP_ID_LENGTH) ||
      selectedSeen.has(appId)
    ) {
      return false;
    }
    selectedSeen.add(appId);
  }
  if (
    !Array.isArray(value.collector_targets) ||
    value.collector_targets.length > MAX_BADGE_PLANNING_SCOPE_IDS
  ) {
    return false;
  }
  if (
    value.mode === "collector"
      ? value.collector_targets.length === 0
      : value.collector_targets.length !== 0
  ) {
    return false;
  }
  const targetSeen = new Set<string>();
  for (const target of value.collector_targets) {
    if (!isBadgeCollectorTarget(target) || targetSeen.has(target.app_id)) {
      return false;
    }
    targetSeen.add(target.app_id);
  }
  if (
    value.compare_app_id !== null &&
    !isPositiveDecimalId(value.compare_app_id, MAX_APP_ID_LENGTH)
  ) {
    return false;
  }
  if (
    !Array.isArray(value.excluded_app_ids) ||
    value.excluded_app_ids.length > MAX_BADGE_PLANNING_EXCLUDED_IDS
  ) {
    return false;
  }
  const excludedSeen = new Set<string>();
  for (const appId of value.excluded_app_ids) {
    if (!isPositiveDecimalId(appId, MAX_APP_ID_LENGTH) || excludedSeen.has(appId)) {
      return false;
    }
    excludedSeen.add(appId);
  }
  if (!Array.isArray(value.protections) || value.protections.length > cards.length) {
    return false;
  }
  const ownedQuantities = new Map(
    cards.map((card) => [card.market_hash_name, card.owned_quantity])
  );
  const protectionSeen = new Set<string>();
  for (const protection of value.protections) {
    if (
      !isRecord(protection) ||
      !hasExactKeys(protection, ["market_hash_name", "keep_quantity", "never_sell"]) ||
      !isNormalCardMarketHashName(protection.market_hash_name) ||
      !ownedQuantities.has(protection.market_hash_name) ||
      protectionSeen.has(protection.market_hash_name) ||
      !isSafeInteger(
        protection.keep_quantity,
        0,
        ownedQuantities.get(protection.market_hash_name) ?? 0
      ) ||
      typeof protection.never_sell !== "boolean"
    ) {
      return false;
    }
    protectionSeen.add(protection.market_hash_name);
  }
  return true;
}

type BadgeSnapshotData = {
  levels: Map<string, number>;
  rows: LevelUpNormalBadgeLevel[];
};

/**
 * Validates the complete session snapshot rows and returns the level map
 * keyed by canonical AppID text plus rebuilt rows ready for canonical
 * (ascending numeric AppID) ordering.
 */
function badgeSnapshotData(value: unknown): BadgeSnapshotData | null {
  if (!Array.isArray(value) || value.length > MAX_NORMAL_BADGE_LEVEL_ROWS) {
    return null;
  }
  const levels = new Map<string, number>();
  const rows: LevelUpNormalBadgeLevel[] = [];
  for (const row of value) {
    if (
      !isRecord(row) ||
      !hasExactKeys(row, ["app_id", "level"]) ||
      !isSafeInteger(row.app_id, 1, MAX_BADGE_APP_ID) ||
      !isSafeInteger(row.level, 0, MAX_BADGE_CRAFT_LEVEL) ||
      levels.has(String(row.app_id))
    ) {
      return null;
    }
    levels.set(String(row.app_id), row.level);
    rows.push({ app_id: row.app_id, level: row.level });
  }
  return { levels, rows };
}

/**
 * Attaches validated planning options and the complete normal badge session
 * snapshot to an ownership request. `base` must come from
 * `buildLevelUpOptimizationRequest`, which already validated the game and
 * card rows; only the small user-controlled options and snapshot are
 * validated here. Every inventory game's badge level must agree with the
 * snapshot (a missing snapshot entry denotes an uncrafted badge, level 0).
 * The returned snapshot is a sorted, unique copy.
 */
export function buildBadgePlanningRequest(
  base: LevelUpOptimizationRequest,
  options: BadgePlanningOptions,
  normalBadgeLevels: readonly LevelUpNormalBadgeLevel[]
): BadgePlanningRequest {
  if (!isBadgePlanningOptions(options, base.cards)) {
    throw new Error("The badge planning options are invalid.");
  }
  const snapshot = badgeSnapshotData(normalBadgeLevels);
  if (snapshot === null) {
    throw new Error("The normal badge snapshot is invalid.");
  }
  for (const game of base.games) {
    if (game.badge_level !== (snapshot.levels.get(game.app_id) ?? 0)) {
      throw new Error(
        "The inventory badge levels disagree with the session snapshot."
      );
    }
  }
  const normal_badge_levels = snapshot.rows.sort(
    (left, right) => left.app_id - right.app_id
  );
  return { ...base, options, normal_badge_levels };
}

export function isBadgePlanningRequest(
  value: unknown
): value is BadgePlanningRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "inventory_refreshed_at",
      "badge_refreshed_at",
      "player_xp",
      "player_level",
      "games",
      "cards",
      "options",
      "normal_badge_levels"
    ])
  ) {
    return false;
  }
  const { options, normal_badge_levels, ...base } = value;
  if (!isLevelUpOptimizationRequest(base)) {
    return false;
  }
  if (!isBadgePlanningOptions(options, base.cards)) {
    return false;
  }
  const snapshot = badgeSnapshotData(normal_badge_levels);
  if (snapshot === null) {
    return false;
  }
  let previousAppId = -1;
  for (const row of snapshot.rows) {
    if (row.app_id <= previousAppId) {
      return false;
    }
    previousAppId = row.app_id;
  }
  return base.games.every(
    (game) => game.badge_level === (snapshot.levels.get(game.app_id) ?? 0)
  );
}

function validateBadgeGameCard(
  value: unknown,
  generatedAtMs: number,
  hasMoney: boolean
): value is BadgeGameCard {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "market_hash_name",
      "card_name",
      "owned_quantity",
      "keep_quantity",
      "never_sell",
      "available_quantity",
      "buy_price_minor",
      "buy_quantity",
      "quote_timestamp"
    ]) ||
    !isNormalCardMarketHashName(value.market_hash_name) ||
    !isNonEmptyText(value.card_name, MAX_MARKET_HASH_NAME_LENGTH) ||
    !isSafeInteger(value.owned_quantity, 0, MAX_CARD_QUANTITY) ||
    !isSafeInteger(value.keep_quantity, 0, value.owned_quantity) ||
    typeof value.never_sell !== "boolean" ||
    value.available_quantity !== value.owned_quantity - value.keep_quantity
  ) {
    return false;
  }
  if (value.buy_price_minor === null) {
    return value.buy_quantity === null && value.quote_timestamp === null;
  }
  return (
    hasMoney &&
    isSafeInteger(value.buy_price_minor, 1, MAX_MINOR_AMOUNT) &&
    isSafeInteger(value.buy_quantity, 1, 1_000_000_000) &&
    isLevelUpIsoTimestamp(value.quote_timestamp) &&
    timestampMilliseconds(value.quote_timestamp) <= generatedAtMs
  );
}

function validateBadgeGame(
  value: unknown,
  generatedAtMs: number,
  hasMoney: boolean
): value is BadgeGame {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "app_id",
      "game_name",
      "badge_level",
      "set_size",
      "owned_unique",
      "owned_cards",
      "available_unique",
      "craftable_count",
      "missing_count",
      "completion_cost_minor",
      "status",
      "reason",
      "cards",
      "target_badge_level"
    ]) ||
    !isPositiveDecimalId(value.app_id, MAX_APP_ID_LENGTH) ||
    !isGameName(value.game_name) ||
    !isSafeInteger(value.badge_level, 0, MAX_BADGE_CRAFT_LEVEL) ||
    (value.set_size !== null &&
      !isSafeInteger(value.set_size, MIN_SET_SIZE, MAX_SET_SIZE)) ||
    (value.target_badge_level !== null &&
      !isSafeInteger(
        value.target_badge_level,
        MIN_BADGE_COLLECTOR_TARGET_LEVEL,
        MAX_BADGE_CRAFT_LEVEL
      )) ||
    !isSafeInteger(value.owned_unique, 0, MAX_LEVEL_UP_CARD_ROWS) ||
    !isSafeInteger(value.owned_cards, 0, MAX_CARD_QUANTITY * MAX_LEVEL_UP_CARD_ROWS) ||
    value.owned_cards < value.owned_unique ||
    !isSafeInteger(value.available_unique, 0, value.owned_unique) ||
    !isSafeInteger(
      value.craftable_count,
      0,
      MAX_BADGE_CRAFT_LEVEL - value.badge_level
    ) ||
    (value.missing_count !== null &&
      !isSafeInteger(value.missing_count, 0, MAX_CARD_QUANTITY)) ||
    (value.completion_cost_minor !== null &&
      ((!hasMoney && value.completion_cost_minor !== 0) ||
        !isSafeInteger(value.completion_cost_minor, 0, MAX_MINOR_AMOUNT))) ||
    !isNonEmptyText(value.reason, MAX_GAME_NAME_LENGTH) ||
    !Array.isArray(value.cards) ||
    value.cards.length > MAX_LEVEL_UP_CARD_ROWS
  ) {
    return false;
  }
  switch (value.status) {
    case "craftable":
    case "incomplete":
    case "maxed":
    case "reserved":
    case "excluded":
    case "unavailable":
      break;
    default:
      return false;
  }
  if (value.status === "maxed" && value.badge_level !== MAX_BADGE_CRAFT_LEVEL) {
    return false;
  }
  const cardHashes = new Set<string>();
  for (const card of value.cards) {
    if (
      !validateBadgeGameCard(card, generatedAtMs, hasMoney) ||
      cardHashes.has(card.market_hash_name) ||
      normalCardAppId(card.market_hash_name) !== value.app_id
    ) {
      return false;
    }
    cardHashes.add(card.market_hash_name);
  }
  return value.owned_unique === value.cards.filter((card) => card.owned_quantity > 0).length &&
    value.owned_cards === value.cards.reduce((sum, card) => sum + card.owned_quantity, 0) &&
    value.available_unique === value.cards.filter((card) => card.available_quantity > 0).length &&
    (value.craftable_count === 0 || (value.set_size === value.cards.length &&
      value.craftable_count === Math.min(MAX_BADGE_CRAFT_LEVEL - value.badge_level,
        ...value.cards.map((card) => card.available_quantity))));
}

function validateBadgePlanPurchase(
  value: unknown,
  generatedAtMs: number
): value is BadgePlanPurchase {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "market_hash_name",
      "card_name",
      "quantity",
      "unit_price_minor",
      "total_minor",
      "quote_timestamp"
    ]) ||
    !isNormalCardMarketHashName(value.market_hash_name) ||
    !isNonEmptyText(value.card_name, MAX_MARKET_HASH_NAME_LENGTH) ||
    !isSafeInteger(value.quantity, 1, MAX_CARD_QUANTITY) ||
    !isSafeInteger(value.unit_price_minor, 1, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(value.total_minor, 1, MAX_MINOR_AMOUNT) ||
    value.total_minor !== value.quantity * value.unit_price_minor ||
    !isLevelUpIsoTimestamp(value.quote_timestamp) ||
    timestampMilliseconds(value.quote_timestamp) > generatedAtMs
  ) {
    return false;
  }
  return true;
}

type ResponseGameIndex = Map<string, BadgeGame>;

/** Every craft uses available owned copies before purchasing replacements. */
function validateBadgePlanStep(
  value: unknown,
  generatedAtMs: number,
  gameIndex: ResponseGameIndex
): value is BadgePlanStep {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "app_id",
      "game_name",
      "badge_level_before",
      "badge_level_after",
      "craft_count",
      "xp_gain",
      "spend_minor",
      "owned_cards_used",
      "purchases"
    ]) ||
    !isPositiveDecimalId(value.app_id, MAX_APP_ID_LENGTH) ||
    !isGameName(value.game_name)
  ) {
    return false;
  }
  const game = gameIndex.get(value.app_id);
  if (game === undefined || value.game_name !== game.game_name) {
    return false;
  }
  if (
    !isSafeInteger(value.badge_level_before, 0, MAX_BADGE_CRAFT_LEVEL) ||
    !isSafeInteger(
      value.craft_count,
      1,
      MAX_BADGE_CRAFT_LEVEL - value.badge_level_before
    ) ||
    value.badge_level_after !==
    value.badge_level_before + value.craft_count ||
    value.xp_gain !== value.craft_count * BADGE_CRAFT_XP ||
    !isSafeInteger(value.owned_cards_used, 0, MAX_CARD_QUANTITY) ||
    !Array.isArray(value.purchases) ||
    value.purchases.length > game.cards.length
  ) {
    return false;
  }
  if (game.set_size === null || game.cards.length !== game.set_size ||
    value.badge_level_before !== game.badge_level ||
    game.status === "excluded" || game.status === "unavailable") return false;
  const purchases = new Map<string, BadgePlanPurchase>();
  let spendMinor = 0;
  let purchaseQuantity = 0;
  for (const purchase of value.purchases) {
    if (!validateBadgePlanPurchase(purchase, generatedAtMs) || purchases.has(purchase.market_hash_name)) return false;
    purchases.set(purchase.market_hash_name, purchase);
    spendMinor += purchase.total_minor;
    purchaseQuantity += purchase.quantity;
  }
  let ownedUsed = 0;
  for (const card of game.cards) {
    const usable = Math.min(card.available_quantity, value.craft_count);
    const purchase = purchases.get(card.market_hash_name);
    const ownedForCard = purchase === undefined
      ? value.craft_count
      : value.craft_count - purchase.quantity;
    if (purchase === undefined) {
      if (usable < value.craft_count) {
        return false;
      }
    } else if (
      purchase.quantity > value.craft_count ||
      ownedForCard > usable ||
      purchase.quantity > (card.buy_quantity ?? 0) ||
      card.buy_price_minor === null ||
      purchase.unit_price_minor !== card.buy_price_minor ||
      purchase.quote_timestamp !== card.quote_timestamp
    ) {
      return false;
    }
    if (ownedForCard !== usable) {
      return false;
    }
    ownedUsed += ownedForCard;
    purchases.delete(card.market_hash_name);
  }
  if (purchases.size !== 0 || ownedUsed !== value.owned_cards_used ||
    !Number.isSafeInteger(spendMinor)) return false;
  if (value.spend_minor !== spendMinor) {
    return false;
  }
  if (
    purchaseQuantity + ownedUsed !==
    value.craft_count * game.set_size
  ) {
    return false;
  }
  return true;
}


function validateBadgePlan(
  value: unknown,
  generatedAtMs: number,
  playerXp: number,
  gameIndex: ResponseGameIndex
): value is BadgePlan {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "strategy",
      "status",
      "reason",
      "target_level",
      "target_reached",
      "craft_count",
      "xp_gain",
      "projected_xp",
      "projected_level",
      "shortfall_xp",
      "spend_minor",
      "remaining_budget_minor",
      "purchase_count",
      "owned_cards_used",
      "steps"
    ]) ||
    (value.strategy !== "cheapest" &&
      value.strategy !== "fewest_purchases" &&
      value.strategy !== "preserve_cards") ||
    (value.status !== "ready" &&
      value.status !== "partial" &&
      value.status !== "no_opportunity") ||
    !isNonEmptyText(value.reason, MAX_GAME_NAME_LENGTH) ||
    (value.target_level !== null &&
      !isSafeInteger(
        value.target_level,
        0,
        MAX_BADGE_PLANNING_TARGET_LEVEL
      )) ||
    typeof value.target_reached !== "boolean" ||
    !isSafeInteger(value.shortfall_xp, 0, MAX_XP) ||
    !isSafeInteger(value.spend_minor, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(value.remaining_budget_minor, 0, MAX_MINOR_AMOUNT) ||
    !Array.isArray(value.steps) ||
    value.steps.length > gameIndex.size
  ) {
    return false;
  }
  let craftCount = 0;
  let xpGain = 0;
  let spendMinor = 0;
  let purchaseCount = 0;
  let ownedCardsUsed = 0;
  const stepApps = new Set<string>();
  for (const step of value.steps) {
    if (
      !validateBadgePlanStep(
        step,
        generatedAtMs,
        gameIndex
      ) || stepApps.has(step.app_id)
    ) {
      return false;
    }
    stepApps.add(step.app_id);
    craftCount += step.craft_count;
    xpGain += step.xp_gain;
    spendMinor += step.spend_minor;
    ownedCardsUsed += step.owned_cards_used;
    for (const purchase of step.purchases) {
      purchaseCount += purchase.quantity;
    }
    if (
      !Number.isSafeInteger(craftCount) ||
      !Number.isSafeInteger(xpGain) ||
      !Number.isSafeInteger(spendMinor) ||
      !Number.isSafeInteger(purchaseCount) ||
      !Number.isSafeInteger(ownedCardsUsed)
    ) {
      return false;
    }
  }
  if (
    value.craft_count !== craftCount ||
    value.xp_gain !== xpGain ||
    value.spend_minor !== spendMinor ||
    value.purchase_count !== purchaseCount ||
    value.owned_cards_used !== ownedCardsUsed
  ) {
    return false;
  }
  if (
    !isSafeInteger(value.projected_xp, 0, MAX_XP) ||
    value.projected_xp !== playerXp + value.xp_gain ||
    !isSafeInteger(value.projected_level, 0, MAX_LEVEL - 1) ||
    value.projected_level !== levelForXp(value.projected_xp)
  ) {
    return false;
  }
  if (value.target_level !== null) {
    const targetMinimumXp = minimumXpForLevel(value.target_level);
    const expectedShortfall = Math.max(
      0,
      targetMinimumXp - value.projected_xp
    );
    if (value.shortfall_xp !== expectedShortfall) {
      return false;
    }
    if (value.target_reached !== (value.projected_level >= value.target_level)) {
      return false;
    }
  }
  return true;
}

function validateBadgeSale(
  value: unknown,
  generatedAtMs: number
): value is BadgeSale {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "market_hash_name",
      "card_name",
      "quantity",
      "buyer_total_minor",
      "seller_receipt_minor",
      "quote_timestamp"
    ]) &&
    isNormalCardMarketHashName(value.market_hash_name) &&
    isNonEmptyText(value.card_name, MAX_MARKET_HASH_NAME_LENGTH) &&
    isSafeInteger(value.quantity, 1, 1) &&
    isSafeInteger(value.buyer_total_minor, 1, MAX_MINOR_AMOUNT) &&
    isSafeInteger(value.seller_receipt_minor, 1, MAX_MINOR_AMOUNT) &&
    value.seller_receipt_minor <= value.buyer_total_minor &&
    isLevelUpIsoTimestamp(value.quote_timestamp) &&
    timestampMilliseconds(value.quote_timestamp) <= generatedAtMs
  );
}

function validateBadgeOpportunity(
  value: unknown,
  generatedAtMs: number,
  responseValidUntilMs: number,
  hasMoney: boolean,
  playerXp: number,
  gameIndex: ResponseGameIndex
): value is BadgeOpportunity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "app_id",
      "status",
      "reason",
      "net_proceeds_minor",
      "craft_xp",
      "sales",
      "replacement_plan",
      "baseline_plan",
      "additional_xp",
      "valid_until"
    ]) ||
    !isPositiveDecimalId(value.app_id, MAX_APP_ID_LENGTH) ||
    (value.status !== "ready" && value.status !== "unavailable") ||
    !isNonEmptyText(value.reason, MAX_GAME_NAME_LENGTH) ||
    value.craft_xp !== BADGE_CRAFT_XP ||
    !Array.isArray(value.sales)
  ) {
    return false;
  }
  const source = gameIndex.get(value.app_id);
  if (value.status === "unavailable") {
    // An unavailable comparison carries no quotes, proceeds or plans.
    return (
      value.net_proceeds_minor === null &&
      value.sales.length === 0 &&
      value.replacement_plan === null &&
      value.baseline_plan === null &&
      value.additional_xp === null &&
      value.valid_until === null
    );
  }
  const replacementPlan = value.replacement_plan;
  const baselinePlan = value.baseline_plan;
  const additionalXp = value.additional_xp;
  const validUntilText = value.valid_until;
  if (
    source === undefined ||
    !hasMoney ||
    source.craftable_count < 1 ||
    source.badge_level >= MAX_BADGE_CRAFT_LEVEL ||
    source.set_size === null ||
    source.cards.length !== source.set_size ||
    !isSafeInteger(value.net_proceeds_minor, 1, MAX_MINOR_AMOUNT) ||
    value.sales.length !== source.cards.length ||
    replacementPlan === null ||
    baselinePlan === null ||
    !Number.isSafeInteger(additionalXp) ||
    !isLevelUpIsoTimestamp(validUntilText)
  ) {
    return false;
  }
  const validUntilMs = timestampMilliseconds(validUntilText);
  if (validUntilMs < generatedAtMs || validUntilMs > responseValidUntilMs) {
    return false;
  }
  const soldHashes = new Set<string>();
  let proceeds = 0;
  for (const sale of value.sales) {
    if (
      !validateBadgeSale(sale, generatedAtMs) ||
      soldHashes.has(sale.market_hash_name)
    ) {
      return false;
    }
    const card = source.cards.find(
      (row) => row.market_hash_name === sale.market_hash_name
    );
    if (
      card === undefined ||
      sale.quantity !== 1 ||
      card.never_sell ||
      card.owned_quantity < 1 ||
      card.available_quantity < 1
    ) {
      return false;
    }
    soldHashes.add(sale.market_hash_name);
    proceeds += sale.seller_receipt_minor;
  }
  if (value.net_proceeds_minor !== proceeds || !Number.isSafeInteger(proceeds)) {
    return false;
  }
  // Only source-game holdings change; that game is excluded from replacements.
  // Every other game's owned quantities must still match the original snapshot.
  if (
    !validateBadgePlan(
      replacementPlan,
      generatedAtMs,
      playerXp,
      gameIndex
    ) ||
    !validateBadgePlan(
      baselinePlan,
      generatedAtMs,
      playerXp,
      gameIndex
    )
  ) {
    return false;
  }
  // The replacement must neither craft nor purchase the source game.
  if (
    replacementPlan.strategy !== "cheapest" ||
    baselinePlan.strategy !== "cheapest" ||
    replacementPlan.target_level !== null ||
    baselinePlan.target_level !== null ||
    replacementPlan.shortfall_xp !== 0 ||
    baselinePlan.shortfall_xp !== 0 ||
    baselinePlan.spend_minor !== 0 ||
    baselinePlan.remaining_budget_minor !== 0 ||
    replacementPlan.spend_minor + replacementPlan.remaining_budget_minor !== proceeds ||
    replacementPlan.steps.some((step) => step.app_id === value.app_id) ||
    replacementPlan.steps.some((step) =>
      step.purchases.some(
        (purchase) => normalCardAppId(purchase.market_hash_name) === value.app_id
      )
    )
  ) {
    return false;
  }
  return additionalXp === replacementPlan.xp_gain - baselinePlan.xp_gain;
}

export function isBadgePlanningResponse(
  value: unknown
): value is BadgePlanningResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "reason",
      "generated_at",
      "valid_until",
      "currency_code",
      "minor_digits",
      "inventory_refreshed_at",
      "badge_refreshed_at",
      "player_xp",
      "player_level",
      "scope",
      "evaluated_game_count",
      "games",
      "plans",
      "opportunity"
    ])
  ) {
    return false;
  }
  if (value.status !== "ready" && value.status !== "unavailable") {
    return false;
  }
  if (!isNonEmptyText(value.reason, MAX_GAME_NAME_LENGTH)) {
    return false;
  }
  if (!isLevelUpIsoTimestamp(value.generated_at)) {
    return false;
  }
  const generatedAtMs = timestampMilliseconds(value.generated_at);
  let hasMoney: boolean;
  if (value.currency_code === null) {
    if (value.minor_digits !== null) {
      return false;
    }
    hasMoney = false;
  } else {
    if (
      !isCurrencyCode(value.currency_code) ||
      !isSafeInteger(value.minor_digits, 0, 3)
    ) {
      return false;
    }
    hasMoney = true;
  }
  if (
    !isLevelUpIsoTimestamp(value.inventory_refreshed_at) ||
    !isLevelUpIsoTimestamp(value.badge_refreshed_at) ||
    !isSafeInteger(value.player_xp, 0, MAX_XP) ||
    !isSafeInteger(value.player_level, 0, MAX_LEVEL - 1) ||
    levelForXp(value.player_xp) !== value.player_level
  ) {
    return false;
  }
  if (
    value.scope !== "inventory_normal_badges" &&
    value.scope !== "selected_normal_badges" &&
    value.scope !== "catalog_normal_badges"
  ) {
    return false;
  }
  const catalogScope = value.scope === "catalog_normal_badges";
  const selectedScope = value.scope === "selected_normal_badges";
  const maxGameRows = catalogScope
    ? MAX_BADGE_PLANNING_CATALOG_GAME_ROWS
    : selectedScope
      ? MAX_NORMAL_GAME_ROWS + MAX_BADGE_PLANNING_SCOPE_IDS
      : MAX_NORMAL_GAME_ROWS;
  const maxCardRows = catalogScope
    ? MAX_BADGE_PLANNING_CATALOG_CARD_ROWS
    : MAX_LEVEL_UP_CARD_ROWS + MAX_BADGE_PLANNING_SCOPE_IDS * MAX_SET_SIZE;
  if (
    !isSafeInteger(value.evaluated_game_count, 0, maxGameRows) ||
    !Array.isArray(value.games) ||
    value.games.length > maxGameRows ||
    value.evaluated_game_count !== value.games.length ||
    !Array.isArray(value.plans) ||
    value.plans.length > 3
  ) {
    return false;
  }
  const gameIndex: ResponseGameIndex = new Map();
  let cardRows = 0;
  for (const game of value.games) {
    if (!validateBadgeGame(game, generatedAtMs, hasMoney) || gameIndex.has(game.app_id)) {
      return false;
    }
    gameIndex.set(game.app_id, game);
    cardRows += game.cards.length;
    if (cardRows > maxCardRows) {
      return false;
    }
  }
  if (value.status === "unavailable") {
    return (
      value.plans.length === 0 &&
      value.valid_until === null &&
      value.opportunity === null
    );
  }
  if (
    !isLevelUpIsoTimestamp(value.valid_until) ||
    timestampMilliseconds(value.valid_until) < generatedAtMs ||
    value.plans.length !== 3
  ) {
    return false;
  }
  const opportunity = value.opportunity;
  if (
    opportunity !== null &&
    !validateBadgeOpportunity(
      opportunity,
      generatedAtMs,
      timestampMilliseconds(value.valid_until),
      hasMoney,
      value.player_xp,
      gameIndex
    )
  ) {
    return false;
  }
  const strategies = new Set<string>();
  for (const plan of value.plans) {
    if (
      !validateBadgePlan(plan, generatedAtMs, value.player_xp, gameIndex) ||
      strategies.has(plan.strategy)
    ) {
      return false;
    }
    strategies.add(plan.strategy);
  }
  return strategies.size === 3;
}

export function assertBadgePlanningResponse(
  value: unknown
): asserts value is BadgePlanningResponse {
  if (!isBadgePlanningResponse(value)) {
    throw new Error("The badge planning service returned an invalid response.");
  }
}

export function responseMatchesRequest(
  response: BadgePlanningResponse,
  request: BadgePlanningRequest
): boolean {
  if (
    timestampMilliseconds(response.inventory_refreshed_at) !==
    timestampMilliseconds(request.inventory_refreshed_at) ||
    timestampMilliseconds(response.badge_refreshed_at) !==
    timestampMilliseconds(request.badge_refreshed_at) ||
    response.player_xp !== request.player_xp ||
    response.player_level !== request.player_level
  ) {
    return false;
  }
  const expectedScope = request.options.scope === "inventory"
    ? "inventory_normal_badges"
    : request.options.scope === "selected"
      ? "selected_normal_badges"
      : "catalog_normal_badges";
  if (
    response.scope !== expectedScope ||
    response.evaluated_game_count !== response.games.length
  ) {
    return false;
  }
  const snapshotLevels = new Map(
    request.normal_badge_levels.map(
      (row) => [String(row.app_id), row.level] as const
    )
  );
  const collectorTargets = request.options.mode === "collector"
    ? new Map(
      request.options.collector_targets.map(
        (target) => [target.app_id, target.target_level] as const
      )
    )
    : new Map<string, number>();
  const selectedIds = new Set(request.options.selected_app_ids);
  const requestGames = new Map(
    request.games.map((game) => [game.app_id, game] as const)
  );
  const ownership = new Map(
    request.cards.map((card) => [card.market_hash_name, card] as const)
  );
  const protections = new Map(
    request.options.protections.map((row) => [row.market_hash_name, row] as const)
  );
  const exclusions = new Set(request.options.excluded_app_ids);
  const catalogScope = request.options.scope === "catalog";
  const matchedRequestGames = new Set<string>();
  for (const game of response.games) {
    // Every returned row must reflect the complete session snapshot and the
    // request's collector goals exactly.
    if (
      game.badge_level !== (snapshotLevels.get(game.app_id) ?? 0) ||
      game.target_badge_level !== (collectorTargets.get(game.app_id) ?? null)
    ) {
      return false;
    }
    const requestGame = requestGames.get(game.app_id);
    if (requestGame !== undefined) matchedRequestGames.add(game.app_id);
    if (requestGame !== undefined && !catalogScope) {
      // Inventory and selected rows mirror the request's inventory metadata;
      // catalog rows are authoritative for names and set sizes.
      if (
        game.game_name !== requestGame.game_name ||
        (requestGame.card_set_size !== null &&
          game.set_size !== requestGame.card_set_size)
      ) {
        return false;
      }
    } else if (!catalogScope && !selectedIds.has(game.app_id)) {
      // Inventory scope returns exactly the inventory rows; selected scope
      // may add discovered zero-owned rows only for selected candidates.
      return false;
    }
    for (const card of game.cards) {
      const owned = ownership.get(card.market_hash_name)?.owned_quantity ?? 0;
      const protection = protections.get(card.market_hash_name);
      if (
        card.owned_quantity !== owned ||
        card.keep_quantity !== (protection?.keep_quantity ?? 0) ||
        card.never_sell !== (protection?.never_sell ?? false)
      ) {
        return false;
      }
      ownership.delete(card.market_hash_name);
    }
  }
  // Discovery must retain inventory rows, even when their composition is unknown.
  if (matchedRequestGames.size !== request.games.length) {
    return false;
  }
  if (ownership.size !== 0) {
    return false;
  }
  const expectedTargetLevel =
    request.options.mode === "target" ? request.options.target_level : null;
  const requiredCrafts = expectedTargetLevel === null ? Infinity :
    Math.max(0, Math.ceil((minimumXpForLevel(expectedTargetLevel) - request.player_xp) / BADGE_CRAFT_XP));
  for (const plan of response.plans) {
    if (
      plan.target_level !== expectedTargetLevel ||
      plan.craft_count > requiredCrafts ||
      plan.spend_minor > request.options.budget_minor ||
      plan.remaining_budget_minor !==
      request.options.budget_minor - plan.spend_minor ||
      plan.steps.some((step) => exclusions.has(step.app_id)) ||
      (request.options.scope === "selected" &&
        plan.steps.some((step) => !selectedIds.has(step.app_id)))
    ) {
      return false;
    }
    if (request.options.mode === "budget" && plan.shortfall_xp !== 0) {
      return false;
    }
    if (request.options.mode === "collector") {
      // Collector plans may only craft targeted games.
      if (plan.steps.some((step) => !collectorTargets.has(step.app_id))) {
        return false;
      }
      let shortfallXp = 0;
      let allTargetsReached = true;
      for (const target of request.options.collector_targets) {
        const plannedCrafts =
          plan.steps.find((step) => step.app_id === target.app_id)?.craft_count ?? 0;
        const plannedLevel = (snapshotLevels.get(target.app_id) ?? 0) + plannedCrafts;
        const missingCrafts = Math.max(0, target.target_level - plannedLevel);
        shortfallXp += missingCrafts * BADGE_CRAFT_XP;
        allTargetsReached = allTargetsReached && missingCrafts === 0;
      }
      if (
        plan.shortfall_xp !== shortfallXp ||
        plan.target_reached !== allTargetsReached
      ) {
        return false;
      }
    }
  }
  if (request.options.compare_app_id === null) {
    return response.opportunity === null;
  }
  if (response.status !== "ready") {
    // The whole response is explicitly unavailable; the on-demand compare
    // was never evaluated, so the absent opportunity is consistent.
    return true;
  }
  const opportunity = response.opportunity;
  if (
    opportunity === null ||
    opportunity.app_id !== request.options.compare_app_id
  ) {
    return false;
  }
  if (opportunity.status !== "ready") {
    return true;
  }
  if (
    exclusions.has(opportunity.app_id) ||
    opportunity.valid_until === null ||
    timestampMilliseconds(opportunity.valid_until) >
    timestampMilliseconds(response.valid_until)
  ) {
    return false;
  }
  const sellable = new Map(request.cards.map((card) => [card.market_hash_name, card.sellable_quantity]));
  if (opportunity.sales.some((sale) => (sellable.get(sale.market_hash_name) ?? 0) < sale.quantity)) {
    return false;
  }
  for (const plan of [opportunity.replacement_plan, opportunity.baseline_plan]) {
    if (plan !== null && plan.steps.some((step) =>
      exclusions.has(step.app_id) ||
      (request.options.scope === "selected" && !selectedIds.has(step.app_id))
    )) {
      return false;
    }
  }
  return true;
}

export type BadgePlanningExpectedMoney = {
  currency_code: string;
  minor_digits: number;
};

/**
 * Thrown when a response arrives under a different currency contract than
 * the one displayed when the request was sent (operator configuration can
 * change between requests). The caller must reset its local contract and
 * rediscover the currency before any nonzero budget is parsed again.
 */
export class BadgePlanningCurrencyChangeError extends Error { }

export async function requestBadgePlanning(
  steamId: string,
  request: BadgePlanningRequest,
  expectedMoney: BadgePlanningExpectedMoney | null,
  signal?: AbortSignal
): Promise<BadgePlanningResponse> {
  if (!isPositiveDecimalId(steamId, MAX_STEAM_ID_LENGTH)) {
    throw new Error("The SteamID is invalid.");
  }
  if (!isBadgePlanningRequest(request)) {
    throw new Error("The badge planning request is invalid.");
  }
  const response = await fetch(BADGE_PLANNING_URL, {
    method: "POST",
    credentials: "include",
    signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Expected-Steam-ID": steamId
    },
    body: JSON.stringify(request)
  });
  if (!response.ok) {
    throw new Error("The badge planning service returned an error.");
  }
  const payload: unknown = await response.json();
  assertBadgePlanningResponse(payload);
  if (
    expectedMoney !== null &&
    (payload.currency_code !== expectedMoney.currency_code ||
      payload.minor_digits !== expectedMoney.minor_digits)
  ) {
    throw new BadgePlanningCurrencyChangeError(
      "The market currency contract changed while planning."
    );
  }
  if (!responseMatchesRequest(payload, request)) {
    throw new Error("The badge planning service returned an invalid response.");
  }
  return payload;
}

export function isBadgePlanningResponseExpired(
  response: BadgePlanningReadyResponse,
  now: number | Date = Date.now()
): boolean {
  const nowMilliseconds = now instanceof Date ? now.getTime() : now;
  return (
    !Number.isFinite(nowMilliseconds) ||
    timestampMilliseconds(response.valid_until) <= nowMilliseconds
  );
}

export type BudgetParseResult =
  | { ok: true; minor: number }
  | { ok: false; message: string };

/**
 * Parses a wallet budget into exact minor units without floating point error.
 * The scale comes from the most recent currency metadata; before the first
 * response a documented fallback scale is used.
 */
export function parseBudgetMinorUnits(
  text: string,
  minorDigits: number
): BudgetParseResult {
  if (!isSafeInteger(minorDigits, 0, 3)) {
    return {
      ok: false,
      message: "The currency scale is not confirmed yet. Try again shortly."
    };
  }
  const trimmed = text.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_INPUT_TEXT_LENGTH ||
    !BUDGET_INPUT_PATTERN.test(trimmed)
  ) {
    return {
      ok: false,
      message:
        "Enter the budget as digits with an optional decimal point, for example 12.34."
    };
  }
  const separatorIndex = trimmed.indexOf(".");
  const wholePart =
    separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const fractionPart =
    separatorIndex === -1 ? "" : trimmed.slice(separatorIndex + 1);
  if (fractionPart.length > minorDigits) {
    return {
      ok: false,
      message:
        minorDigits === 0
          ? "This currency has no fractional units. Enter a whole amount."
          : `This currency uses at most ${minorDigits} digit(s) after the decimal point.`
    };
  }
  if (wholePart.length > 12) {
    return { ok: false, message: "The budget is too large." };
  }
  const minor =
    Number(wholePart) * 10 ** minorDigits +
    Number(fractionPart.padEnd(minorDigits, "0") || "0");
  if (!Number.isSafeInteger(minor)) {
    return { ok: false, message: "The budget is too large." };
  }
  if (minor > MAX_BADGE_PLANNING_BUDGET_MINOR) {
    return {
      ok: false,
      message: "The budget ceiling for a single plan is 10,000,000.00."
    };
  }
  return { ok: true, minor };
}

export type TargetLevelParseResult =
  | { ok: true; level: number }
  | { ok: false; message: string };

export function parseTargetLevelInput(text: string): TargetLevelParseResult {
  const trimmed = text.trim();
  if (!TARGET_LEVEL_INPUT_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message: "Enter the target level as a whole number."
    };
  }
  const level = Number(trimmed);
  if (level > MAX_BADGE_PLANNING_TARGET_LEVEL) {
    return {
      ok: false,
      message: `The target level cannot exceed ${MAX_BADGE_PLANNING_TARGET_LEVEL}.`
    };
  }
  return { ok: true, level };
}

/**
 * Removes reserved copies once per hash from consumable ownership. Never-sell
 * alone disables selling without blocking crafting. Excluded games disappear.
 * Only the independent legacy swap receives these reduced rows; the badge
 * planner receives original ownership and explicit protections.
 */
export function buildSaleSwapItems(
  items: readonly LevelUpInventoryItem[],
  protections: ReadonlyMap<string, BadgeProtection>,
  excludedAppIds: ReadonlySet<string>
): LevelUpInventoryItem[] {
  const result: LevelUpInventoryItem[] = [];
  const remaining = new Map([...protections].map(([hash, protection]) => [hash, protection.keep_quantity]));
  for (const item of items) {
    const hash = item.market_hash_name;
    if (!isNormalCardMarketHashName(hash)) {
      result.push(item);
      continue;
    }
    const appId = normalCardAppId(hash);
    if (appId !== null && excludedAppIds.has(appId)) continue;
    const keep = remaining.get(hash) ?? 0;
    const withheld = Math.min(keep, item.quantity);
    remaining.set(hash, keep - withheld);
    const quantity = item.quantity - withheld;
    if (quantity === 0) continue;
    const marketable = item.marketable && !(protections.get(hash)?.never_sell ?? false);
    result.push(quantity === item.quantity && marketable === item.marketable
      ? item : { ...item, quantity, marketable });
  }
  return result;
}
