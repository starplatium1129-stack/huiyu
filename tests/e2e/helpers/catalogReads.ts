import type { Page } from '@playwright/test'
import type { CatalogKind, CatalogPage, CatalogRecord, CatalogSummary } from '../../../src/api/catalogApi'
import { GUEST_GUIDE_DISMISSED_KEY } from '../../../src/utils/storageKeys'
import { installDesktopHostFixture } from './desktopHost'

export interface CatalogReadFixture { records: CatalogRecord[]; version: number }

export function catalogScene(id: string, title = '场景记录 · ' + id): CatalogRecord {
  return { kind: 'scene', id, revision: 1, sortOrder: Number(id.slice(2)), createdAt: null, updatedAt: null,
    data: { id, title, category: '日常', char: 'nene', rating: 'All', mature: false,
      story: '仅用于隔离界面验证的中性场景记录。', storyJa: '', lora: '', emotion: '', season: '', time: '',
      timeOfDay: '', location: '', weather: '', camera: '', lighting: '', tags: [], usage: [],
      prompt: ' fixture  prompt\nline two ', negative: 'fixture negative', animaCaption: 'fixture caption',
      recommendedSize: '832x1216', extension: { untouched: true } } }
}

function summary(record: CatalogRecord): CatalogSummary {
  const data: Record<string, unknown> = Array.isArray(record.data) ? {} : record.data
  return { kind: record.kind, id: record.id, revision: record.revision, sortOrder: record.sortOrder,
    createdAt: record.createdAt, updatedAt: record.updatedAt, title: String(data.title ?? record.id),
    characterId: String(data.char ?? data.characterId ?? ''), category: String(data.category ?? ''),
    rating: String(data.rating ?? data.sampleRating ?? 'All') }
}

/** Only the current catalog's read endpoints. Every test owns its explicit write replies. */
export async function installCatalogReads(page: Page, state: CatalogReadFixture, url: string) {
  const origin = new URL(url).origin
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const forbidden = { ok: false, error: 'Unmocked API forbidden', code: 'CATALOG_TEST_NETWORK_BLOCKED' }
  await page.route('**/api/**', route => route.fulfill({ status: 403, json: forbidden }))
  await page.route(/\/api\/catalog(?:\/(?:record|stats|history|export))?(?:\?.*)?$/, route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: forbidden })
    const { pathname, searchParams: query } = new URL(route.request().url())
    if (pathname === '/api/catalog/stats') {
      const counts: Record<CatalogKind, number> = { character: 0, outfit: 0, scene: 0, blueprint: 0, document: 0 }
      for (const record of state.records) counts[record.kind]++
      const next = Math.max(0, ...state.records.filter(record => record.kind === 'scene').map(record => Number(record.id.slice(2)))) + 1
      return route.fulfill({ json: { ok: true, version: state.version, counts, nextSceneId: 'sc' + String(next).padStart(3, '0') } })
    }
    if (pathname === '/api/catalog/export') return route.fulfill({ json: { version: 1, records: state.records, retired: [] } })
    if (pathname === '/api/catalog/history') return route.fulfill({ json: { ok: true, items: [] } })
    if (pathname === '/api/catalog/record') {
      const record = state.records.find(item => item.kind === query.get('kind') && item.id === query.get('id'))
      return record ? route.fulfill({ json: { ok: true, record } })
        : route.fulfill({ status: 404, json: { ok: false, error: 'Fixture record not found' } })
    }
    const all = state.records.filter(record => record.kind === query.get('kind')).map(summary)
    const search = (query.get('search') ?? '').toLowerCase()
    const filtered = all.filter(item => [item.id, item.title].join(' ').toLowerCase().includes(search)
      && (!query.get('character') || item.characterId === query.get('character'))
      && (!query.get('category') || item.category === query.get('category'))
      && (!query.get('rating') || item.rating === query.get('rating')))
    const pageNumber = Math.max(1, Number(query.get('page') || 1)), pageSize = Math.max(1, Number(query.get('pageSize') || 24))
    const result: CatalogPage = { ok: true, version: state.version, items: filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
      total: filtered.length, page: pageNumber, pageSize, facets: {
        characters: [...new Set(all.map(item => item.characterId).filter(Boolean))],
        categories: [...new Set(all.map(item => item.category).filter(Boolean))],
        ratings: [...new Set(all.map(item => item.rating).filter(Boolean))],
      } }
    return route.fulfill({ json: result })
  })
  await page.route('**/api/maintenance/home-hero', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { ok: true, version: 1, entries: {} } }) : route.fulfill({ status: 403, json: forbidden }))
  await page.route('**/data/**', route => {
    const file = new URL(route.request().url()).pathname.split('/').pop()!
    const scenes = state.records.filter(record => record.kind === 'scene').map(record => record.data)
    const metadata: Record<string, unknown> = {
      'scenes.json': scenes, 'scenes-nene.json': scenes, 'scenes-core.json': scenes, 'scenes-index.json': {},
      'characters.json': [], 'popular-characters.json': { characters: [] },
      'scene-blueprints.json': { blueprints: state.records.filter(record => record.kind === 'blueprint').map(record => record.data) },
      'tags.json': state.records.find(record => record.kind === 'document' && record.id === 'tags')?.data ?? [],
      'curation.json': state.records.find(record => record.kind === 'document' && record.id === 'curation')?.data ?? {},
    }
    return route.fulfill({ json: metadata[file] ?? [] })
  })
  await page.addInitScript(key => localStorage.setItem(key, '1'), GUEST_GUIDE_DISMISSED_KEY)
  await installDesktopHostFixture(page)
}
