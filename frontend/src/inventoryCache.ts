export const INVENTORY_CACHE_SCHEMA_VERSION = 4;
export const INVENTORY_CACHE_DATABASE_NAME = "steam-optimizer-inventory";
export const INVENTORY_CACHE_STORE_NAME = "inventory";

const INVENTORY_CACHE_DATABASE_VERSION = 2;
const INVENTORY_CACHE_METADATA_STORE_NAME = "metadata";
const INVENTORY_CACHE_EPOCH_KEY = "cache_epoch";
const INVENTORY_CACHE_ACTIVE_ACCOUNT_KEY = "active_account";

export type InventoryCacheRecord<T> = {
  schema_version: number;
  steam_id: string;
  refreshed_at: string;
  inventory: T;
};

type InventoryCacheEpochRecord = {
  key: typeof INVENTORY_CACHE_EPOCH_KEY;
  value: number;
};

type InventoryCacheActiveAccountRecord = {
  key: typeof INVENTORY_CACHE_ACTIVE_ACCOUNT_KEY;
  value: string;
};

export type InventoryValidator<T> = (value: unknown) => value is T;

function hasIndexedDb(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

function isSteamId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function cacheEpoch(value: unknown): number | null {
  if (typeof value === "undefined") {
    return 0;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Partial<InventoryCacheEpochRecord>;
  if (
    record.key !== INVENTORY_CACHE_EPOCH_KEY ||
    typeof record.value !== "number" ||
    !Number.isSafeInteger(record.value) ||
    record.value < 0
  ) {
    return null;
  }
  return record.value;
}

function cachedSteamId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Partial<InventoryCacheActiveAccountRecord>;
  return record.key === INVENTORY_CACHE_ACTIVE_ACCOUNT_KEY &&
    isSteamId(record.value)
    ? record.value
    : null;
}

function incrementCacheEpoch(store: IDBObjectStore): void {
  const request = store.get(INVENTORY_CACHE_EPOCH_KEY);
  request.onsuccess = () => {
    const current = cacheEpoch(request.result);
    store.put({
      key: INVENTORY_CACHE_EPOCH_KEY,
      value:
        current === null || current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1
    } satisfies InventoryCacheEpochRecord);
  };
}

function isCacheRecord<T>(
  value: unknown,
  steamId: string,
  validateInventory: InventoryValidator<T>
): value is InventoryCacheRecord<T> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Partial<InventoryCacheRecord<T>>;
  return (
    record.schema_version === INVENTORY_CACHE_SCHEMA_VERSION &&
    record.steam_id === steamId &&
    isSteamId(record.steam_id) &&
    isIsoTimestamp(record.refreshed_at) &&
    validateInventory(record.inventory)
  );
}

function openDatabase(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }

  const { promise, reject, resolve } =
    Promise.withResolvers<IDBDatabase>();
  let request: IDBOpenDBRequest;
  try {
    request = globalThis.indexedDB.open(
      INVENTORY_CACHE_DATABASE_NAME,
      INVENTORY_CACHE_DATABASE_VERSION
    );
  } catch (error) {
    reject(error);
    return promise;
  }

  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(INVENTORY_CACHE_STORE_NAME)) {
      database.createObjectStore(INVENTORY_CACHE_STORE_NAME, {
        keyPath: "steam_id"
      });
    }
    if (
      !database.objectStoreNames.contains(
        INVENTORY_CACHE_METADATA_STORE_NAME
      )
    ) {
      database.createObjectStore(INVENTORY_CACHE_METADATA_STORE_NAME, {
        keyPath: "key"
      });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () =>
    reject(request.error ?? new Error("IndexedDB could not be opened."));
  request.onblocked = () => reject(new Error("IndexedDB opening was blocked."));
  return promise;
}

function closeDatabase(database: IDBDatabase): void {
  try {
    database.close();
  } catch {
    // Closing is best-effort. The cache must never block sign-in.
  }
}

export async function readInventoryCacheEpoch(): Promise<number | null> {
  if (!hasIndexedDb()) {
    return null;
  }

  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return null;
  }

  const { promise, resolve } = Promise.withResolvers<number | null>();
  let settled = false;
  const finish = (value: number | null) => {
    if (settled) {
      return;
    }
    settled = true;
    closeDatabase(database);
    resolve(value);
  };

  try {
    const transaction = database.transaction(
      INVENTORY_CACHE_METADATA_STORE_NAME,
      "readonly"
    );
    const request = transaction
      .objectStore(INVENTORY_CACHE_METADATA_STORE_NAME)
      .get(INVENTORY_CACHE_EPOCH_KEY);
    let result: number | null = null;
    request.onsuccess = () => {
      result = cacheEpoch(request.result);
    };
    request.onerror = () => finish(null);
    transaction.oncomplete = () => finish(result);
    transaction.onerror = () => finish(null);
    transaction.onabort = () => finish(null);
  } catch {
    finish(null);
  }
  return promise;
}

export async function readInventoryCache<T>(
  steamId: string,
  validateInventory: InventoryValidator<T>
): Promise<InventoryCacheRecord<T> | null> {
  if (!isSteamId(steamId) || !hasIndexedDb()) {
    return null;
  }

  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return null;
  }

  const { promise, resolve } =
    Promise.withResolvers<InventoryCacheRecord<T> | null>();
  let result: InventoryCacheRecord<T> | null = null;
  let settled = false;
  const finish = (value: InventoryCacheRecord<T> | null) => {
    if (settled) {
      return;
    }
    settled = true;
    closeDatabase(database);
    resolve(value);
  };

  let transaction: IDBTransaction;
  try {
    transaction = database.transaction(
      [
        INVENTORY_CACHE_STORE_NAME,
        INVENTORY_CACHE_METADATA_STORE_NAME
      ],
      "readwrite"
    );
    const store = transaction.objectStore(INVENTORY_CACHE_STORE_NAME);
    const metadataStore = transaction.objectStore(
      INVENTORY_CACHE_METADATA_STORE_NAME
    );
    const request = store.get(steamId);
    request.onsuccess = () => {
      const candidate: unknown = request.result;
      if (isCacheRecord(candidate, steamId, validateInventory)) {
        result = candidate;
        return;
      }

      if (typeof candidate !== "undefined") {
        try {
          store.delete(steamId);
          incrementCacheEpoch(metadataStore);
        } catch {
          // The transaction error handler below will turn this into a cache miss.
        }
      }
    };
    request.onerror = () => finish(null);
    transaction.oncomplete = () => finish(result);
    transaction.onerror = () => finish(null);
    transaction.onabort = () => finish(null);
  } catch {
    finish(null);
  }
  return promise;
}

export async function writeInventoryCache<T>(
  steamId: string,
  inventory: T,
  validateInventory: InventoryValidator<T>,
  refreshedAt: string,
  expectedEpoch: number,
  expectedRefreshedAt?: string
): Promise<string | null | undefined> {
  if (
    !isSteamId(steamId) ||
    !isIsoTimestamp(refreshedAt) ||
    !validateInventory(inventory) ||
    !Number.isSafeInteger(expectedEpoch) ||
    expectedEpoch < 0 ||
    (typeof expectedRefreshedAt !== "undefined" &&
      !isIsoTimestamp(expectedRefreshedAt)) ||
    !hasIndexedDb()
  ) {
    return undefined;
  }

  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return undefined;
  }

  const record: InventoryCacheRecord<T> = {
    schema_version: INVENTORY_CACHE_SCHEMA_VERSION,
    steam_id: steamId,
    refreshed_at: refreshedAt,
    inventory
  };

  const { promise, resolve } =
    Promise.withResolvers<string | null | undefined>();
  let settled = false;
  let wroteRecord = false;
  const finish = (value: string | null | undefined) => {
    if (settled) {
      return;
    }
    settled = true;
    closeDatabase(database);
    resolve(value);
  };

  try {
    const transaction = database.transaction(
      [
        INVENTORY_CACHE_STORE_NAME,
        INVENTORY_CACHE_METADATA_STORE_NAME
      ],
      "readwrite"
    );
    const inventoryStore = transaction.objectStore(
      INVENTORY_CACHE_STORE_NAME
    );
    const metadataStore = transaction.objectStore(
      INVENTORY_CACHE_METADATA_STORE_NAME
    );
    const epochRequest = metadataStore.get(INVENTORY_CACHE_EPOCH_KEY);
    epochRequest.onsuccess = () => {
      if (cacheEpoch(epochRequest.result) !== expectedEpoch) {
        return;
      }
      const putRecord = () => {
        inventoryStore.put(record);
        wroteRecord = true;
      };
      if (typeof expectedRefreshedAt === "undefined") {
        putRecord();
        return;
      }
      const currentRequest = inventoryStore.get(steamId);
      currentRequest.onsuccess = () => {
        const current = currentRequest.result as
          | Partial<InventoryCacheRecord<unknown>>
          | undefined;
        if (
          current?.steam_id === steamId &&
          current.refreshed_at === expectedRefreshedAt
        ) {
          putRecord();
        }
      };
      currentRequest.onerror = () => transaction.abort();
    };
    epochRequest.onerror = () => transaction.abort();
    transaction.oncomplete = () =>
      finish(wroteRecord ? refreshedAt : null);
    transaction.onerror = () => finish(undefined);
    transaction.onabort = () => finish(undefined);
  } catch {
    finish(undefined);
  }
  return promise;
}

export async function clearInventoryCache(): Promise<void> {
  if (!hasIndexedDb()) {
    return;
  }

  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  const finish = () => {
    if (settled) {
      return;
    }
    settled = true;
    closeDatabase(database);
    resolve();
  };

  try {
    const transaction = database.transaction(
      [
        INVENTORY_CACHE_STORE_NAME,
        INVENTORY_CACHE_METADATA_STORE_NAME
      ],
      "readwrite"
    );
    const metadataStore = transaction.objectStore(
      INVENTORY_CACHE_METADATA_STORE_NAME
    );
    transaction.objectStore(INVENTORY_CACHE_STORE_NAME).clear();
    metadataStore.delete(INVENTORY_CACHE_ACTIVE_ACCOUNT_KEY);
    incrementCacheEpoch(metadataStore);
    transaction.oncomplete = finish;
    transaction.onerror = finish;
    transaction.onabort = finish;
  } catch {
    finish();
  }
  await promise;
}

export async function clearInventoryCacheExcept(steamId: string): Promise<void> {
  if (!isSteamId(steamId) || !hasIndexedDb()) {
    return;
  }

  let database: IDBDatabase;
  try {
    database = await openDatabase();
  } catch {
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  const finish = () => {
    if (settled) {
      return;
    }
    settled = true;
    closeDatabase(database);
    resolve();
  };

  try {
    const transaction = database.transaction(
      [
        INVENTORY_CACHE_STORE_NAME,
        INVENTORY_CACHE_METADATA_STORE_NAME
      ],
      "readwrite"
    );
    const store = transaction.objectStore(INVENTORY_CACHE_STORE_NAME);
    const metadataStore = transaction.objectStore(
      INVENTORY_CACHE_METADATA_STORE_NAME
    );
    let accountChecked = false;
    let cursorFinished = false;
    let shouldIncrementEpoch = false;
    let incrementQueued = false;
    const incrementWhenReady = () => {
      if (
        accountChecked &&
        cursorFinished &&
        shouldIncrementEpoch &&
        !incrementQueued
      ) {
        incrementQueued = true;
        incrementCacheEpoch(metadataStore);
      }
    };

    const accountRequest = metadataStore.get(
      INVENTORY_CACHE_ACTIVE_ACCOUNT_KEY
    );
    accountRequest.onsuccess = () => {
      const activeSteamId = cachedSteamId(accountRequest.result);
      shouldIncrementEpoch =
        shouldIncrementEpoch ||
        (activeSteamId !== null && activeSteamId !== steamId);
      metadataStore.put({
        key: INVENTORY_CACHE_ACTIVE_ACCOUNT_KEY,
        value: steamId
      } satisfies InventoryCacheActiveAccountRecord);
      accountChecked = true;
      incrementWhenReady();
    };
    accountRequest.onerror = () => transaction.abort();

    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        cursorFinished = true;
        incrementWhenReady();
        return;
      }
      if (cursor.key !== steamId) {
        cursor.delete();
        shouldIncrementEpoch = true;
      }
      cursor.continue();
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = finish;
    transaction.onerror = finish;
    transaction.onabort = finish;
  } catch {
    finish();
  }
  await promise;
}
