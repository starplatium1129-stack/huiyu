import { describe, expect, it } from 'vitest'
import {
  buildCharacterSettingEntries,
  parseCharacterSettingCards,
  recallCharacterSetting,
  type CharacterSettingRecord,
} from './characterSettingMemory'

const NENE_CARD: CharacterSettingRecord = {
  id: 'nene',
  name: '绫地宁宁',
  bgStory: '绫地宁宁是《魔女的夜宴》的女主角之一，隐瞒成为魔女后的契约代价。',
  personality: ['温柔体贴', '认真负责', '容易害羞慌乱'],
  likes: ['家人平安', '安稳的校园生活'],
  speech: 'gentle and considerate; flusters easily',
  identity: { role: '与契约代价抗争的魔女', age: '本篇高中生', occupation: '姬松学院学生', faction: '超自然研究会' },
}

const NATSUME_CARD: CharacterSettingRecord = {
  id: 'natsume',
  name: '四季夏目',
  bgStory: '四季夏目是不擅长表达感情的大学生，在 Café Stella 打工。',
  personality: ['冷静寡言', '外冷内热'],
  likes: ['安静的午后', '咖啡'],
  speech: 'reserved and concise; care shown through actions',
}

describe('characterSettingMemory · 解析', () => {
  it('完整档案解析出结构化设定卡，仅保留真实字段', () => {
    const cards = parseCharacterSettingCards([{ id: 'nene', name: '绫地宁宁', bg_story: '背景', personality: ['温柔'], likes: ['家人'], speech: 'gentle', identity: { role: '魔女' } }])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: 'nene', name: '绫地宁宁', bgStory: '背景', personality: ['温柔'], likes: ['家人'], speech: 'gentle' })
    expect(cards[0].identity?.role).toBe('魔女')
  })

  it('缺失关键字段/重复 id/非数组输入被安全过滤', () => {
    expect(parseCharacterSettingCards(null)).toEqual([])
    expect(parseCharacterSettingCards([null, { name: '无 id' }, { id: 'a' }, { id: 'a' }])).toHaveLength(1)
  })

})

describe('characterSettingMemory · 条目组装', () => {
  it('bgStory/personality/likes/speech/identity 全部映射为可注入条目', () => {
    const entries = buildCharacterSettingEntries(NENE_CARD)
    expect(entries.some(entry => entry.startsWith('背景：'))).toBe(true)
    expect(entries.some(entry => entry.startsWith('性格：') && entry.includes('温柔体贴'))).toBe(true)
    expect(entries.some(entry => entry.startsWith('喜好：') && entry.includes('家人平安'))).toBe(true)
    expect(entries.some(entry => entry.startsWith('说话风格：'))).toBe(true)
    expect(entries.some(entry => entry.includes('与契约代价抗争的魔女'))).toBe(true)
  })

  it('identity 全空时不产出设定条目', () => {
    const entries = buildCharacterSettingEntries({ ...NENE_CARD, identity: {} })
    expect(entries.some(entry => entry.startsWith('设定：'))).toBe(false)
  })
})

describe('characterSettingMemory · 召回', () => {
  const CARDS = [NENE_CARD, NATSUME_CARD]

  it('精确角色匹配：空 query 返回该角色全部设定条目', () => {
    const entries = recallCharacterSetting(CARDS, 'nene', '')
    expect(entries.length).toBeGreaterThanOrEqual(4)
    expect(entries.join('')).toContain('绫地宁宁')
  })

  it('关键词召回：query 命中某条时排它优先', () => {
    const entries = recallCharacterSetting(CARDS, 'nene', '害羞', 6)
    expect(entries[0]).toContain('容易害羞慌乱')
  })

  it('关键词零命中时退回角色基础设定（背景+性格），保证注入不空', () => {
    const entries = recallCharacterSetting(CARDS, 'natsume', '与角色无关的关键词xyz', 6)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some(entry => entry.startsWith('背景：'))).toBe(true)
  })

  it('limit 生效：截断条目数不超过上限', () => {
    const entries = recallCharacterSetting(CARDS, 'nene', '', 2)
    expect(entries).toHaveLength(2)
  })
})
