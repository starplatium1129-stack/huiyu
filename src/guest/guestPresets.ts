import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

export type GuestSection = 'character' | 'scene' | 'free'

export interface GuestIdea {
  id: string
  title: string
  caption: string
  icon: ArchiveIconName
  prompt: string
}

export interface GuestMoodChip {
  id: string
  label: string
  icon: ArchiveIconName
  snippet: string
}

export const DEFAULT_GUEST_EXAMPLE =
  'An anime illustration of a tiny bookshop at dusk. Rain streaks the windows, amber lamps light the shelves, and the glow reflects on the wet pavement.'

export const GUEST_IDEAS: readonly GuestIdea[] = [
  {
    id: 'rainy-bookshop',
    title: '雨夜暖灯书店',
    caption: '黄昏微雨，暖灯透过橱窗映在湿润街面',
    icon: 'book',
    prompt: DEFAULT_GUEST_EXAMPLE,
  },
  {
    id: 'seaside-train',
    title: '黄昏海边电车',
    caption: '金色晚霞照亮沿海铁道与远方浪花',
    icon: 'sun',
    prompt:
      'An anime illustration of a quiet coastal train platform at sunset, golden light sparkling over calm ocean waves, gentle breeze, warm cinematic sky.',
  },
  {
    id: 'sakura-walk',
    title: '樱花飞舞校道',
    caption: '春风拂过林荫斜坡，漫天樱瓣逆光飘落',
    icon: 'cherry',
    prompt:
      'An anime illustration of a peaceful cherry blossom sloped street in spring morning, backlit petals drifting in the breeze, soft dappled sunlight on stone steps.',
  },
  {
    id: 'starry-greenhouse',
    title: '星夜玻璃温室',
    caption: '繁星穹顶下的静谧花房与温暖提灯',
    icon: 'moon',
    prompt:
      'An anime illustration of an enchanting glass conservatory at night filled with blooming flowers, warm lantern glow inside, deep starry sky overhead.',
  },
  {
    id: 'afternoon-cafe',
    title: '午后热茶咖啡馆',
    caption: '木质窗台、阳光光斑与氤氲热气的咖啡杯',
    icon: 'coffee',
    prompt:
      'An anime illustration of a cozy corner table in a quiet wooden cafe, afternoon sunlight streaming through sheer curtains, steaming coffee cup and open sketchbook.',
  },
  {
    id: 'snow-lantern',
    title: '雪夜灯笼小径',
    caption: '轻雪落满石阶，暖光灯笼点亮冬夜街角',
    icon: 'snowflake',
    prompt:
      'An anime illustration of a quiet snowy stone lane at night, soft snowflakes falling around warm glowing paper lanterns, serene winter atmosphere.',
  },
]

export const GUEST_MOOD_CHIPS: readonly GuestMoodChip[] = [
  { id: 'sunset', label: '夕阳余晖', icon: 'sun', snippet: 'warm golden sunset light' },
  { id: 'sakura', label: '樱花飘落', icon: 'cherry', snippet: 'drifting sakura petals' },
  { id: 'rain', label: '微雨夜色', icon: 'rain', snippet: 'gentle evening rain, wet reflections' },
  { id: 'starlight', label: '星夜微风', icon: 'moon', snippet: 'starlit night sky, soft breeze' },
  { id: 'smile', label: '温暖微笑', icon: 'happy', snippet: 'gentle warm smile' },
  { id: 'window', label: '窗边回眸', icon: 'bywindow', snippet: 'standing by the window, looking back' },
  { id: 'closeup', label: '柔焦特写', icon: 'closeup', snippet: 'portrait close-up, soft depth of field' },
  { id: 'cafe', label: '咖啡午后', icon: 'coffee', snippet: 'cozy cafe afternoon ambiance' },
]

export function getGuestCharacterAmbience(characterId?: string, characterTitle?: string) {
  if (characterId === 'nene') {
    return {
      title: '绫地宁宁 · 月下画桌',
      quote: '月影落进窗格前，先为这一幕留白吧。',
    }
  }
  if (characterId === 'natsume') {
    return {
      title: '四季夏目 · 午后画桌',
      quote: '咖啡刚温好，慢慢挑一页想画的故事。',
    }
  }
  if (characterTitle) {
    return {
      title: `${characterTitle} · 画室留白`,
      quote: `光影与构图都已备好，随时描绘${characterTitle}的这一幕。`,
    }
  }
  return {
    title: '欢迎来到绘遇好友画室',
    quote: '挑一位角色、选一幕场景，或直接写下你想画的画面。',
  }
}

export function hasMoodSnippet(prompt: string, snippet: string): boolean {
  return prompt.toLowerCase().includes(snippet.toLowerCase())
}

export function toggleMoodSnippet(prompt: string, snippet: string): string {
  const escaped = snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matchPattern = new RegExp(`(?:,\\s*|\\s+)?${escaped}(?:\\s*,)?`, 'i')
  if (matchPattern.test(prompt)) {
    return prompt
      .replace(matchPattern, ', ')
      .replace(/^[,\s]+|[,\s]+$/g, '')
      .replace(/,\s*,+/g, ', ')
  }
  const trimmed = prompt.trim().replace(/[,\s]+$/g, '')
  return trimmed ? `${trimmed}, ${snippet}` : snippet
}
