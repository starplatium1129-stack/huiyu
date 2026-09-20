import type { Scene } from '@/types/scene'
import type { LoraMeta } from './promptPolicyTypes'
import type { PromptTagSource } from './promptTagDictionary'

export interface PromptCharacter {
  id: string
  lora?: { name: string; weight: number }
  traits?: Array<string | { tag: string; label: string; icon?: string }>
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)

function scene(value: unknown): value is Scene {
  return record(value) && text(value.id) && text(value.title)
    && ['story', 'prompt', 'visualDescription', 'char', 'category', 'season', 'series', 'rating', 'lora',
      'time', 'timeOfDay', 'lighting', 'camera', 'negative', 'location', 'weather', 'emotion', 'recommendedSize',
      'animaCaption'].every(key => optional(value[key], text))
    && optional(value.tags, strings) && optional(value.usage, strings)
    && optional(value.mature, v => typeof v === 'boolean')
}

function character(value: unknown): value is PromptCharacter {
  return record(value) && text(value.id)
    && optional(value.lora, v => record(v) && text(v.name) && finite(v.weight))
    && optional(value.traits, v => Array.isArray(v) && v.every(t => text(t) || (record(t)
      && text(t.tag) && text(t.label) && optional(t.icon, text))))
}

function lora(value: unknown): value is LoraMeta {
  return record(value) && optional(value.name, text)
    && optional(value.strength, v => record(v) && ['default', 'min', 'max'].every(k => optional(v[k], finite)))
    && optional(value.recommended_weight, v => record(v)
      && ['portrait', 'fullbody', 'complex_scene'].every(k => optional(v[k], finite)))
}

function tag(value: unknown): value is PromptTagSource {
  return record(value) && text(value.en) && text(value.cat)
    && ['cn', 'desc', 'source', 'version'].every(key => optional(value[key], text))
    && optional(value.aliases, strings)
}

/** Preserve valid records and extensions. Invalid catalogs must never look successfully empty. */
function catalog<T>(value: unknown, label: string, guard: (item: unknown) => item is T): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  return value.map((item: unknown, index) => {
    if (!guard(item)) throw new Error(`${label} 第 ${index + 1} 条字段无效`)
    return item
  })
}

export const parsePromptScenes = (value: unknown) => catalog(value, '工作台场景', scene)
export const parsePromptCharacters = (value: unknown) => catalog(value, '工作台角色', character)
export const parsePromptLoras = (value: unknown) => catalog(value, '工作台 LoRA', lora)
export const parsePromptTags = (value: unknown) => catalog(value, '工作台词条', tag)
