// Where the encrypted wallet lives: this page's own IndexedDB, on the wallet bridge origin. The app
// origin is a different origin, so it can't open this database (the browser's same-origin rule; an
// end-to-end check proves it). Every call can fail, because storage can be blocked or private; a
// failure never creates, changes or returns a wallet: it fails closed with a plain message.
import { isVaultBlob, type VaultBlob } from "./vault";

export const DB_NAME = "veylo-wallet";
const STORE = "vault";

export type VaultStore = {
  list(): Promise<VaultBlob[]>;
  put(blob: VaultBlob): Promise<void>;
  remove(accountId: string): Promise<void>;
};

const unavailable = () =>
  new Error("This browser can't keep a wallet right now. Allow site data, or try another browser.");

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(unavailable());
  });
}

export function indexedDbStore(factory: IDBFactory | undefined = globalThis.indexedDB): VaultStore {
  async function open(): Promise<IDBDatabase> {
    if (!factory) throw unavailable();
    const opening = factory.open(DB_NAME, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE))
        opening.result.createObjectStore(STORE, { keyPath: "accountId" });
    };
    try {
      return await request(opening);
    } catch {
      throw unavailable();
    }
  }
  async function run<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>) {
    const db = await open();
    try {
      const tx = db.transaction(STORE, mode);
      const result = await request(work(tx.objectStore(STORE)));
      if (mode === "readwrite")
        await new Promise<void>((ok, fail) => {
          tx.oncomplete = () => ok();
          tx.onerror = () => fail(unavailable());
          tx.onabort = () => fail(unavailable());
        });
      return result;
    } catch {
      throw unavailable();
    } finally {
      db.close();
    }
  }
  return {
    async list() {
      const all = await run("readonly", (s) => s.getAll());
      return (all as unknown[]).filter(isVaultBlob);
    },
    async put(blob) {
      await run("readwrite", (s) => s.put(blob));
    },
    async remove(accountId) {
      await run("readwrite", (s) => s.delete(accountId));
    },
  };
}

/** An in-memory store, for tests and for private windows where nothing can be kept. */
export function memoryStore(): VaultStore {
  const map = new Map<string, VaultBlob>();
  return {
    async list() {
      return [...map.values()].map((b) => JSON.parse(JSON.stringify(b)) as VaultBlob);
    },
    async put(blob) {
      map.set(blob.accountId, JSON.parse(JSON.stringify(blob)) as VaultBlob);
    },
    async remove(accountId) {
      map.delete(accountId);
    },
  };
}
