import { useCallback, useRef, useState } from "react";
import {
  MAX_CARD_QUANTITY,
  MAX_LEVEL_UP_CARD_ROWS,
  MAX_STEAM_ID_LENGTH,
  formatAbsoluteTime,
  formatMinorUnits,
  formatRelativeTime,
  isInventorySnapshotFresh,
  isLevelUpIsoTimestamp,
  isNormalCardMarketHashName,
  normalCardAppId
} from "./levelUpOptimization";
import type { LevelUpInventoryItem } from "./levelUpOptimization";
import {
  MAX_BADGE_CRAFT_LEVEL,
  MAX_BADGE_PLANNING_SCOPE_IDS,
  MAX_BADGE_PLANNING_TARGET_LEVEL,
  MIN_BADGE_COLLECTOR_TARGET_LEVEL,
  isBadgePlanningResponseExpired
} from "./badgePlanning";
import type {
  BadgeCollectorTarget,
  BadgePlan,
  BadgePlanStrategy,
  BadgePlanningMoney,
  BadgePlanningMode,
  BadgePlanningReadyResponse,
  BadgePlanningScope,
  BadgeProtection
} from "./badgePlanning";

/**
 * Plan workflow: opt-in per-account saved setup storage, the downloadable
 * reference checklist, and the pure have/want/surplus arithmetic behind it.
 *
 * Boundaries enforced by this module:
 * - Only bounded intent and optional checklist annotation IDs are persisted.
 *   Holdings, quotes, and computed plans never reach storage.
 * - The checklist is a reference document. It never claims that a purchase,
 *   sale, or craft happened or will happen automatically; prices carry their
 *   quote timestamps and the export states the reference-only warning.
 * - Quantities are computed per card hash from per-asset inventory rows.
 *   Tradeable counts are summed per copy, never reduced to an any-copy
 *   boolean. Surplus is only what remains after the selected plan and any
 *   requested collector goals consume their copies; reserved and never-sell
 *   copies are never suggested for trades.
 */

export const PLAN_INTENT_SCHEMA_VERSION = 1;
/** Mirrors the request-side card-row bound for stored protections. */
export const MAX_PLAN_INTENT_PROTECTIONS = MAX_LEVEL_UP_CARD_ROWS;
export const PLAN_INTENT_KEY_PREFIX = "steamally:plan-intent";
/** Checklist rows rendered inline before the download note takes over. */
export const PLAN_CHECKLIST_RENDER_LIMIT = 300;

const PLAN_INTENT_LIST_KEYS = [
  "mode",
  "targetLevel",
  "budgetText",
  "money",
  "scope",
  "selectedAppIds",
  "collectorTargets",
  "protections",
  "excludedAppIds",
  "strategy"
] as const;

const TARGET_LEVEL_TEXT_PATTERN = /^[0-9]{1,7}$/;
const BUDGET_TEXT_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;
const MAX_INPUT_TEXT_LENGTH = 32;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const POSITIVE_DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const STEAM_ID_PATTERN = new RegExp(`^[0-9]{1,${MAX_STEAM_ID_LENGTH}}$`);

export type PlanIntent = {
  mode: BadgePlanningMode;
  targetLevel: string;
  budgetText: string;
  money: BadgePlanningMoney | null;
  scope: BadgePlanningScope;
  selectedAppIds: string[];
  collectorTargets: BadgeCollectorTarget[];
  protections: BadgeProtection[];
  excludedAppIds: string[];
  strategy: BadgePlanStrategy;
};

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return (
    present.length === keys.length && keys.every((key) => present.includes(key))
  );
}

function isSafeInteger(
  value: unknown,
  min: number,
  max: number
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isPositiveAppId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 20 &&
    POSITIVE_DECIMAL_ID_PATTERN.test(value)
  );
}

function isTargetLevelText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "" ||
      (TARGET_LEVEL_TEXT_PATTERN.test(value) &&
        Number(value) <= MAX_BADGE_PLANNING_TARGET_LEVEL))
  );
}

function isBudgetText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "" ||
      (value.length <= MAX_INPUT_TEXT_LENGTH &&
        BUDGET_TEXT_PATTERN.test(value)))
  );
}

function isMoney(value: unknown): value is BadgePlanningMoney {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (!hasExactKeys(value, ["currency_code", "minor_digits"])) {
    return false;
  }
  const money = value as BadgePlanningMoney;
  return (
    typeof money.currency_code === "string" &&
    CURRENCY_CODE_PATTERN.test(money.currency_code) &&
    isSafeInteger(money.minor_digits, 0, 3)
  );
}

function isUniqueAppIdList(
  value: unknown,
  maxLength: number,
  allowEmpty: boolean
): value is string[] {
  if (!Array.isArray(value) || value.length > maxLength) return false;
  if (!allowEmpty && value.length === 0) return false;
  const seen = new Set<string>();
  for (const appId of value) {
    if (!isPositiveAppId(appId) || seen.has(appId)) return false;
    seen.add(appId);
  }
  return true;
}

function isCollectorTargets(value: unknown): value is BadgeCollectorTarget[] {
  if (!Array.isArray(value) || value.length > MAX_BADGE_PLANNING_SCOPE_IDS) {
    return false;
  }
  const seen = new Set<string>();
  for (const target of value) {
    if (
      typeof target !== "object" ||
      target === null ||
      Array.isArray(target)
    ) {
      return false;
    }
    if (!hasExactKeys(target, ["app_id", "target_level"])) {
      return false;
    }
    const candidate = target as BadgeCollectorTarget;
    if (
      !isPositiveAppId(candidate.app_id) ||
      seen.has(candidate.app_id) ||
      !isSafeInteger(
        candidate.target_level,
        MIN_BADGE_COLLECTOR_TARGET_LEVEL,
        MAX_BADGE_CRAFT_LEVEL
      )
    ) {
      return false;
    }
    seen.add(candidate.app_id);
  }
  return true;
}

function isProtections(value: unknown): value is BadgeProtection[] {
  if (!Array.isArray(value) || value.length > MAX_PLAN_INTENT_PROTECTIONS) {
    return false;
  }
  const seen = new Set<string>();
  for (const protection of value) {
    if (
      typeof protection !== "object" ||
      protection === null ||
      Array.isArray(protection)
    ) {
      return false;
    }
    if (
      !hasExactKeys(protection, [
        "market_hash_name",
        "keep_quantity",
        "never_sell"
      ])
    ) {
      return false;
    }
    const candidate = protection as BadgeProtection;
    if (
      !isNormalCardMarketHashName(candidate.market_hash_name) ||
      seen.has(candidate.market_hash_name) ||
      !isSafeInteger(candidate.keep_quantity, 0, MAX_CARD_QUANTITY) ||
      typeof candidate.never_sell !== "boolean"
    ) {
      return false;
    }
    seen.add(candidate.market_hash_name);
  }
  return true;
}

/**
 * Validates a stored setup against the same bounds as the planning request
 * options, so a restored intent can always rebuild a valid request. The
 * request-shaped lists stay strict: targets only in collector mode, selected
 * ids only for the selected scope.
 */
export function isPlanIntent(value: unknown): value is PlanIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (!hasExactKeys(value, PLAN_INTENT_LIST_KEYS)) {
    return false;
  }
  const intent = value as PlanIntent;
  if (
    intent.mode !== "target" &&
    intent.mode !== "budget" &&
    intent.mode !== "collector"
  ) {
    return false;
  }
  if (
    intent.scope !== "inventory" &&
    intent.scope !== "selected" &&
    intent.scope !== "catalog"
  ) {
    return false;
  }
  if (
    intent.strategy !== "cheapest" &&
    intent.strategy !== "fewest_purchases" &&
    intent.strategy !== "preserve_cards"
  ) {
    return false;
  }
  if (
    !isTargetLevelText(intent.targetLevel) ||
    !isBudgetText(intent.budgetText)
  ) {
    return false;
  }
  if (intent.money !== null && !isMoney(intent.money)) {
    return false;
  }
  if (
    !isUniqueAppIdList(
      intent.excludedAppIds,
      MAX_BADGE_PLANNING_SCOPE_IDS,
      true
    )
  ) {
    return false;
  }
  if (
    !isUniqueAppIdList(
      intent.selectedAppIds,
      MAX_BADGE_PLANNING_SCOPE_IDS,
      intent.scope !== "selected"
    )
  ) {
    return false;
  }
  if (!isCollectorTargets(intent.collectorTargets)) {
    return false;
  }
  if (
    intent.mode === "collector"
      ? intent.collectorTargets.length === 0
      : intent.collectorTargets.length > 0
  ) {
    return false;
  }
  return isProtections(intent.protections);
}

/**
 * True when a saved intent may drive paid spending again: the intent either
 * saved no currency binding, or the freshly discovered contract matches the
 * saved one exactly. A mismatch keeps spending disabled with disclosure.
 */
export function planIntentCurrencyBinding(
  intent: PlanIntent,
  money: BadgePlanningMoney | null
): boolean {
  if (intent.money === null) {
    return true;
  }
  return (
    money !== null &&
    money.currency_code === intent.money.currency_code &&
    money.minor_digits === intent.money.minor_digits
  );
}

/**
 * Clamps stored keep quantities against actual holdings before a restored
 * intent becomes a draft. Protections are never dropped; only the quantity
 * shrinks, and every reduction is reported for disclosure.
 */
export function clampPlanIntentProtections(
  intent: PlanIntent,
  items: readonly LevelUpInventoryItem[]
): { intent: PlanIntent; clampedMarketHashNames: string[] } {
  const owned = new Map<string, number>();
  for (const item of items) {
    if (
      item.item_type === "trading_card" &&
      item.card_border === "normal" &&
      isNormalCardMarketHashName(item.market_hash_name) &&
      isSafeInteger(item.quantity, 1, MAX_CARD_QUANTITY)
    ) {
      const hash = item.market_hash_name;
      owned.set(hash, (owned.get(hash) ?? 0) + item.quantity);
    }
  }
  const clampedMarketHashNames: string[] = [];
  const protections = intent.protections.map((protection) => {
    const ownedQuantity = owned.get(protection.market_hash_name);
    if (
      ownedQuantity === undefined ||
      protection.keep_quantity <= ownedQuantity
    ) {
      return protection;
    }
    clampedMarketHashNames.push(protection.market_hash_name);
    return { ...protection, keep_quantity: ownedQuantity };
  });
  return {
    intent: { ...intent, protections },
    clampedMarketHashNames
  };
}

/* Saved setup storage ------------------------------------------------------ */

const READ_UNAVAILABLE_MESSAGE =
  "Local storage is unavailable, so saved plan setups cannot be read on this device.";
const WRITE_UNAVAILABLE_MESSAGE =
  "Local storage is unavailable, so the plan setup cannot be saved on this device.";
const WRITE_FAILED_MESSAGE =
  "The plan setup could not be saved to local storage because the browser refused the write.";
const READ_CORRUPT_MESSAGE =
  "The saved plan setup on this device could not be read. Use the forget action to remove it.";
const SIGNED_OUT_MESSAGE = "Sign in to save a plan setup on this device.";
const INVALID_INTENT_MESSAGE =
  "This plan setup contains values outside the allowed bounds, so it was not saved.";
const REMEMBER_REQUIRED_MESSAGE =
  "Turn on the remember option before saving a plan setup on this device.";

export type PlanIntentState = {
  saved: PlanIntent | null;
  remember: boolean;
  error: string | null;
};

export type PlanIntentApi = PlanIntentState & {
  setRemember(value: boolean, intent: PlanIntent): void;
  save(intent: PlanIntent): void;
  forget(): void;
};

type PlanIntentEnvelope = {
  schema: typeof PLAN_INTENT_SCHEMA_VERSION;
  remember: boolean;
  intent: PlanIntent | null;
};

/** Storage key for one account; null when the id cannot be stored safely. */
export function planIntentStorageKey(steamId: string | null): string | null {
  if (steamId === null || !STEAM_ID_PATTERN.test(steamId)) {
    return null;
  }
  return `${PLAN_INTENT_KEY_PREFIX}:${steamId}`;
}

function accessibleStorage(): Storage | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

function isEnvelope(value: unknown): value is PlanIntentEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (!hasExactKeys(value, ["schema", "remember", "intent"])) {
    return false;
  }
  const envelope = value as PlanIntentEnvelope;
  return (
    envelope.schema === PLAN_INTENT_SCHEMA_VERSION &&
    typeof envelope.remember === "boolean" &&
    (envelope.intent === null || isPlanIntent(envelope.intent))
  );
}

type EnvelopeRead =
  | { kind: "absent" }
  | { kind: "ok"; envelope: PlanIntentEnvelope }
  | { kind: "unavailable" }
  | { kind: "corrupt" };

function readEnvelope(storage: Storage | null, key: string): EnvelopeRead {
  if (storage === null) {
    return { kind: "unavailable" };
  }
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { kind: "unavailable" };
  }
  if (raw === null) {
    return { kind: "absent" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isEnvelope(parsed)) {
      return { kind: "corrupt" };
    }
    return { kind: "ok", envelope: parsed };
  } catch {
    return { kind: "corrupt" };
  }
}

function writeEnvelope(
  storage: Storage | null,
  key: string,
  envelope: PlanIntentEnvelope
): string | null {
  if (storage === null) {
    return WRITE_UNAVAILABLE_MESSAGE;
  }
  try {
    storage.setItem(key, JSON.stringify(envelope));
    return null;
  } catch {
    return WRITE_FAILED_MESSAGE;
  }
}

function removeEnvelope(storage: Storage | null, key: string): string | null {
  if (storage === null) {
    return WRITE_UNAVAILABLE_MESSAGE;
  }
  try {
    storage.removeItem(key);
    return null;
  } catch {
    return WRITE_FAILED_MESSAGE;
  }
}

/**
 * Reads the stored setup for one account without applying anything. Corrupt
 * or unreadable storage reports an explicit error and never a fake empty
 * success; forget() is the recovery path.
 */
export function readPlanIntentState(steamId: string | null): PlanIntentState {
  const key = planIntentStorageKey(steamId);
  if (key === null) {
    return { saved: null, remember: false, error: null };
  }
  const read = readEnvelope(accessibleStorage(), key);
  if (read.kind === "unavailable") {
    return { saved: null, remember: false, error: READ_UNAVAILABLE_MESSAGE };
  }
  if (read.kind === "corrupt") {
    return { saved: null, remember: false, error: READ_CORRUPT_MESSAGE };
  }
  if (read.kind === "absent") {
    return { saved: null, remember: false, error: null };
  }
  return {
    saved: read.envelope.intent,
    remember: read.envelope.remember && read.envelope.intent !== null,
    error: null
  };
}

/**
 * Opt-in per-account storage for the bounded plan setup. Data lives under a
 * key derived from the steam id, so different accounts never share state.
 * Saving requires the remember opt-in; opting out and forgetting remove the
 * stored data entirely. Nothing but the validated intent is written.
 */
export function usePlanIntent(steamId: string | null): PlanIntentApi {
  // Account-scoped state: the wrapper remembers which account the state was
  // read for, and an account change resets it synchronously during render
  // (the documented reset-on-prop-change pattern). No render ever exposes
  // another account's saved setup and no effect flush is needed.
  const [account, setAccount] = useState<{
    steamId: string | null;
    state: PlanIntentState;
  }>(() => ({
    steamId,
    state: readPlanIntentState(steamId)
  }));
  if (account.steamId !== steamId) {
    setAccount({ steamId, state: readPlanIntentState(steamId) });
  }

  // Event callbacks share same-tick commits, but never read or mutate refs
  // during rendering. A changed account reads its own stored state instead.
  const stateRef = useRef(account);
  const commit = useCallback(
    (state: PlanIntentState) => {
      const next = { steamId, state };
      stateRef.current = next;
      setAccount(next);
    },
    [steamId]
  );

  const setRemember = useCallback(
    (value: boolean, intent: PlanIntent) => {
      const current =
        stateRef.current.steamId === steamId
          ? stateRef.current.state
          : readPlanIntentState(steamId);
      const key = planIntentStorageKey(steamId);
      if (key === null) {
        commit({ ...current, error: SIGNED_OUT_MESSAGE });
        return;
      }
      const storage = accessibleStorage();
      if (!value) {
        // Opting out removes the stored data instead of hiding it.
        commit({
          saved: null,
          remember: false,
          error: removeEnvelope(storage, key)
        });
        return;
      }
      if (!isPlanIntent(intent)) {
        commit({ ...current, error: INVALID_INTENT_MESSAGE });
        return;
      }
      const failure = writeEnvelope(storage, key, {
        schema: PLAN_INTENT_SCHEMA_VERSION,
        remember: true,
        intent
      });
      commit(
        failure === null
          ? { saved: intent, remember: true, error: null }
          : { saved: null, remember: false, error: failure }
      );
    },
    [steamId, commit]
  );

  const save = useCallback(
    (intent: PlanIntent) => {
      const current =
        stateRef.current.steamId === steamId
          ? stateRef.current.state
          : readPlanIntentState(steamId);
      const key = planIntentStorageKey(steamId);
      if (key === null) {
        commit({ ...current, error: SIGNED_OUT_MESSAGE });
        return;
      }
      if (!isPlanIntent(intent)) {
        commit({ ...current, error: INVALID_INTENT_MESSAGE });
        return;
      }
      if (!current.remember) {
        commit({ ...current, error: REMEMBER_REQUIRED_MESSAGE });
        return;
      }
      const failure = writeEnvelope(accessibleStorage(), key, {
        schema: PLAN_INTENT_SCHEMA_VERSION,
        remember: true,
        intent
      });
      commit(
        failure === null
          ? { saved: intent, remember: true, error: null }
          : { ...current, error: failure }
      );
    },
    [steamId, commit]
  );

  const forget = useCallback(() => {
    const key = planIntentStorageKey(steamId);
    if (key === null) {
      commit({ saved: null, remember: false, error: null });
      return;
    }
    commit({
      saved: null,
      remember: false,
      error: removeEnvelope(accessibleStorage(), key)
    });
  }, [steamId, commit]);

  return {
    saved: account.state.saved,
    remember: account.state.remember,
    error: account.state.error,
    setRemember,
    save,
    forget
  };
}

/* Have / want / surplus arithmetic ---------------------------------------- */

export type PlanWantSource = "plan_drift" | "collector_goal";

export type PlanCardCounts = {
  gameId: string;
  gameName: string;
  marketHashName: string;
  cardName: string;
  /** Every copy in the current inventory snapshot rows. */
  ownedTotal: number;
  /** Copies pinned by keep_quantity; never consumed, never surplus. */
  reserved: number;
  /** Tradable and marketable copies among the unreserved pool. */
  tradeableUnreserved: number;
  /** Copies the selected plan consumes per craft across its steps. */
  planCraftDemand: number;
  /** Copies the plan buys outright. */
  purchased: number;
  craftFromInventory: number;
  /** Positive when the current inventory no longer covers the plan. */
  craftMissing: number;
  /** Remaining crafts for requested collector goals beyond the plan. */
  goalCraftDemand: number;
  goalFromInventory: number;
  goalMissing: number;
  /** Everything that must still be acquired: craftMissing + goalMissing. */
  wanted: number;
  /** Unreserved copies left after plan and goal commitments. */
  surplus: number;
  /** Tradable and marketable subset of surplus that trades may be suggested for. */
  suggestedTradeable: number;
  withheldSurplus: number;
  withheldReason: "never_sell" | "excluded" | "not_tradable" | null;
};

export type PlanWantsResult = {
  cards: PlanCardCounts[];
  /** Requested collector targets without usable game composition data. */
  unmatchedCollectorTargets: BadgeCollectorTarget[];
  /** Plan steps whose game returned no card composition to attribute usage to. */
  stepsWithoutComposition: string[];
};

export type PlanWantsArgs = {
  response: BadgePlanningReadyResponse;
  plan: BadgePlan;
  items: readonly LevelUpInventoryItem[];
  collectorTargets?: readonly BadgeCollectorTarget[];
};

type CardAccumulator = {
  gameId: string;
  gameName: string;
  cardName: string;
  ownedTotal: number;
  tradeableOwned: number;
  keep: number;
  neverSell: boolean;
  excluded: boolean;
  planCraftDemand: number;
  purchased: number;
  goalCraftDemand: number;
};

function isNormalCardItem(
  item: LevelUpInventoryItem
): item is LevelUpInventoryItem & { market_hash_name: string } {
  return (
    item.item_type === "trading_card" &&
    item.card_border === "normal" &&
    isNormalCardMarketHashName(item.market_hash_name) &&
    isSafeInteger(item.quantity, 1, MAX_CARD_QUANTITY) &&
    typeof item.marketable === "boolean" &&
    typeof item.tradable === "boolean"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Computes per-card wanted and surplus quantities for the selected plan.
 *
 * Exact invariants per card hash:
 * - ownedTotal = reserved + craftFromInventory + goalFromInventory + surplus
 * - purchased + craftFromInventory + craftMissing = planCraftDemand
 * - goalFromInventory + goalMissing = goalCraftDemand
 * - 0 <= suggestedTradeable <= surplus <= ownedTotal - reserved
 *
 * Tradeability is allocated per copy, never per hash boolean. Reserved pins
 * and craft consumption draw tradable-and-marketable copies first, so the
 * suggested trade count can only understate, never overstate, liquid copies.
 * Duplicates are not surplus: surplus exists only beyond commitments.
 */
export function computePlanWantsAndSurplus({
  response,
  plan,
  items,
  collectorTargets = []
}: PlanWantsArgs): PlanWantsResult {
  const games = new Map(response.games.map((game) => [game.app_id, game]));
  const accumulators = new Map<string, CardAccumulator>();
  const planCraftsByGame = new Map<string, number>();
  const unmatchedCollectorTargets: BadgeCollectorTarget[] = [];
  const stepsWithoutComposition: string[] = [];

  const ensure = (
    hash: string,
    gameId: string,
    gameName: string,
    cardName: string
  ): CardAccumulator => {
    let acc = accumulators.get(hash);
    if (acc === undefined) {
      acc = {
        gameId,
        gameName,
        cardName,
        ownedTotal: 0,
        tradeableOwned: 0,
        keep: 0,
        neverSell: false,
        excluded: false,
        planCraftDemand: 0,
        purchased: 0,
        goalCraftDemand: 0
      };
      accumulators.set(hash, acc);
    }
    return acc;
  };

  for (const game of response.games) {
    const excluded = game.status === "excluded";
    for (const card of game.cards) {
      const acc = ensure(
        card.market_hash_name,
        game.app_id,
        game.game_name,
        card.card_name
      );
      acc.keep = Math.max(acc.keep, card.keep_quantity);
      acc.neverSell = acc.neverSell || card.never_sell;
      acc.excluded = acc.excluded || excluded;
      if (acc.gameName === "") {
        acc.gameName = game.game_name;
      }
    }
  }

  // Copies of hashes that no returned game covers have unknown set
  // composition; they are never claimed as usable inventory or surplus.
  for (const item of items) {
    if (!isNormalCardItem(item) || !accumulators.has(item.market_hash_name)) {
      continue;
    }
    const acc = accumulators.get(item.market_hash_name);
    if (acc === undefined) {
      continue;
    }
    acc.ownedTotal += item.quantity;
    if (item.marketable && item.tradable) {
      acc.tradeableOwned += item.quantity;
    }
  }

  for (const step of plan.steps) {
    const game = games.get(step.app_id);
    if (game === undefined || game.cards.length === 0) {
      if (!stepsWithoutComposition.includes(step.app_id)) {
        stepsWithoutComposition.push(step.app_id);
      }
    } else if (step.craft_count > 0) {
      for (const card of game.cards) {
        ensure(
          card.market_hash_name,
          game.app_id,
          game.game_name,
          card.card_name
        ).planCraftDemand += step.craft_count;
      }
    }
    planCraftsByGame.set(
      step.app_id,
      (planCraftsByGame.get(step.app_id) ?? 0) + step.craft_count
    );
    for (const purchase of step.purchases) {
      const appId = normalCardAppId(purchase.market_hash_name);
      const owningGame = appId === null ? undefined : games.get(appId);
      const acc = ensure(
        purchase.market_hash_name,
        owningGame?.app_id ?? appId ?? step.app_id,
        owningGame?.game_name ?? step.game_name,
        owningGame?.cards.find(
          (card) => card.market_hash_name === purchase.market_hash_name
        )?.card_name ?? purchase.card_name
      );
      acc.purchased += purchase.quantity;
      if (acc.gameName === "") {
        acc.gameName = step.game_name;
      }
    }
  }

  for (const target of collectorTargets) {
    const game = games.get(target.app_id);
    if (game === undefined || game.cards.length === 0) {
      unmatchedCollectorTargets.push(target);
      continue;
    }
    const goalCrafts =
      Math.min(target.target_level, MAX_BADGE_CRAFT_LEVEL) - game.badge_level;
    const remaining = Math.max(
      0,
      goalCrafts - (planCraftsByGame.get(target.app_id) ?? 0)
    );
    if (remaining === 0) {
      continue;
    }
    for (const card of game.cards) {
      ensure(
        card.market_hash_name,
        game.app_id,
        game.game_name,
        card.card_name
      ).goalCraftDemand += remaining;
    }
  }

  const cards: PlanCardCounts[] = [];
  for (const [hash, acc] of accumulators) {
    if (
      acc.ownedTotal === 0 &&
      acc.planCraftDemand === 0 &&
      acc.purchased === 0 &&
      acc.goalCraftDemand === 0
    ) {
      continue;
    }
    const reserved = Math.min(acc.keep, acc.ownedTotal);
    const unreserved = acc.ownedTotal - reserved;
    // Reserved pins consume liquid copies first: claims never overstate.
    const tradeableUnreserved = clamp(acc.tradeableOwned, 0, unreserved);
    const craftNeed = Math.max(0, acc.planCraftDemand - acc.purchased);
    const craftFromInventory = Math.min(craftNeed, unreserved);
    const craftMissing = craftNeed - craftFromInventory;
    const leftover = unreserved - craftFromInventory;
    const goalFromInventory = Math.min(acc.goalCraftDemand, leftover);
    const goalMissing = acc.goalCraftDemand - goalFromInventory;
    const surplus = leftover - goalFromInventory;
    // Excluded games and never-sell hashes are withheld from suggested
    // trades entirely, per the conservative protection policy.
    const suggestedTradeable =
      acc.excluded || acc.neverSell
        ? 0
        : clamp(
            tradeableUnreserved - craftFromInventory - goalFromInventory,
            0,
            surplus
          );
    const withheldSurplus = surplus - suggestedTradeable;
    cards.push({
      gameId: acc.gameId,
      gameName: acc.gameName,
      marketHashName: hash,
      cardName: acc.cardName === "" ? hash : acc.cardName,
      ownedTotal: acc.ownedTotal,
      reserved,
      tradeableUnreserved,
      planCraftDemand: acc.planCraftDemand,
      purchased: acc.purchased,
      craftFromInventory,
      craftMissing,
      goalCraftDemand: acc.goalCraftDemand,
      goalFromInventory,
      goalMissing,
      wanted: craftMissing + goalMissing,
      surplus,
      suggestedTradeable,
      withheldSurplus,
      withheldReason: acc.excluded
        ? "excluded"
        : acc.neverSell
          ? "never_sell"
          : withheldSurplus > 0
            ? "not_tradable"
            : null
    });
  }

  return { cards, unmatchedCollectorTargets, stepsWithoutComposition };
}

/* Checklist model and exports --------------------------------------------- */

export type PlanChecklistRow =
  | {
      kind: "craft";
      id: string;
      gameId: string;
      gameName: string;
      craftCount: number;
      badgeLevelBefore: number;
      badgeLevelAfter: number;
      xpGain: number;
      ownedCardsUsed: number;
    }
  | {
      kind: "purchase";
      id: string;
      gameId: string;
      gameName: string;
      marketHashName: string;
      cardName: string;
      quantity: number;
      unitPriceMinor: number;
      totalMinor: number;
      quoteTimestamp: string;
    }
  | {
      kind: "want";
      id: string;
      gameId: string;
      gameName: string;
      marketHashName: string;
      cardName: string;
      quantity: number;
      source: PlanWantSource;
    }
  | {
      kind: "surplus";
      id: string;
      gameId: string;
      gameName: string;
      marketHashName: string;
      cardName: string;
      quantity: number;
      suggestedTradeable: number;
      withheldQuantity: number;
      withheldReason: "never_sell" | "excluded" | "not_tradable" | null;
    };

export type PlanChecklistReference = {
  generatedAt: string;
  validUntil: string;
  inventoryRefreshedAt: string;
  badgeRefreshedAt: string;
  currencyCode: string | null;
  minorDigits: number | null;
  strategy: BadgePlanStrategy;
  planStatus: BadgePlan["status"];
  planReason: string;
  targetLevel: number | null;
  targetReached: boolean;
  shortfallXp: number;
  playerLevel: number;
  projectedLevel: number;
  stale: boolean;
};

export type PlanChecklist = {
  schema: "plan-workflow-checklist";
  version: 1;
  steamId: string;
  planKey: string;
  builtAt: string;
  reference: PlanChecklistReference;
  summary: {
    craftCount: number;
    purchaseCount: number;
    ownedCardsUsed: number;
    spendMinor: number;
    remainingBudgetMinor: number;
    xpGain: number;
    projectedXp: number;
  };
  warnings: string[];
  rows: PlanChecklistRow[];
};

export type PlanChecklistFormat = "csv" | "json";

const REFERENCE_ONLY_WARNING =
  "Reference only. Nothing is bought, sold, or crafted automatically; prices are quotes recorded at their timestamps.";
const STALE_WARNING =
  "This plan snapshot is stale: it expired or its inventory and badge data aged out. Refresh before relying on any price or quantity.";
const CURRENCY_MISSING_WARNING =
  "No currency is confirmed for this snapshot: amounts are raw minor units and purchases need a re-confirmed budget.";
const DRIFT_WARNING =
  "The current inventory no longer matches the plan snapshot. Rows marked as plan drift must be acquired before the plan can run as written, or the plan should be regenerated.";
const GOAL_WARNING =
  "Collector goal wants are listed beyond the plan's own crafts, toward the full requested levels.";
const COMPOSITION_WARNING =
  "Some planned crafts could not be attributed to specific cards because the game composition was unavailable in this snapshot.";

/** Annotation identity follows the actual plan, not the time it was re-fetched. */
export function planChecklistKey(
  steamId: string,
  response: BadgePlanningReadyResponse,
  plan: BadgePlan
): string {
  const identity = JSON.stringify([
    response.inventory_refreshed_at,
    response.player_xp,
    response.player_level,
    response.currency_code,
    response.minor_digits,
    plan,
    response.games
      .filter(
        (game) => game.owned_cards > 0 || game.target_badge_level !== null
      )
      .map((game) => [
        game.app_id,
        game.badge_level,
        game.target_badge_level,
        game.status,
        game.cards.map((card) => [
          card.market_hash_name,
          card.owned_quantity,
          card.keep_quantity,
          card.never_sell
        ])
      ])
  ]);
  // Two independent integer hashes keep the stored identifier bounded.
  // This is an annotation key, never an authorization or transaction token.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${steamId}|${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export type ChecklistMarks = {
  remember: boolean;
  ids: ReadonlySet<string>;
  error: string | null;
};

/** Restore annotations only for an identical plan over the same inventory. */
export function readChecklistMarks(
  steamId: string,
  checklist: PlanChecklist
): ChecklistMarks {
  const empty: ChecklistMarks = {
    remember: false,
    ids: new Set(),
    error: null
  };
  const accountKey = planIntentStorageKey(steamId);
  const storage = accessibleStorage();
  if (accountKey === null || storage === null) return empty;
  try {
    const raw = storage.getItem(`${accountKey}:marks`);
    if (raw === null) return empty;
    if (raw.length > 256_000)
      throw new Error("Checklist marks exceed storage bounds.");
    const value: unknown = JSON.parse(raw);
    if (
      value === null ||
      typeof value !== "object" ||
      Object.keys(value).length !== 3 ||
      !("schema" in value) ||
      value.schema !== 1 ||
      !("planKey" in value) ||
      typeof value.planKey !== "string" ||
      value.planKey.length > 128 ||
      !("ids" in value) ||
      !Array.isArray(value.ids) ||
      value.ids.length > PLAN_CHECKLIST_RENDER_LIMIT ||
      !value.ids.every(
        (id): id is string => typeof id === "string" && id.length <= 640
      )
    ) {
      throw new Error("Invalid checklist marks.");
    }
    if (value.planKey !== checklist.planKey)
      return { ...empty, remember: true };
    const allowed = new Set(
      checklist.rows.slice(0, PLAN_CHECKLIST_RENDER_LIMIT).map((row) => row.id)
    );
    return {
      remember: true,
      ids: new Set(value.ids.filter((id) => allowed.has(id))),
      error: null
    };
  } catch {
    return {
      ...empty,
      remember: true,
      error:
        "Saved checklist marks could not be read. Turn off remembering to remove them."
    };
  }
}

/** Persist annotation IDs and a fingerprint, never the plan or its snapshots. */
export function persistChecklistMarks(
  steamId: string,
  checklist: PlanChecklist,
  remember: boolean,
  ids: ReadonlySet<string>
): string | null {
  const accountKey = planIntentStorageKey(steamId);
  const storage = accessibleStorage();
  if (accountKey === null || storage === null)
    return "Checklist storage is unavailable.";
  const key = `${accountKey}:marks`;
  try {
    if (!remember) {
      storage.removeItem(key);
      return null;
    }
    const allowed = new Set(
      checklist.rows.slice(0, PLAN_CHECKLIST_RENDER_LIMIT).map((row) => row.id)
    );
    const selected = [...ids].filter((id) => allowed.has(id));
    const raw = JSON.stringify({
      schema: 1,
      planKey: checklist.planKey,
      ids: selected
    });
    if (raw.length > 256_000)
      return "These checklist marks exceed the local storage limit.";
    storage.setItem(key, raw);
    return null;
  } catch {
    return "Checklist marks could not be saved or cleared. Check this browser's storage settings.";
  }
}

export function toggleChecklistAnnotation(
  annotations: ReadonlySet<string>,
  id: string
): ReadonlySet<string> {
  const next = new Set(annotations);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function buildPlanChecklist(args: {
  steamId: string;
  response: BadgePlanningReadyResponse;
  plan: BadgePlan;
  items: readonly LevelUpInventoryItem[];
  collectorTargets?: readonly BadgeCollectorTarget[];
  now?: number | Date;
}): PlanChecklist {
  const {
    steamId,
    response,
    plan,
    items,
    collectorTargets,
    now = Date.now()
  } = args;
  const wants = computePlanWantsAndSurplus({
    response,
    plan,
    items,
    collectorTargets
  });
  const planKey = planChecklistKey(steamId, response, plan);
  const builtAt = new Date(now).toISOString();
  const stale =
    isBadgePlanningResponseExpired(response, now) ||
    !isInventorySnapshotFresh(response.inventory_refreshed_at, now) ||
    !isInventorySnapshotFresh(response.badge_refreshed_at, now);

  const rows: PlanChecklistRow[] = [];
  plan.steps.forEach((step, stepIndex) => {
    for (const purchase of step.purchases) {
      rows.push({
        kind: "purchase",
        id: `purchase:${step.app_id}:${stepIndex}:${purchase.market_hash_name}`,
        gameId: step.app_id,
        gameName: step.game_name,
        marketHashName: purchase.market_hash_name,
        cardName: purchase.card_name,
        quantity: purchase.quantity,
        unitPriceMinor: purchase.unit_price_minor,
        totalMinor: purchase.total_minor,
        quoteTimestamp: purchase.quote_timestamp
      });
    }
    rows.push({
      kind: "craft",
      id: `craft:${step.app_id}:${stepIndex}`,
      gameId: step.app_id,
      gameName: step.game_name,
      craftCount: step.craft_count,
      badgeLevelBefore: step.badge_level_before,
      badgeLevelAfter: step.badge_level_after,
      xpGain: step.xp_gain,
      ownedCardsUsed: step.owned_cards_used
    });
  });
  for (const counts of wants.cards) {
    if (counts.craftMissing > 0) {
      rows.push({
        kind: "want",
        id: `want:${counts.marketHashName}:plan_drift`,
        gameId: counts.gameId,
        gameName: counts.gameName,
        marketHashName: counts.marketHashName,
        cardName: counts.cardName,
        quantity: counts.craftMissing,
        source: "plan_drift"
      });
    }
    if (counts.goalMissing > 0) {
      rows.push({
        kind: "want",
        id: `want:${counts.marketHashName}:collector_goal`,
        gameId: counts.gameId,
        gameName: counts.gameName,
        marketHashName: counts.marketHashName,
        cardName: counts.cardName,
        quantity: counts.goalMissing,
        source: "collector_goal"
      });
    }
    if (counts.surplus > 0) {
      rows.push({
        kind: "surplus",
        id: `surplus:${counts.marketHashName}`,
        gameId: counts.gameId,
        gameName: counts.gameName,
        marketHashName: counts.marketHashName,
        cardName: counts.cardName,
        quantity: counts.surplus,
        suggestedTradeable: counts.suggestedTradeable,
        withheldQuantity: counts.withheldSurplus,
        withheldReason: counts.withheldReason
      });
    }
  }

  const warnings: string[] = [REFERENCE_ONLY_WARNING];
  if (stale) {
    warnings.push(STALE_WARNING);
  }
  if (response.currency_code === null || response.minor_digits === null) {
    warnings.push(CURRENCY_MISSING_WARNING);
  }
  if (wants.cards.some((counts) => counts.craftMissing > 0)) {
    warnings.push(DRIFT_WARNING);
  }
  if (wants.cards.some((counts) => counts.goalMissing > 0)) {
    warnings.push(GOAL_WARNING);
  }
  if (wants.unmatchedCollectorTargets.length > 0) {
    warnings.push(
      `Collector targets without usable game data are not silently skipped: ${wants.unmatchedCollectorTargets.map((target) => `${target.app_id} (level ${target.target_level})`).join(", ")}.`
    );
  }
  if (wants.stepsWithoutComposition.length > 0) {
    warnings.push(
      `${COMPOSITION_WARNING} Games: ${wants.stepsWithoutComposition.join(", ")}.`
    );
  }

  return {
    schema: "plan-workflow-checklist",
    version: 1,
    steamId,
    planKey,
    builtAt,
    reference: {
      generatedAt: response.generated_at,
      validUntil: response.valid_until,
      inventoryRefreshedAt: response.inventory_refreshed_at,
      badgeRefreshedAt: response.badge_refreshed_at,
      currencyCode: response.currency_code,
      minorDigits: response.minor_digits,
      strategy: plan.strategy,
      planStatus: plan.status,
      planReason: plan.reason,
      targetLevel: plan.target_level,
      targetReached: plan.target_reached,
      shortfallXp: plan.shortfall_xp,
      playerLevel: response.player_level,
      projectedLevel: plan.projected_level,
      stale
    },
    summary: {
      craftCount: plan.craft_count,
      purchaseCount: plan.purchase_count,
      ownedCardsUsed: plan.owned_cards_used,
      spendMinor: plan.spend_minor,
      remainingBudgetMinor: plan.remaining_budget_minor,
      xpGain: plan.xp_gain,
      projectedXp: plan.projected_xp
    },
    warnings,
    rows
  };
}

export function formatChecklistMoney(
  amountMinor: number,
  currencyCode: string | null,
  minorDigits: number | null
): string {
  if (currencyCode === null || minorDigits === null) {
    return `${amountMinor} minor`;
  }
  return formatMinorUnits(amountMinor, currencyCode, minorDigits);
}

function absoluteText(timestamp: string, now: number): string {
  if (!isLevelUpIsoTimestamp(timestamp)) {
    return timestamp;
  }
  return `${formatAbsoluteTime(timestamp)} (${formatRelativeTime(timestamp, now)})`;
}

/**
 * Single precise description of one checklist row, shared by the text
 * export and the component so the copy can never drift apart.
 */
export function describeChecklistRow(
  row: PlanChecklistRow,
  checklist: PlanChecklist
): string {
  const money = (amount: number) =>
    formatChecklistMoney(
      amount,
      checklist.reference.currencyCode,
      checklist.reference.minorDigits
    );
  switch (row.kind) {
    case "craft":
      return `Craft ${row.gameName} ×${row.craftCount} — badge level ${row.badgeLevelBefore} → ${row.badgeLevelAfter}, +${row.xpGain} XP, uses ${row.ownedCardsUsed} owned cards`;
    case "purchase":
      return `Buy ${row.quantity} × ${row.cardName} for ${row.gameName} — ${money(row.totalMinor)} total (unit ${money(row.unitPriceMinor)}, buyer total; quote ${absoluteText(row.quoteTimestamp, Date.parse(checklist.builtAt))})`;
    case "want":
      return row.source === "plan_drift"
        ? `Still wanted (plan drift): ${row.quantity} × ${row.cardName} for ${row.gameName}`
        : `Still wanted (collector goal): ${row.quantity} × ${row.cardName} for ${row.gameName}`;
    case "surplus": {
      const withheld =
        row.withheldReason === null || row.withheldQuantity === 0
          ? ""
          : row.withheldReason === "never_sell"
            ? `; ${row.withheldQuantity} withheld (never-sell protection)`
            : row.withheldReason === "excluded"
              ? `; ${row.withheldQuantity} withheld (game excluded from planning)`
              : `; ${row.withheldQuantity} withheld (not tradable)`;
      return `Surplus after commitments: ${row.quantity} × ${row.cardName} (${row.gameName}) — ${row.suggestedTradeable} suggested for trades${withheld}`;
    }
  }
}

export function checklistToText(
  checklist: PlanChecklist,
  checkedIds: ReadonlySet<string> = new Set()
): string {
  const now = Date.parse(checklist.builtAt);
  const { reference, summary } = checklist;
  const money = (amount: number) =>
    formatChecklistMoney(amount, reference.currencyCode, reference.minorDigits);
  const lines: string[] = [
    `Badge plan checklist — ${reference.strategy.replace(/_/g, " ")} (${reference.planStatus.replace(/_/g, " ")})`,
    `Account: ${checklist.steamId}`,
    REFERENCE_ONLY_WARNING,
    `Plan generated: ${absoluteText(reference.generatedAt, now)}`,
    `Valid until: ${absoluteText(reference.validUntil, now)}`,
    `Inventory snapshot: ${absoluteText(reference.inventoryRefreshedAt, now)}`,
    `Badge snapshot: ${absoluteText(reference.badgeRefreshedAt, now)}`,
    reference.currencyCode === null || reference.minorDigits === null
      ? "Currency: not confirmed (amounts are minor units)"
      : `Currency: ${reference.currencyCode} (${reference.minorDigits} minor digit(s))`,
    `Spend: ${money(summary.spendMinor)} | Budget left: ${money(summary.remainingBudgetMinor)} | Crafts: ${summary.craftCount} (+${summary.xpGain} XP) | Purchases: ${summary.purchaseCount}`,
    `Projected: level ${reference.projectedLevel} at ${summary.projectedXp} XP` +
      (reference.shortfallXp > 0
        ? ` | Shortfall: ${reference.shortfallXp} XP`
        : "")
  ];
  for (const warning of checklist.warnings) {
    lines.push(`Note: ${warning}`);
  }
  lines.push("");
  for (const row of checklist.rows) {
    const mark = checkedIds.has(row.id) ? "[x]" : "[ ]";
    lines.push(`${mark} ${describeChecklistRow(row, checklist)}`);
  }
  return lines.join("\n");
}

/**
 * Text beginning with =, +, -, or @ would execute as a spreadsheet formula,
 * and text beginning with control whitespace (tab, LF, VT, FF, CR) enables
 * delimiter or protocol smuggling. Such cells are neutralized with a leading
 * apostrophe before the standard RFC 4180 quoting; the JSON export keeps the
 * exact names untouched.
 */
const CSV_UNSAFE_PREFIX_PATTERN = /^[=+\-@\t\n\v\f\r]/;

function csvEscape(value: string): string {
  const neutralized = CSV_UNSAFE_PREFIX_PATTERN.test(value)
    ? `'${value}`
    : value;
  return /[",\n\r]/.test(neutralized)
    ? `"${neutralized.replaceAll('"', '""')}"`
    : neutralized;
}

const CHECKLIST_CSV_HEADER = [
  "section",
  "game",
  "app_id",
  "card",
  "market_hash_name",
  "quantity",
  "unit_price_minor",
  "total_minor",
  "quote_timestamp",
  "xp",
  "detail",
  "checked"
] as const;

export function checklistToCsv(
  checklist: PlanChecklist,
  checkedIds: ReadonlySet<string> = new Set()
): string {
  const { reference, summary } = checklist;
  const money = (amount: number) =>
    formatChecklistMoney(amount, reference.currencyCode, reference.minorDigits);
  const meta: [string, string][] = [
    ["reference", REFERENCE_ONLY_WARNING],
    ["account", checklist.steamId],
    ["generated_at", reference.generatedAt],
    ["valid_until", reference.validUntil],
    ["inventory_refreshed_at", reference.inventoryRefreshedAt],
    ["badge_refreshed_at", reference.badgeRefreshedAt],
    ["currency", reference.currencyCode ?? "not_confirmed"],
    [
      "minor_digits",
      reference.minorDigits === null
        ? "not_confirmed"
        : String(reference.minorDigits)
    ],
    ["strategy", reference.strategy],
    ["plan_status", reference.planStatus],
    ["stale", String(reference.stale)],
    ["spend", money(summary.spendMinor)],
    ["budget_left", money(summary.remainingBudgetMinor)],
    ["craft_count", String(summary.craftCount)],
    ["xp_gain", String(summary.xpGain)],
    ["purchase_count", String(summary.purchaseCount)],
    ["built_at", checklist.builtAt]
  ];
  const lines: string[] = meta.map(
    ([key, value]) => `# ${key}: ${csvEscape(value)}`
  );
  lines.push("");
  lines.push(CHECKLIST_CSV_HEADER.join(","));
  for (const row of checklist.rows) {
    const cells: string[] = [row.kind];
    const common: string[] = [];
    const numbers: string[] = [];
    let quoteTimestamp = "";
    let xp = "";
    let detail = "";
    switch (row.kind) {
      case "craft":
        common.push(row.gameName, row.gameId, "", "");
        numbers.push(String(row.craftCount), "", "");
        xp = String(row.xpGain);
        detail = `level ${row.badgeLevelBefore} -> ${row.badgeLevelAfter}; uses ${row.ownedCardsUsed} owned cards`;
        break;
      case "purchase":
        common.push(row.gameName, row.gameId, row.cardName, row.marketHashName);
        numbers.push(
          String(row.quantity),
          String(row.unitPriceMinor),
          String(row.totalMinor)
        );
        quoteTimestamp = row.quoteTimestamp;
        detail = `buyer total; unit ${money(row.unitPriceMinor)} total ${money(row.totalMinor)}`;
        break;
      case "want":
        common.push(row.gameName, row.gameId, row.cardName, row.marketHashName);
        numbers.push(String(row.quantity), "", "");
        detail = row.source;
        break;
      case "surplus":
        common.push(row.gameName, row.gameId, row.cardName, row.marketHashName);
        numbers.push(String(row.quantity), "", "");
        detail =
          `after commitments; ${row.suggestedTradeable} suggested for trades` +
          (row.withheldReason === null || row.withheldQuantity === 0
            ? ""
            : `; ${row.withheldQuantity} withheld (${row.withheldReason})`);
        break;
    }
    cells.push(
      ...common,
      ...numbers,
      quoteTimestamp,
      xp,
      detail,
      checkedIds.has(row.id) ? "true" : "false"
    );
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\r\n");
}

export function checklistToJson(
  checklist: PlanChecklist,
  checkedIds: ReadonlySet<string> = new Set()
): string {
  return JSON.stringify(
    {
      ...checklist,
      rows: checklist.rows.map((row) => ({
        ...row,
        checked: checkedIds.has(row.id)
      }))
    },
    null,
    2
  );
}

/** Triggers a browser download; false when the browser refuses. */
export function downloadChecklist(
  checklist: PlanChecklist,
  format: PlanChecklistFormat,
  checkedIds: ReadonlySet<string> = new Set()
): boolean {
  const content =
    format === "csv"
      ? checklistToCsv(checklist, checkedIds)
      : checklistToJson(checklist, checkedIds);
  try {
    const blob = new Blob([content], {
      type:
        format === "csv"
          ? "text/csv;charset=utf-8"
          : "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `badge-plan-checklist-${checklist.reference.generatedAt.replace(/[^A-Za-z0-9.-]+/g, "-")}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
