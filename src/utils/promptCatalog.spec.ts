import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsePromptScenes, parsePromptCharacters, parsePromptLoras, parsePromptTags } from './promptCatalog'

describe('workbench catalog boundary', () => {
  it('accepts current catalogs without dropping fields or rewriting prompt bytes', () => {
    for (const [file, parse] of [
      ['scenes', parsePromptScenes], ['characters', parsePromptCharacters],
      ['loras', parsePromptLoras], ['tags', parsePromptTags],
    ] as const) {
      const value = JSON.parse(readFileSync(`data/${file}.json`, 'utf8'))
      expect(parse(value)).toEqual(value)
      expect(parse(value)[0]).toBe(value[0])
    }
  })
  it('rejects malformed nested fields before consumers access them', () => {
    expect(() => parsePromptScenes([{ id: 's', title: 'River', tags: [1] }])).toThrow('第 1 条')
    expect(() => parsePromptCharacters([{ id: 'c', lora: { name: 'x', weight: '1' } }])).toThrow('第 1 条')
    expect(() => parsePromptLoras([{ strength: { default: Infinity } }])).toThrow('第 1 条')
    expect(() => parsePromptTags([{ en: 'sky', cat: 'place', aliases: 'blue' }])).toThrow('第 1 条')
    expect(() => parsePromptScenes({})).toThrow('必须是数组')
  })
})
