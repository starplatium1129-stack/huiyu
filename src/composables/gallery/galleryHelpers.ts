import type { ArtworkRecord } from '@/types/artwork'
import type { TrashEntry } from '@/storage/artworkRepository'
import type { Scene, LoraMeta } from '@/stores/sceneStore'
import type { PopularCharacter } from '@/utils/popularContent'
import { artworkSearchText } from '@/utils/artworkSearch'

/** Viewer actions bind to a stable artwork identity, never to a mutable list position. */
export function artworkIndexById(items: readonly ArtworkRecord[], id: string | number | null): number {
  if (id === null) return -1
  const key = String(id)
  return items.findIndex(item => String(item.id) === key)
}

export function characterName(value: string | undefined, item: ArtworkRecord | undefined, characters: PopularCharacter[]): string {
  if (value === 'nene') return '绫地宁宁'
  if (value === 'natsume') return '四季夏目'
  if (value === 'triad' || value === 'both') return '宁宁与夏目'
  const id = item?.characterId || value
  const character = id ? characters.find(candidate => candidate.id === id) : undefined
  return character?.displayName ?? (value || '—')
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

export function loraName(id: string | null | undefined, loras: LoraMeta[]): string {
  if (!id) return '—'
  const item = loras.find(l => l.id === id || (l.name && (l.name === id || String(id).startsWith(l.name))))
  return (item?.name || id) as string
}

/** 高清修复参数回显：旧条目无字段显示「—」，新条目精确显示倍率/放大器/步数。 */
export function hiresLabel(i: ArtworkRecord): string {
  if (i.hiresFix == null) return '—'
  if (!i.hiresFix) return '关'
  const scale = i.hiresScale ? ` ×${i.hiresScale}` : ''
  const upscaler = i.hiresUpscaler ? ` · ${String(i.hiresUpscaler).split(/[\\/]/).pop()}` : ''
  const steps = i.hiresSteps ? ` · ${i.hiresSteps}步` : ''
  return `开${scale}${upscaler}${steps}`
}

export function modelName(value: string | undefined): string {
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

export function formatDate(ts: number) {
        const d = new Date(ts);
        return Number.isFinite(d.getTime())
            ? d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
