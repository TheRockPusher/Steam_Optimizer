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
  MAX_NORMAL_GAME_ROWS,
  MAX_SET_SIZE,
  MAX_STEAM_ID_LENGTH,
  MAX_XP,
  MIN_SET_SIZE,
  minimumXpForLevel,
  normalCardAppId,
  type LevelUpCardOwnership,
  type LevelUpGame,
  type LevelUpInventoryItem,
  type LevelUpOptimizationRequest
} from "./levelUpOptimization";

export const BADGE_PLANNING_URL = `${(
  import.meta.env.VITE_API_BASE_URL ?? ""
).replace(/\/+$/, "")}/api/auth/badge-planning`;
export const MAX_BADGE_PLANNING_TARGET_LEVEL = 100_000;
export const MAX_BADGE_PLANNING_BUDGET_MINOR = 1_000_000_000;
export const BADGE_CRAFT_XP = 100;
export const MAX_BADGE_CRAFT_LEVEL = 5;
/**
 * Only zero-budget discovery may use this parsing scale before the server
 * confirms currency. Nonzero budgets always require the confirmed scale.
 */
export const ASSUMED_BUDGET_MINOR_DIGITS = 2;

export type BadgePlanningMode = "target" | "budget";

export type BadgeProtection = {
  market_hash_name: string;
  keep_quantity: number;
  never_sell: boolean;
};

export type BadgePlanningOptions = {
  mode: BadgePlanningMode;
  target_level: number | null;
  budget_minor: number;
  excluded_app_ids: string[];
  protections: BadgeProtection[];
};

export type BadgePlanningRequest = LevelUpOptimizationRequest & {
  options: BadgePlanningOptions;
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
  scope: "inventory_normal_badges";
  games: BadgeGame[];
  plans: BadgePlan[];
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
  scope: "inventory_normal_badges";
  games: BadgeGame[];
  plans: [];
};

export type BadgePlanningResponse =
  | BadgePlanningReadyResponse
  | BadgePlanningUnavailableResponse;

const POSITIVE_DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const BUDGET_INPUT_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;
const TARGET_LEVEL_INPUT_PATTERN = /^[0-9]{1,7}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const MAX_INPUT_TEXT_LENGTH = 32;

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



export function isBadgePlanningOptions(
  value: unknown,
  games: readonly LevelUpGame[],
  cards: readonly LevelUpCardOwnership[]
): value is BadgePlanningOptions {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "mode",
      "target_level",
      "budget_minor",
      "excluded_app_ids",
      "protections"
    ])
  ) {
    return false;
  }
  if (value.mode !== "target" && value.mode !== "budget") {
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
  if (!Array.isArray(value.excluded_app_ids) || value.excluded_app_ids.length > games.length) {
    return false;
  }
  const gameIds = new Set(games.map((game) => game.app_id));
  const excludedSeen = new Set<string>();
  for (const appId of value.excluded_app_ids) {
    if (
      !isPositiveDecimalId(appId, MAX_APP_ID_LENGTH) ||
      !gameIds.has(appId) ||
      excludedSeen.has(appId)
    ) {
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

/**
 * Attaches validated planning options to an ownership snapshot. `base` must
 * come from `buildLevelUpOptimizationRequest`, which already validated the
 * game and card rows; re-scanning them here would repeat that work on every
 * options change. Only the options (small, user-controlled) are validated,
 * with each membership map built once.
 */
export function buildBadgePlanningRequest(
  base: LevelUpOptimizationRequest,
  options: BadgePlanningOptions
): BadgePlanningRequest {
  if (!isBadgePlanningOptions(options, base.games, base.cards)) {
    throw new Error("The badge planning options are invalid.");
  }
  return { ...base, options };
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
      "options"
    ])
  ) {
    return false;
  }
  const { options, ...base } = value;
  if (!isLevelUpOptimizationRequest(base)) {
    return false;
  }
  return isBadgePlanningOptions(options, base.games, base.cards);
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

const MAX_MARKET_HASH_NAME_LENGTH = 512;

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
      "cards"
    ]) ||
    !isPositiveDecimalId(value.app_id, MAX_APP_ID_LENGTH) ||
    !isGameName(value.game_name) ||
    !isSafeInteger(value.badge_level, 0, MAX_BADGE_CRAFT_LEVEL) ||
    (value.set_size !== null &&
      !isSafeInteger(value.set_size, MIN_SET_SIZE, MAX_SET_SIZE)) ||
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
    value.purchases.length > MAX_LEVEL_UP_CARD_ROWS
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
    const owned = Math.min(card.available_quantity, value.craft_count);
    ownedUsed += owned;
    const needed = value.craft_count - owned;
    const purchase = purchases.get(card.market_hash_name);
    if (needed === 0) {
      if (purchase !== undefined) return false;
    } else if (purchase === undefined || purchase.quantity !== needed ||
      purchase.unit_price_minor !== card.buy_price_minor ||
      needed > (card.buy_quantity ?? 0) || purchase.quote_timestamp !== card.quote_timestamp) return false;
    purchases.delete(card.market_hash_name);
  }
  if (purchases.size !== 0 || ownedUsed !== value.owned_cards_used ||
    !Number.isSafeInteger(spendMinor)) return false;
  if (value.spend_minor !== spendMinor) {
    return false;
  }
  if (
    game.set_size !== null &&
    purchaseQuantity + value.owned_cards_used !==
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
    !isSafeInteger(value.spend_minor, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(value.remaining_budget_minor, 0, MAX_MINOR_AMOUNT) ||
    !Array.isArray(value.steps) ||
    value.steps.length > MAX_NORMAL_GAME_ROWS
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
    if (!validateBadgePlanStep(step, generatedAtMs, gameIndex) || stepApps.has(step.app_id)) {
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
  if (value.target_level === null) {
    if (value.shortfall_xp !== 0) {
      return false;
    }
  } else {
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
      "games",
      "plans"
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
    levelForXp(value.player_xp) !== value.player_level ||
    value.scope !== "inventory_normal_badges" ||
    !Array.isArray(value.games) ||
    value.games.length > MAX_NORMAL_GAME_ROWS ||
    !Array.isArray(value.plans) ||
    value.plans.length > 3
  ) {
    return false;
  }
  const gameIndex: ResponseGameIndex = new Map();
  for (const game of value.games) {
    if (!validateBadgeGame(game, generatedAtMs, hasMoney)) {
      return false;
    }
    if (gameIndex.has(game.app_id)) {
      return false;
    }
    gameIndex.set(game.app_id, game);
  }
  if (value.status === "unavailable") {
    return value.plans.length === 0 && value.valid_until === null;
  }
  if (
    !isLevelUpIsoTimestamp(value.valid_until) ||
    timestampMilliseconds(value.valid_until) < generatedAtMs ||
    value.plans.length !== 3
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
  if (response.games.length !== request.games.length) {
    return false;
  }
  const requestGames = new Map(
    request.games.map((game) => [game.app_id, game])
  );
  for (const game of response.games) {
    const requestGame = requestGames.get(game.app_id);
    if (
      requestGame === undefined ||
      game.game_name !== requestGame.game_name ||
      game.badge_level !== requestGame.badge_level ||
      (requestGame.card_set_size !== null &&
        game.set_size !== requestGame.card_set_size)
    ) {
      return false;
    }
  }
  const ownership = new Map(request.cards.map((card) => [card.market_hash_name, card]));
  const protections = new Map(request.options.protections.map((row) => [row.market_hash_name, row]));
  const exclusions = new Set(request.options.excluded_app_ids);
  for (const game of response.games) {
    for (const card of game.cards) {
      const owned = ownership.get(card.market_hash_name)?.owned_quantity ?? 0;
      const protection = protections.get(card.market_hash_name);
      if (card.owned_quantity !== owned || card.keep_quantity !== (protection?.keep_quantity ?? 0) ||
        card.never_sell !== (protection?.never_sell ?? false)) return false;
      ownership.delete(card.market_hash_name);
    }
  }
  if (ownership.size !== 0) return false;
  const expectedTargetLevel = request.options.mode === "target" ? request.options.target_level : null;
  const requiredCrafts = expectedTargetLevel === null ? Infinity :
    Math.max(0, Math.ceil((minimumXpForLevel(expectedTargetLevel) - request.player_xp) / BADGE_CRAFT_XP));
  return response.plans.every((plan) =>
    plan.target_level === expectedTargetLevel &&
    plan.craft_count <= requiredCrafts &&
    plan.spend_minor <= request.options.budget_minor &&
    plan.remaining_budget_minor === request.options.budget_minor - plan.spend_minor &&
    plan.steps.every((step) => !exclusions.has(step.app_id))
  );
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
