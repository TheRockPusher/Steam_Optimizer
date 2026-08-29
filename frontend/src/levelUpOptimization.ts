export const LEVEL_UP_OPTIMIZATION_URL = `${(
  import.meta.env.VITE_API_BASE_URL ?? ""
).replace(/\/+$/, "")}/api/auth/level-up`;
export const STEAM_COMMUNITY_ORIGIN = "https://steamcommunity.com";
export const MAX_LEVEL_UP_CARD_ROWS = 10_000;
export const MAX_MARKET_HASH_NAME_LENGTH = 512;
export const MAX_STEAM_ID_LENGTH = 20;
export const MAX_APP_ID_LENGTH = 20;
export const MAX_CARD_QUANTITY = 1_000_000;
export const MAX_SET_SIZE = 15;
export const MIN_SET_SIZE = 5;
export const MAX_LEVEL = 1_000_000;
export const MAX_XP = Number.MAX_SAFE_INTEGER;
export const MAX_CATALOG_COUNT = 1_000_000;
export const MAX_MINOR_AMOUNT = Number.MAX_SAFE_INTEGER;
export const LEVEL_UP_INVENTORY_MAX_AGE_MS = 60 * 60 * 1000;

const NORMAL_CARD_HASH_PATTERN = /^([1-9][0-9]*)-(.+) \(Trading Card\)$/;
const POSITIVE_DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export type LevelUpInventoryItem = {
  market_hash_name: string | null;
  quantity: number;
  marketable: boolean;
  tradable: boolean;
  /** Existing inventory responses carry this discriminator. */
  item_type?: string;
  icon_url?: string | null;
};

export type LevelUpCardOwnership = {
  market_hash_name: string;
  owned_quantity: number;
  sellable_quantity: number;
};

export type LevelUpOptimizationRequest = {
  inventory_refreshed_at: string;
  cards: LevelUpCardOwnership[];
};

export type LevelUpReason =
  | "ready"
  | "currency_contract_missing"
  | "steam_web_api_key_missing"
  | "badge_data_unavailable"
  | "inventory_snapshot_too_old"
  | "price_generation_unavailable"
  | "price_generation_stale"
  | "quote_depth_unavailable"
  | "catalog_warming"
  | "no_complete_sellable_set"
  | "no_positive_xp_swap";

export type LevelUpStatus =
  | "ready"
  | "no_opportunity"
  | "warming"
  | "unavailable";

export type LevelUpMoneyMetadata = {
  currency_code: string;
  minor_digits: number;
  price_basis: "instant_top_of_book";
  steam_fee_bps: number;
  publisher_fee_bps: number;
  min_fee_minor: number;
  taxes_included: false;
};

export type LevelUpPlayerState = {
  current_xp: number;
  current_level: number;
  xp_to_next_level: number;
  projected_xp: number;
  projected_level: number;
  projected_xp_to_next_level: number;
};

export type LevelUpSellRow = {
  market_hash_name: string;
  card_name: string;
  quantity: 1;
  buyer_total: number;
  steam_fee: number;
  publisher_fee: number;
  seller_receipt: number;
  top_bid_quantity: number;
  quote_timestamp: string;
};

export type LevelUpBuyRow = {
  market_hash_name: string;
  card_name: string;
  quantity: 1;
  buyer_total: number;
  top_ask_quantity: number;
  quote_timestamp: string;
};

export type LevelUpSourcePlan = {
  app_id: string;
  game_name: string;
  badge_level: number;
  set_size: number;
  rows: LevelUpSellRow[];
};

export type LevelUpDestinationPlan = {
  app_id: string;
  game_name: string;
  badge_level_before: number;
  badge_level_after: number;
  set_size: number;
  rows: LevelUpBuyRow[];
  set_subtotal: number;
  craft_xp: 100;
};

export type LevelUpTotals = {
  source_buyer_total: number;
  steam_fee_total: number;
  publisher_fee_total: number;
  seller_receipt_total: number;
  purchase_total: number;
  unspent_swap_proceeds: number;
  direct_craft_xp: 100;
  swap_path_xp: number;
  xp_advantage: number;
  destination_count: number;
  scope_limited: boolean;
};


type LevelUpResponseCommon = {
  status: LevelUpStatus;
  reason: LevelUpReason | null;
  generated_at: string;
  inventory_refreshed_at: string;
  catalog_total_sets: number;
  catalog_resolved_sets: number;
  catalog_pending_sets: number;
  currency_code: string | null;
  minor_digits: number | null;
  price_basis: "instant_top_of_book" | null;
  steam_fee_bps: number | null;
  publisher_fee_bps: number | null;
  min_fee_minor: number | null;
  taxes_included: false | null;
  scope_limited: boolean;
  valid_until: string | null;
  player: LevelUpPlayerState | null;
  source: LevelUpSourcePlan | null;
  destinations: LevelUpDestinationPlan[];
  totals: LevelUpTotals | null;
  message?: string | null;
};

export type LevelUpReadyResponse = LevelUpResponseCommon & {
  status: "ready";
  reason: "ready";
  currency_code: string;
  minor_digits: number;
  price_basis: "instant_top_of_book";
  steam_fee_bps: number;
  publisher_fee_bps: number;
  min_fee_minor: number;
  taxes_included: false;
  valid_until: string;
  player: LevelUpPlayerState;
  source: LevelUpSourcePlan;
  destinations: LevelUpDestinationPlan[];
  totals: LevelUpTotals;
};

export type LevelUpNoOpportunityResponse = LevelUpResponseCommon & {
  status: "no_opportunity";
  reason: "no_complete_sellable_set" | "no_positive_xp_swap";
  valid_until: null;
  player: null;
  source: null;
  destinations: [];
  totals: null;
};

export type LevelUpWarmingResponse = LevelUpResponseCommon & {
  status: "warming";
  reason: "catalog_warming";
  valid_until: null;
  player: null;
  source: null;
  destinations: [];
  totals: null;
};

export type LevelUpUnavailableResponse = LevelUpResponseCommon & {
  status: "unavailable";
  reason:
  | "currency_contract_missing"
  | "steam_web_api_key_missing"
  | "badge_data_unavailable"
  | "inventory_snapshot_too_old"
  | "price_generation_unavailable"
  | "price_generation_stale"
  | "quote_depth_unavailable";
  valid_until: null;
  player: null;
  source: null;
  destinations: [];
  totals: null;
};

export type LevelUpOptimizationResponse =
  | LevelUpReadyResponse
  | LevelUpNoOpportunityResponse
  | LevelUpWarmingResponse
  | LevelUpUnavailableResponse;


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
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

function sumSafe(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      return null;
    }
  }
  return total;
}

function isPositiveDecimalId(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    POSITIVE_DECIMAL_ID_PATTERN.test(value)
  );
}

export function isNormalCardMarketHashName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MARKET_HASH_NAME_LENGTH
  ) {
    return false;
  }
  const match = NORMAL_CARD_HASH_PATTERN.exec(value);
  return (
    match !== null &&
    match[1].length <= MAX_APP_ID_LENGTH &&
    match[2].length > 0
  );
}

export function normalCardAppId(value: string): string | null {
  const match = NORMAL_CARD_HASH_PATTERN.exec(value);
  return match !== null && match[1].length <= MAX_APP_ID_LENGTH ? match[1] : null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const timezone = match[8];
  if (timezone !== "Z") {
    const zoneHour = Number(timezone.slice(1, 3));
    const zoneMinute = Number(timezone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) {
      return false;
    }
  }
  return Number.isFinite(Date.parse(value));
}

export function isLevelUpIsoTimestamp(value: unknown): value is string {
  return isIsoTimestamp(value);
}

function timestampMilliseconds(value: string): number {
  return Date.parse(value);
}

/** Minimum total XP required to be at a Steam level. */
export function minimumXpForLevel(level: number): number {
  if (!isSafeInteger(level, 0, MAX_LEVEL)) {
    throw new Error("The level is invalid.");
  }
  const completeTens = Math.floor(level / 10);
  const remainder = level % 10;
  return (
    500 * completeTens * (completeTens + 1) +
    100 * (completeTens + 1) * remainder
  );
}

export function levelForXp(xp: number): number {
  if (!isSafeInteger(xp, 0, MAX_XP)) {
    throw new Error("The XP value is invalid.");
  }
  let low = 0;
  let high = Math.min(MAX_LEVEL, Math.floor(Math.sqrt(xp / 500) * 20 + 20));
  while (minimumXpForLevel(high) <= xp && high < MAX_LEVEL) {
    high = Math.min(MAX_LEVEL, high * 2 + 1);
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (minimumXpForLevel(middle) <= xp) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

export function xpToNextLevel(xp: number): number {
  const level = levelForXp(xp);
  return minimumXpForLevel(level + 1) - xp;
}

function isNonEmptyText(
  value: unknown,
  maxLength = MAX_MARKET_HASH_NAME_LENGTH
): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && CURRENCY_CODE_PATTERN.test(value);
}

function validateCatalogCounts(value: Record<string, unknown>): boolean {
  return (
    isSafeInteger(value.catalog_total_sets, 0, MAX_CATALOG_COUNT) &&
    isSafeInteger(value.catalog_resolved_sets, 0, MAX_CATALOG_COUNT) &&
    isSafeInteger(value.catalog_pending_sets, 0, MAX_CATALOG_COUNT) &&
    value.catalog_resolved_sets + value.catalog_pending_sets === value.catalog_total_sets
  );
}

function validateMoneyFields(value: Record<string, unknown>): boolean {
  const fields = [
    value.currency_code,
    value.minor_digits,
    value.price_basis,
    value.steam_fee_bps,
    value.publisher_fee_bps,
    value.min_fee_minor,
    value.taxes_included
  ];
  const allUnset = fields.every((field) => field === null);
  if (allUnset) {
    return true;
  }
  return (
    isCurrencyCode(value.currency_code) &&
    isSafeInteger(value.minor_digits, 0, 3) &&
    value.price_basis === "instant_top_of_book" &&
    isSafeInteger(value.steam_fee_bps, 0, 10_000) &&
    isSafeInteger(value.publisher_fee_bps, 0, 10_000) &&
    isSafeInteger(value.min_fee_minor, 0, MAX_MINOR_AMOUNT) &&
    value.taxes_included === false
  );
}

function validatePlayer(value: unknown): value is LevelUpPlayerState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "current_xp",
      "current_level",
      "xp_to_next_level",
      "projected_xp",
      "projected_level",
      "projected_xp_to_next_level"
    ])
  ) {
    return false;
  }
  const player = value as Partial<LevelUpPlayerState>;
  if (
    !isSafeInteger(player.current_xp, 0, MAX_XP) ||
    !isSafeInteger(player.current_level, 0, MAX_LEVEL - 1) ||
    !isSafeInteger(player.xp_to_next_level, 0, MAX_XP) ||
    !isSafeInteger(player.projected_xp, 0, MAX_XP) ||
    !isSafeInteger(player.projected_level, 0, MAX_LEVEL - 1) ||
    !isSafeInteger(player.projected_xp_to_next_level, 0, MAX_XP)
  ) {
    return false;
  }
  const currentMinimum = minimumXpForLevel(player.current_level);
  const nextMinimum = minimumXpForLevel(player.current_level + 1);
  const projectedMinimum = minimumXpForLevel(player.projected_level);
  const projectedNextMinimum = minimumXpForLevel(player.projected_level + 1);
  return (
    player.current_xp >= currentMinimum &&
    player.current_xp < nextMinimum &&
    player.xp_to_next_level === nextMinimum - player.current_xp &&
    player.projected_xp >= projectedMinimum &&
    player.projected_xp < projectedNextMinimum &&
    player.projected_xp_to_next_level === projectedNextMinimum - player.projected_xp &&
    player.projected_xp >= player.current_xp &&
    player.projected_level >= player.current_level
  );
}


function validateSellRow(value: unknown, generatedAt: number): value is LevelUpSellRow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "market_hash_name",
      "card_name",
      "quantity",
      "buyer_total",
      "steam_fee",
      "publisher_fee",
      "seller_receipt",
      "top_bid_quantity",
      "quote_timestamp"
    ]) ||
    !isNormalCardMarketHashName(value.market_hash_name) ||
    !isNonEmptyText(value.card_name, MAX_MARKET_HASH_NAME_LENGTH) ||
    value.quantity !== 1 ||
    !isSafeInteger(value.buyer_total, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(value.steam_fee, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(value.publisher_fee, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(value.seller_receipt, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(value.top_bid_quantity, 1, MAX_CARD_QUANTITY) ||
    !isIsoTimestamp(value.quote_timestamp)
  ) {
    return false;
  }
  const feeTotal = value.steam_fee + value.publisher_fee;
  const recomposedBuyerTotal = value.seller_receipt + feeTotal;
  return (
    Number.isSafeInteger(feeTotal) &&
    Number.isSafeInteger(recomposedBuyerTotal) &&
    timestampMilliseconds(value.quote_timestamp) <= generatedAt &&
    feeTotal <= value.buyer_total &&
    recomposedBuyerTotal === value.buyer_total
  );
}

function validateBuyRow(value: unknown, generatedAt: number): value is LevelUpBuyRow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "market_hash_name",
      "card_name",
      "quantity",
      "buyer_total",
      "top_ask_quantity",
      "quote_timestamp"
    ]) ||
    !isNormalCardMarketHashName(value.market_hash_name) ||
    !isNonEmptyText(value.card_name, MAX_MARKET_HASH_NAME_LENGTH) ||
    value.quantity !== 1 ||
    !isSafeInteger(value.buyer_total, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(value.top_ask_quantity, 1, MAX_CARD_QUANTITY) ||
    !isIsoTimestamp(value.quote_timestamp)
  ) {
    return false;
  }
  return timestampMilliseconds(value.quote_timestamp) <= generatedAt;
}

function validateSource(value: unknown, generatedAt: number): value is LevelUpSourcePlan {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["app_id", "game_name", "badge_level", "set_size", "rows"]) ||
    !isPositiveDecimalId(value.app_id, MAX_APP_ID_LENGTH) ||
    !isNonEmptyText(value.game_name, 512) ||
    !isSafeInteger(value.badge_level, 0, 4) ||
    !isSafeInteger(value.set_size, MIN_SET_SIZE, MAX_SET_SIZE) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== value.set_size
  ) {
    return false;
  }
  const hashes = new Set<string>();
  for (const row of value.rows) {
    if (
      !validateSellRow(row, generatedAt) ||
      hashes.has(row.market_hash_name) ||
      normalCardAppId(row.market_hash_name) !== value.app_id
    ) {
      return false;
    }
    hashes.add(row.market_hash_name);
  }
  return true;
}

function validateDestination(
  value: unknown,
  generatedAt: number
): value is LevelUpDestinationPlan {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "app_id",
      "game_name",
      "badge_level_before",
      "badge_level_after",
      "set_size",
      "rows",
      "set_subtotal",
      "craft_xp"
    ]) ||
    !isPositiveDecimalId(value.app_id, MAX_APP_ID_LENGTH) ||
    !isNonEmptyText(value.game_name, 512) ||
    !isSafeInteger(value.badge_level_before, 0, 4) ||
    value.badge_level_after !== value.badge_level_before + 1 ||
    !isSafeInteger(value.set_size, MIN_SET_SIZE, MAX_SET_SIZE) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== value.set_size ||
    !isSafeInteger(value.set_subtotal, 0, MAX_MINOR_AMOUNT) ||
    value.craft_xp !== 100
  ) {
    return false;
  }
  const hashes = new Set<string>();
  let subtotal = 0;
  for (const row of value.rows) {
    if (
      !validateBuyRow(row, generatedAt) ||
      hashes.has(row.market_hash_name) ||
      normalCardAppId(row.market_hash_name) !== value.app_id
    ) {
      return false;
    }
    hashes.add(row.market_hash_name);
    subtotal += row.buyer_total;
    if (!Number.isSafeInteger(subtotal)) {
      return false;
    }
  }
  return subtotal === value.set_subtotal;
}

function validateTotals(
  value: unknown,
  source: LevelUpSourcePlan,
  destinations: LevelUpDestinationPlan[],
  player: LevelUpPlayerState,
  scopeLimited: boolean
): value is LevelUpTotals {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "source_buyer_total",
      "steam_fee_total",
      "publisher_fee_total",
      "seller_receipt_total",
      "purchase_total",
      "unspent_swap_proceeds",
      "direct_craft_xp",
      "swap_path_xp",
      "xp_advantage",
      "destination_count",
      "scope_limited"
    ])
  ) {
    return false;
  }
  const totals = value as Partial<LevelUpTotals>;
  const sourceBuyerTotal = sumSafe(source.rows.map((row) => row.buyer_total));
  const steamFeeTotal = sumSafe(source.rows.map((row) => row.steam_fee));
  const publisherFeeTotal = sumSafe(source.rows.map((row) => row.publisher_fee));
  const sellerReceiptTotal = sumSafe(source.rows.map((row) => row.seller_receipt));
  const purchaseTotal = sumSafe(destinations.map((destination) => destination.set_subtotal));
  const destinationCount = destinations.length;
  const swapPathXp = destinationCount * 100;
  if (
    sourceBuyerTotal === null ||
    steamFeeTotal === null ||
    publisherFeeTotal === null ||
    sellerReceiptTotal === null ||
    purchaseTotal === null ||
    !isSafeInteger(totals.unspent_swap_proceeds, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(totals.purchase_total, 0, MAX_MINOR_AMOUNT) ||
    !isSafeInteger(player.projected_xp, 0, MAX_XP) ||
    !isSafeInteger(player.current_xp, 0, MAX_XP)
  ) {
    return false;
  }
  const unspentAndPurchase = totals.unspent_swap_proceeds + totals.purchase_total;
  const xpDelta = player.projected_xp - player.current_xp;
  return (
    isSafeInteger(totals.source_buyer_total, 0, MAX_MINOR_AMOUNT) &&
    isSafeInteger(totals.steam_fee_total, 0, MAX_MINOR_AMOUNT) &&
    isSafeInteger(totals.publisher_fee_total, 0, MAX_MINOR_AMOUNT) &&
    isSafeInteger(totals.seller_receipt_total, 0, MAX_MINOR_AMOUNT) &&
    isSafeInteger(totals.direct_craft_xp, 0, MAX_XP) &&
    isSafeInteger(totals.swap_path_xp, 0, MAX_XP) &&
    isSafeInteger(totals.xp_advantage, 0, MAX_XP) &&
    isSafeInteger(totals.destination_count, 0, 5) &&
    typeof totals.scope_limited === "boolean" &&
    Number.isSafeInteger(unspentAndPurchase) &&
    Number.isSafeInteger(xpDelta) &&
    totals.source_buyer_total === sourceBuyerTotal &&
    totals.steam_fee_total === steamFeeTotal &&
    totals.publisher_fee_total === publisherFeeTotal &&
    totals.seller_receipt_total === sellerReceiptTotal &&
    totals.purchase_total === purchaseTotal &&
    unspentAndPurchase === totals.seller_receipt_total &&
    totals.direct_craft_xp === 100 &&
    totals.swap_path_xp === swapPathXp &&
    totals.xp_advantage === totals.swap_path_xp - totals.direct_craft_xp &&
    totals.destination_count === destinationCount &&
    totals.scope_limited === scopeLimited &&
    totals.swap_path_xp === xpDelta
  );
}

function validateReadyPlan(
  value: Record<string, unknown>,
  generatedAt: number,
  player: LevelUpPlayerState,
  scopeLimited: boolean
): boolean {
  if (
    !isRecord(value.source) ||
    !Array.isArray(value.destinations) ||
    value.destinations.length < 2 ||
    value.destinations.length > 5 ||
    (scopeLimited && value.destinations.length !== 5)
  ) {
    return false;
  }
  if (
    !validateSource(value.source, generatedAt) ||
    !value.destinations.every((destination) => validateDestination(destination, generatedAt))
  ) {
    return false;
  }
  if (!validateTotals(value.totals, value.source, value.destinations, player, scopeLimited)) {
    return false;
  }
  const appIds = new Set<string>();
  for (const destination of value.destinations) {
    if (appIds.has(destination.app_id) || destination.app_id === value.source.app_id) {
      return false;
    }
    appIds.add(destination.app_id);
  }
  return true;
}

function validateCommon(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(
      value,
      [
        "status",
        "reason",
        "generated_at",
        "inventory_refreshed_at",
        "catalog_total_sets",
        "catalog_resolved_sets",
        "catalog_pending_sets",
        "currency_code",
        "minor_digits",
        "price_basis",
        "steam_fee_bps",
        "publisher_fee_bps",
        "min_fee_minor",
        "taxes_included",
        "scope_limited",
        "valid_until",
        "player",
        "source",
        "destinations",
        "totals"
      ],
      ["message"]
    ) &&
    isIsoTimestamp(value.generated_at) &&
    isIsoTimestamp(value.inventory_refreshed_at) &&
    timestampMilliseconds(value.inventory_refreshed_at) <= timestampMilliseconds(value.generated_at) &&
    validateCatalogCounts(value) &&
    validateMoneyFields(value) &&
    typeof value.scope_limited === "boolean" &&
    Array.isArray(value.destinations) &&
    (value.message === undefined || value.message === null || isNonEmptyText(value.message, 2_000))
  );
}

export function isLevelUpOptimizationResponse(
  value: unknown
): value is LevelUpOptimizationResponse {
  if (!isRecord(value) || !validateCommon(value)) {
    return false;
  }
  const response = value as Record<string, unknown> & LevelUpResponseCommon;
  const generatedAt = timestampMilliseconds(response.generated_at);
  switch (response.status) {
    case "ready": {
      if (
        response.reason !== "ready" ||
        response.catalog_pending_sets !== 0 ||
        !isCurrencyCode(response.currency_code) ||
        !isSafeInteger(response.minor_digits, 0, 3) ||
        response.price_basis !== "instant_top_of_book" ||
        !isSafeInteger(response.steam_fee_bps, 0, 10_000) ||
        !isSafeInteger(response.publisher_fee_bps, 0, 10_000) ||
        !isSafeInteger(response.min_fee_minor, 0, MAX_MINOR_AMOUNT) ||
        response.taxes_included !== false ||
        !isIsoTimestamp(response.valid_until)
      ) {
        return false;
      }
      if (timestampMilliseconds(response.valid_until) <= generatedAt) {
        return false;
      }
      const player = response.player;
      if (!validatePlayer(player)) {
        return false;
      }
      return validateReadyPlan(response, generatedAt, player, response.scope_limited);
    }
    case "no_opportunity":
      return (
        (response.reason === "no_complete_sellable_set" ||
          response.reason === "no_positive_xp_swap") &&
        response.catalog_pending_sets === 0 &&
        response.valid_until === null &&
        response.player === null &&
        response.source === null &&
        response.destinations.length === 0 &&
        response.totals === null &&
        response.scope_limited === false
      );
    case "warming":
      return (
        response.reason === "catalog_warming" &&
        response.valid_until === null &&
        response.player === null &&
        response.source === null &&
        response.destinations.length === 0 &&
        response.totals === null &&
        response.scope_limited === false &&
        response.catalog_pending_sets > 0
      );
    case "unavailable":
      return (
        (response.reason === "currency_contract_missing" ||
          response.reason === "steam_web_api_key_missing" ||
          response.reason === "badge_data_unavailable" ||
          response.reason === "inventory_snapshot_too_old" ||
          response.reason === "price_generation_unavailable" ||
          response.reason === "price_generation_stale" ||
          response.reason === "quote_depth_unavailable") &&
        (response.reason !== "currency_contract_missing" ||
          response.currency_code === null) &&
        response.valid_until === null &&
        response.player === null &&
        response.source === null &&
        response.destinations.length === 0 &&
        response.totals === null &&
        response.scope_limited === false
      );
    default:
      return false;
  }
}


export function assertLevelUpOptimizationResponse(
  value: unknown
): asserts value is LevelUpOptimizationResponse {
  if (!isLevelUpOptimizationResponse(value)) {
    throw new Error("The level-up optimization service returned an invalid response.");
  }
}

function isSnapshotItem(
  value: LevelUpInventoryItem
): value is LevelUpInventoryItem & { market_hash_name: string } {
  return (
    isNormalCardMarketHashName(value.market_hash_name) &&
    isSafeInteger(value.quantity, 1, MAX_CARD_QUANTITY) &&
    typeof value.marketable === "boolean" &&
    typeof value.tradable === "boolean" &&
    (value.item_type === undefined || value.item_type === "trading_card")
  );
}

export function aggregateNormalCardOwnership(
  items: readonly LevelUpInventoryItem[]
): LevelUpCardOwnership[] {
  const groups = new Map<string, LevelUpCardOwnership>();
  for (const item of items) {
    if (!isSnapshotItem(item)) {
      continue;
    }
    const existing = groups.get(item.market_hash_name);
    const ownedQuantity = (existing?.owned_quantity ?? 0) + item.quantity;
    const sellableQuantity =
      (existing?.sellable_quantity ?? 0) +
      (item.marketable && item.tradable ? item.quantity : 0);
    if (ownedQuantity > MAX_CARD_QUANTITY || sellableQuantity > ownedQuantity) {
      continue;
    }
    groups.set(item.market_hash_name, {
      market_hash_name: item.market_hash_name,
      owned_quantity: ownedQuantity,
      sellable_quantity: sellableQuantity
    });
  }
  return [...groups.values()].sort((left, right) =>
    left.market_hash_name < right.market_hash_name
      ? -1
      : left.market_hash_name > right.market_hash_name
        ? 1
        : 0
  );
}


export function buildLevelUpOptimizationRequest(
  items: readonly LevelUpInventoryItem[],
  inventoryRefreshedAt: string
): LevelUpOptimizationRequest {
  if (!isIsoTimestamp(inventoryRefreshedAt)) {
    throw new Error("The inventory refresh timestamp is invalid.");
  }
  const request: LevelUpOptimizationRequest = {
    inventory_refreshed_at: inventoryRefreshedAt,
    cards: aggregateNormalCardOwnership(items)
  };
  if (!isLevelUpOptimizationRequest(request)) {
    throw new Error("The level-up optimization request is invalid.");
  }
  return request;
}


function isLevelUpCardOwnership(value: unknown): value is LevelUpCardOwnership {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["market_hash_name", "owned_quantity", "sellable_quantity"]) &&
    isNormalCardMarketHashName(value.market_hash_name) &&
    isSafeInteger(value.owned_quantity, 1, MAX_CARD_QUANTITY) &&
    isSafeInteger(value.sellable_quantity, 0, MAX_CARD_QUANTITY) &&
    value.sellable_quantity <= value.owned_quantity
  );
}

export function isLevelUpOptimizationRequest(
  value: unknown
): value is LevelUpOptimizationRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["inventory_refreshed_at", "cards"]) ||
    !isIsoTimestamp(value.inventory_refreshed_at) ||
    !Array.isArray(value.cards) ||
    value.cards.length > MAX_LEVEL_UP_CARD_ROWS
  ) {
    return false;
  }
  const hashes = new Set<string>();
  for (const card of value.cards) {
    if (!isLevelUpCardOwnership(card) || hashes.has(card.market_hash_name)) {
      return false;
    }
    hashes.add(card.market_hash_name);
  }
  return true;
}

function validateSteamId(steamId: string): void {
  if (!isPositiveDecimalId(steamId, MAX_STEAM_ID_LENGTH)) {
    throw new Error("The SteamID is invalid.");
  }
}

export function buildSteamMarketListingUrl(marketHashName: string): string {
  if (!isNormalCardMarketHashName(marketHashName)) {
    throw new Error("The market hash name is invalid.");
  }
  return `${STEAM_COMMUNITY_ORIGIN}/market/listings/753/${encodeURIComponent(marketHashName)}`;
}

export const buildMarketListingUrl = buildSteamMarketListingUrl;

export const steamMarketListingUrl = buildSteamMarketListingUrl;

export function buildSteamProfileGamecardsUrl(steamId: string, appId: string): string {
  validateSteamId(steamId);
  if (!isPositiveDecimalId(appId, MAX_APP_ID_LENGTH)) {
    throw new Error("The AppID is invalid.");
  }
  return `${STEAM_COMMUNITY_ORIGIN}/profiles/${encodeURIComponent(steamId)}/gamecards/${encodeURIComponent(appId)}/`;
}

export const buildProfileGamecardsUrl = buildSteamProfileGamecardsUrl;

export const steamProfileGamecardsUrl = buildSteamProfileGamecardsUrl;
export function formatMinorUnits(
  amountMinor: number,
  currencyCode: string,
  minorDigits: number,
  locale = "en-US"
): string {
  if (
    !isSafeInteger(amountMinor, 0, MAX_MINOR_AMOUNT) ||
    !isCurrencyCode(currencyCode) ||
    !isSafeInteger(minorDigits, 0, 3)
  ) {
    throw new Error("The monetary amount or currency contract is invalid.");
  }
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
    currencyDisplay: "symbol",
    minimumFractionDigits: minorDigits,
    maximumFractionDigits: minorDigits
  });
  const scale = 10n ** BigInt(minorDigits);
  const amount = BigInt(amountMinor);
  const major = amount / scale;
  const fraction = (amount % scale).toString().padStart(minorDigits, "0");
  return formatter
    .formatToParts(Number(major))
    .map((part) => (part.type === "fraction" ? fraction : part.value))
    .join("");
}

export const formatMoney = formatMinorUnits;

export const formatCurrency = formatMinorUnits;

export function formatAbsoluteTime(timestamp: string, locale = "en-US"): string {
  if (!isIsoTimestamp(timestamp)) {
    throw new Error("The timestamp is invalid.");
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

export const formatTimestamp = formatAbsoluteTime;

export function formatRelativeTime(
  timestamp: string,
  now: number | Date = Date.now(),
  locale = "en-US"
): string {
  if (!isIsoTimestamp(timestamp)) {
    throw new Error("The timestamp is invalid.");
  }
  const nowMilliseconds = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("The current time is invalid.");
  }
  const differenceSeconds = Math.round((timestampMilliseconds(timestamp) - nowMilliseconds) / 1000);
  const absoluteSeconds = Math.abs(differenceSeconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absoluteSeconds < 60
      ? [differenceSeconds, "second"]
      : absoluteSeconds < 3_600
        ? [Math.round(differenceSeconds / 60), "minute"]
        : absoluteSeconds < 86_400
          ? [Math.round(differenceSeconds / 3_600), "hour"]
          : [Math.round(differenceSeconds / 86_400), "day"];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}

export const formatRelativeTimestamp = formatRelativeTime;

export function formatQuoteAge(timestamp: string, now: number | Date = Date.now()): string {
  return formatRelativeTime(timestamp, now);
}

export function quoteAgeMilliseconds(timestamp: string, now: number | Date = Date.now()): number {
  if (!isIsoTimestamp(timestamp)) {
    throw new Error("The timestamp is invalid.");
  }
  const nowMilliseconds = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("The current time is invalid.");
  }
  return Math.max(0, nowMilliseconds - timestampMilliseconds(timestamp));
}

export function isLevelUpResponseExpired(
  response: LevelUpReadyResponse,
  now: number | Date = Date.now()
): boolean {
  const nowMilliseconds = now instanceof Date ? now.getTime() : now;
  return !Number.isFinite(nowMilliseconds) || timestampMilliseconds(response.valid_until) <= nowMilliseconds;
}


export async function requestLevelUpOptimization(
  steamId: string,
  request: LevelUpOptimizationRequest,
  signal?: AbortSignal
): Promise<LevelUpOptimizationResponse> {
  validateSteamId(steamId);
  if (!isLevelUpOptimizationRequest(request)) {
    throw new Error("The level-up optimization request is invalid.");
  }
  const response = await fetch(LEVEL_UP_OPTIMIZATION_URL, {
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
    throw new Error("The level-up optimization service returned an error.");
  }
  const payload: unknown = await response.json();
  assertLevelUpOptimizationResponse(payload);
  return payload;
}

export type LevelUpPanelInventoryItem = LevelUpInventoryItem;


export function isInventorySnapshotFresh(
  inventoryRefreshedAt: string | null,
  now: number | Date = Date.now()
): boolean {
  if (inventoryRefreshedAt === null || !isIsoTimestamp(inventoryRefreshedAt)) {
    return false;
  }
  const nowMilliseconds = now instanceof Date ? now.getTime() : now;
  return (
    Number.isFinite(nowMilliseconds) &&
    nowMilliseconds - timestampMilliseconds(inventoryRefreshedAt) <= LEVEL_UP_INVENTORY_MAX_AGE_MS
  );
}
export type LevelUpState =
  | { kind: "idle"; key: string | null }
  | { kind: "loading"; key: string }
  | { kind: "response"; key: string; response: LevelUpOptimizationResponse }
  | { kind: "expired"; key: string; response: LevelUpReadyResponse }
  | { kind: "error"; key: string; message: string };

export function levelUpSnapshotKey(
  steamId: string | null,
  inventoryRefreshedAt: string | null
): string | null {
  return steamId !== null && inventoryRefreshedAt !== null
    ? `${steamId}\u0000${inventoryRefreshedAt}`
    : null;
}
