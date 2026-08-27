/** Persist in-browser H.264 conversions so refresh does not re-encode the same clip. */

const DB_NAME = 'veritas_h264_cache';
const DB_VERSION = 1;
const STORE = 'videos';
/** How many oldest clips to drop when the browser reports storage quota full. */
const QUOTA_EVICT_BATCH = 8;

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

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as DOMException;
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** Drop oldest cached clips — only used when the browser disk quota is full. */
async function evictOldest(count: number): Promise<number> {
  const db = await openDb();
  const all = await new Promise<CacheRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as CacheRecord[]) || []);
    req.onerror = () => reject(req.error);
  });
  if (all.length === 0) return 0;
  all.sort((a, b) => a.createdAt - b.createdAt);
  const toDelete = all.slice(0, Math.min(count, all.length));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const rec of toDelete) store.delete(rec.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB evict failed'));
  });
  return toDelete.length;
}

async function putRecord(record: CacheRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'));
  });
}

/**
 * Cache converted H.264 with no app-side size cap (supports large match folders, e.g. 6–8GB+).
 * Only evicts oldest clips if the browser reports QuotaExceededError.
 */
export async function putCachedH264(source: File, converted: File): Promise<void> {
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

  try {
    await putRecord(record);
    return;
  } catch (err) {
    if (!isQuotaError(err)) {
      console.warn('[h264 cache] write failed', err);
      return;
    }
  }

  // Browser disk full for this origin — free space by dropping oldest, then retry a few times.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const removed = await evictOldest(QUOTA_EVICT_BATCH);
      if (removed === 0) break;
      await putRecord(record);
      return;
    } catch (err) {
      if (!isQuotaError(err)) {
        console.warn('[h264 cache] write failed after eviction', err);
        return;
      }
    }
  }
  console.warn('[h264 cache] browser storage quota full; could not save converted clip');
}

/** Quick check used when opening a playlist — restore cached H.264 without re-encoding. */
export async function hydrateH264FromCache(file: File): Promise<File | null> {
  if (/_h264\.(mp4|mov|m4v)$/i.test(file.name)) return file;
  return getCachedH264(file);
}
