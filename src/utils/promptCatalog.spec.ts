import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsePromptScenes, parsePromptCharacters, parsePromptLoras, parsePromptTags } from './promptCatalog'

describe('workbench catalog boundary', () => {
  it('accepts current catalogs without dropping fields or rewriting prompt bytes', () => {
    for (const [file, parse] of [
      ['scenes', parsePromptScenes],
      ['loras', parsePromptLoras], ['tags', parsePromptTags],
    ] as const) {
      const value = JSON.parse(readFileSync(`data/${file}.json`, 'utf8'))
      const parsed = parse(value)
      expect(parsed).toEqual(value)
      expect(parsed[0]).toBe(value[0])
    }
  })
  it('separates the six Endfield profile LoRAs while retaining studio generation configuration', () => {
    const value = JSON.parse(readFileSync('data/characters.json', 'utf8'))
    const parsed = parsePromptCharacters(value)
    const profiles = parsed.filter(item => item.profileLora)
    expect(profiles.map(item => item.id)).toEqual([
      'laevatain_arknights', 'perlica_arknights', 'yvonne_arknights',
      'zhuang_fangyi_arknights', 'administrator_arknights', 'rossy_arknights',
    ])
    expect(parsed).toHaveLength(value.length)
    parsed.forEach((item, index) => {
      const raw = value[index]
      if (item.profileLora) {
        expect(item.lora).toBeUndefined()
        const { profileLora, ...rest } = item
        expect({ ...rest, lora: profileLora }).toEqual(raw)
        expect(raw).not.toHaveProperty('profileLora')
      } else {
        expect(item).toBe(raw)
      }
    })
    const executable = { id: 'popular-with-config', type: 'popular', lora: { name: 'actual-model', weight: .85 } }
    expect(parsePromptCharacters([executable])[0]).toBe(executable)
    expect(parsed.filter(item => item.lora).length).toBeGreaterThan(0)
  })
  it('rejects malformed nested fields before consumers access them', () => {
    expect(() => parsePromptScenes([{ id: 's', title: 'River', tags: [1] }])).toThrow('第 1 条')
    expect(() => parsePromptCharacters([{ id: 'c', lora: { name: 'x', weight: '1' } }])).toThrow('第 1 条')
    expect(() => parsePromptCharacters([{ id: 'c', type: 'popular', lora: { name: 'x', weight: '1', trigger_words: ['x'] } }])).toThrow('第 1 条')
    expect(() => parsePromptCharacters([{ id: 'c', type: 'popular', lora: { name: 'x', trigger_words: [1] } }])).toThrow('第 1 条')
    expect(() => parsePromptLoras([{ strength: { default: Infinity } }])).toThrow('第 1 条')
    expect(() => parsePromptTags([{ en: 'sky', cat: 'place', aliases: 'blue' }])).toThrow('第 1 条')
    expect(() => parsePromptScenes({})).toThrow('必须是数组')
  })
})
