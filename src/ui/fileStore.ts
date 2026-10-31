/**
 * Remembers the open file across reloads.
 *
 * A FileSystemFileHandle can be stored in IndexedDB (not in localStorage). After a
 * reload the browser usually wants the user to confirm access again, which only
 * works from a click, so `ensurePermission(h, true)` must be called from one.
 */

const DB = "mirrormaid";
const STORE = "handles";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Stores the current file handle, or forgets it when called with undefined. */
export async function rememberHandle(handle?: FileSystemFileHandle) {
  try {
    await tx<unknown>(
      "readwrite",
      (s) =>
        (handle ? s.put(handle, KEY) : s.delete(KEY)) as IDBRequest<unknown>,
    );
  } catch {
    /* IndexedDB unavailable (private mode): the file just won't be remembered */
  }
}

export async function recallHandle(): Promise<
  FileSystemFileHandle | undefined
> {
  try {
    return (await tx("readonly", (s) => s.get(KEY))) ?? undefined;
  } catch {
    return undefined;
  }
}

/** True if the browser's last answer was a hard "denied" (blocked for this site). */
export let lastDenied = false;

type WithPermission = FileSystemFileHandle & {
  queryPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
};

/** True if we may read and write the file. With `request`, asks the user (needs a click). */
export async function ensurePermission(
  handle: FileSystemFileHandle,
  request: boolean,
): Promise<boolean> {
  const h = handle as WithPermission;
  if (!h.queryPermission) return true;
  const state = await h.queryPermission({ mode: "readwrite" });
  if (state === "granted") return true;
  if (!request || !h.requestPermission) return false;
  try {
    // Throws if the click's user activation was already used up (e.g. by a file dialog).
    const after = await h.requestPermission({ mode: "readwrite" });
    if (after !== "granted")
      console.warn("[mirrormaid] write permission:", state, "→", after);
    lastDenied = after === "denied";
    return after === "granted";
  } catch (e) {
    console.warn("[mirrormaid] requestPermission failed", state, e);
    return false;
  }
}
