import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INVENTORY_CACHE_DATABASE_NAME,
  INVENTORY_CACHE_SCHEMA_VERSION,
  INVENTORY_CACHE_STORE_NAME,
  clearInventoryCache,
  clearInventoryCacheExcept,
  readInventoryCache,
  readInventoryCacheEpoch,
  writeInventoryCache
} from "./inventoryCache";

type FixtureItem = { id: string; name: string };
type FixtureInventory = { items: FixtureItem[] };

// lib.dom types indexedDB as a non-optional IDBFactory, but the jsdom test
// environment leaves it undefined; each test swaps in a fresh fake factory.
const globalScope = globalThis as { indexedDB?: IDBFactory };

const STEAM_ID = "76561198000000001";
const OTHER_STEAM_ID = "76561198000000002";
const REFRESHED_AT_FIRST = "2026-08-01T00:00:00.000Z";
const REFRESHED_AT_SECOND = "2026-08-02T00:00:00.000Z";
const REFRESHED_AT_GEM = "2026-08-03T00:00:00.000Z";

const INVENTORY_A: FixtureInventory = {
  items: [
    { id: "1001", name: "Case Hardened" },
    { id: "1002", name: "Dragon Lore" }
  ]
};

const INVENTORY_B: FixtureInventory = {
  items: [
    { id: "1001", name: "Case Hardened" },
    { id: "1002", name: "Dragon Lore" },
    { id: "1003", name: "Medusa" }
  ]
};

const GEM_INVENTORY: FixtureInventory = {
  items: [{ id: "1001", name: "Case Hardened (Gemmed)" }]
};

function isFixtureInventory(value: unknown): value is FixtureInventory {
  if (typeof value !== "object" || value === null || !("items" in value)) {
    return false;
  }

  const items: unknown = value.items;
  if (!Array.isArray(items)) {
    return false;
  }

  return items.every((item) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    if (!("id" in item) || !("name" in item)) {
      return false;
    }
    return typeof item.id === "string" && typeof item.name === "string";
  });
}

describe("inventoryCache", () => {
  let factory: IDBFactory;
  let originalIndexedDb: IDBFactory | undefined;

  // Direct store access exists only to seed state the exported API refuses to
  // write (corrupt envelopes) and to observe deletion. Every behavior under
  // test still flows through the exported functions.
  function openExistingDatabase(): Promise<IDBDatabase> {
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const request = factory.open(INVENTORY_CACHE_DATABASE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB could not be opened."));
    return promise;
  }

  async function rawStoreRead(steamId: string): Promise<unknown> {
    const database = await openExistingDatabase();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const transaction = database.transaction(
      [INVENTORY_CACHE_STORE_NAME],
      "readonly"
    );
    const request = transaction
      .objectStore(INVENTORY_CACHE_STORE_NAME)
      .get(steamId);
    let value: unknown;
    request.onsuccess = () => {
      value = request.result;
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("raw read failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("raw read aborted"));
    try {
      return await promise;
    } finally {
      database.close();
    }
  }

  async function rawStoreWrite(value: unknown): Promise<void> {
    const database = await openExistingDatabase();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const transaction = database.transaction(
      [INVENTORY_CACHE_STORE_NAME],
      "readwrite"
    );
    transaction.objectStore(INVENTORY_CACHE_STORE_NAME).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("raw write failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("raw write aborted"));
    try {
      await promise;
    } finally {
      database.close();
    }
  }

  beforeEach(() => {
    originalIndexedDb = globalScope.indexedDB;
    factory = new IDBFactory();
    globalScope.indexedDB = factory;
  });

  afterEach(() => {
    globalScope.indexedDB = originalIndexedDb;
  });

  it("round-trips a valid inventory without bumping the epoch", async () => {
    expect(await readInventoryCacheEpoch()).toBe(0);

    const writtenAt = await writeInventoryCache(
      STEAM_ID,
      INVENTORY_A,
      isFixtureInventory,
      REFRESHED_AT_FIRST,
      0
    );
    expect(writtenAt).toBe(REFRESHED_AT_FIRST);

    expect(await readInventoryCache(STEAM_ID, isFixtureInventory)).toEqual({
      schema_version: INVENTORY_CACHE_SCHEMA_VERSION,
      steam_id: STEAM_ID,
      refreshed_at: REFRESHED_AT_FIRST,
      inventory: INVENTORY_A
    });
    expect(await readInventoryCacheEpoch()).toBe(0);
  });

  it.each([
    { reason: "an incompatible schema", corruption: { schema_version: INVENTORY_CACHE_SCHEMA_VERSION + 1 } },
    { reason: "an invalid timestamp", corruption: { refreshed_at: "not-a-timestamp" } },
    { reason: "invalid inventory data", corruption: { inventory: { items: "garbage" } } }
  ])("deletes $reason and advances the epoch once", async ({ corruption }) => {
    expect(await readInventoryCacheEpoch()).toBe(0);
    await rawStoreWrite({
      schema_version: INVENTORY_CACHE_SCHEMA_VERSION,
      steam_id: STEAM_ID,
      refreshed_at: REFRESHED_AT_FIRST,
      inventory: INVENTORY_A,
      ...corruption
    });

    expect(await readInventoryCache(STEAM_ID, isFixtureInventory)).toBeNull();
    expect(await rawStoreRead(STEAM_ID)).toBeUndefined();
    expect(await readInventoryCacheEpoch()).toBe(1);

    expect(await readInventoryCache(STEAM_ID, isFixtureInventory)).toBeNull();
    expect(await readInventoryCacheEpoch()).toBe(1);
  });

  it("stale-epoch writes cannot resurrect a signed-out account", async () => {
    const seededAt = await writeInventoryCache(
      STEAM_ID,
      INVENTORY_A,
      isFixtureInventory,
      REFRESHED_AT_FIRST,
      0
    );
    expect(seededAt).toBe(REFRESHED_AT_FIRST);

    await clearInventoryCache();
    expect(await readInventoryCacheEpoch()).toBe(1);
    expect(await readInventoryCache(STEAM_ID, isFixtureInventory)).toBeNull();

    const resurrectedAt = await writeInventoryCache(
      STEAM_ID,
      INVENTORY_B,
      isFixtureInventory,
      REFRESHED_AT_SECOND,
      0
    );
    expect(resurrectedAt).toBeNull();
    expect(await readInventoryCache(STEAM_ID, isFixtureInventory)).toBeNull();
    expect(await readInventoryCacheEpoch()).toBe(1);
  });

  it("stale gem refresh loses to newer cached inventory", async () => {
    const seededAt = await writeInventoryCache(
      STEAM_ID,
      INVENTORY_A,
      isFixtureInventory,
      REFRESHED_AT_FIRST,
      0
    );
    expect(seededAt).toBe(REFRESHED_AT_FIRST);
    const newerAt = await writeInventoryCache(
      STEAM_ID,
      INVENTORY_B,
      isFixtureInventory,
      REFRESHED_AT_SECOND,
      0
    );
    expect(newerAt).toBe(REFRESHED_AT_SECOND);

    const staleGemWrite = await writeInventoryCache(
      STEAM_ID,
      GEM_INVENTORY,
      isFixtureInventory,
      REFRESHED_AT_GEM,
      0,
      REFRESHED_AT_FIRST
    );
    expect(staleGemWrite).toBeNull();

    const preserved = await readInventoryCache(STEAM_ID, isFixtureInventory);
    expect(preserved?.refreshed_at).toBe(REFRESHED_AT_SECOND);
    expect(preserved?.inventory).toEqual(INVENTORY_B);

    const matchingGemWrite = await writeInventoryCache(
      STEAM_ID,
      GEM_INVENTORY,
      isFixtureInventory,
      REFRESHED_AT_GEM,
      0,
      REFRESHED_AT_SECOND
    );
    expect(matchingGemWrite).toBe(REFRESHED_AT_GEM);
    expect(await readInventoryCache(STEAM_ID, isFixtureInventory)).toEqual({
      schema_version: INVENTORY_CACHE_SCHEMA_VERSION,
      steam_id: STEAM_ID,
      refreshed_at: REFRESHED_AT_GEM,
      inventory: GEM_INVENTORY
    });
  });

  it("prunes other accounts, keeps the active one, bumps once", async () => {
    const seededAt = await writeInventoryCache(
      STEAM_ID,
      INVENTORY_A,
      isFixtureInventory,
      REFRESHED_AT_FIRST,
      0
    );
    expect(seededAt).toBe(REFRESHED_AT_FIRST);
    const otherAt = await writeInventoryCache(
      OTHER_STEAM_ID,
      INVENTORY_B,
      isFixtureInventory,
      REFRESHED_AT_SECOND,
      0
    );
    expect(otherAt).toBe(REFRESHED_AT_SECOND);

    await clearInventoryCacheExcept(STEAM_ID);

    expect(await readInventoryCache(STEAM_ID, isFixtureInventory)).toEqual({
      schema_version: INVENTORY_CACHE_SCHEMA_VERSION,
      steam_id: STEAM_ID,
      refreshed_at: REFRESHED_AT_FIRST,
      inventory: INVENTORY_A
    });
    expect(
      await readInventoryCache(OTHER_STEAM_ID, isFixtureInventory)
    ).toBeNull();
    expect(await readInventoryCacheEpoch()).toBe(1);

    await clearInventoryCacheExcept(STEAM_ID);
    expect(await readInventoryCacheEpoch()).toBe(1);
  });
});
