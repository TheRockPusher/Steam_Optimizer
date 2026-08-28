import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import steamSignInWide from "./assets/steam/sits_01.png";
import steamSignInCompact from "./assets/steam/sits_02.png";
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
    inventory: InventoryCheck;
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

type GemRefreshResponse = {
  values: GemRefreshValue[];
  pending_group_count: number;
  gem_rate_limited: boolean;
  gem_retry_after_seconds: number | null;
};


type ViewState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; session: SignedInSession }
  | { kind: "api-unavailable" };
const MILLISECONDS_PER_SECOND = 1000;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const SESSION_URL = `${API_BASE_URL}/api/auth/session`;
const GEM_REFRESH_URL = `${API_BASE_URL}/api/auth/gems`;
const LOGOUT_URL = `${API_BASE_URL}/api/auth/logout`;
const STEAM_LOGIN_URL = `${API_BASE_URL}/api/auth/steam/start`;
const STEAM_PRIVACY_URL = "https://steamcommunity.com/my/edit/settings";
const PRIVACY_POLICY_URL =
  "https://github.com/TheRockPusher/Steam_Optimizer#privacy-and-steam-data-policy";
const NON_ASCII_DECIMAL_PATTERN = /[^0-9]/;
const NONNEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const INVENTORY_PAGE_SIZE = 50;
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
    !Array.isArray(check.items)
  ) {
    return false;
  }

  if (!check.gem_rate_limited && gemRetryAfterSeconds !== null) {
    return false;
  }

  const itemKeys = new Set<string>();
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
    isInventoryCheck(checks.inventory)
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
  if (
    payload.values.length > groups.length ||
    payload.values.some(
      (entry) =>
        !requestedKeys.has(`${entry.game_app_id}:${entry.card_rarity}`)
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
    gem_status: gemStatus,
    gem_message: gemMessage,
    gem_priceable_item_count: gemPriceableCount,
    gem_priced_item_count: gemPricedCount,
    gem_rate_limited: refresh.gem_rate_limited,
    gem_retry_after_seconds: refresh.gem_retry_after_seconds
  };
}


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

function toViewState(session: SessionResponse): ViewState {
  return session.authenticated
    ? { kind: "signed-in", session }
    : { kind: "signed-out" };
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

function Brand() {
  return (
    <div className="brand" aria-label="Steam Optimizer">
      <span className="brand-mark" aria-hidden="true">
        SO
      </span>
      <span className="brand-name">Steam Optimizer</span>
    </div>
  );
}

function ReadOnlyBoundary() {
  return (
    <aside className="boundary-note" aria-labelledby="boundary-title">
      <p className="section-label">Read-only by design</p>
      <h2 id="boundary-title">Your account stays under your control.</h2>
      <p>
        Steam Optimizer only reads information Steam exposes publicly. It cannot
        trade, sell, craft, or change your account. Any future account action
        stays manual and happens on Steam.
      </p>
    </aside>
  );
}

function LoadingView() {
  return (
    <section className="state-panel loading-panel" aria-labelledby="loading-title">
      <div>
        <p className="section-label">Steam connection</p>
        <h2 id="loading-title">Checking your connection</h2>
        <p className="state-copy">
          Looking for an existing local session. No Steam credentials are sent
          from this page.
        </p>
      </div>
      <div className="loading-indicator">
        <span className="loading-dot" aria-hidden="true" />
        Checking session…
      </div>
    </section>
  );
}


function SignedOutView() {
  return (
    <section className="state-panel connection-panel" aria-labelledby="connect-title">
      <div className="connection-copy">
        <p className="section-label">Stage one · Connect</p>
        <h2 id="connect-title">Connect Steam to check public access.</h2>
        <p id="connect-description" className="state-copy">
          Continue to Steam in this browser. Steam handles sign-in and returns
          your public Steam identity—your password never comes here.
        </p>
      </div>

      <div className="connection-details" aria-label="Connection details">
        <div>
          <span className="detail-number" aria-hidden="true">
            01
          </span>
          <p>
            <strong>Steam verifies you.</strong>
            <span>Authentication happens on Steam Community.</span>
          </p>
        </div>
        <div>
          <span className="detail-number" aria-hidden="true">
            02
          </span>
          <p>
            <strong>We check public surfaces.</strong>
            <span>Profile and inventory access are reported separately.</span>
          </p>
        </div>
        <div>
          <span className="detail-number" aria-hidden="true">
            03
          </span>
          <p>
            <strong>You decide what comes next.</strong>
            <span>No account actions are automated.</span>
          </p>
        </div>
      </div>
    </section>
  );
}

function ApiUnavailableView({ onRetry }: { onRetry: () => void }) {
  return (
    <section
      className="state-panel unavailable-panel"
      aria-labelledby="unavailable-title"
    >
      <div>
        <p className="section-label">Connection service</p>
        <h2 id="unavailable-title">Steam connection is unavailable.</h2>
        <p className="state-copy">
          We could not reach the app's session service. This is a service or
          configuration problem—not a Steam privacy result.
        </p>
      </div>
      <button className="secondary-action" type="button" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

function SteamIdentity({ user }: { user: SteamUser }) {
  const displayName = user.display_name?.trim() || "Steam member";
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <div className="identity">
      {user.avatar_url ? (
        <img className="avatar" src={user.avatar_url} alt="" />
      ) : (
        <span className="avatar avatar-fallback" aria-hidden="true">
          {initials}
        </span>
      )}
      <div>
        <p className="section-label">Connected Steam identity</p>
        <h2 id="account-title">{displayName}</h2>
        <p className="steam-id">Steam ID {user.steam_id}</p>
      </div>
    </div>
  );
}

type AccessCardProps =
  | { surface: "profile"; check: VisibilityCheck }
  | { surface: "inventory"; check: InventoryCheck };

function AccessCard({ surface, check }: AccessCardProps) {
  const title = surface === "profile" ? "Steam profile" : "Steam inventory";
  const privateGuidance =
    surface === "profile"
      ? "Your Steam profile is not public."
      : "Your Steam inventory is not public.";
  const isRateLimited =
    surface === "inventory" &&
    check.status === "unavailable" &&
    check.rate_limited;
  const statusLabel = isRateLimited ? "Try later" : STATUS_LABELS[check.status];

  return (
    <article
      className={`access-card access-card-${check.status}`}
      aria-labelledby={`${surface}-title`}
    >
      <div className="access-card-heading">
        <div>
          <p className="card-index">{surface === "profile" ? "01" : "02"}</p>
          <h3 id={`${surface}-title`}>{title}</h3>
        </div>
        <p className={`access-badge access-badge-${check.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel}
        </p>
      </div>

      <p className="check-message">{check.message}</p>

      {check.status === "private" && (
        <p className="result-guidance">
          {privateGuidance}{" "}
          <a href={STEAM_PRIVACY_URL} target="_blank" rel="noreferrer">
            Open Steam privacy settings
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          , then recheck.
        </p>
      )}

      {check.status === "unavailable" &&
        (isRateLimited ? (
          <p className="result-guidance">
            Steam is temporarily limiting automated checks. This is not a
            privacy result and does not mean your inventory is private.
          </p>
        ) : (
          <p className="result-guidance">
            This is not a privacy result. Recheck when the service is available.
          </p>
        ))}
    </article>
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
  const [sort, setSort] = useState<InventorySort | null>(null);
  const [groupByGame, setGroupByGame] = useState(true);
  const groupedItems = useMemo(
    () =>
      groupByGame
        ? groupInventoryItems(items, sort)
        : [
          {
            key: "all",
            kind: "other" as const,
            game_app_id: null,
            game_name: null,
            items:
              sort === null
                ? items
                : [...items].sort((left, right) =>
                  compareInventoryItems(left, right, sort)
                )
          }
        ],
    [groupByGame, items, sort]
  );
  const pageCount = Math.max(
    1,
    Math.ceil(items.length / INVENTORY_PAGE_SIZE)
  );
  const pageIndex = Math.min(requestedPageIndex, pageCount - 1);

  const firstItemIndex = pageIndex * INVENTORY_PAGE_SIZE;
  const lastItemIndex = Math.min(
    firstItemIndex + INVENTORY_PAGE_SIZE,
    items.length
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

  return (
    <section className="inventory-browser" aria-labelledby="inventory-items-title">
      <div className="inventory-browser-heading">
        <div>
          <p className="section-label">Item ledger</p>
          <h3 id="inventory-items-title">Inventory items</h3>
        </div>
        <div className="inventory-browser-settings">
          <p>
            {INVENTORY_COUNT_FORMATTER.format(items.length)} distinct item{" "}
            {items.length === 1 ? "type" : "types"}
          </p>
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

      <p
        className="inventory-page-status"
        role="status"
        aria-label="Inventory pagination status"
        aria-live="polite"
        aria-atomic="true"
      >
        Showing {INVENTORY_COUNT_FORMATTER.format(firstItemIndex + 1)}–
        {INVENTORY_COUNT_FORMATTER.format(lastItemIndex)} of{" "}
        {INVENTORY_COUNT_FORMATTER.format(items.length)}. Page{" "}
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
    </section>
  );
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
  const coverageMessage =
    inventory.priceable_item_count === 0
      ? "No marketable item types require a price lookup."
      : `SteamApis price data is available for ${INVENTORY_COUNT_FORMATTER.format(
        inventory.priced_item_count
      )} of ${INVENTORY_COUNT_FORMATTER.format(
        inventory.priceable_item_count
      )} marketable item ${inventory.priceable_item_count === 1 ? "type" : "types"
      }.`;
  const gemCoverageMessage =
    inventory.gem_priceable_item_count === 0
      ? "No trading-card item types require a gem lookup."
      : `Gem values are available for ${INVENTORY_COUNT_FORMATTER.format(
        inventory.gem_priced_item_count
      )} of ${INVENTORY_COUNT_FORMATTER.format(
        inventory.gem_priceable_item_count
      )} trading-card item ${inventory.gem_priceable_item_count === 1 ? "type" : "types"
      }.`;
  const gemCashContext = inventory.gem_cash_context;

  return (
    <section className="inventory-results" aria-labelledby="inventory-results-title">
      <div className="inventory-results-heading">
        <div>
          <p className="section-label">Public inventory</p>
          <h2 id="inventory-results-title">What is in your inventory</h2>
        </div>
        <p>
          Quantities combine matching Steam assets. Prices are read-only market
          context, not sale offers.
        </p>
      </div>

      <section className="price-coverage" aria-labelledby="price-coverage-title">
        <div className="price-coverage-heading">
          <div>
            <p className="section-label">Price coverage</p>
            <h3 id="price-coverage-title">Current market snapshot</h3>
          </div>
          <p
            className={`pricing-status pricing-status-${inventory.price_status}`}
          >
            <span className="status-dot" aria-hidden="true" />
            {PRICE_STATUS_LABELS[inventory.price_status]}
          </p>
        </div>
        <p className="price-coverage-copy">{coverageMessage}</p>
        <p className="price-message">
          SteamApis does not specify the currency for this feed. Values are
          shown exactly as received, without a currency symbol.
        </p>
        {inventory.price_message.trim().length > 0 && (
          <p className="price-message">{inventory.price_message}</p>
        )}
        <dl className="inventory-summary">
          <div>
            <dt>Total assets</dt>
            <dd>
              {INVENTORY_COUNT_FORMATTER.format(inventory.total_asset_count)}
            </dd>
          </div>
          <div>
            <dt>Distinct item types</dt>
            <dd>
              {INVENTORY_COUNT_FORMATTER.format(inventory.unique_item_count)}
            </dd>
          </div>
          <div>
            <dt>Priceable types</dt>
            <dd>
              {INVENTORY_COUNT_FORMATTER.format(
                inventory.priceable_item_count
              )}
            </dd>
          </div>
          <div>
            <dt>Types with prices</dt>
            <dd>{INVENTORY_COUNT_FORMATTER.format(inventory.priced_item_count)}</dd>
          </div>
        </dl>
      </section>

      <section className="gem-coverage" aria-labelledby="gem-coverage-title">
        <div className="gem-coverage-heading">
          <div>
            <p className="section-label">Gem coverage</p>
            <h3 id="gem-coverage-title">Trading-card gem values</h3>
          </div>
          <div className="gem-coverage-actions">
            <p
              className={`gem-status gem-status-${inventory.gem_status}`}
            >
              <span className="status-dot" aria-hidden="true" />
              {GEM_STATUS_LABELS[inventory.gem_status]}
            </p>
            <button
              className={`gem-refresh-button${isRefreshingGems ? " gem-refresh-button-active" : ""}`}
              type="button"
              onClick={onRefreshGems}
              disabled={
                isRefreshingGems || inventory.gem_priceable_item_count === 0
              }
              aria-label={
                isRefreshingGems
                  ? "Refreshing gem values"
                  : "Refresh gem values"
              }
              title="Refresh cached gem values"
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </div>
        <p className="gem-coverage-copy">{gemCoverageMessage}</p>
        {inventory.gem_message.trim().length > 0 && (
          <p className="gem-message">{inventory.gem_message}</p>
        )}
        {refreshMessage !== null && (
          <p className="gem-message gem-refresh-message">{refreshMessage}</p>
        )}
        {inventory.gem_rate_limited && (
          <p className="gem-message gem-rate-limit-message">
            Steam Community is temporarily rate-limiting gem lookups. Cached
            values remain available
            {inventory.gem_retry_after_seconds !== null
              ? `; try again in ${inventory.gem_retry_after_seconds}s`
              : ""}
            .
          </p>
        )}
        <p className="gem-cash-provenance">
          Gem cash value uses the SteamApis lowest-sell basis for{" "}
          {GEM_CASH_MARKET_HASH_NAME} ({GEM_CASH_SACK_SIZE} gems). This feed has
          unknown currency. Each value is a per-card replacement-cost estimate.
        </p>
        {gemCashContext !== null && (
          <p className="gem-cash-context">
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
        <dl className="gem-summary">
          <div>
            <dt>Gem-priceable types</dt>
            <dd>
              {INVENTORY_COUNT_FORMATTER.format(
                inventory.gem_priceable_item_count
              )}
            </dd>
          </div>
          <div>
            <dt>Types with gem values</dt>
            <dd>
              {INVENTORY_COUNT_FORMATTER.format(
                inventory.gem_priced_item_count
              )}
            </dd>
          </div>
        </dl>
      </section>

      {inventory.items.length > 0 ? (
        <InventoryBrowser
          key={inventory.unique_item_count}
          items={inventory.items}
        />
      ) : (
        <div className="inventory-empty">
          <h3>No inventory items to display</h3>
          <p>
            Steam returned a public inventory with no items. Recheck after your
            inventory changes.
          </p>
        </div>
      )}
    </section>
  );
}

function SignedInView({
  session,
  isRechecking,
  isRefreshingGems,
  isSigningOut,
  retryAfterSeconds,
  actionMessage,
  gemRefreshMessage,
  onRecheck,
  onRefreshGems,
  onLogout
}: {
  session: SignedInSession;
  isRechecking: boolean;
  isRefreshingGems: boolean;
  isSigningOut: boolean;
  retryAfterSeconds: number;
  actionMessage: string | null;
  gemRefreshMessage: string | null;
  onRecheck: () => void;
  onRefreshGems: () => void;
  onLogout: () => void;
}) {
  const isRecheckDisabled =
    isRechecking ||
    isRefreshingGems ||
    isSigningOut ||
    retryAfterSeconds > 0;

  return (
    <section className="account-view" aria-labelledby="account-title">
      <div className="account-header">
        <SteamIdentity user={session.user} />
        <div className="account-actions">
          <button
            className="secondary-action"
            type="button"
            onClick={onRecheck}
            disabled={isRecheckDisabled}
            aria-describedby={
              retryAfterSeconds > 0 ? "recheck-cooldown" : undefined
            }
          >
            {isRechecking ? "Checking…" : "Recheck Steam access"}
          </button>
          <button
            className="text-action"
            type="button"
            onClick={onLogout}
            disabled={isSigningOut || isRechecking || isRefreshingGems}
          >
            {isSigningOut ? "Signing out…" : "Sign out on this device"}
          </button>
        </div>
      </div>

      {(isRechecking || actionMessage) && (
        <p className={`action-status${actionMessage ? " action-status-error" : ""}`}>
          {isRechecking ? "Rechecking profile and inventory access…" : actionMessage}
        </p>
      )}

      {retryAfterSeconds > 0 && (
        <p id="recheck-cooldown" className="action-status cooldown-status">
          Repeated immediate recheck requests are disabled. Try again in{" "}
          {retryAfterSeconds}s.
        </p>
      )}

      <div className="access-intro">
        <div>
          <p className="section-label">Public access check</p>
          <h2>What Steam exposes right now</h2>
        </div>
        <p>
          These checks are independent. An unavailable check means we could not
          verify it—not that the surface is private.
        </p>
      </div>

      <div className="access-grid">
        <AccessCard surface="profile" check={session.checks.profile} />
        <AccessCard surface="inventory" check={session.checks.inventory} />
      </div>

      {session.checks.inventory.status === "public" && (
        <InventoryResults
          inventory={session.checks.inventory}
          isRefreshingGems={isRefreshingGems}
          refreshMessage={gemRefreshMessage}
          onRefreshGems={onRefreshGems}
        />
      )}
    </section>
  );
}

export function App() {
  const [viewState, setViewState] = useState<ViewState>({ kind: "loading" });
  const [isRechecking, setIsRechecking] = useState(false);
  const [isRefreshingGems, setIsRefreshingGems] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [retryDeadlineMs, setRetryDeadlineMs] = useState<number | null>(null);
  const [countdownNowMs, setCountdownNowMs] = useState(() => performance.now());
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [gemRefreshMessage, setGemRefreshMessage] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("Checking session…");
  const retryDeadlineRef = useRef<number | null>(null);
  const recheckInFlightRef = useRef(false);
  const gemRefreshInFlightRef = useRef(false);
  const retryAfterSeconds = secondsUntilDeadline(
    retryDeadlineMs,
    countdownNowMs
  );

  const applySession = useCallback((session: SessionResponse) => {
    const nowMs = performance.now();
    const deadlineMs =
      session.authenticated &&
        session.checks.inventory.retry_after_seconds !== null
        ? nowMs +
        session.checks.inventory.retry_after_seconds *
        MILLISECONDS_PER_SECOND
        : null;

    retryDeadlineRef.current = deadlineMs;
    setRetryDeadlineMs(deadlineMs);
    setCountdownNowMs(nowMs);
    setViewState(toViewState(session));
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void requestSession(controller.signal)
      .then((session) => {
        if (!controller.signal.aborted) {
          applySession(session);
          setStatusAnnouncement("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setViewState({ kind: "api-unavailable" });
          setStatusAnnouncement("Steam connection is unavailable.");
        }
      });

    return () => controller.abort();
  }, [applySession]);

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
    setStatusAnnouncement("Checking session…");

    try {
      applySession(await requestSession());
      setStatusAnnouncement("");
    } catch {
      setViewState({ kind: "api-unavailable" });
      setStatusAnnouncement("Steam connection is unavailable.");
    }
  }

  async function handleRecheck() {
    if (
      recheckInFlightRef.current ||
      gemRefreshInFlightRef.current ||
      isSigningOut ||
      secondsUntilDeadline(retryDeadlineRef.current, performance.now()) > 0
    ) {
      return;
    }

    recheckInFlightRef.current = true;
    setIsRechecking(true);
    setActionMessage(null);
    setGemRefreshMessage(null);
    setStatusAnnouncement("Rechecking profile and inventory access…");

    try {
      const session = await requestSession();
      applySession(session);
      setStatusAnnouncement(
        session.authenticated
          ? `Recheck complete. Steam profile: ${STATUS_LABELS[session.checks.profile.status]}. Steam inventory: ${STATUS_LABELS[session.checks.inventory.status]}.`
          : "Your local session has ended. Sign in again to recheck Steam access."
      );
    } catch {
      const message =
        "We could not recheck Steam access. The service is unavailable, and your previous results have not changed.";
      setActionMessage(message);
      setStatusAnnouncement(message);
    } finally {
      recheckInFlightRef.current = false;
      setIsRechecking(false);
    }
  }
  async function handleGemRefresh() {
    if (
      gemRefreshInFlightRef.current ||
      recheckInFlightRef.current ||
      isSigningOut ||
      viewState.kind !== "signed-in" ||
      viewState.session.checks.inventory.status !== "public"
    ) {
      return;
    }
    const inventory = viewState.session.checks.inventory;
    if (gemRefreshGroups(inventory.items).length === 0) {
      return;
    }

    gemRefreshInFlightRef.current = true;
    setIsRefreshingGems(true);
    setGemRefreshMessage(null);
    setStatusAnnouncement("Refreshing cached gem values…");

    try {
      const refresh = await requestGemRefresh(inventory);
      const mergedInventory = mergeGemRefresh(inventory, refresh);
      setViewState((current) =>
        current.kind === "signed-in"
          ? {
            kind: "signed-in",
            session: {
              ...current.session,
              checks: {
                ...current.session.checks,
                inventory: mergeGemRefresh(
                  current.session.checks.inventory,
                  refresh
                )
              }
            }
          }
          : current
      );
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
    if (gemRefreshInFlightRef.current) {
      return;
    }
    setIsSigningOut(true);
    setActionMessage(null);
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

      applySession({ authenticated: false });
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
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <header className="site-header">
        <Brand />
        <div className="site-header-actions">
          <p className="boundary-pill">
            <span aria-hidden="true">●</span>
            Read-only workspace
          </p>
          {viewState.kind === "signed-out" && (
            <a
              className="steam-sign-in-link"
              href={STEAM_LOGIN_URL}
              aria-describedby="connect-description"
            >
              <picture className="steam-sign-in-picture">
                <source
                  media="(max-width: 40rem)"
                  srcSet={steamSignInCompact}
                  width="109"
                  height="66"
                />
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
        </div>
      </header>

      <main id="main-content" className="page-main">
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">Understand what Steam makes public</p>
          <h1 id="page-title">A clearer view of your Steam inventory.</h1>
          <p className="hero-copy">
            Connect your account to verify which Steam surfaces are public before
            using read-only inventory and badge tools.
          </p>
        </section>
        <p
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {statusAnnouncement}
        </p>

        {viewState.kind === "loading" && <LoadingView />}
        {viewState.kind === "signed-out" && <SignedOutView />}
        {viewState.kind === "api-unavailable" && (
          <ApiUnavailableView onRetry={() => void handleRetry()} />
        )}
        {viewState.kind === "signed-in" && (
          <SignedInView
            session={viewState.session}
            isRechecking={isRechecking}
            isRefreshingGems={isRefreshingGems}
            isSigningOut={isSigningOut}
            retryAfterSeconds={retryAfterSeconds}
            actionMessage={actionMessage}
            gemRefreshMessage={gemRefreshMessage}
            onRecheck={() => void handleRecheck()}
            onRefreshGems={() => void handleGemRefresh()}
            onLogout={() => void handleLogout()}
          />
        )}

        <ReadOnlyBoundary />
      </main>

      <footer className="site-footer">
        <p>Steam Optimizer</p>
        <p>Public data in. Manual decisions out.</p>
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
          Privacy &amp; Steam data terms
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      </footer>
    </div>
  );
}
