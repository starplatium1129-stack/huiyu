import type { ArtworkRecord } from '@/types/artwork'
import type { TrashEntry } from '@/storage/artworkRepository'
import type { Scene, LoraMeta } from '@/stores/sceneStore'
import type { PopularCharacter } from '@/utils/popularContent'
import { artworkSearchText } from '@/application/artwork/searchIndex'
import { artworkTags } from './artworkTags'
import { tagKey } from '@/utils/animaPromptOrder'
import { splitBreaks, tokenize } from '@/utils/promptPrimitives'
import { STUDIO_PROMPT_SUBJECTS } from '@/config/promptConstants'

/** Legacy numeric IDs and their serialized references identify the same artwork. */
export const artworkIdKey = (id: string | number): string => String(id).trim()

/** Viewer actions bind to a stable artwork identity, never to a mutable list position. */
export function artworkIndexById(items: readonly ArtworkRecord[], id: string | number | null): number {
  if (id === null) return -1
  const key = artworkIdKey(id)
  return items.findIndex(item => artworkIdKey(item.id) === key)
}

export function characterName(value: string | undefined, item: ArtworkRecord | undefined, characters: PopularCharacter[]): string {
  const studioNames: Record<string, string> = { nene: '绫地宁宁', natsume: '四季夏目', triad: '宁宁与夏目', both: '宁宁与夏目' }
  const identities = [item?.characterId, item?.storyOrigin?.characterId, value, item?.character]
    .map(id => id?.trim()).filter((id): id is string => !!id && id.toLowerCase() !== 'none')
  for (const id of identities) {
    if (studioNames[id]) return studioNames[id]
    const character = characters.find(candidate => candidate.id === id
      || [candidate.displayName, candidate.originalName, ...candidate.aliases].some(name => tagKey(name) === tagKey(id)))
    if (character) return character.displayName
  }
  if (item) {
    // Match whole name tokens only. Appearance, clothing and franchise tags do not identify a person.
    const tokens = new Set([
      ...artworkTags(item),
      ...splitBreaks((item.prompt || '').split('\n')[0]).flatMap(tokenize),
    ].map(tagKey))
    const names: string[] = []
    for (const id of ['nene', 'natsume']) {
      if ([studioNames[id], ...STUDIO_PROMPT_SUBJECTS[id].characterTokens].some(name => tokens.has(tagKey(name)))) names.push(studioNames[id])
    }
    for (const character of characters) {
      const nameTokens = [character.displayName, character.originalName, ...(character.characterTokens || [])]
      if (nameTokens.some(name => name.trim() && tokens.has(tagKey(name)))) names.push(character.displayName)
    }
    if (names.length) return [...new Set(names)].join('、')
  }
  return identities[0] || '自由创作'
}

/**
 * 一条作品的检索文本。
 * 拼接场景名、角色、故事、所属项目、Prompt，用于展墙全文检索。
 */
export function searchHaystack(item: ArtworkRecord): string {
  return artworkSearchText(item)
}

/** 回收站卡片摘要：取原 history 条目的 prompt 短述 */
export function trashPrompt(entry: TrashEntry): string {
  const first = entry.historyEntries?.[0]
  if (first && typeof first === 'object') {
    const record = first as Record<string, unknown>
    const prompt = typeof record.prompt === 'string' ? record.prompt : ''
    if (prompt) return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt
    const scene = typeof record.scene === 'string' ? record.scene : ''
    if (scene) return scene.length > 60 ? `${scene.slice(0, 60)}…` : scene
  }
  return '（已删除作品）'
}

export function formatTrashTime(ts: number): string {
  const d = new Date(Number(ts))
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function loraName(id: string | null | undefined, loras: LoraMeta[]): string {
  if (!id) return '—'
  const item = loras.find(l => l.id === id || (l.name && (l.name === id || String(id).startsWith(l.name))))
  return (item?.name || id) as string
}

/** 高清修复参数回显：旧条目无字段显示「—」，新条目精确显示倍率/放大器/步数。 */
function hiresLabel(i: ArtworkRecord): string {
  if (i.hiresFix == null) return '—'
  if (!i.hiresFix) return '关'
  const scale = i.hiresScale ? ` ×${i.hiresScale}` : ''
  const upscaler = i.hiresUpscaler ? ` · ${String(i.hiresUpscaler).split(/[\\/]/).pop()}` : ''
  const steps = i.hiresSteps ? ` · ${i.hiresSteps}步` : ''
  return `开${scale}${upscaler}${steps}`
}

function modelName(value: string | undefined): string {
  if (!value) return 'WebUI 当前模型'
  const name = String(value).split(/[\\/]/).pop()!.replace(/\s*\[[a-f0-9]+\]\s*$/i, '')
  return name.length > 42 ? name.slice(0, 39) + '…' : name
}

export function sceneTitle(
  id: string | null | undefined,
  item: ArtworkRecord | undefined,
  scenes: Scene[],
  popularCharacters: PopularCharacter[]
): string {
  if (item?.sceneTitle) return item.sceneTitle
  const found = scenes.find(s => s.id === id)
  if (found && typeof found.title === 'string' && found.title) return found.title
  if (item?.subject === 'popular' || item?.characterId) {
    const popChar = popularCharacters.find(c => c.id === (item.characterId || item.character))
    if (popChar) return `${popChar.displayName} 创作`
  }
  if (item?.story) return item.story.slice(0, 20)
  return id || '未命名作品'
}

const artworkDateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function formatDate(ts: number) {
        const d = new Date(ts);
        return Number.isFinite(d.getTime())
            ? artworkDateFormatter.format(d)
            : '时间未记录';
    }

export function dayGroup(ts: number) {
        const date = new Date(ts);
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diff = (start.getTime() - date.getTime()) / 86400000;
        return diff < 1 ? '今天' : diff < 7 ? '本周' : '更早';
    }

export function safeImageUrl(v: string | undefined) {
        if (typeof v !== 'string' || !v.trim())
            return '';
        try {
            const url = new URL(v.trim(), location.href);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
        }
        catch {
            return '';
        }
    }

export function artworkFacts(item: ArtworkRecord | null | undefined, loras: LoraMeta[]): { label: string; value: string }[] {
  if (!item) return [];
  if (item.engine === 'manga-screen') return [
    { label: '处理器', value: item.artifactKind === 'lineart'
      ? item.provider === 'local' ? '漫画化 · 导入线稿' : '漫画化 · 原生任务线稿'
      : 'MangaScreen · 原生漫画流程' },
    { label: '尺寸', value: item.size || '' },
  ];
  return [
    { label: '尺寸', value: item.size || '' },
    { label: 'LoRA', value: loraName(item.lora, loras) },
    { label: '模型', value: modelName(item.checkpoint) },
    { label: 'Seed', value: item.seed == null ? '' : String(item.seed) },
    { label: 'Sampler', value: item.sampler || '' },
    { label: '高清修复', value: hiresLabel(item) },
    { label: 'CFG', value: item.cfg == null ? '' : String(item.cfg) },
    { label: '步数', value: item.steps == null ? '' : String(item.steps) },
  ];
}
