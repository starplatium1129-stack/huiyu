import { apiClient, type ApiResponseObject } from './client'
export type CatalogKind = 'character' | 'outfit' | 'scene' | 'blueprint' | 'document'
export interface CatalogRecord {
  kind: CatalogKind; id: string; revision: number; sortOrder: number
  createdAt: string | null; updatedAt: string | null; data: Record<string, unknown> | unknown[]
}
export interface CatalogSummary extends Omit<CatalogRecord, 'data'> { title: string; characterId: string; category: string; rating: string }
export interface CatalogQuery { kind: CatalogKind | 'media'; search?: string; character?: string; category?: string; rating?: string; sort?: string; page?: number; pageSize?: number; createdFrom?: string; createdTo?: string }
export interface CatalogPage { ok: true; version: number; items: CatalogSummary[]; total: number; page: number; pageSize: number; facets: { characters: string[]; categories: string[]; ratings: string[] } }
export interface CatalogChange { kind: CatalogKind; id: string; expectedRevision: number; data?: CatalogRecord['data']; patch?: Record<string, unknown>; sortOrder?: number; createdAt?: string; remove?: boolean }
export interface CatalogReceipt { ok: true; preview: boolean; version: number; batch: string; items: Array<{ kind: CatalogKind; id: string; revision: number; removed: boolean }>; diffs: Array<{ kind: CatalogKind; id: string; before: CatalogRecord | null; after: CatalogRecord | null }> }
export interface CatalogSnapshot { version: 1; records: CatalogRecord[]; retired: CatalogRecord[] }
const kinds: CatalogKind[] = ['character', 'outfit', 'scene', 'blueprint', 'document']
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string')
const key = (v: Record<string, unknown>) => kinds.includes(v.kind as CatalogKind) && typeof v.id === 'string' && !!v.id
function isCatalogMetadata(v: unknown): v is Omit<CatalogRecord, 'data'> & Record<string, unknown> {
  return object(v) && key(v) && Number.isSafeInteger(v.revision) && Number.isSafeInteger(v.sortOrder)
    && (v.createdAt === null || typeof v.createdAt === 'string') && (v.updatedAt === null || typeof v.updatedAt === 'string')
}
export function isCatalogRecord(v: unknown): v is CatalogRecord {
  return isCatalogMetadata(v) && object(v) && (object(v.data) || Array.isArray(v.data))
}
function isCatalogPage(v: ApiResponseObject): boolean {
  return v.ok === true && Number.isSafeInteger(v.version) && Number.isSafeInteger(v.total)
    && Number.isSafeInteger(v.page) && Number.isSafeInteger(v.pageSize)
    && Array.isArray(v.items) && v.items.every(row => isCatalogMetadata(row)
      && object(row) && ['title', 'characterId', 'category', 'rating'].every(field => typeof row[field] === 'string'))
    && object(v.facets) && strings(v.facets.characters) && strings(v.facets.categories) && strings(v.facets.ratings)
}
function isCatalogReceipt(v: ApiResponseObject): boolean {
  return v.ok === true && typeof v.preview === 'boolean' && Number.isSafeInteger(v.version) && typeof v.batch === 'string'
    && Array.isArray(v.items) && v.items.every(row => object(row) && key(row) && Number.isSafeInteger(row.revision) && typeof row.removed === 'boolean')
    && Array.isArray(v.diffs) && v.diffs.every(diff => object(diff) && key(diff)
      && (diff.before !== null || diff.after !== null)
      && (diff.before === null || isCatalogRecord(diff.before))
      && (diff.after === null || isCatalogRecord(diff.after)))
}
const success = (v: ApiResponseObject) => v.ok === true
const options = (signal?: AbortSignal) => ({ cache: 'no-store' as const, cachePolicy: 'bypass' as const, timeoutMs: 15_000, signal })
const queryString = (query: object) => new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()
export const catalogApi = {
  query(query: CatalogQuery, signal?: AbortSignal) {
    return apiClient.request<CatalogPage>(`/api/catalog?${queryString(query)}`, { ...options(signal), validate: isCatalogPage })
  },
  record(kind: CatalogKind, id: string, revision?: number, signal?: AbortSignal) {
    return apiClient.request<{ ok: true; record: CatalogRecord }>(`/api/catalog/record?${queryString({ kind, id, revision })}`, { ...options(signal), validate: v => success(v) && isCatalogRecord(v.record) })
  },
  stats(signal?: AbortSignal) {
    return apiClient.request<{ ok: true; version: number; counts: Record<CatalogKind, number>; nextSceneId: string }>('/api/catalog/stats', { ...options(signal), validate: v => success(v) && typeof v.nextSceneId === 'string' && object(v.counts) && kinds.every(k => Number.isSafeInteger((v.counts as Record<string, unknown>)[k])) })
  },
  check() { return apiClient.request<{ ok: true; integrity: string; contracts: unknown; scope: string }>('/api/catalog/check', { ...options(), timeoutMs: 120_000, validate: success }) },
  history(kind: CatalogKind, id: string, signal?: AbortSignal) {
    return apiClient.request<{ ok: true; items: Array<{ revision: number; at: string; removed: boolean }> }>(`/api/catalog/history?${queryString({ kind, id })}`, { ...options(signal), validate: v => success(v) && Array.isArray(v.items) })
  },
  changes(changes: CatalogChange[], preview = false, signal?: AbortSignal) {
    return apiClient.request<CatalogReceipt>('/api/catalog/changes', { method: 'POST', body: { changes, preview }, signal, timeoutMs: 120_000, validate: isCatalogReceipt })
  },
  snapshot() {
    return apiClient.request<CatalogSnapshot>('/api/catalog/export', { ...options(), timeoutMs: 120_000, validate: v => v.version === 1 && Array.isArray(v.records) && v.records.every(isCatalogRecord) && Array.isArray(v.retired) })
  },
  importSnapshot(snapshot: CatalogSnapshot, preview = true) {
    return apiClient.request<CatalogReceipt>('/api/catalog/import', { method: 'POST', body: { snapshot, preview }, timeoutMs: 120_000, validate: isCatalogReceipt })
  },
  character(id: string, signal?: AbortSignal) {
    return apiClient.request<{ ok: true; version: number; character: unknown; profile: unknown; blueprints: unknown[] }>(`/api/catalog/character?${queryString({ id })}`, { ...options(signal), validate: v => success(v) && Array.isArray(v.blueprints) })
  },
}
