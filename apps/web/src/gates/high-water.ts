// The registry head high-water mark (ARCHITECTURE §6.2 step 5): the highest head version this
// browser has accepted per org. A lower version is a rollback and fails gate B. Storage that is
// missing or fails is an error, so gate B fails closed.

export class StorageUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailable";
  }
}

export type HighWaterStore = {
  /** The highest accepted version, or 0 if none yet. Throws StorageUnavailable on any failure. */
  get(orgId: string): Promise<number>;
  /** Raises the mark; never lowers it. Throws StorageUnavailable on any failure. */
  raise(orgId: string, version: number): Promise<void>;
};

const DB_NAME = "veylo-gates";
const STORE = "registry-high-water";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

/** IndexedDB in the browser. Every access is wrapped: any problem throws StorageUnavailable. */
export function createIndexedDbHighWater(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): HighWaterStore {
  async function open(): Promise<IDBDatabase> {
    if (!factory) throw new StorageUnavailable("IndexedDB is not available");
    try {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      return await request(req);
    } catch (err) {
      throw new StorageUnavailable(`IndexedDB failed to open: ${String(err)}`);
    }
  }
  return {
    async get(orgId) {
      const db = await open();
      try {
        const value = await request(
          db.transaction(STORE, "readonly").objectStore(STORE).get(orgId),
        );
        if (value === undefined) return 0;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          throw new StorageUnavailable("stored high-water mark is corrupt");
        }
        return value;
      } catch (err) {
        if (err instanceof StorageUnavailable) throw err;
        throw new StorageUnavailable(`IndexedDB read failed: ${String(err)}`);
      } finally {
        db.close();
      }
    },
    async raise(orgId, version) {
      const db = await open();
      try {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const current = await request(store.get(orgId));
        if (typeof current !== "number" || version > current)
          await request(store.put(version, orgId));
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
        });
      } catch (err) {
        throw new StorageUnavailable(`IndexedDB write failed: ${String(err)}`);
      } finally {
        db.close();
      }
    },
  };
}

/** For tests and server rendering: an in-memory store. */
export function createMemoryHighWater(initial: Record<string, number> = {}): HighWaterStore {
  const marks = new Map(Object.entries(initial));
  return {
    async get(orgId) {
      return marks.get(orgId) ?? 0;
    },
    async raise(orgId, version) {
      if (version > (marks.get(orgId) ?? 0)) marks.set(orgId, version);
    },
  };
}
