import { beforeEach, describe, expect, it } from 'vitest'
import {
  analyzeQuery, matchesSearch, prepareSceneSearch, searchScore, readHiddenScenes,
  readSceneUsage,
  recordSceneUsage,
  sceneUsageScore,
  writeHiddenScenes,
  SCENE_USAGE_KEY,
} from './sceneUX'

/**
 * sceneUX 使用统计契约：注入式 Storage（不碰真实 localStorage），
 * 覆盖读写往返、脏数据迁移、封顶/去重与评分衰减规则。
 */

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
  } as Storage
}

describe('sceneUX · 隐藏场景集合', () => {
  let storage: Storage
  beforeEach(() => { storage = fakeStorage() })

  it('write→read 往返保持去重', () => {
    writeHiddenScenes(['sc001', 'sc002', 'sc001'], storage)
    expect([...readHiddenScenes(storage)].sort()).toEqual(['sc001', 'sc002'])
  })

  it('存储里的非字符串 id 被过滤，缺失时为空集', () => {
    storage.setItem('aics_hidden_scenes', JSON.stringify(['sc1', 42, null, 'sc2']))
    expect([...readHiddenScenes(storage)].sort()).toEqual(['sc1', 'sc2'])
    expect(readHiddenScenes(fakeStorage()).size).toBe(0)
  })
})

describe('sceneUX · 使用次数统计', () => {
  let storage: Storage
  beforeEach(() => { storage = fakeStorage() })

  it('recordSceneUsage 累加次数并取最新时间戳', () => {
    const t0 = 1_700_000_000_000
    recordSceneUsage({ id: 'sc010' }, storage, t0)
    recordSceneUsage({ id: 'sc010' }, storage, t0 + 5000)
    const usage = readSceneUsage(storage)
    expect(usage.sc010).toEqual({ uses: 2, lastUsed: t0 + 5000 })
  })

  it('uses 封顶 9999；空 id 不写入', () => {
    storage.setItem(SCENE_USAGE_KEY, JSON.stringify({
      version: 1,
      records: { scX: { uses: 9999, lastUsed: 1 } },
    }))
    recordSceneUsage({ id: 'scX' }, storage, 42)
    expect(readSceneUsage(storage).scX.uses).toBe(9999)

    const before = readSceneUsage(storage)
    recordSceneUsage({ id: '' }, storage)
    expect(readSceneUsage(storage)).toEqual(before)
  })

  it('旧版裸 records 结构自动迁移到信封格式', () => {
    // 历史格式：顶层直接就是 records（无 version 信封）
    storage.setItem(SCENE_USAGE_KEY, JSON.stringify({
      scOld: { uses: 3.7, lastUsed: -5 }, // 非法值应被清洗
      scGood: { uses: 2, lastUsed: 100 },
    }))
    const usage = readSceneUsage(storage)
    expect(usage.scGood).toEqual({ uses: 2, lastUsed: 100 })
    expect(usage.scOld).toEqual({ uses: 3, lastUsed: 0 })
    // 迁移结果回写为带版本的信封
    expect(JSON.parse(storage.getItem(SCENE_USAGE_KEY)!)).toMatchObject({ version: 1 })
  })
})

describe('sceneUX · 排序评分', () => {
  const NOW = 1_800_000_000_000
  const DAY = 86_400_000

  it('分数 = min(uses,12)×4 + 新近度档位', () => {
    expect(sceneUsageScore(undefined, NOW)).toBe(0)
    expect(sceneUsageScore({ uses: 1, lastUsed: NOW }, NOW)).toBe(4 + 12)          // 当天
    expect(sceneUsageScore({ uses: 3, lastUsed: NOW - 3 * DAY }, NOW)).toBe(12 + 8) // 一周内
    expect(sceneUsageScore({ uses: 5, lastUsed: NOW - 20 * DAY }, NOW)).toBe(20 + 4) // 一月内
    expect(sceneUsageScore({ uses: 2, lastUsed: NOW - 60 * DAY }, NOW)).toBe(8 + 1)  // 三月内
    expect(sceneUsageScore({ uses: 2, lastUsed: NOW - 200 * DAY }, NOW)).toBe(8 + 0)  // 更早
    expect(sceneUsageScore({ uses: 50, lastUsed: NOW }, NOW)).toBe(60)
  })
})

it('reuses one query analysis without changing aliases, stop phrases, Chinese boundaries or ranking weights', () => {
  const config = { searchAliases: { 夜雨: ['雨夜', 'rain night'], 夏日: ['夏'] } }
  const analysis = analyzeQuery('雨夜', config)
  const title = prepareSceneSearch({ title: '雨夜', story: '' }), story = prepareSceneSearch({ title: '', story: '雨夜' })
  expect(matchesSearch(title, analysis)).toBe(true)
  expect(searchScore(title, analysis)).toBe(88)
  expect(searchScore(story, analysis)).toBe(42)
  expect(matchesSearch(prepareSceneSearch({ title: 'rain night' }), analyzeQuery('请帮我找，雨夜。', config))).toBe(true)
  expect(analyzeQuery('夏目', config).intents).not.toContain('夏日')
  expect(matchesSearch(title, analyzeQuery('晴天', config))).toBe(false)
  expect(searchScore(title, analyzeQuery('晴天', config))).toBe(0)
})
