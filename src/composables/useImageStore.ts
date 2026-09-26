/** AICGImageStore 的 TypeScript 替代：IndexedDB 图片 Blob 存储 */
import { withMigrationWrite, assertWebArtworkWritable } from '../platform/web/migrationBarrier.ts'

const DB_NAME = 'aics_image_store'
const DB_VERSION = 1
const STORE_NAME = 'images'

let dbPromise: Promise<IDBDatabase> | null = null

export interface StoredImageRecord {
  id: string
  blob: Blob
  name: string
  type: string
  size: number
  created_at: number
}

export interface ImageRecordInput {
  id: string
  blob: Blob
  name?: string
  type?: string
  created_at?: number
}

function blobName(blob: Blob): string {
  return 'name' in blob && typeof blob.name === 'string' ? blob.name : ''
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const idb = globalThis.indexedDB
    if (!idb) { reject(new Error('当前浏览器不支持 IndexedDB')); return }
    const req = idb.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME))
        req.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => { db.close(); dbPromise = null }
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('图片数据库打开失败'))
  }).catch(error => {
    dbPromise = null
    throw error
  })
  return dbPromise
}

function createId(): string {
  if (globalThis.crypto?.randomUUID) return 'img_' + globalThis.crypto.randomUUID()
  return 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)
}

function tx<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => void): Promise<T | undefined> {
  if (mode === 'readwrite') assertWebArtworkWritable()
  const run = () => transact<T>(mode, action)
  return mode === 'readwrite' ? withMigrationWrite(run) : run()
}
function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => void): Promise<T | undefined> {
  return openDb().then(db => new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try { transaction = db.transaction(STORE_NAME, mode) } catch (e) { reject(e); return }
    const store = transaction.objectStore(STORE_NAME)
    let result: IDBRequest | undefined
    try { action(store) } catch (e) { transaction.abort(); reject(e); return }
    transaction.oncomplete = () => resolve(result?.result as T | undefined)
    transaction.onerror   = () => reject(transaction.error ?? new Error('图片数据库事务失败'))
    transaction.onabort   = () => reject(transaction.error ?? new Error('图片数据库事务已取消'))
  }))
}

export async function imgPut(file: Blob): Promise<string> {
  if (!(file instanceof Blob) || !file.size) throw new Error('图片文件为空')
  const id = createId()
  await tx('readwrite', store => store.put({
    id,
    blob: file,
    name: blobName(file),
    type: file.type,
    size: file.size,
    created_at: Date.now(),
  } satisfies StoredImageRecord))
  return id
}

export async function imgPutRecord(record: ImageRecordInput): Promise<string> {
  if (!record?.id?.trim()) throw new Error('图片记录缺少 ID')
  if (!(record.blob instanceof Blob) || !record.blob.size) throw new Error('图片记录为空')
  const n = { id: record.id.trim(), blob: record.blob, name: record.name ?? '', type: record.type ?? record.blob.type, size: record.blob.size, created_at: record.created_at ?? Date.now() }
  await tx('readwrite', store => store.put(n))
  return n.id
}

export async function imgGetRecord(id: string): Promise<StoredImageRecord | null> {
  if (!id?.trim()) return null
  const db = await openDb()
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try { transaction = db.transaction(STORE_NAME, 'readonly') } catch (e) { reject(e); return }
    const req = transaction.objectStore(STORE_NAME).get(id.trim())
    req.onsuccess = () => resolve(req.result?.blob instanceof Blob ? req.result as StoredImageRecord : null)
    req.onerror   = () => reject(req.error ?? new Error('图片读取失败'))
  })
}

export async function imgGet(id: string): Promise<Blob | null> {
  return (await imgGetRecord(id))?.blob ?? null
}

export async function imgDelete(id: string): Promise<void> { await imgDeleteMany([id]) }

export async function imgDeleteMany(ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
  if (!unique.length) return
  await tx('readwrite', store => { unique.forEach(id => store.delete(id)) })
}

export async function imgList(): Promise<StoredImageRecord[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try { transaction = db.transaction(STORE_NAME, 'readonly') } catch (e) { reject(e); return }
    const req = transaction.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : [])
    req.onerror   = () => reject(req.error ?? new Error('图片列表读取失败'))
  })
}

/** Includes temporary and trash media; migration must never infer the set from history. */
export async function imgPage(after?: string, limit = 20): Promise<{ entries: StoredImageRecord[]; nextCursor: string | null }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('无效的图片迁移分页大小')
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const entries: StoredImageRecord[] = []
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve({ entries, nextCursor: null }); return }
      if (entries.length === limit) { resolve({ entries, nextCursor: entries.at(-1)!.id }); return }
      entries.push(cursor.value as StoredImageRecord); cursor.continue()
    }
  })
}

/** 只数记录数（不拉 Blob），供陪伴事件检测器等轻量轮询使用。 */
export async function imgCount(): Promise<number> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try { transaction = db.transaction(STORE_NAME, 'readonly') } catch (e) { reject(e); return }
    const req = transaction.objectStore(STORE_NAME).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error ?? new Error('图片计数失败'))
  })
}
