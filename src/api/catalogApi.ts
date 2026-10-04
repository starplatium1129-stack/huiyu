import { apiClient, type ApiResponseObject } from './client'
export type CatalogKind = 'character' | 'outfit' | 'scene' | 'blueprint' | 'document'
export interface CatalogRecord {
  kind: CatalogKind; id: string; revision: number; sortOrder: number
  createdAt: string | null; updatedAt: string | null; data: Record<string, unknown> | unknown[]
}
export interface CatalogSummary extends Omit<CatalogRecord, 'data'> { title: string; characterId: string; category: string; rating: string }
export interface CatalogQuery { kind: CatalogKind | 'media'; search?: string; character?: string; category?: string; rating?: string; sort?: string; page?: number; pageSize?: number }
export interface CatalogPage { ok: true; version: number; items: CatalogSummary[]; total: number; page: number; pageSize: number; facets: { characters: string[]; categories: string[]; ratings: string[] } }
export interface CatalogChange { kind: CatalogKind; id: string; expectedRevision: number; data?: CatalogRecord['data']; patch?: Record<string, unknown>; sortOrder?: number; remove?: boolean }
export interface CatalogReceipt { ok: true; preview: boolean; version: number; batch: string; items: Array<{ kind: CatalogKind; id: string; revision: number; removed: boolean }>; diffs: Array<{ kind: CatalogKind; id: string; before: CatalogRecord | null; after: CatalogRecord | null }> }
export interface CatalogSnapshot { version: 1; records: CatalogRecord[]; retired: CatalogRecord[] }
const kinds: CatalogKind[] = ['character', 'outfit', 'scene', 'blueprint', 'document']
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function isCatalogRecord(v: unknown): v is CatalogRecord {
  return object(v) && kinds.includes(v.kind as CatalogKind) && typeof v.id === 'string' && !!v.id
    && Number.isSafeInteger(v.revision) && Number.isSafeInteger(v.sortOrder)
    && (v.createdAt === null || typeof v.createdAt === 'string') && (v.updatedAt === null || typeof v.updatedAt === 'string')
    && (object(v.data) || Array.isArray(v.data))
}
const success = (v: ApiResponseObject) => v.ok === true
const options = (signal?: AbortSignal) => ({ cache: 'no-store' as const, cachePolicy: 'bypass' as const, timeoutMs: 15_000, signal })
const queryString = (query: object) => new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()
export const catalogApi = {
  query(query: CatalogQuery, signal?: AbortSignal) {
    return apiClient.request<CatalogPage>(`/api/catalog?${queryString(query)}`, { ...options(signal), validate: v => success(v) && Array.isArray(v.items) && v.items.every(row => object(row) && typeof row.id === 'string' && typeof row.title === 'string' && Number.isSafeInteger(row.revision)) && Number.isSafeInteger(v.total) && object(v.facets) })
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
    return apiClient.request<CatalogReceipt>('/api/catalog/changes', { method: 'POST', body: { changes, preview }, signal, timeoutMs: 120_000, validate: v => success(v) && Array.isArray(v.items) && Array.isArray(v.diffs) && Number.isSafeInteger(v.version) })
  },
  snapshot() {
    return apiClient.request<CatalogSnapshot>('/api/catalog/export', { ...options(), timeoutMs: 120_000, validate: v => v.version === 1 && Array.isArray(v.records) && v.records.every(isCatalogRecord) && Array.isArray(v.retired) })
  },
  importSnapshot(snapshot: CatalogSnapshot, preview = true) {
    return apiClient.request<CatalogReceipt>('/api/catalog/import', { method: 'POST', body: { snapshot, preview }, timeoutMs: 120_000, validate: v => success(v) && Array.isArray(v.items) && Array.isArray(v.diffs) })
  },
  character(id: string, signal?: AbortSignal) {
    return apiClient.request<{ ok: true; version: number; character: unknown; profile: unknown; blueprints: unknown[] }>(`/api/catalog/character?${queryString({ id })}`, { ...options(signal), validate: v => success(v) && Array.isArray(v.blueprints) })
  },
}
