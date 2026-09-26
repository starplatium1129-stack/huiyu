/** AICKVStore 的 TypeScript 替代：IndexedDB KV 存储（history / projects 等） */
import { withMigrationWrite, assertWebArtworkWritable } from '../platform/web/migrationBarrier.ts'
import { ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, ARTWORK_TRASH_KV_KEY, ARTWORK_HISTORY_QUARANTINE_KEY } from '../utils/storageKeys.ts'
const artworkKeys = new Set<string>([ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, ARTWORK_TRASH_KV_KEY, ARTWORK_HISTORY_QUARANTINE_KEY])

const DB_NAME = 'aics_kv_store'
const DB_VERSION = 1
const STORE_NAME = 'kv'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持 IndexedDB')); return }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME))
        req.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => { db.close(); dbPromise = null }
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('KV 数据库打开失败'))
  }).catch(error => {
    dbPromise = null
    throw error
  })
  return dbPromise
}

export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  // 不再走内存缓存：memCache 是标签页私有副本，跨标签页写入后另一页会
  // 一直读到旧值（历史/作品册"丢新记录"）。IndexedDB 单键读取是毫秒级，
  // 本项目数据量下直接查库没有可感知的性能代价。
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => {
      resolve((req.result?.value ?? null) as T | null)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  return kvSetMany([{ key, value }])
}

/** Commit related records together; a quota failure must not split history from projects. */
export async function kvSetMany(entries: Array<{ key: string; value: unknown }>): Promise<void> {
  if (entries.some(entry => artworkKeys.has(entry.key))) assertWebArtworkWritable()
  return withMigrationWrite(() => commitEntries(entries))
}
async function commitEntries(entries: Array<{ key: string; value: unknown }>): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(entries)) as Array<{ key: string; value: unknown }>
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('KV 事务已取消'))
    try {
      for (const entry of snapshot) tx.objectStore(STORE_NAME).put(entry)
    } catch (error) { tx.abort(); reject(error) }
  })
}

/** Atomic read-modify-write, including browsers without Web Locks. The reducer is synchronous. */
export async function kvUpdate<T>(key: string, update: (current: unknown) => T): Promise<T> {
  if (artworkKeys.has(key)) assertWebArtworkWritable()
  return withMigrationWrite(() => updateEntry(key, update))
}
async function updateEntry<T>(key: string, update: (current: unknown) => T): Promise<T> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    let result: T
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('KV 事务已取消'))
    const request = store.get(key)
    request.onsuccess = () => {
      try {
        result = update(request.result?.value ?? null)
        store.put({ key, value: JSON.parse(JSON.stringify(result)) })
      } catch (error) { tx.abort(); reject(error) }
    }
  })
}

/** Cursor pages preserve unregistered keys for the migration classification gate. */
export async function kvPage(after?: string, limit = 100): Promise<{ entries: Array<{ key: string; value: unknown }>; nextCursor: string | null }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('无效的迁移分页大小')
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const entries: Array<{ key: string; value: unknown }> = []
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve({ entries, nextCursor: null }); return }
      if (entries.length === limit) { resolve({ entries, nextCursor: entries.at(-1)!.key }); return }
      entries.push(cursor.value as { key: string; value: unknown }); cursor.continue()
    }
  })
}

/** 兼容旧版 AICKVStore.init() 调用 */
export const kvInit = openDb
