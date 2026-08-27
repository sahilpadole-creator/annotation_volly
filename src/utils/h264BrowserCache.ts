/** Persist in-browser H.264 conversions so refresh does not re-encode the same clip. */

const DB_NAME = 'veritas_h264_cache';
const DB_VERSION = 1;
const STORE = 'videos';
/** Soft cap — drop oldest entries when total size exceeds this. */
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export function h264CacheKey(file: File): string {
  const base = file.name.replace(/^.*[/\\]/, '');
  return `${base}|${file.size}|${file.lastModified}`;
}

interface CacheRecord {
  key: string;
  name: string;
  size: number;
  lastModified: number;
  outFilename: string;
  blob: Blob;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let req: IDBRequest<T> | undefined;
    try {
      const result = fn(store);
      if (result) req = result;
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function getCachedH264(file: File): Promise<File | null> {
  try {
    const key = h264CacheKey(file);
    const record = await withStore<CacheRecord>('readonly', (store) => store.get(key));
    if (!record?.blob) return null;
    return new File([record.blob], record.outFilename || `${file.name.replace(/\.[^/.]+$/, '')}_h264.mp4`, {
      type: 'video/mp4',
    });
  } catch (err) {
    console.warn('[h264 cache] read failed', err);
    return null;
  }
}

async function enforceCacheBudget(store: IDBObjectStore): Promise<void> {
  const all = await new Promise<CacheRecord[]>((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as CacheRecord[]) || []);
    req.onerror = () => reject(req.error);
  });
  let total = all.reduce((sum, r) => sum + (r.blob?.size || 0), 0);
  if (total <= MAX_CACHE_BYTES) return;
  all.sort((a, b) => a.createdAt - b.createdAt);
  for (const rec of all) {
    if (total <= MAX_CACHE_BYTES) break;
    store.delete(rec.key);
    total -= rec.blob?.size || 0;
  }
}

export async function putCachedH264(source: File, converted: File): Promise<void> {
  try {
    const key = h264CacheKey(source);
    const record: CacheRecord = {
      key,
      name: source.name.replace(/^.*[/\\]/, ''),
      size: source.size,
      lastModified: source.lastModified,
      outFilename: converted.name,
      blob: converted,
      createdAt: Date.now(),
    };
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(record);
      void enforceCacheBudget(store);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'));
    });
  } catch (err) {
    console.warn('[h264 cache] write failed', err);
  }
}

/** Quick check used when opening a playlist — restore cached H.264 without re-encoding. */
export async function hydrateH264FromCache(file: File): Promise<File | null> {
  if (/_h264\.(mp4|mov|m4v)$/i.test(file.name)) return file;
  return getCachedH264(file);
}
