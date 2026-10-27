import { normalizeCalibration, type AnimeCalibration } from './calibration'

export interface AnimeModel {
  characterId: string
  name: string
  file: Blob
  enabled: boolean
}

// PSD Blobs cannot use useKVStore, whose JSON snapshot strips binary data.
let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('huiyu-anime25d', 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('models')) db.createObjectStore('models', { keyPath: 'characterId' })
      db.createObjectStore('calibrations', { keyPath: 'fingerprint' })
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); database = undefined }
      resolve(db)
    }
    request.onerror = () => { database = undefined; reject(request.error) }
    request.onblocked = () => { database = undefined; reject(new Error('请关闭旧版桌宠窗口后重试')) }
  })
}

export async function readAnimeCalibration(fingerprint: string): Promise<AnimeCalibration> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction('calibrations').objectStore('calibrations').get(fingerprint)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const record = request.result
      if (record && (record.fingerprint !== fingerprint || record.version !== 1)) {
        reject(new Error('模型校准数据版本不受支持')); return
      }
      resolve(normalizeCalibration(record?.value))
    }
  })
}

export async function writeAnimeCalibration(fingerprint: string, value: AnimeCalibration) {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('calibrations', 'readwrite')
    transaction.objectStore('calibrations').put({ fingerprint, version: 1, value: normalizeCalibration(value) })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function readAnimeModel(characterId: string): Promise<AnimeModel | null> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction('models').objectStore('models').get(characterId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const value = request.result
      if (value == null) { resolve(null); return }
      if (value.characterId !== characterId || typeof value.name !== 'string'
        || !(value.file instanceof Blob) || typeof value.enabled !== 'boolean') {
        reject(new Error('保存的 2.5D 模型无效，请重新导入 PSD')); return
      }
      resolve(value)
    }
  })
}

export async function writeAnimeModel(characterId: string, model: AnimeModel | null) {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('models', 'readwrite')
    const store = transaction.objectStore('models')
    if (model) store.put(model)
    else store.delete(characterId)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
