import type { SceneBlueprint } from '../types/sceneBlueprint'
import { inferBlueprintDecisions } from './popularBlueprintDecisions'

export const RATING_OPTS = [
  { v: 'all', l: '全部分级' },
  { v: 'All', l: '全年龄' },
  { v: 'R15', l: 'R15' },
  { v: 'R18', l: 'R18' },
] as const

const CATEGORY_ORDER = ['全部', '现代日常', '温馨日常', '和风奇幻', '奇幻', '泰拉日常', '泰拉都市', '泰拉自然']

export function buildPopularCategories(pool: SceneBlueprint[]) {
  const counts = new Map<string, number>()
  counts.set('all', pool.length)
  for (const blueprint of pool) {
    const key = blueprint.adult ? '成人' : blueprint.category
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ id: key === 'all' ? 'all' : key, label: key === 'all' ? '全部' : key, count }))
    .sort((a, b) => {
      if (a.label === '成人' || a.id === '成人') return 1
      if (b.label === '成人' || b.id === '成人') return -1
      const indexA = CATEGORY_ORDER.indexOf(a.label)
      const indexB = CATEGORY_ORDER.indexOf(b.label)
      if (indexA >= 0 || indexB >= 0) {
        const rankA = indexA >= 0 ? indexA : Number.MAX_SAFE_INTEGER
        const rankB = indexB >= 0 ? indexB : Number.MAX_SAFE_INTEGER
        if (rankA !== rankB) return rankA - rankB
      }
      if (a.count !== b.count) return b.count - a.count
      return a.label.localeCompare(b.label, 'zh-CN')
    })
}

const SHOT_LABELS: Record<string, string> = {
  close: '特写', medium: '半身', wide: '全景', pov: '第一人称',
  high: '俯视', low: '仰视', side: '侧面', turn: '回眸', over: '自拍', detail: '细节',
}
const LIGHT_LABELS: Record<string, string> = {
  golden: '黄金光', window: '窗光', back: '逆光', moon: '月光',
  lantern: '灯笼光', overcast: '阴天光',
}
const MOOD_LABELS: Record<string, string> = {
  warmth: '暖色', calm: '平静', tension: '张力', sad: '忧郁', joy: '欢快',
}

export function shotLabel(blueprint: SceneBlueprint): string {
  const shot = inferBlueprintDecisions(blueprint).shot
  return shot ? SHOT_LABELS[shot] || shot : '自动'
}

export function lightLabel(blueprint: SceneBlueprint): string {
  const lighting = inferBlueprintDecisions(blueprint).lighting
  return lighting ? LIGHT_LABELS[lighting] || lighting : '自动'
}

export function moodLabel(blueprint: SceneBlueprint): string {
  const mood = inferBlueprintDecisions(blueprint).colorMood
  return mood ? MOOD_LABELS[mood] || mood : '自动'
}

export function artistLabel(blueprint: SceneBlueprint): string {
  return blueprint.adultArtistHint?.replace(/^@/, '') ?? ''
}

export function timeLabel(value: string): string {
  return ({ morning: '清晨', afternoon: '午后', sunset: '黄昏', evening: '傍晚', night: '夜晚', late_night: '深夜', day: '白天', noon: '中午' } as Record<string, string>)[value] || value || ''
}

export function sampleRatingOf(blueprint: SceneBlueprint): string {
  if (blueprint.sampleRating === 'SFW') return 'All'
  return blueprint.sampleRating || (blueprint.adult ? 'R18' : 'All')
}
