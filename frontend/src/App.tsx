import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import steamSignInWide from "./assets/steam/sits_01.png";
import {
  clearInventoryCache,
  clearInventoryCacheExcept,
  readInventoryCache,
  readInventoryCacheEpoch,
  writeInventoryCache
} from "./inventoryCache";
import "./App.css";

type VisibilityStatus = "public" | "private" | "unavailable";

type VisibilityCheck = {
  status: VisibilityStatus;
  message: string;
};

type PriceStatus = "complete" | "partial" | "unavailable";

type GemStatus = "complete" | "partial" | "unavailable";

type CardRarity = "normal" | "foil";

type InventoryPrice = {
  currency: null;
  highest_buy: string | null;
  lowest_sell: string | null;
  observed_at: string | null;
};

type BoosterInfo = {
  game_app_id: string;
  game_name: string | null;
  market_hash_name: string | null;
  card_count: 3;
  card_set_size: number | null;
  gem_cost: number | null;
  price: InventoryPrice | null;
};

type GemCashContext = {
  currency: null;
  basis: "lowest_sell";
  market_hash_name: "753-Sack of Gems";
  sack_gems: 1000;
  sack_price: string;
  observed_at: string | null;
};

type InventoryItem = {
  class_id: string;
  instance_id: string;
  name: string;
  market_hash_name: string | null;
  quantity: number;
  icon_url: string | null;
  marketable: boolean;
  tradable: boolean;
  price: InventoryPrice | null;
  item_type: "trading_card" | "other";
  game_app_id: string | null;
  game_name: string | null;
  card_rarity: CardRarity | null;
  gem_yield: number | null;
  gem_cash_value: string | null;
};

type InventorySortField =
  | "name"
  | "quantity"
  | "marketable"
  | "highest_buy"
  | "lowest_sell"
  | "observed_at"
  | "gem_yield"
  | "gem_cash_value";

type SortDirection = "ascending" | "descending";

type InventorySort = {
  field: InventorySortField;
  direction: SortDirection;
};

type InventoryView = "all" | "worth-more-as-gems";

type InventoryViewDefinition = {
  key: InventoryView;
  label: string;
  tabId: string;
  panelId: string;
};
type InventoryResultView = "items" | "boosters";

type InventoryResultViewDefinition = {
  key: InventoryResultView;
  label: string;
  tabId: string;
  panelId: string;
};


type InventoryCheck = VisibilityCheck & {
  retry_after_seconds: number | null;
  rate_limited: boolean;
  total_asset_count: number;
  unique_item_count: number;
  priceable_item_count: number;
  priced_item_count: number;
  price_status: PriceStatus;
  price_message: string;
  gem_status: GemStatus;
  gem_message: string;
  gem_priceable_item_count: number;
  gem_priced_item_count: number;
  gem_rate_limited: boolean;
  gem_retry_after_seconds: number | null;
  gem_cash_context: GemCashContext | null;
  boosters: BoosterInfo[];
  items: InventoryItem[];
};

type SteamUser = {
  steam_id: string;
  display_name: string | null;
  avatar_url: string | null;
};

type SignedOutSession = {
  authenticated: false;
};

type SignedInSession = {
  authenticated: true;
  user: SteamUser;
  checks: {
    profile: VisibilityCheck;
  };
};

type SessionResponse = SignedOutSession | SignedInSession;
type GemRefreshGroup = {
  game_app_id: string;
  card_rarity: CardRarity;
};

type GemRefreshValue = GemRefreshGroup & {
  gem_yield: number;
};

type BoosterRefreshValue = {
  game_app_id: string;
  card_set_size: number | null;
  gem_cost: number | null;
};

type GemRefreshResponse = {
  values: GemRefreshValue[];
  pending_group_count: number;
  boosters: BoosterRefreshValue[];
  pending_booster_count: number;
  gem_rate_limited: boolean;
  gem_retry_after_seconds: number | null;
};

type InventoryState = {
  inventory: InventoryCheck | null;
  refreshedAt: string | null;
  source: "cache" | "network" | null;
  isLoading: boolean;
  message: string | null;
};

type InventoryLoadResult = {
  kind: "cache" | "network" | "error" | "session-changed";
  inventory?: InventoryCheck;
  refreshedAt?: string;
  preserved?: boolean;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; session: SignedInSession }
  | { kind: "api-unavailable" };
const MILLISECONDS_PER_SECOND = 1000;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const SESSION_URL = `${API_BASE_URL}/api/auth/session`;
const INVENTORY_URL = `${API_BASE_URL}/api/auth/inventory`;
const GEM_REFRESH_URL = `${API_BASE_URL}/api/auth/gems`;
const LOGOUT_URL = `${API_BASE_URL}/api/auth/logout`;
const STEAM_LOGIN_URL = `${API_BASE_URL}/api/auth/steam/start`;
const STEAM_PRIVACY_URL = "https://steamcommunity.com/my/edit/settings";
const PRIVACY_POLICY_URL =
  "https://github.com/TheRockPusher/Steam_Optimizer#privacy-and-steam-data-policy";
const NON_ASCII_DECIMAL_PATTERN = /[^0-9]/;
const NONNEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const INVENTORY_PAGE_SIZE = 50;
const INVENTORY_VIEWS: ReadonlyArray<InventoryViewDefinition> = [
  {
    key: "all",
    label: "All items",
    tabId: "inventory-tab-all",
    panelId: "inventory-panel-all"
  },
  {
    key: "worth-more-as-gems",
    label: "Worth more as gems",
    tabId: "inventory-tab-worth-gems",
    panelId: "inventory-panel-worth-gems"
  }
];
const INVENTORY_RESULT_VIEWS: ReadonlyArray<InventoryResultViewDefinition> = [
  {
    key: "items",
    label: "Items",
    tabId: "inventory-results-tab-items",
    panelId: "inventory-results-panel-items"
  },
  {
    key: "boosters",
    label: "Boosters",
    tabId: "inventory-results-tab-boosters",
    panelId: "inventory-results-panel-boosters"
  }
];


const INVENTORY_COUNT_FORMATTER = new Intl.NumberFormat("en-US");
const PRICE_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short"
});

const STATUS_LABELS: Record<VisibilityStatus, string> = {
  public: "Public",
  private: "Private",
  unavailable: "Unavailable"
};
const PRICE_STATUS_LABELS: Record<PriceStatus, string> = {
  complete: "Complete pricing",
  partial: "Partial pricing",
  unavailable: "Pricing unavailable"
};
const GEM_STATUS_LABELS: Record<GemStatus, string> = {
  complete: "Complete gem pricing",
  partial: "Partial gem pricing",
  unavailable: "Gem pricing unavailable"
};
const GEM_CASH_MARKET_HASH_NAME = "753-Sack of Gems";
const GEM_CASH_SACK_SIZE = 1000;

const INVENTORY_COLUMNS: ReadonlyArray<{
  field: InventorySortField;
  label: string;
}> = [
    { field: "name", label: "Item" },
    { field: "quantity", label: "Quantity" },
    { field: "marketable", label: "Marketability" },
    { field: "highest_buy", label: "Highest buy" },
    { field: "lowest_sell", label: "Lowest sell" },
    { field: "observed_at", label: "Price timestamp" },
    { field: "gem_yield", label: "Gem value" },
    { field: "gem_cash_value", label: "Gem cash value" }
  ];
const INVENTORY_NAME_COLLATOR = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base"
});

function isVisibilityCheck(value: unknown): value is VisibilityCheck {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const check = value as Partial<VisibilityCheck>;
  return (
    (check.status === "public" ||
      check.status === "private" ||
      check.status === "unavailable") &&
    typeof check.message === "string"
  );
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
  );
}

function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !NON_ASCII_DECIMAL_PATTERN.test(value)
  );
}
function isCanonicalGemDecimal(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !NONNEGATIVE_DECIMAL_PATTERN.test(value)
  ) {
    return false;
  }

  if (value.includes(".")) {
    return !value.endsWith("0");
  }
  return true;
}

function gemCashValueForYield(gemYield: number, sackPrice: string): string {
  const [integer, fraction = ""] = sackPrice.split(".");
  const sackDigits = BigInt(`${integer}${fraction}`);
  const product = sackDigits * BigInt(gemYield);
  const scale = fraction.length + 3;
  const padded = product.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const decimal = padded.slice(-scale).replace(/0+$/, "");
  return decimal.length > 0 ? `${whole}.${decimal}` : whole;
}


function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isInventoryPrice(value: unknown): value is InventoryPrice {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const price = value as Partial<InventoryPrice>;
  return (
    price.currency === null &&
    (price.highest_buy === null ||
      (typeof price.highest_buy === "string" &&
        NONNEGATIVE_DECIMAL_PATTERN.test(price.highest_buy))) &&
    (price.lowest_sell === null ||
      (typeof price.lowest_sell === "string" &&
        NONNEGATIVE_DECIMAL_PATTERN.test(price.lowest_sell))) &&
    (typeof price.observed_at === "string" || price.observed_at === null)
  );
}

function gemCostForCardSetSize(cardSetSize: number): number {
  return Math.floor((12000 + cardSetSize) / (2 * cardSetSize));
}

function isBoosterDerivation(
  cardSetSize: unknown,
  gemCost: unknown
): boolean {
  if (cardSetSize === null || gemCost === null) {
    return cardSetSize === null && gemCost === null;
  }

  return (
    isSafeInteger(cardSetSize, 5) &&
    cardSetSize <= 15 &&
    isSafeInteger(gemCost, 0) &&
    gemCost === gemCostForCardSetSize(cardSetSize)
  );
}


function isBoosterInfo(value: unknown): value is BoosterInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const booster = value as Partial<BoosterInfo>;
  if (
    !isDecimalString(booster.game_app_id) ||
    !(
      booster.game_name === null ||
      (typeof booster.game_name === "string" &&
        booster.game_name.trim().length > 0)
    ) ||
    !(
      booster.market_hash_name === null ||
      (typeof booster.market_hash_name === "string" &&
        booster.market_hash_name.length > 0)
    ) ||
    booster.card_count !== 3 ||
    !isBoosterDerivation(booster.card_set_size, booster.gem_cost) ||
    (booster.price !== null && !isInventoryPrice(booster.price))
  ) {
    return false;
  }

  return (
    (booster.market_hash_name === null || booster.game_name !== null) &&
    (booster.price === null || booster.market_hash_name !== null)
  );
}


function isGemCashContext(value: unknown): value is GemCashContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const context = value as Partial<GemCashContext>;
  return (
    context.currency === null &&
    context.basis === "lowest_sell" &&
    context.market_hash_name === GEM_CASH_MARKET_HASH_NAME &&
    context.sack_gems === GEM_CASH_SACK_SIZE &&
    typeof context.sack_price === "string" &&
    isCanonicalGemDecimal(context.sack_price) &&
    (typeof context.observed_at === "string" || context.observed_at === null)
  );
}

function isInventoryItem(value: unknown): value is InventoryItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const item = value as Partial<InventoryItem>;
  const hasValidBaseFields =
    isDecimalString(item.class_id) &&
    isDecimalString(item.instance_id) &&
    typeof item.name === "string" &&
    (typeof item.market_hash_name === "string" ||
      item.market_hash_name === null) &&
    isSafeInteger(item.quantity, 1) &&
    (item.icon_url === null || isHttpsUrl(item.icon_url)) &&
    typeof item.marketable === "boolean" &&
    typeof item.tradable === "boolean" &&
    (item.price === null || isInventoryPrice(item.price));
  const hasValidType =
    item.item_type === "trading_card" || item.item_type === "other";
  const hasValidGameId =
    item.game_app_id === null || isDecimalString(item.game_app_id);
  const hasValidGameName =
    item.game_name === null ||
    (typeof item.game_name === "string" && item.game_name.trim().length > 0);
  const hasValidRarity =
    item.card_rarity === null ||
    item.card_rarity === "normal" ||
    item.card_rarity === "foil";
  const hasValidGemYield =
    item.gem_yield === null || isSafeInteger(item.gem_yield, 0);
  const hasValidGemCashValue =
    item.gem_cash_value === null ||
    isCanonicalGemDecimal(item.gem_cash_value);

  if (
    !hasValidBaseFields ||
    !hasValidType ||
    !hasValidGameId ||
    !hasValidGameName ||
    !hasValidRarity ||
    !hasValidGemYield ||
    !hasValidGemCashValue
  ) {
    return false;
  }

  if (
    typeof item.gem_yield === "undefined" ||
    typeof item.gem_cash_value === "undefined"
  ) {
    return false;
  }

  if (item.item_type === "other") {
    return (
      item.game_app_id === null &&
      item.game_name === null &&
      item.card_rarity === null &&
      item.gem_yield === null &&
      item.gem_cash_value === null
    );
  }

  if (item.game_app_id === null) {
    return (
      item.game_name === null &&
      item.card_rarity === null &&
      item.gem_yield === null &&
      item.gem_cash_value === null
    );
  }

  return (
    item.card_rarity !== null &&
    ((item.gem_yield === null && item.gem_cash_value === null) ||
      (item.gem_yield !== null &&
        (item.gem_cash_value === null ||
          typeof item.gem_cash_value === "string")))
  );
}

function isInventoryCheck(value: unknown): value is InventoryCheck {
  if (!isVisibilityCheck(value)) {
    return false;
  }

  const check = value as Partial<InventoryCheck>;
  const retryAfterSeconds = check.retry_after_seconds;
  const gemRetryAfterSeconds = check.gem_retry_after_seconds;
  if (
    typeof retryAfterSeconds === "undefined" ||
    (retryAfterSeconds !== null &&
      (!isSafeInteger(retryAfterSeconds, 0) ||
        !Number.isSafeInteger(
          retryAfterSeconds * MILLISECONDS_PER_SECOND
        ))) ||
    typeof check.rate_limited !== "boolean" ||
    !isSafeInteger(check.total_asset_count, 0) ||
    !isSafeInteger(check.unique_item_count, 0) ||
    !isSafeInteger(check.priceable_item_count, 0) ||
    !isSafeInteger(check.priced_item_count, 0) ||
    (check.price_status !== "complete" &&
      check.price_status !== "partial" &&
      check.price_status !== "unavailable") ||
    typeof check.price_message !== "string" ||
    (check.gem_status !== "complete" &&
      check.gem_status !== "partial" &&
      check.gem_status !== "unavailable") ||
    typeof check.gem_message !== "string" ||
    !isSafeInteger(check.gem_priceable_item_count, 0) ||
    !isSafeInteger(check.gem_priced_item_count, 0) ||
    typeof check.gem_rate_limited !== "boolean" ||
    typeof gemRetryAfterSeconds === "undefined" ||
    (gemRetryAfterSeconds !== null &&
      (!isSafeInteger(gemRetryAfterSeconds, 0) ||
        !Number.isSafeInteger(
          gemRetryAfterSeconds * MILLISECONDS_PER_SECOND
        ))) ||
    typeof check.gem_cash_context === "undefined" ||
    (check.gem_cash_context !== null &&
      !isGemCashContext(check.gem_cash_context)) ||
    !Array.isArray(check.boosters) ||
    !Array.isArray(check.items)
  ) {
    return false;
  }

  if (!check.gem_rate_limited && gemRetryAfterSeconds !== null) {
    return false;
  }

  const boosterKeys = new Set<string>();
  for (const booster of check.boosters) {
    if (!isBoosterInfo(booster)) {
      return false;
    }
    const boosterKey = booster.game_app_id;
    if (boosterKeys.has(boosterKey)) {
      return false;
    }
    boosterKeys.add(boosterKey);
  }

  const itemKeys = new Set<string>();
  const tradingCardGameIds = new Set<string>();
  let totalAssetCount = 0;
  let marketableItemCount = 0;
  let pricedItemCount = 0;
  let tradingCardCount = 0;
  let gemPricedItemCount = 0;
  let gemCashValueCount = 0;
  const gemYieldsByGroup = new Map<string, number | null>();

  for (const item of check.items) {
    if (!isInventoryItem(item)) {
      return false;
    }

    const itemKey = `${item.class_id}:${item.instance_id}`;
    if (itemKeys.has(itemKey)) {
      return false;
    }
    itemKeys.add(itemKey);

    if (item.quantity > Number.MAX_SAFE_INTEGER - totalAssetCount) {
      return false;
    }
    totalAssetCount += item.quantity;

    if (item.marketable) {
      marketableItemCount += 1;
    }
    if (item.price !== null) {
      if (!item.marketable || item.market_hash_name === null) {
        return false;
      }
      pricedItemCount += 1;
    }

    if (item.item_type === "trading_card") {
      tradingCardCount += 1;
      if (item.game_app_id !== null) {
        tradingCardGameIds.add(item.game_app_id);
      }
      if (item.gem_yield !== null) {
        gemPricedItemCount += 1;
      }
      if (item.gem_cash_value !== null) {
        gemCashValueCount += 1;
      }
      if (item.game_app_id !== null && item.card_rarity !== null) {
        const groupKey = `${item.game_app_id}:${item.card_rarity}`;
        const existingYield = gemYieldsByGroup.get(groupKey);
        if (
          typeof existingYield !== "undefined" &&
          existingYield !== item.gem_yield
        ) {
          return false;
        }
        gemYieldsByGroup.set(groupKey, item.gem_yield);
      }
      if (
        item.gem_yield !== null &&
        check.gem_cash_context !== null &&
        item.gem_cash_value !==
        gemCashValueForYield(
          item.gem_yield,
          check.gem_cash_context.sack_price
        )
      ) {
        return false;
      }
      if (
        (item.gem_yield === null || check.gem_cash_context === null) &&
        item.gem_cash_value !== null
      ) {
        return false;
      }
    }
  }

  if (
    [...boosterKeys].some((gameAppId) => !tradingCardGameIds.has(gameAppId)) ||
    gemCashValueCount > gemPricedItemCount ||
    (gemCashValueCount > 0 && check.gem_cash_context === null) ||
    (tradingCardCount === 0 && check.gem_cash_context !== null)
  ) {
    return false;
  }

  return (
    check.items.length === check.unique_item_count &&
    totalAssetCount === check.total_asset_count &&
    check.priced_item_count <= check.priceable_item_count &&
    check.priceable_item_count <= check.unique_item_count &&
    marketableItemCount === check.priceable_item_count &&
    pricedItemCount === check.priced_item_count &&
    check.gem_priceable_item_count === tradingCardCount &&
    check.gem_priced_item_count === gemPricedItemCount &&
    check.gem_priced_item_count <= check.gem_priceable_item_count &&
    check.gem_priceable_item_count <= tradingCardCount &&
    (check.gem_status === "complete"
      ? check.gem_priced_item_count === check.gem_priceable_item_count
      : check.gem_status === "partial"
        ? check.gem_priced_item_count > 0 &&
        check.gem_priced_item_count < check.gem_priceable_item_count
        : check.gem_priced_item_count === 0 &&
        (check.gem_priceable_item_count > 0 || check.status !== "public"))
  );
}
function isCacheableInventory(value: unknown): value is InventoryCheck {
  return (
    isInventoryCheck(value) &&
    (value.status === "public" || value.status === "private")
  );
}
function isSessionResponse(value: unknown): value is SessionResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const session = value as {
    authenticated?: unknown;
    user?: unknown;
    checks?: unknown;
  };
  if (typeof session.authenticated !== "boolean") {
    return false;
  }

  if (!session.authenticated) {
    return true;
  }
  if ("inventory" in session) {
    return false;
  }
  if (
    typeof session.user !== "object" ||
    session.user === null ||
    typeof session.checks !== "object" ||
    session.checks === null
  ) {
    return false;
  }


  const user = session.user as Partial<SteamUser>;
  const checks = session.checks as {
    profile?: unknown;
    inventory?: unknown;
  };

  return (
    typeof user.steam_id === "string" &&
    user.steam_id.length > 0 &&
    !NON_ASCII_DECIMAL_PATTERN.test(user.steam_id) &&
    (typeof user.display_name === "string" || user.display_name === null) &&
    (typeof user.avatar_url === "string" || user.avatar_url === null) &&
    isVisibilityCheck(checks.profile) &&
    !("inventory" in checks)
  );
}
function isGemRefreshResponse(value: unknown): value is GemRefreshResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const refresh = value as Partial<GemRefreshResponse>;
  if (
    !Array.isArray(refresh.values) ||
    !isSafeInteger(refresh.pending_group_count, 0) ||
    !Array.isArray(refresh.boosters) ||
    !isSafeInteger(refresh.pending_booster_count, 0) ||
    typeof refresh.gem_rate_limited !== "boolean" ||
    typeof refresh.gem_retry_after_seconds === "undefined" ||
    (refresh.gem_retry_after_seconds !== null &&
      !isSafeInteger(refresh.gem_retry_after_seconds, 0)) ||
    (!refresh.gem_rate_limited &&
      refresh.gem_retry_after_seconds !== null)
  ) {
    return false;
  }

  const keys = new Set<string>();
  for (const entry of refresh.values) {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const candidate = entry as Partial<GemRefreshValue>;
    if (
      !isDecimalString(candidate.game_app_id) ||
      (candidate.card_rarity !== "normal" &&
        candidate.card_rarity !== "foil") ||
      !isSafeInteger(candidate.gem_yield, 0)
    ) {
      return false;
    }
    const key = `${candidate.game_app_id}:${candidate.card_rarity}`;
    if (keys.has(key)) {
      return false;
    }
    keys.add(key);
  }

  const boosterKeys = new Set<string>();
  for (const entry of refresh.boosters) {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const candidate = entry as Partial<BoosterRefreshValue>;
    if (
      !isDecimalString(candidate.game_app_id) ||
      !isBoosterDerivation(candidate.card_set_size, candidate.gem_cost)
    ) {
      return false;
    }
    if (boosterKeys.has(candidate.game_app_id)) {
      return false;
    }
    boosterKeys.add(candidate.game_app_id);
  }

  return true;
}

function gemRefreshGroups(items: InventoryItem[]): GemRefreshGroup[] {
  const groups = new Map<string, GemRefreshGroup>();
  for (const item of items) {
    if (
      item.item_type !== "trading_card" ||
      item.game_app_id === null ||
      item.card_rarity === null
    ) {
      continue;
    }
    const key = `${item.game_app_id}:${item.card_rarity}`;
    groups.set(key, {
      game_app_id: item.game_app_id,
      card_rarity: item.card_rarity
    });
  }
  return [...groups.values()].sort((left, right) => {
    const appComparison = compareDecimalStrings(
      left.game_app_id,
      right.game_app_id
    );
    return appComparison === 0
      ? left.card_rarity.localeCompare(right.card_rarity)
      : appComparison;
  });
}

async function requestGemRefresh(
  inventory: InventoryCheck
): Promise<GemRefreshResponse> {
  const groups = gemRefreshGroups(inventory.items);
  const response = await fetch(GEM_REFRESH_URL, {
    body: JSON.stringify({ groups }),
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  if (!response.ok) {
    throw new Error("The gem refresh service returned an error.");
  }
  const payload: unknown = await response.json();
  if (!isGemRefreshResponse(payload)) {
    throw new Error("The gem refresh service returned an invalid response.");
  }
  const requestedKeys = new Set(
    groups.map((group) => `${group.game_app_id}:${group.card_rarity}`)
  );
  const requestedBoosterIds = new Set(
    groups.map((group) => group.game_app_id)
  );
  if (
    payload.values.length > groups.length ||
    payload.values.some(
      (entry) =>
        !requestedKeys.has(`${entry.game_app_id}:${entry.card_rarity}`)
    ) ||
    payload.boosters.length > requestedBoosterIds.size ||
    payload.boosters.some(
      (entry) => !requestedBoosterIds.has(entry.game_app_id)
    )
  ) {
    throw new Error("The gem refresh service returned unrequested values.");
  }
  return payload;
}

function mergeGemRefresh(
  inventory: InventoryCheck,
  refresh: GemRefreshResponse
): InventoryCheck {
  const yields = new Map<string, number>(
    refresh.values.map(
      (entry) =>
        [`${entry.game_app_id}:${entry.card_rarity}`, entry.gem_yield] as const
    )
  );
  const boosterValues = new Map<string, BoosterRefreshValue>(
    refresh.boosters.map(
      (entry) => [entry.game_app_id, entry] as const
    )
  );
  const items = inventory.items.map((item) => {
    if (
      item.item_type !== "trading_card" ||
      item.game_app_id === null ||
      item.card_rarity === null
    ) {
      return item;
    }
    const key = `${item.game_app_id}:${item.card_rarity}`;
    if (!yields.has(key)) {
      return item;
    }
    const gemYield = yields.get(key);
    if (typeof gemYield !== "number") {
      return item;
    }
    return {
      ...item,
      gem_yield: gemYield,
      gem_cash_value:
        inventory.gem_cash_context === null
          ? null
          : gemCashValueForYield(
            gemYield,
            inventory.gem_cash_context.sack_price
          )
    };
  });
  const boosters = inventory.boosters.map((booster) => {
    const refreshedBooster = boosterValues.get(booster.game_app_id);
    if (typeof refreshedBooster === "undefined") {
      return booster;
    }
    return {
      ...booster,
      card_set_size: refreshedBooster.card_set_size,
      gem_cost: refreshedBooster.gem_cost
    };
  });
  const gemPriceableCount = items.filter(
    (item) => item.item_type === "trading_card"
  ).length;
  const gemPricedCount = items.filter(
    (item) =>
      item.item_type === "trading_card" && item.gem_yield !== null
  ).length;
  const gemStatus: GemStatus =
    gemPriceableCount === 0 || gemPricedCount === gemPriceableCount
      ? "complete"
      : gemPricedCount > 0
        ? "partial"
        : "unavailable";
  const gemMessage =
    gemStatus === "complete"
      ? gemPriceableCount === 0
        ? "No trading cards require gem prices."
        : "Gem prices are current for all trading cards."
      : refresh.pending_group_count > 0
        ? "Background gem pricing is still processing uncached card groups."
        : "Gem prices are unavailable for some trading cards.";
  return {
    ...inventory,
    items,
    boosters,
    gem_status: gemStatus,
    gem_message: gemMessage,
    gem_priceable_item_count: gemPriceableCount,
    gem_priced_item_count: gemPricedCount,
    gem_rate_limited: refresh.gem_rate_limited,
    gem_retry_after_seconds: refresh.gem_retry_after_seconds
  };
}

class InventorySessionChangedError extends Error { }


async function requestSession(signal?: AbortSignal): Promise<SessionResponse> {
  const response = await fetch(SESSION_URL, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal
  });

  if (!response.ok) {
    throw new Error("The session service returned an error.");
  }

  const payload: unknown = await response.json();
  if (!isSessionResponse(payload)) {
    throw new Error("The session service returned an invalid response.");
  }

  return payload;
}

async function requestInventory(
  steamId: string,
  signal?: AbortSignal
): Promise<InventoryCheck> {
  const response = await fetch(INVENTORY_URL, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Expected-Steam-ID": steamId
    },
    method: "POST",
    signal
  });

  if (response.status === 401) {
    throw new InventorySessionChangedError();
  }
  if (!response.ok) {
    throw new Error("The inventory service returned an error.");
  }

  const payload: unknown = await response.json();
  if (!isInventoryCheck(payload)) {
    throw new Error("The inventory service returned an invalid response.");
  }

  return payload;
}

function secondsUntilDeadline(deadlineMs: number | null, nowMs: number): number {
  if (deadlineMs === null) {
    return 0;
  }

  return Math.max(
    0,
    Math.ceil((deadlineMs - nowMs) / MILLISECONDS_PER_SECOND)
  );
}

type PageKind = "home" | "faq";

function Brand({ currentPage }: { currentPage: PageKind }) {
  return (
    <a
      className="brand"
      href="/"
      aria-label="Steam Optimizer home"
      aria-current={currentPage === "home" ? "page" : undefined}
    >
      <span className="brand-mark" aria-hidden="true">
        SO
      </span>
      <span className="brand-name">Steam Optimizer</span>
    </a>
  );
}

function SiteHeader({
  currentPage,
  children
}: {
  currentPage: PageKind;
  children?: ReactNode;
}) {
  return (
    <header className="site-header">
      <Brand currentPage={currentPage} />
      <div className="site-header-actions">
        <nav className="primary-nav" aria-label="Primary navigation">
          <a
            className="nav-link"
            href="/faq"
            aria-current={currentPage === "faq" ? "page" : undefined}
          >
            FAQ
          </a>
        </nav>
        {children}
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>Steam Optimizer</p>
      <div className="footer-links">
        <a href="/faq">FAQ</a>
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
          Privacy &amp; Steam data terms
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      </div>
    </footer>
  );
}

function LoadingView() {
  return (
    <section className="session-status" aria-label="Steam session">
      <p className="loading-indicator">
        <span className="loading-dot" aria-hidden="true" />
        Checking your Steam session…
      </p>
    </section>
  );
}

function ApiUnavailableView({ onRetry }: { onRetry: () => void }) {
  return (
    <section
      className="session-alert"
      aria-labelledby="unavailable-title"
    >
      <div>
        <h2 id="unavailable-title">Steam connection is unavailable.</h2>
        <p>
          The session service could not be reached. This is not a Steam privacy
          result.
        </p>
      </div>
      <button className="secondary-action" type="button" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

function SteamIdentity({
  user,
  isSigningOut,
  isBusy,
  onLogout
}: {
  user: SteamUser;
  isSigningOut: boolean;
  isBusy: boolean;
  onLogout: () => void;
}) {
  const displayName = user.display_name?.trim() || "Steam member";
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <details className="account-menu">
      <summary
        className="identity-trigger"
        aria-label={`Connected Steam account: ${displayName}`}
      >
        {user.avatar_url ? (
          <img className="avatar" src={user.avatar_url} alt="" />
        ) : (
          <span className="avatar avatar-fallback" aria-hidden="true">
            {initials}
          </span>
        )}
        <span className="identity-name">{displayName}</span>
        <span className="identity-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="account-popover">
        <p className="section-label">Connected Steam account</p>
        <p className="account-name">{displayName}</p>
        <p className="steam-id">Steam ID {user.steam_id}</p>
        <button
          className="text-action"
          type="button"
          onClick={onLogout}
          disabled={isSigningOut || isBusy}
        >
          {isSigningOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </details>
  );
}

function AccessSummary({
  profile,
  inventory,
  isInventoryLoading
}: {
  profile: VisibilityCheck;
  inventory: InventoryCheck | null;
  isInventoryLoading: boolean;
}) {
  const inventoryStatus = inventory?.status ?? "unavailable";
  const inventoryStatusLabel =
    inventory === null
      ? isInventoryLoading
        ? "Checking…"
        : "Unavailable"
      : inventory.status === "unavailable" && inventory.rate_limited
        ? "Try later"
        : STATUS_LABELS[inventory.status];

  return (
    <dl className="access-summary" aria-label="Steam access status">
      <div className={`access-summary-item access-summary-${profile.status}`}>
        <dt>Profile</dt>
        <dd
          className={`access-badge access-badge-${profile.status}`}
          aria-label={`Steam profile: ${STATUS_LABELS[profile.status]}`}
        >
          <span className="status-dot" aria-hidden="true" />
          {STATUS_LABELS[profile.status]}
        </dd>
      </div>
      <div
        className={`access-summary-item access-summary-${inventoryStatus}`}
      >
        <dt>Inventory</dt>
        <dd
          className={`access-badge access-badge-${inventoryStatus}`}
          aria-label={`Steam inventory: ${inventoryStatusLabel}`}
        >
          <span className="status-dot" aria-hidden="true" />
          {inventoryStatusLabel}
        </dd>
      </div>
    </dl>
  );
}

function formatPriceTimestamp(observedAt: string): string {
  const observedDate = new Date(observedAt);
  return Number.isNaN(observedDate.getTime())
    ? observedAt
    : PRICE_TIMESTAMP_FORMATTER.format(observedDate);
}

function compareDecimalStrings(left: string, right: string): number {
  const [leftInteger, leftFraction = ""] = left.split(".");
  const [rightInteger, rightFraction = ""] = right.split(".");

  if (leftInteger.length !== rightInteger.length) {
    return leftInteger.length - rightInteger.length;
  }

  const integerComparison = leftInteger.localeCompare(rightInteger);
  if (integerComparison !== 0) {
    return integerComparison;
  }

  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction
    .padEnd(fractionLength, "0")
    .localeCompare(rightFraction.padEnd(fractionLength, "0"));
}

function isWorthMoreAsGems(item: InventoryItem): boolean {
  if (
    item.item_type !== "trading_card" ||
    !item.marketable ||
    item.gem_cash_value === null ||
    item.price === null ||
    item.price.lowest_sell === null
  ) {
    return false;
  }

  return compareDecimalStrings(item.gem_cash_value, item.price.lowest_sell) > 0;
}

function comparePriceTimestamps(left: string, right: string): number {
  const leftTimestamp = Date.parse(left);
  const rightTimestamp = Date.parse(right);
  const leftIsValid = !Number.isNaN(leftTimestamp);
  const rightIsValid = !Number.isNaN(rightTimestamp);

  if (leftIsValid && rightIsValid) {
    return leftTimestamp - rightTimestamp;
  }
  if (leftIsValid !== rightIsValid) {
    return leftIsValid ? -1 : 1;
  }
  return left.localeCompare(right);
}

function compareNullableValues<T>(
  left: T | null,
  right: T | null,
  direction: SortDirection,
  compare: (first: T, second: T) => number
): number {
  if (left === null) {
    return right === null ? 0 : 1;
  }
  if (right === null) {
    return -1;
  }

  const comparison = compare(left, right);
  return direction === "ascending" ? comparison : -comparison;
}

function compareInventoryItems(
  left: InventoryItem,
  right: InventoryItem,
  sort: InventorySort
): number {
  switch (sort.field) {
    case "name":
      return compareNullableValues(
        left.name,
        right.name,
        sort.direction,
        INVENTORY_NAME_COLLATOR.compare
      );
    case "quantity":
      return compareNullableValues(
        left.quantity,
        right.quantity,
        sort.direction,
        (first, second) => first - second
      );
    case "marketable":
      return compareNullableValues(
        left.marketable ? "Marketable" : "Nonmarketable",
        right.marketable ? "Marketable" : "Nonmarketable",
        sort.direction,
        INVENTORY_NAME_COLLATOR.compare
      );
    case "highest_buy":
      return compareNullableValues(
        left.price?.highest_buy ?? null,
        right.price?.highest_buy ?? null,
        sort.direction,
        compareDecimalStrings
      );
    case "lowest_sell":
      return compareNullableValues(
        left.price?.lowest_sell ?? null,
        right.price?.lowest_sell ?? null,
        sort.direction,
        compareDecimalStrings
      );
    case "observed_at":
      return compareNullableValues(
        left.price?.observed_at ?? null,
        right.price?.observed_at ?? null,
        sort.direction,
        comparePriceTimestamps
      );
    case "gem_yield":
      return compareNullableValues(
        left.gem_yield,
        right.gem_yield,
        sort.direction,
        (first, second) => first - second
      );
    case "gem_cash_value":
      return compareNullableValues(
        left.gem_cash_value,
        right.gem_cash_value,
        sort.direction,
        compareDecimalStrings
      );
  }
}

function InventoryColumnHeader({
  field,
  label,
  sort,
  onSort
}: {
  field: InventorySortField;
  label: string;
  sort: InventorySort | null;
  onSort: (field: InventorySortField) => void;
}) {
  const direction = sort?.field === field ? sort.direction : null;
  const nextDirection = direction === "ascending" ? "descending" : "ascending";

  return (
    <th scope="col" aria-sort={direction ?? "none"}>
      <button
        className="inventory-sort-button"
        type="button"
        onClick={() => onSort(field)}
        aria-label={`Sort by ${label}, ${nextDirection}`}
      >
        <span aria-hidden="true">{label}</span>
        <span className="inventory-sort-arrows" aria-hidden="true">
          <span
            className={`inventory-sort-arrow${direction === "ascending" ? " inventory-sort-arrow-active" : ""}`}
          >
            ▲
          </span>
          <span
            className={`inventory-sort-arrow${direction === "descending" ? " inventory-sort-arrow-active" : ""}`}
          >
            ▼
          </span>
        </span>
      </button>
    </th>
  );
}
function InventoryItemRow({ item }: { item: InventoryItem }) {
  const unavailableLabel = item.marketable ? "Unavailable" : "Not applicable";
  const highestBuy = item.price?.highest_buy;
  const lowestSell = item.price?.lowest_sell;
  const observedAt = item.price?.observed_at;
  const marketHashName =
    item.market_hash_name !== null && item.market_hash_name !== item.name
      ? item.market_hash_name
      : null;
  const gemValue =
    item.item_type === "other"
      ? "Not applicable"
      : item.gem_yield === null
        ? "Unavailable"
        : INVENTORY_COUNT_FORMATTER.format(item.gem_yield);
  const gemCashValue =
    item.item_type === "other"
      ? "Not applicable"
      : item.gem_cash_value ?? "Unavailable";
  const cardRarity =
    item.item_type === "trading_card" && item.card_rarity !== null
      ? `${item.card_rarity === "foil" ? "Foil" : "Normal"} card`
      : null;

  return (
    <tr className={`inventory-item inventory-item-${item.item_type}`}>
      <th className="inventory-item-name-cell" scope="row">
        <div className="inventory-item-name">
          {item.icon_url !== null && (
            <img
              className="inventory-item-icon"
              src={`${item.icon_url}/64fx64f`}
              alt=""
              loading="lazy"
              decoding="async"
            />
          )}
          <div>
            <strong>{item.name}</strong>
            {cardRarity !== null && (
              <span className="card-rarity-label">{cardRarity}</span>
            )}
            {marketHashName !== null && (
              <span className="market-hash-name">{marketHashName}</span>
            )}
          </div>
        </div>
      </th>
      <td className="inventory-item-field">
        <span className="inventory-field-label">Quantity</span>
        <span className="inventory-quantity">
          {INVENTORY_COUNT_FORMATTER.format(item.quantity)}
        </span>
      </td>
      <td className="inventory-item-field">
        <span className="inventory-field-label">Marketability</span>
        <span
          className={`marketability-label ${item.marketable
            ? "marketability-label-public"
            : "marketability-label-unavailable"
            }`}
        >
          {item.marketable ? "Marketable" : "Nonmarketable"}
        </span>
      </td>
      <td className="inventory-item-field inventory-price-value">
        <span className="inventory-field-label">Highest buy</span>
        <span>
          {typeof highestBuy === "string" ? highestBuy : unavailableLabel}
        </span>
      </td>
      <td className="inventory-item-field inventory-price-value">
        <span className="inventory-field-label">Lowest sell</span>
        <span>
          {typeof lowestSell === "string" ? lowestSell : unavailableLabel}
        </span>
      </td>
      <td className="inventory-item-field inventory-observed-at">
        <span className="inventory-field-label">Price timestamp</span>
        {typeof observedAt === "string" && observedAt.length > 0 ? (
          <time dateTime={observedAt}>{formatPriceTimestamp(observedAt)}</time>
        ) : (
          <span>{unavailableLabel}</span>
        )}
      </td>
      <td className="inventory-item-field inventory-gem-value">
        <span className="inventory-field-label">Gem value</span>
        <span>{gemValue}</span>
      </td>
      <td className="inventory-item-field inventory-gem-cash-value">
        <span className="inventory-field-label">Gem cash value</span>
        <span>{gemCashValue}</span>
      </td>
    </tr>
  );
}

type InventoryGroupKind = "game" | "fallback" | "other";

type InventoryGroup = {
  key: string;
  kind: InventoryGroupKind;
  game_app_id: string | null;
  game_name: string | null;
  items: InventoryItem[];
};

function groupInventoryItems(
  items: InventoryItem[],
  sort: InventorySort | null
): InventoryGroup[] {
  const groupsByKey = new Map<string, InventoryGroup>();

  for (const item of items) {
    const key =
      item.item_type === "other"
        ? "other"
        : item.game_app_id === null
          ? "trading-card-fallback"
          : `game:${item.game_app_id}`;
    const existingGroup = groupsByKey.get(key);

    if (existingGroup !== undefined) {
      existingGroup.items.push(item);
      const existingGameName = existingGroup.game_name;
      if (
        item.game_name !== null &&
        (existingGameName === null ||
          INVENTORY_NAME_COLLATOR.compare(item.game_name, existingGameName) < 0)
      ) {
        existingGroup.game_name = item.game_name.trim();
      }
      continue;
    }
    groupsByKey.set(key, {
      key,
      kind:
        item.item_type === "other"
          ? "other"
          : item.game_app_id === null
            ? "fallback"
            : "game",
      game_app_id: item.item_type === "other" ? null : item.game_app_id,
      game_name:
        item.item_type === "other" || item.game_name === null
          ? null
          : item.game_name.trim(),
      items: [item]
    });
  }

  const groups = [...groupsByKey.values()];
  groups.sort((left, right) => {
    if (left.kind === "other") {
      return right.kind === "other" ? 0 : 1;
    }
    if (right.kind === "other") {
      return -1;
    }
    if (left.kind === "game" && right.kind === "fallback") {
      return -1;
    }
    if (left.kind === "fallback" && right.kind === "game") {
      return 1;
    }
    if (left.game_name !== null && right.game_name !== null) {
      const nameComparison = INVENTORY_NAME_COLLATOR.compare(
        left.game_name,
        right.game_name
      );
      if (nameComparison !== 0) {
        return nameComparison;
      }
    } else if (left.game_name !== null) {
      return -1;
    } else if (right.game_name !== null) {
      return 1;
    }
    if (left.game_app_id !== null && right.game_app_id !== null) {
      return compareDecimalStrings(left.game_app_id, right.game_app_id);
    }
    if (left.game_app_id !== null) {
      return -1;
    }
    if (right.game_app_id !== null) {
      return 1;
    }
    return left.key.localeCompare(right.key);
  });

  return groups.map((group) => ({
    ...group,
    items:
      sort === null
        ? group.items
        : [...group.items].sort((left, right) =>
          compareInventoryItems(left, right, sort)
        )
  }));
}

function InventoryBrowser({ items }: { items: InventoryItem[] }) {
  const [requestedPageIndex, setRequestedPageIndex] = useState(0);
  const [knownPageCount, setKnownPageCount] = useState(() =>
    Math.max(1, Math.ceil(items.length / INVENTORY_PAGE_SIZE))
  );
  const [sort, setSort] = useState<InventorySort | null>(null);
  const [groupByGame, setGroupByGame] = useState(true);
  const [activeView, setActiveView] = useState<InventoryView>("all");
  const tabRefs = useRef<Record<InventoryView, HTMLButtonElement | null>>({
    all: null,
    "worth-more-as-gems": null
  });
  const allItemsPanelRef = useRef<HTMLDivElement>(null);
  const worthMoreAsGemsPanelRef = useRef<HTMLDivElement>(null);
  const focusWasWithinActivePanel = useRef(false);
  const worthMoreAsGemsItems = useMemo(
    () => items.filter(isWorthMoreAsGems),
    [items]
  );
  const activeItems =
    activeView === "all" ? items : worthMoreAsGemsItems;

  function activateInventoryView(view: InventoryView, focusTab = false) {
    setActiveView(view);
    setRequestedPageIndex(0);
    if (focusTab) {
      tabRefs.current[view]?.focus();
    }
  }

  const groupedItems = useMemo(
    () =>
      groupByGame
        ? groupInventoryItems(activeItems, sort)
        : [
          {
            key: "all",
            kind: "other" as const,
            game_app_id: null,
            game_name: null,
            items:
              sort === null
                ? activeItems
                : [...activeItems].sort((left, right) =>
                  compareInventoryItems(left, right, sort)
                )
          }
        ],
    [activeItems, groupByGame, sort]
  );
  const pageCount = Math.max(
    1,
    Math.ceil(activeItems.length / INVENTORY_PAGE_SIZE)
  );
  if (knownPageCount !== pageCount) {
    setKnownPageCount(pageCount);
    setRequestedPageIndex((currentIndex) =>
      Math.min(currentIndex, pageCount - 1)
    );
  }
  const pageIndex = Math.min(requestedPageIndex, pageCount - 1);
  useEffect(() => {
    const activePanel =
      activeView === "all"
        ? allItemsPanelRef.current
        : worthMoreAsGemsPanelRef.current;
    if (
      focusWasWithinActivePanel.current &&
      document.activeElement === document.body
    ) {
      activePanel?.focus();
    }
  }, [activeItems.length, activeView, pageCount]);

  const firstItemIndex = pageIndex * INVENTORY_PAGE_SIZE;
  const lastItemIndex = Math.min(
    firstItemIndex + INVENTORY_PAGE_SIZE,
    activeItems.length
  );
  const visibleGroups = useMemo(() => {
    let remainingOffset = firstItemIndex;
    let remainingItems = INVENTORY_PAGE_SIZE;
    const pageGroups: InventoryGroup[] = [];

    for (const group of groupedItems) {
      if (remainingItems === 0) {
        break;
      }
      if (remainingOffset >= group.items.length) {
        remainingOffset -= group.items.length;
        continue;
      }

      const pageItems = group.items.slice(
        remainingOffset,
        remainingOffset + remainingItems
      );
      if (pageItems.length > 0) {
        pageGroups.push({ ...group, items: pageItems });
        remainingItems -= pageItems.length;
      }
      remainingOffset = 0;
    }

    return pageGroups;
  }, [firstItemIndex, groupedItems]);

  function handleSort(field: InventorySortField) {
    setSort((currentSort) => ({
      field,
      direction:
        currentSort?.field === field && currentSort.direction === "ascending"
          ? "descending"
          : "ascending"
    }));
    setRequestedPageIndex(0);
  }

  function renderInventoryLedger() {
    if (activeItems.length === 0) {
      return null;
    }

    return (
      <>
        <p
          className="inventory-page-status"
          role="status"
          aria-label="Inventory pagination status"
          aria-live="polite"
          aria-atomic="true"
        >
          Showing {INVENTORY_COUNT_FORMATTER.format(firstItemIndex + 1)}–
          {INVENTORY_COUNT_FORMATTER.format(lastItemIndex)} of{" "}
          {INVENTORY_COUNT_FORMATTER.format(activeItems.length)}. Page{" "}
          {pageIndex + 1} of {pageCount}.
        </p>

        {pageCount > 1 && (
          <nav className="inventory-pagination" aria-label="Inventory pages">
            <button
              className="secondary-action"
              type="button"
              onClick={() => setRequestedPageIndex(pageIndex - 1)}
              disabled={pageIndex === 0}
              aria-label="Previous inventory page"
            >
              Previous
            </button>
            <label className="inventory-page-picker">
              <span>Page</span>
              <select
                value={pageIndex + 1}
                onChange={(event) =>
                  setRequestedPageIndex(Number(event.currentTarget.value) - 1)
                }
                aria-label="Inventory page"
              >
                {Array.from({ length: pageCount }, (_, index) => (
                  <option key={index} value={index + 1}>
                    {index + 1}
                  </option>
                ))}
              </select>
              <span>of {pageCount}</span>
            </label>
            <button
              className="secondary-action"
              type="button"
              onClick={() => setRequestedPageIndex(pageIndex + 1)}
              disabled={pageIndex === pageCount - 1}
              aria-label="Next inventory page"
            >
              Next
            </button>
          </nav>
        )}

        <table className="inventory-table" aria-labelledby="inventory-items-title">
          <colgroup>
            <col className="inventory-column-item" />
            <col className="inventory-column-quantity" />
            <col className="inventory-column-marketability" />
            <col className="inventory-column-price" />
            <col className="inventory-column-price" />
            <col className="inventory-column-timestamp" />
            <col className="inventory-column-gem" />
            <col className="inventory-column-gem-cash" />
          </colgroup>
          <thead>
            <tr>
              {INVENTORY_COLUMNS.map((column) => (
                <InventoryColumnHeader
                  key={column.field}
                  field={column.field}
                  label={column.label}
                  sort={sort}
                  onSort={handleSort}
                />
              ))}
            </tr>
          </thead>
          {visibleGroups.map((group) => {
            const headingId = `inventory-group-${group.key.replace(
              /[^a-zA-Z0-9_-]/g,
              "-"
            )}`;
            const groupLabel =
              group.kind === "other"
                ? "Other inventory items"
                : group.game_name !== null
                  ? group.game_name
                  : group.game_app_id !== null
                    ? `Trading cards (unknown game, App ID ${group.game_app_id})`
                    : "Trading cards (game unavailable)";

            return (
              <tbody
                key={group.key}
                aria-labelledby={groupByGame ? headingId : undefined}
              >
                {groupByGame && (
                  <tr className="inventory-group-header">
                    <th
                      id={headingId}
                      scope="rowgroup"
                      colSpan={INVENTORY_COLUMNS.length}
                    >
                      {groupLabel}
                    </th>
                  </tr>
                )}
                {group.items.map((item) => (
                  <InventoryItemRow
                    key={`${item.class_id}:${item.instance_id}`}
                    item={item}
                  />
                ))}
              </tbody>
            );
          })}
        </table>
      </>
    );
  }

  return (
    <section className="inventory-browser" aria-labelledby="inventory-items-title">
      <div className="inventory-browser-heading">
        <h3 id="inventory-items-title" className="visually-hidden">
          Inventory items
        </h3>
        <div className="inventory-browser-settings">
          <label className="inventory-group-setting">
            <input
              type="checkbox"
              checked={groupByGame}
              onChange={(event) => {
                setGroupByGame(event.currentTarget.checked);
                setRequestedPageIndex(0);
              }}
            />
            <span>Group by game</span>
          </label>
        </div>
      </div>

      <div
        className="inventory-view-tabs"
        role="tablist"
        aria-label="Inventory views"
      >
        {INVENTORY_VIEWS.map((view, index) => {
          const isActive = activeView === view.key;
          const itemCount =
            view.key === "all"
              ? items.length
              : worthMoreAsGemsItems.length;

          return (
            <button
              key={view.key}
              ref={(element) => {
                tabRefs.current[view.key] = element;
              }}
              className="inventory-view-tab"
              id={view.tabId}
              type="button"
              role="tab"
              aria-controls={view.panelId}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => activateInventoryView(view.key, true)}
              onKeyDown={(event) => {
                let nextIndex: number | null = null;

                if (event.key === "ArrowLeft") {
                  nextIndex =
                    (index - 1 + INVENTORY_VIEWS.length) %
                    INVENTORY_VIEWS.length;
                } else if (event.key === "ArrowRight") {
                  nextIndex = (index + 1) % INVENTORY_VIEWS.length;
                } else if (event.key === "Home") {
                  nextIndex = 0;
                } else if (event.key === "End") {
                  nextIndex = INVENTORY_VIEWS.length - 1;
                }

                if (nextIndex === null) {
                  return;
                }

                event.preventDefault();
                activateInventoryView(
                  INVENTORY_VIEWS[nextIndex].key,
                  true
                );
              }}
            >
              <span>{view.label}</span>
              <span className="inventory-view-tab-count">
                ({INVENTORY_COUNT_FORMATTER.format(itemCount)})
              </span>
            </button>
          );
        })}
      </div>

      <div
        ref={allItemsPanelRef}
        className="inventory-view-panel"
        id="inventory-panel-all"
        role="tabpanel"
        aria-labelledby="inventory-tab-all"
        tabIndex={activeView === "all" ? 0 : -1}
        hidden={activeView !== "all"}
        onFocusCapture={() => {
          focusWasWithinActivePanel.current = true;
        }}
        onBlurCapture={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            focusWasWithinActivePanel.current = false;
          }
        }}
      >
        {activeView === "all" && renderInventoryLedger()}
      </div>

      <div
        ref={worthMoreAsGemsPanelRef}
        className="inventory-view-panel"
        id="inventory-panel-worth-gems"
        role="tabpanel"
        aria-labelledby="inventory-tab-worth-gems"
        tabIndex={activeView === "worth-more-as-gems" ? 0 : -1}
        hidden={activeView !== "worth-more-as-gems"}
        onFocusCapture={() => {
          focusWasWithinActivePanel.current = true;
        }}
        onBlurCapture={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            focusWasWithinActivePanel.current = false;
          }
        }}
      >
        {activeView === "worth-more-as-gems" && (
          <>
            <p
              className="visually-hidden"
              role="status"
              aria-label="Worth more as gems result count"
              aria-live="polite"
              aria-atomic="true"
            >
              {worthMoreAsGemsItems.length === 0
                ? "No item types are currently worth more as gems."
                : `${INVENTORY_COUNT_FORMATTER.format(
                  worthMoreAsGemsItems.length
                )} item ${worthMoreAsGemsItems.length === 1 ? "type is" : "types are"
                } currently worth more as gems.`}
            </p>
            {activeItems.length === 0 ? (
              <div className="inventory-filtered-empty">
                <h4>No items are worth more as gems</h4>
                <p>
                  No marketable trading card with both a gem cash value and a
                  current lowest-sell market price currently qualifies. Review
                  All items to see every returned item type.
                </p>
              </div>
            ) : (
              renderInventoryLedger()
            )}
          </>
        )}
      </div>

    </section>
  );
}

function BoosterResults({ boosters }: { boosters: BoosterInfo[] }) {
  return (
    <section
      className="booster-coverage"
      aria-labelledby="booster-coverage-title"
    >
      <div className="booster-coverage-heading">
        <div>
          <p className="section-label">Booster packs</p>
          <h3 id="booster-coverage-title">Booster details by game</h3>
        </div>
        <p>
          {INVENTORY_COUNT_FORMATTER.format(boosters.length)} game
          {boosters.length === 1 ? "" : "s"} with trading-card data
        </p>
      </div>
      <p className="booster-coverage-copy">
        Gem cost is derived from the public normal-card set size. Every Steam
        booster pack contains three cards. Market prices are read-only SteamApis
        order-book values, and this feed does not identify the currency.
      </p>
      <div className="booster-grid">
        {boosters.map((booster) => {
          const gameLabel =
            booster.game_name?.trim() || `App ID ${booster.game_app_id}`;
          const headingId = `booster-game-${booster.game_app_id}`;
          const lowestSell = booster.price?.lowest_sell;
          const highestBuy = booster.price?.highest_buy;
          const observedAt = booster.price?.observed_at;

          return (
            <article
              className="booster-card"
              key={booster.game_app_id}
              aria-labelledby={headingId}
            >
              <div className="booster-card-heading">
                <div>
                  <h4 id={headingId}>{gameLabel}</h4>
                  <p>App ID {booster.game_app_id}</p>
                </div>
                <span className="booster-card-count">
                  {INVENTORY_COUNT_FORMATTER.format(booster.card_count)} cards
                </span>
              </div>
              <dl className="booster-summary">
                <div>
                  <dt>Lowest sell</dt>
                  <dd>{lowestSell ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Highest buy</dt>
                  <dd>{highestBuy ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Gem cost</dt>
                  <dd>
                    {booster.gem_cost === null
                      ? "Unavailable"
                      : INVENTORY_COUNT_FORMATTER.format(booster.gem_cost)}
                  </dd>
                </div>
                <div>
                  <dt>Cards in set</dt>
                  <dd>
                    {booster.card_set_size === null
                      ? "Unavailable"
                      : INVENTORY_COUNT_FORMATTER.format(booster.card_set_size)}
                  </dd>
                </div>
                <div>
                  <dt>Cards per booster</dt>
                  <dd>{INVENTORY_COUNT_FORMATTER.format(booster.card_count)}</dd>
                </div>
              </dl>
              {typeof observedAt === "string" && observedAt.length > 0 && (
                <p className="booster-observed-at">
                  Price observed{" "}
                  <time dateTime={observedAt}>
                    {formatPriceTimestamp(observedAt)}
                  </time>
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function InventoryPricingSummary({
  inventory,
  isRefreshingGems,
  onRefreshGems
}: {
  inventory: InventoryCheck;
  isRefreshingGems: boolean;
  onRefreshGems: () => void;
}) {
  const marketStatusLabel = PRICE_STATUS_LABELS[inventory.price_status];
  const gemStatusLabel = GEM_STATUS_LABELS[inventory.gem_status];
  const totalAssetCount = INVENTORY_COUNT_FORMATTER.format(
    inventory.total_asset_count
  );
  const marketPricingCount = `${INVENTORY_COUNT_FORMATTER.format(
    inventory.priced_item_count
  )}/${INVENTORY_COUNT_FORMATTER.format(inventory.priceable_item_count)}`;
  const gemPricingCount = `${INVENTORY_COUNT_FORMATTER.format(
    inventory.gem_priced_item_count
  )}/${INVENTORY_COUNT_FORMATTER.format(
    inventory.gem_priceable_item_count
  )}`;

  return (
    <div className="inventory-pricing-summary" aria-label="Inventory pricing summary">
      <dl className="inventory-pricing-metrics">
        <div
          className="inventory-pricing-stat inventory-pricing-stat-total"
          aria-label={`Total assets: ${totalAssetCount}`}
        >
          <dt>Items</dt>
          <dd>{totalAssetCount}</dd>
        </div>
        <div
          className={`inventory-pricing-stat inventory-pricing-stat-${inventory.price_status}`}
          aria-label={`Market pricing: ${marketStatusLabel}. ${marketPricingCount} item types priced`}
        >
          <dt>
            <span className="status-dot" aria-hidden="true" />
            Market
          </dt>
          <dd>{marketPricingCount}</dd>
        </div>
        <div
          className={`inventory-pricing-stat inventory-pricing-stat-${inventory.gem_status}`}
          aria-label={`Gem pricing: ${gemStatusLabel}. ${gemPricingCount} trading-card item types priced`}
        >
          <dt>
            <span className="status-dot" aria-hidden="true" />
            Gems
          </dt>
          <dd>{gemPricingCount}</dd>
        </div>
      </dl>
      <button
        className={`gem-refresh-button${isRefreshingGems ? " gem-refresh-button-active" : ""}`}
        type="button"
        onClick={onRefreshGems}
        disabled={isRefreshingGems || inventory.gem_priceable_item_count === 0}
        aria-label={
          isRefreshingGems ? "Refreshing gem values" : "Refresh gem values"
        }
        title="Refresh cached gem values"
      >
        <span aria-hidden="true">↻</span>
      </button>
    </div>
  );
}

function inventoryPriceCoverageMessage(inventory: InventoryCheck): string {
  return inventory.priceable_item_count === 0
    ? "No marketable item types require a price lookup."
    : `SteamApis price data is available for ${INVENTORY_COUNT_FORMATTER.format(
      inventory.priced_item_count
    )} of ${INVENTORY_COUNT_FORMATTER.format(
      inventory.priceable_item_count
    )} marketable item ${inventory.priceable_item_count === 1 ? "type" : "types"
    }.`;
}

function inventoryGemCoverageMessage(inventory: InventoryCheck): string {
  return inventory.gem_priceable_item_count === 0
    ? "No trading-card item types require a gem lookup."
    : `Gem values are available for ${INVENTORY_COUNT_FORMATTER.format(
      inventory.gem_priced_item_count
    )} of ${INVENTORY_COUNT_FORMATTER.format(
      inventory.gem_priceable_item_count
    )} trading-card item ${inventory.gem_priceable_item_count === 1 ? "type" : "types"
    }.`;
}

function InventoryResults({
  inventory,
  isRefreshingGems,
  refreshMessage,
  onRefreshGems
}: {
  inventory: InventoryCheck;
  isRefreshingGems: boolean;
  refreshMessage: string | null;
  onRefreshGems: () => void;
}) {
  const [activeResultView, setActiveResultView] =
    useState<InventoryResultView>("items");
  const resultTabRefs = useRef<
    Record<InventoryResultView, HTMLButtonElement | null>
  >({
    items: null,
    boosters: null
  });

  function activateResultView(
    view: InventoryResultView,
    focusTab = false
  ) {
    setActiveResultView(view);
    if (focusTab) {
      resultTabRefs.current[view]?.focus();
    }
  }

  return (
    <section className="inventory-results" aria-labelledby="inventory-results-title">
      <div className="inventory-results-heading">
        <div>
          <p className="section-label">Inventory</p>
          <h2 id="inventory-results-title">Items and boosters</h2>
        </div>
        <InventoryPricingSummary
          inventory={inventory}
          isRefreshingGems={isRefreshingGems}
          onRefreshGems={onRefreshGems}
        />
      </div>
      {refreshMessage !== null && (
        <p className="inventory-refresh-status" aria-live="polite">
          {refreshMessage}
        </p>
      )}
      <div
        className="inventory-view-tabs inventory-result-tabs"
        role="tablist"
        aria-label="Inventory result views"
      >
        {INVENTORY_RESULT_VIEWS.map((view, index) => {
          const isActive = activeResultView === view.key;

          return (
            <button
              key={view.key}
              ref={(element) => {
                resultTabRefs.current[view.key] = element;
              }}
              className="inventory-view-tab"
              id={view.tabId}
              type="button"
              role="tab"
              aria-controls={view.panelId}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => activateResultView(view.key, true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activateResultView(view.key, true);
                  return;
                }

                let nextIndex: number | null = null;

                if (event.key === "ArrowLeft") {
                  nextIndex =
                    (index - 1 + INVENTORY_RESULT_VIEWS.length) %
                    INVENTORY_RESULT_VIEWS.length;
                } else if (event.key === "ArrowRight") {
                  nextIndex = (index + 1) % INVENTORY_RESULT_VIEWS.length;
                } else if (event.key === "Home") {
                  nextIndex = 0;
                } else if (event.key === "End") {
                  nextIndex = INVENTORY_RESULT_VIEWS.length - 1;
                }

                if (nextIndex === null) {
                  return;
                }

                event.preventDefault();
                resultTabRefs.current[
                  INVENTORY_RESULT_VIEWS[nextIndex].key
                ]?.focus();
              }}
            >
              {view.label}
            </button>
          );
        })}
      </div>

      <div
        className="inventory-view-panel"
        id="inventory-results-panel-items"
        role="tabpanel"
        aria-labelledby="inventory-results-tab-items"
        tabIndex={activeResultView === "items" ? 0 : -1}
        hidden={activeResultView !== "items"}
      >
        {inventory.items.length > 0 ? (
          <InventoryBrowser
            key={inventory.unique_item_count}
            items={inventory.items}
          />
        ) : (
          <div className="inventory-empty">
            <h3>No inventory items to display</h3>
            <p>
              Steam returned a public inventory with no items. Recheck after
              your inventory changes.
            </p>
          </div>
        )}
      </div>

      <div
        className="inventory-view-panel"
        id="inventory-results-panel-boosters"
        role="tabpanel"
        aria-labelledby="inventory-results-tab-boosters"
        tabIndex={activeResultView === "boosters" ? 0 : -1}
        hidden={activeResultView !== "boosters"}
      >
        {inventory.boosters.length > 0 ? (
          <BoosterResults boosters={inventory.boosters} />
        ) : (
          <div className="inventory-empty">
            <h3>No booster packs to display</h3>
            <p>
              No trading-card games were identified in this inventory, so
              there are no related booster packs to display.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
function InventoryFaq({
  profile,
  inventory
}: {
  profile: VisibilityCheck;
  inventory: InventoryCheck;
}) {
  const hasPrivateSurface =
    profile.status === "private" || inventory.status === "private";
  const gemCashContext = inventory.gem_cash_context;

  return (
    <section className="inventory-faq" aria-labelledby="faq-title">
      <div className="inventory-faq-heading">
        <p className="section-label">FAQ</p>
        <h2 id="faq-title">About these results</h2>
      </div>
      <div className="inventory-faq-list">
        <details className="inventory-faq-item">
          <summary>What do the Steam access statuses mean?</summary>
          <div className="inventory-faq-answer">
            <p>
              <strong>Public</strong> means Steam exposed that surface to the
              check. <strong>Private</strong> means Steam did not expose it.
              <strong> Unavailable</strong> means the service could not verify
              it and is not a privacy result.
            </p>
            <p>
              <strong>Profile check:</strong> {profile.message}
            </p>
            <p>
              <strong>Inventory check:</strong> {inventory.message}
            </p>
            {hasPrivateSurface && (
              <p>
                To change a private surface,{" "}
                <a href={STEAM_PRIVACY_URL} target="_blank" rel="noreferrer">
                  open Steam privacy settings
                  <span className="visually-hidden">
                    {" "}
                    (opens in a new tab)
                  </span>
                </a>{" "}
                and recheck Steam access.
              </p>
            )}
            {inventory.status === "unavailable" && inventory.rate_limited && (
              <p>
                Steam is temporarily limiting automated checks. This does not
                mean the inventory is private.
              </p>
            )}
          </div>
        </details>
        <details className="inventory-faq-item">
          <summary>How do the market and gem numbers work?</summary>
          <div className="inventory-faq-answer">
            <p>
              The Market number is priced marketable item types over
              priceable item types. The Gems number is priced trading-card item
              types over trading-card item types that can be checked.
            </p>
            <p>
              Worth more as gems compares each trading card&apos;s per-card gem
              cash value against its current lowest-sell market price. Missing
              values are excluded from this view.
            </p>
            <p>{inventoryPriceCoverageMessage(inventory)}</p>
            <p>
              SteamApis does not specify the market feed currency. Values are
              shown exactly as received, without a currency symbol.
            </p>
            {inventory.price_message.trim().length > 0 && (
              <p>
                <strong>Market note:</strong> {inventory.price_message}
              </p>
            )}
            <p>{inventoryGemCoverageMessage(inventory)}</p>
            <p>
              <a href="/faq#gem-values">How gem values work</a> explains the
              source data and replacement-cost calculation.
            </p>
            {inventory.gem_message.trim().length > 0 && (
              <p>
                <strong>Gem note:</strong> {inventory.gem_message}
              </p>
            )}
            {inventory.gem_rate_limited && (
              <p>
                Steam Community is temporarily rate-limiting gem lookups.
                Cached values remain available
                {inventory.gem_retry_after_seconds !== null
                  ? `; try again in ${inventory.gem_retry_after_seconds}s`
                  : ""}
                .
              </p>
            )}
            <p>
              Gem cash value uses the SteamApis lowest-sell basis for{" "}
              {GEM_CASH_MARKET_HASH_NAME} ({GEM_CASH_SACK_SIZE} gems). This feed
              has unknown currency. Each value is a per-card replacement-cost
              estimate.
            </p>
            {gemCashContext !== null && (
              <p>
                Current sack price: {gemCashContext.sack_price}
                {gemCashContext.observed_at !== null &&
                  gemCashContext.observed_at.length > 0 && (
                    <>
                      {" "}
                      <time dateTime={gemCashContext.observed_at}>
                        ({formatPriceTimestamp(gemCashContext.observed_at)})
                      </time>
                    </>
                  )}
                .
              </p>
            )}
          </div>
        </details>
        <details className="inventory-faq-item">
          <summary>Why can the item count differ from table rows?</summary>
          <div className="inventory-faq-answer">
            <p>
              Items is the total number of Steam assets. The table combines
              matching assets into distinct item types, so one row can
              represent more than one item.
            </p>
          </div>
        </details>
        <details className="inventory-faq-item">
          <summary>Can Steam Optimizer change my Steam account?</summary>
          <div className="inventory-faq-answer">
            <p>
              No. Steam Optimizer only reads information Steam exposes
              publicly. It cannot trade, sell, craft, or change your account.
              Any future account action stays manual and happens on Steam.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}


function SignedInView({
  session,
  inventoryState,
  isRechecking,
  isRefreshingInventory,
  isRefreshingGems,
  retryAfterSeconds,
  actionMessage,
  inventoryActionMessage,
  gemRefreshMessage,
  onRefreshInventory,
  onRefreshGems
}: {
  session: SignedInSession;
  inventoryState: InventoryState;
  isRechecking: boolean;
  isRefreshingInventory: boolean;
  isRefreshingGems: boolean;
  retryAfterSeconds: number;
  actionMessage: string | null;
  inventoryActionMessage: string | null;
  gemRefreshMessage: string | null;
  onRefreshInventory: () => void;
  onRefreshGems: () => void;
}) {
  const isInventoryRefreshDisabled =
    isRefreshingInventory ||
    inventoryState.isLoading ||
    isRechecking ||
    isRefreshingGems ||
    retryAfterSeconds > 0;

  return (
    <section className="account-view">
      {(isRechecking || actionMessage || inventoryActionMessage) && (
        <p
          className={`action-status${actionMessage || inventoryActionMessage
            ? " action-status-error"
            : ""
            }`}
          aria-live="polite"
        >
          {isRechecking
            ? "Rechecking Steam profile access…"
            : actionMessage ?? inventoryActionMessage}
        </p>
      )}

      {retryAfterSeconds > 0 && (
        <p id="inventory-cooldown" className="action-status cooldown-status">
          Repeated immediate inventory refreshes are disabled. Try again in{" "}
          {retryAfterSeconds}s.
        </p>
      )}
      <div className="inventory-cache-toolbar">
        <p className="inventory-cache-status" aria-live="polite">
          {inventoryState.refreshedAt !== null ? (
            <>
              Inventory last refreshed{" "}
              <time dateTime={inventoryState.refreshedAt}>
                {formatPriceTimestamp(inventoryState.refreshedAt)}
              </time>
              {inventoryState.source === "cache" ? " (cached)" : ""}.
            </>
          ) : inventoryState.isLoading ? (
            "Checking your Steam inventory…"
          ) : (
            inventoryState.message ?? "Inventory has not been loaded yet."
          )}
        </p>
        <button
          className="secondary-action"
          type="button"
          onClick={onRefreshInventory}
          disabled={isInventoryRefreshDisabled}
          aria-describedby={
            retryAfterSeconds > 0 ? "inventory-cooldown" : undefined
          }
        >
          {isRefreshingInventory
            ? "Refreshing inventory…"
            : inventoryState.isLoading
              ? "Checking inventory…"
              : "Refresh inventory"}
        </button>
      </div>

      {inventoryState.inventory?.status === "public" && (
        <InventoryResults
          inventory={inventoryState.inventory}
          isRefreshingGems={isRefreshingGems}
          refreshMessage={gemRefreshMessage}
          onRefreshGems={onRefreshGems}
        />
      )}
      {inventoryState.inventory !== null && (
        <InventoryFaq
          profile={session.checks.profile}
          inventory={inventoryState.inventory}
        />
      )}
    </section>
  );
}

function HomePage() {
  const [viewState, setViewState] = useState<ViewState>({ kind: "loading" });
  const [inventoryState, setInventoryState] = useState<InventoryState>({
    inventory: null,
    refreshedAt: null,
    source: null,
    isLoading: false,
    message: null
  });
  const [isRechecking, setIsRechecking] = useState(false);
  const [isRefreshingInventory, setIsRefreshingInventory] = useState(false);
  const [isRefreshingGems, setIsRefreshingGems] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [retryDeadlineMs, setRetryDeadlineMs] = useState<number | null>(null);
  const [countdownNowMs, setCountdownNowMs] = useState(() => performance.now());
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [inventoryActionMessage, setInventoryActionMessage] = useState<
    string | null
  >(null);
  const [gemRefreshMessage, setGemRefreshMessage] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("Checking session…");
  const retryDeadlineRef = useRef<number | null>(null);
  const recheckInFlightRef = useRef(false);
  const inventoryRefreshInFlightRef = useRef(false);
  const gemRefreshInFlightRef = useRef(false);
  const activeSteamIdRef = useRef<string | null>(null);
  const inventoryStateRef = useRef(inventoryState);
  const inventoryRequestTokenRef = useRef(0);
  const inventoryLoadPromiseRef = useRef<{
    steamId: string;
    token: number;
    promise: Promise<InventoryLoadResult>;
  } | null>(null);
  const retryAfterSeconds = secondsUntilDeadline(
    retryDeadlineMs,
    countdownNowMs
  );

  const updateInventoryState = useCallback((nextState: InventoryState) => {
    inventoryStateRef.current = nextState;
    setInventoryState(nextState);
  }, []);

  const setInventoryRetryDeadline = useCallback(
    (inventory: InventoryCheck | null) => {
      const nowMs = performance.now();
      const deadlineMs =
        inventory?.retry_after_seconds !== null &&
          inventory?.retry_after_seconds !== undefined
          ? nowMs + inventory.retry_after_seconds * MILLISECONDS_PER_SECOND
          : null;
      retryDeadlineRef.current = deadlineMs;
      setRetryDeadlineMs(deadlineMs);
      setCountdownNowMs(nowMs);
    },
    []
  );

  const isCurrentInventoryRequest = useCallback(
    (token: number, steamId: string): boolean =>
      activeSteamIdRef.current === steamId &&
      inventoryRequestTokenRef.current === token,
    []
  );

  const loadInventoryForUser = useCallback((
    steamId: string,
    forceNetwork = false
  ): Promise<InventoryLoadResult> => {
    const existingLoad = inventoryLoadPromiseRef.current;
    if (!forceNetwork && existingLoad?.steamId === steamId) {
      return existingLoad.promise;
    }

    const token = inventoryRequestTokenRef.current + 1;
    inventoryRequestTokenRef.current = token;
    activeSteamIdRef.current = steamId;
    const previousState = inventoryStateRef.current;
    updateInventoryState({
      ...previousState,
      isLoading: true,
      message: null
    });

    const promise = (async (): Promise<InventoryLoadResult> => {
      try {
        if (!forceNetwork) {
          let cached: {
            refreshed_at: string;
            inventory: InventoryCheck;
          } | null = null;
          try {
            await clearInventoryCacheExcept(steamId);
            if (isCurrentInventoryRequest(token, steamId)) {
              cached = await readInventoryCache(
                steamId,
                isCacheableInventory
              );
            }
          } catch {
            cached = null;
          }
          if (!isCurrentInventoryRequest(token, steamId)) {
            return { kind: "error" };
          }
          if (cached !== null) {
            setInventoryRetryDeadline(cached.inventory);
            updateInventoryState({
              inventory: cached.inventory,
              refreshedAt: cached.refreshed_at,
              source: "cache",
              isLoading: false,
              message: null
            });
            return {
              kind: "cache",
              inventory: cached.inventory,
              refreshedAt: cached.refreshed_at
            };
          }
        }

        const cacheEpoch = await readInventoryCacheEpoch();
        const inventory = await requestInventory(steamId);
        if (!isCurrentInventoryRequest(token, steamId)) {
          return { kind: "error" };
        }
        setInventoryRetryDeadline(inventory);

        const currentState = inventoryStateRef.current;
        if (
          inventory.status === "unavailable" &&
          currentState.inventory !== null &&
          currentState.inventory.status !== "unavailable"
        ) {
          updateInventoryState({
            ...currentState,
            isLoading: false,
            message: null
          });
          return {
            kind: "network",
            inventory,
            preserved: true
          };
        }

        if (
          inventory.status === "public" ||
          inventory.status === "private"
        ) {
          const fetchedAt = new Date().toISOString();
          const storedAt =
            cacheEpoch === null
              ? undefined
              : await writeInventoryCache(
                steamId,
                inventory,
                isCacheableInventory,
                fetchedAt,
                cacheEpoch
              );
          if (!isCurrentInventoryRequest(token, steamId)) {
            return { kind: "error" };
          }
          if (storedAt === null) {
            updateInventoryState({
              ...inventoryStateRef.current,
              isLoading: false
            });
            return { kind: "session-changed" };
          }
          const refreshedAt = storedAt ?? fetchedAt;
          updateInventoryState({
            inventory,
            refreshedAt,
            source: "network",
            isLoading: false,
            message: null
          });
          return {
            kind: "network",
            inventory,
            refreshedAt
          };
        }

        updateInventoryState({
          inventory,
          refreshedAt: null,
          source: "network",
          isLoading: false,
          message: null
        });
        return { kind: "network", inventory };
      } catch (error) {
        if (!isCurrentInventoryRequest(token, steamId)) {
          return { kind: "error" };
        }
        if (error instanceof InventorySessionChangedError) {
          updateInventoryState({
            ...inventoryStateRef.current,
            isLoading: false
          });
          return { kind: "session-changed" };
        }
        const currentState = inventoryStateRef.current;
        updateInventoryState({
          ...currentState,
          isLoading: false,
          message:
            currentState.inventory === null
              ? "We could not load your Steam inventory. Try refreshing when the service is available."
              : null
        });
        return {
          kind: "error",
          preserved: currentState.inventory !== null
        };
      } finally {
        if (inventoryLoadPromiseRef.current?.token === token) {
          inventoryLoadPromiseRef.current = null;
        }
      }
    })();

    inventoryLoadPromiseRef.current = {
      steamId,
      token,
      promise
    };
    return promise;
  }, [
    isCurrentInventoryRequest,
    setInventoryRetryDeadline,
    updateInventoryState
  ]);

  const presentSession = useCallback(async (
    session: SessionResponse,
    shouldLoadInventory: boolean
  ): Promise<InventoryLoadResult | null> => {
    if (!session.authenticated) {
      activeSteamIdRef.current = null;
      inventoryRequestTokenRef.current += 1;
      inventoryLoadPromiseRef.current = null;
      updateInventoryState({
        inventory: null,
        refreshedAt: null,
        source: null,
        isLoading: false,
        message: null
      });
      setRetryDeadlineMs(null);
      retryDeadlineRef.current = null;
      setViewState({ kind: "signed-out" });
      return null;
    }

    const previousSteamId = activeSteamIdRef.current;
    const accountChanged =
      previousSteamId !== null && previousSteamId !== session.user.steam_id;
    activeSteamIdRef.current = session.user.steam_id;
    setViewState({ kind: "signed-in", session });

    const needsInventory =
      shouldLoadInventory ||
      accountChanged ||
      previousSteamId === null;
    if (!needsInventory) {
      return null;
    }

    if (accountChanged || shouldLoadInventory) {
      updateInventoryState({
        inventory: null,
        refreshedAt: null,
        source: null,
        isLoading: false,
        message: null
      });
      setInventoryRetryDeadline(null);
    }
    return loadInventoryForUser(session.user.steam_id);
  }, [
    loadInventoryForUser,
    setInventoryRetryDeadline,
    updateInventoryState
  ]);

  const loadCurrentSession = useCallback(
    async (signal?: AbortSignal) => {
      let session = await requestSession(signal);
      let result = await presentSession(session, true);
      if (result?.kind === "session-changed" && !signal?.aborted) {
        session = await requestSession(signal);
        result = await presentSession(session, true);
      }
      return { session, result };
    },
    [presentSession]
  );

  useEffect(() => {
    const controller = new AbortController();

    void requestSession(controller.signal)
      .then(async (initialSession) => {
        let session = initialSession;
        let result = await presentSession(session, true);
        if (result?.kind === "session-changed" && !controller.signal.aborted) {
          session = await requestSession(controller.signal);
          result = await presentSession(session, true);
        }
        return { session, result };
      })
      .then(({ session, result }) => {
        if (controller.signal.aborted) {
          return;
        }
        if (!session.authenticated) {
          setStatusAnnouncement(
            "Your local session has ended. Sign in again to load saved inventory."
          );
        } else if (
          result?.kind === "cache" &&
          result.refreshedAt !== undefined
        ) {
          setStatusAnnouncement(
            `Loaded cached inventory. Last refreshed ${formatPriceTimestamp(
              result.refreshedAt
            )}.`
          );
        } else if (result?.kind === "network" && result.inventory) {
          setStatusAnnouncement(
            `Inventory check complete: ${STATUS_LABELS[result.inventory.status]}.`
          );
        } else if (
          result?.kind === "error" ||
          result?.kind === "session-changed"
        ) {
          setStatusAnnouncement(
            "We could not load your Steam inventory. Refresh when the service is available."
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setViewState({ kind: "api-unavailable" });
          setStatusAnnouncement("Steam connection is unavailable.");
        }
      });

    return () => {
      controller.abort();
      activeSteamIdRef.current = null;
      inventoryRequestTokenRef.current += 1;
    };
  }, [presentSession]);

  useEffect(() => {
    if (retryDeadlineMs === null) {
      return;
    }

    const remainingMs = retryDeadlineMs - performance.now();
    if (remainingMs <= 0) {
      retryDeadlineRef.current = null;
      return;
    }

    const remainingSeconds = Math.ceil(
      remainingMs / MILLISECONDS_PER_SECOND
    );
    const nextTickMs =
      remainingMs -
      (remainingSeconds - 1) * MILLISECONDS_PER_SECOND;
    const timeoutId = window.setTimeout(() => {
      setCountdownNowMs(performance.now());
    }, nextTickMs);

    return () => window.clearTimeout(timeoutId);
  }, [countdownNowMs, retryDeadlineMs]);

  async function handleRetry() {
    setViewState({ kind: "loading" });
    setActionMessage(null);
    setInventoryActionMessage(null);
    setStatusAnnouncement("Checking session…");

    try {
      const { session, result } = await loadCurrentSession();
      if (!session.authenticated) {
        setStatusAnnouncement(
          "Your local session has ended. Sign in again to load saved inventory."
        );
      } else if (result?.kind === "cache" && result.refreshedAt !== undefined) {
        setStatusAnnouncement(
          `Loaded cached inventory. Last refreshed ${formatPriceTimestamp(
            result.refreshedAt
          )}.`
        );
      } else if (result?.kind === "network" && result.inventory) {
        setStatusAnnouncement(
          `Inventory check complete: ${STATUS_LABELS[result.inventory.status]}.`
        );
      }
    } catch {
      setViewState({ kind: "api-unavailable" });
      setStatusAnnouncement("Steam connection is unavailable.");
    }
  }

  async function handleRecheck() {
    if (
      recheckInFlightRef.current ||
      inventoryRefreshInFlightRef.current ||
      gemRefreshInFlightRef.current ||
      isSigningOut
    ) {
      return;
    }

    recheckInFlightRef.current = true;
    setIsRechecking(true);
    setActionMessage(null);
    setInventoryActionMessage(null);
    setGemRefreshMessage(null);
    setStatusAnnouncement("Rechecking Steam profile access…");

    try {
      let session = await requestSession();
      const previousSteamId = activeSteamIdRef.current;
      let result = await presentSession(session, false);
      if (result?.kind === "session-changed") {
        const current = await loadCurrentSession();
        session = current.session;
        result = current.result;
      }
      if (!session.authenticated) {
        setStatusAnnouncement(
          "Your local session has ended. Sign in again to recheck Steam profile access."
        );
      } else if (
        previousSteamId !== null &&
        previousSteamId !== session.user.steam_id
      ) {
        let inventoryOutcome = "Inventory could not be loaded.";
        if (result?.kind === "cache" && result.refreshedAt !== undefined) {
          inventoryOutcome = `Loaded cached inventory last refreshed ${formatPriceTimestamp(
            result.refreshedAt
          )}.`;
        } else if (result?.kind === "network" && result.inventory) {
          inventoryOutcome = `Inventory check complete: ${STATUS_LABELS[result.inventory.status]}.`;
        }
        setStatusAnnouncement(
          `Account changed. Steam profile: ${STATUS_LABELS[session.checks.profile.status]}. ${inventoryOutcome}`
        );
      } else if (
        result?.kind === "network" &&
        result.inventory?.status === "unavailable"
      ) {
        setStatusAnnouncement(
          `Profile recheck complete. Steam profile: ${STATUS_LABELS[session.checks.profile.status]}. Inventory is unavailable.`
        );
      } else {
        setStatusAnnouncement(
          `Profile recheck complete. Steam profile: ${STATUS_LABELS[session.checks.profile.status]}.`
        );
      }
    } catch {
      const message =
        "We could not recheck Steam profile access. The service is unavailable, and your previous results have not changed.";
      setActionMessage(message);
      setStatusAnnouncement(message);
    } finally {
      recheckInFlightRef.current = false;
      setIsRechecking(false);
    }
  }

  async function handleInventoryRefresh() {
    if (
      inventoryRefreshInFlightRef.current ||
      recheckInFlightRef.current ||
      gemRefreshInFlightRef.current ||
      isSigningOut ||
      inventoryStateRef.current.isLoading ||
      viewState.kind !== "signed-in" ||
      retryAfterSeconds > 0
    ) {
      return;
    }

    const steamId = viewState.session.user.steam_id;
    inventoryRefreshInFlightRef.current = true;
    setIsRefreshingInventory(true);
    setInventoryActionMessage(null);
    setGemRefreshMessage(null);
    setStatusAnnouncement("Refreshing inventory…");

    try {
      let result: InventoryLoadResult | null = await loadInventoryForUser(
        steamId,
        true
      );
      if (result.kind === "session-changed") {
        const current = await loadCurrentSession();
        if (!current.session.authenticated) {
          setStatusAnnouncement(
            "Your local session has ended. Sign in again to refresh inventory."
          );
          return;
        }
        result = current.result;
        if (current.session.user.steam_id !== steamId) {
          let inventoryOutcome = "Inventory could not be loaded.";
          if (result?.kind === "cache" && result.refreshedAt !== undefined) {
            inventoryOutcome = `Loaded cached inventory last refreshed ${formatPriceTimestamp(
              result.refreshedAt
            )}.`;
          } else if (result?.kind === "network" && result.inventory) {
            inventoryOutcome = `Inventory check complete: ${STATUS_LABELS[result.inventory.status]}.`;
          }
          setStatusAnnouncement(
            `Account changed. Steam profile: ${STATUS_LABELS[current.session.checks.profile.status]}. ${inventoryOutcome}`
          );
          return;
        }
      }
      if (result?.kind === "network" && result.inventory !== undefined) {
        if (result.inventory.status === "unavailable") {
          const message =
            "We could not refresh inventory right now. Your previous inventory results have not changed.";
          setInventoryActionMessage(message);
          setStatusAnnouncement(message);
        } else {
          setStatusAnnouncement(
            `Inventory refresh complete: ${STATUS_LABELS[result.inventory.status]}.`
          );
        }
      } else if (result?.kind === "cache" && result.refreshedAt !== undefined) {
        setStatusAnnouncement(
          `Loaded cached inventory. Last refreshed ${formatPriceTimestamp(
            result.refreshedAt
          )}.`
        );
      } else {
        const message =
          "We could not refresh inventory right now. Your previous inventory results have not changed.";
        setInventoryActionMessage(message);
        setStatusAnnouncement(message);
      }
    } catch {
      const message =
        "We could not refresh inventory right now. Your previous inventory results have not changed.";
      setInventoryActionMessage(message);
      setStatusAnnouncement(message);
    } finally {
      inventoryRefreshInFlightRef.current = false;
      setIsRefreshingInventory(false);
    }
  }

  async function handleGemRefresh() {
    if (
      gemRefreshInFlightRef.current ||
      recheckInFlightRef.current ||
      inventoryRefreshInFlightRef.current ||
      isSigningOut ||
      viewState.kind !== "signed-in" ||
      inventoryStateRef.current.inventory?.status !== "public"
    ) {
      return;
    }
    const inventory = inventoryStateRef.current.inventory;
    const steamId = activeSteamIdRef.current;
    if (inventory === null || steamId === null) {
      return;
    }
    if (gemRefreshGroups(inventory.items).length === 0) {
      return;
    }

    gemRefreshInFlightRef.current = true;
    setIsRefreshingGems(true);
    setGemRefreshMessage(null);
    setStatusAnnouncement("Refreshing cached gem values…");

    try {
      const cacheEpoch = await readInventoryCacheEpoch();
      const refresh = await requestGemRefresh(inventory);
      const mergedInventory = mergeGemRefresh(inventory, refresh);
      if (activeSteamIdRef.current !== steamId) {
        return;
      }
      const currentState = inventoryStateRef.current;
      if (currentState.inventory === null) {
        return;
      }
      const currentRefreshedAt = currentState.refreshedAt;
      const storedAt =
        cacheEpoch === null || currentRefreshedAt === null
          ? undefined
          : await writeInventoryCache(
            steamId,
            mergedInventory,
            isCacheableInventory,
            currentRefreshedAt,
            cacheEpoch,
            currentRefreshedAt
          );
      if (activeSteamIdRef.current !== steamId || storedAt === null) {
        return;
      }
      updateInventoryState({
        ...currentState,
        inventory: mergedInventory,
        message: null
      });
      setGemRefreshMessage("Gem values refreshed from the background cache.");
      setStatusAnnouncement(
        `Gem refresh complete. ${mergedInventory.gem_priced_item_count} of ${mergedInventory.gem_priceable_item_count} trading-card item types have gem values.`
      );
    } catch {
      const message =
        "We could not refresh cached gem values. Your inventory results have not changed.";
      setGemRefreshMessage(message);
      setStatusAnnouncement(message);
    } finally {
      gemRefreshInFlightRef.current = false;
      setIsRefreshingGems(false);
    }
  }

  async function handleLogout() {
    if (
      gemRefreshInFlightRef.current ||
      inventoryRefreshInFlightRef.current ||
      recheckInFlightRef.current
    ) {
      return;
    }
    setIsSigningOut(true);
    setActionMessage(null);
    setInventoryActionMessage(null);
    setGemRefreshMessage(null);
    setStatusAnnouncement("Signing out…");

    try {
      const response = await fetch(LOGOUT_URL, {
        credentials: "include",
        method: "POST"
      });

      if (response.status !== 204) {
        throw new Error("The logout service returned an unexpected response.");
      }
      activeSteamIdRef.current = null;
      inventoryRequestTokenRef.current += 1;
      inventoryLoadPromiseRef.current = null;
      try {
        await clearInventoryCache();
      } catch {
        // Cache cleanup must not prevent a successful server sign-out.
      }
      updateInventoryState({
        inventory: null,
        refreshedAt: null,
        source: null,
        isLoading: false,
        message: null
      });
      setRetryDeadlineMs(null);
      retryDeadlineRef.current = null;
      setViewState({ kind: "signed-out" });
      setStatusAnnouncement("Signed out successfully.");
    } catch {
      const message =
        "We could not clear your local session. Your Steam account was not changed; please try again.";
      setActionMessage(message);
      setStatusAnnouncement(message);
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="app-shell">
      <title>Steam Optimizer</title>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <SiteHeader currentPage="home">
        {viewState.kind === "signed-out" && (
          <a className="steam-sign-in-link" href={STEAM_LOGIN_URL}>
            <picture className="steam-sign-in-picture">
              <img
                className="steam-sign-in-image"
                src={steamSignInWide}
                width="180"
                height="35"
                alt="Steam sign-in; Steam Optimizer is not affiliated with Valve"
              />
            </picture>
          </a>
        )}
        {viewState.kind === "signed-in" && (
          <div className="site-account">
            <AccessSummary
              profile={viewState.session.checks.profile}
              inventory={inventoryState.inventory}
              isInventoryLoading={inventoryState.isLoading}
            />
            <button
              className="secondary-action"
              type="button"
              aria-label="Recheck Steam profile"
              onClick={() => void handleRecheck()}
              disabled={
                isRechecking ||
                isRefreshingInventory ||
                isRefreshingGems ||
                isSigningOut
              }
            >
              {isRechecking ? "Checking…" : "Recheck"}
            </button>
            <SteamIdentity
              user={viewState.session.user}
              isSigningOut={isSigningOut}
              isBusy={
                isRechecking || isRefreshingInventory || isRefreshingGems
              }
              onLogout={() => void handleLogout()}
            />
          </div>
        )}
      </SiteHeader>

      <main id="main-content" className="page-main">
        {viewState.kind !== "signed-in" && (
          <section className="hero" aria-labelledby="page-title">
            <h1 id="page-title">Compare your Steam inventory.</h1>
            <p className="hero-copy">
              Check public access, market prices, and card gem values.
            </p>
          </section>
        )}
        <p
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {statusAnnouncement}
        </p>

        {viewState.kind === "loading" && <LoadingView />}
        {viewState.kind === "api-unavailable" && (
          <ApiUnavailableView onRetry={() => void handleRetry()} />
        )}
        {viewState.kind === "signed-in" && (
          <SignedInView
            session={viewState.session}
            inventoryState={inventoryState}
            isRechecking={isRechecking}
            isRefreshingInventory={isRefreshingInventory}
            isRefreshingGems={isRefreshingGems}
            retryAfterSeconds={retryAfterSeconds}
            actionMessage={actionMessage}
            inventoryActionMessage={inventoryActionMessage}
            gemRefreshMessage={gemRefreshMessage}
            onRefreshInventory={() => void handleInventoryRefresh()}
            onRefreshGems={() => void handleGemRefresh()}
          />
        )}

      </main>

      <SiteFooter />
    </div>
  );
}

function FaqPage() {
  return (
    <div className="app-shell">
      <title>FAQ | Steam Optimizer</title>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <SiteHeader currentPage="faq" />

      <main id="main-content" className="page-main faq-main">
        <header className="faq-hero">
          <p className="eyebrow">FAQ</p>
          <h1>Steam inventory questions, answered.</h1>
          <p className="hero-copy">
            The details on access, pricing, gems, and privacy.
          </p>
        </header>

        <div className="faq-list">
          <section id="account-access">
            <h2>Can Steam Optimizer change my account?</h2>
            <p>
              No. Steam Optimizer reads public Steam Community data. It cannot
              trade, sell, craft, buy, or change your account. Any action you
              choose stays manual and happens on Steam.
            </p>
            <p>
              Sign-in is handled by Steam Community. Your Steam password never
              reaches this app.
            </p>
          </section>

          <section id="visibility">
            <h2>Why can profile and inventory access differ?</h2>
            <p>
              Steam exposes profile and inventory visibility separately. A
              public profile can still have a private inventory.
            </p>
            <p>
              Unavailable is not the same as private. It means Steam or the
              session service could not complete that check, including during
              rate limits.
            </p>
          </section>

          <section id="market-prices">
            <h2>Where do market prices come from?</h2>
            <p>
              Market snapshots come from SteamApis and are shown exactly as
              received. The feed does not identify its currency, and values are
              context—not sale offers.
            </p>
          </section>

          <section id="gem-values">
            <h2>How are gem values calculated?</h2>
            <p>
              Steam Community provides the gem yield for trading cards. The cash
              estimate uses the SteamApis lowest-sell price for{" "}
              {GEM_CASH_MARKET_HASH_NAME}, divided across{" "}
              {INVENTORY_COUNT_FORMATTER.format(GEM_CASH_SACK_SIZE)} gems. It is
              a per-card replacement-cost estimate.
            </p>
            <p>
              “Worth more as gems” compares that estimate with the card's current
              lowest-sell market price. Cards missing either value are excluded.
            </p>
          </section>

          <section id="refreshes">
            <h2>Why can pricing refreshes be delayed?</h2>
            <p>
              Steam Community and pricing providers can rate-limit requests.
              Cached values remain visible while a refresh is delayed or only
              partly complete.
            </p>
          </section>

          <section id="privacy-settings">
            <h2>How do I make my inventory public?</h2>
            <p>
              Open{" "}
              <a href={STEAM_PRIVACY_URL} target="_blank" rel="noreferrer">
                Steam privacy settings
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
              , change Inventory to Public, then return and recheck access.
            </p>
          </section>

          <section id="affiliation">
            <h2>Is this affiliated with Valve?</h2>
            <p>
              No. Steam Optimizer is an independent open-source project and is
              not affiliated with Valve.
            </p>
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

export function App() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  return pathname === "/faq" ? <FaqPage /> : <HomePage />;
}
