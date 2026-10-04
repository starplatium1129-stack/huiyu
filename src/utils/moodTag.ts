/**
 * 情绪标签协议解析（纯 TS，无 DOM）。
 *
 * 协议：回复文本中的行内标签 `[mood=happy]` / `[mood:happy]`（大小写不敏感）
 * 显式声明情绪，替代"从文本猜情绪"的启发式。
 *
 * 降级安全：
 * - 无标签 → emotion=null，cleanText 与原文一致；
 * - 非法情绪值 → 标签仍从展示文本剥离，情绪不生效；
 * - 悬挂标签（`[mood=` 已出现但未闭合）→ 剥离到文本末尾，情绪不生效，
 *   避免流式增量过程中协议残留闪现到界面；
 * - 多标签 → 取最后一个合法值（流式末尾的声明最准）。
 */

import type { ChatEmotion } from './emotionRuntime'

/** 协议接受的合法情绪（与 emotionRuntime 的 ChatEmotion 一致）。 */
export const MOOD_TAG_EMOTIONS: readonly ChatEmotion[] = [
  'neutral',
  'shy',
  'happy',
  'sad',
  'serious',
  'gentle',
]

export interface MoodTagExtract {
  /** 最后一个合法标签声明的情绪；无标签/非法值/悬挂时为 null */
  emotion: ChatEmotion | null
  /** 剥离全部标签（含非法与悬挂部分）后的展示文本 */
  cleanText: string
}

const TAG_START = /\[mood\s*[:=]/i
const TAG_PREFIX = /\[(?:m(?:o(?:o(?:d\s*)?)?)?)?$/i

export function extractMoodTag(raw: string): MoodTagExtract {
  return createMoodTagStream().push(raw)
}

/** 只重读可能继续组成标签的尾部；未形成起点的前缀仍立即显示。 */
export function createMoodTagStream() {
  let clean = ''
  let pending = ''
  let emotion: ChatEmotion | null = null

  return {
    /** 下个片段无法改写的干净前缀，供启发式保留跨标签的关键词衔接。 */
    get committedLength() { return clean.length },
    push(delta: string): MoodTagExtract {
      const raw = pending + delta
      pending = ''
      let index = 0
      while (index < raw.length) {
        const match = TAG_START.exec(raw.slice(index))
        if (!match) {
          const tail = raw.slice(index)
          const prefix = TAG_PREFIX.exec(tail)
          clean += prefix ? tail.slice(0, prefix.index) : tail
          pending = prefix ? tail.slice(prefix.index) : ''
          return { emotion, cleanText: clean + pending }
        }
        const open = index + match.index
        clean += raw.slice(index, open)
        const close = raw.indexOf(']', open + match[0].length)
        if (close < 0) {
          // 起点已确认的悬挂标签不显示，等待后续片段闭合。
          pending = raw.slice(open)
          break
        }
        const value = raw.slice(open + match[0].length, close).trim().toLowerCase()
        if (value && (MOOD_TAG_EMOTIONS as readonly string[]).includes(value)) emotion = value as ChatEmotion
        index = close + 1
      }
      return { emotion, cleanText: clean }
    },
  }
}

/** 判断文本是否包含（可能是未闭合的）标签起点，用于提示词约束场景。 */
export function hasMoodTagOpen(raw: string): boolean {
  return TAG_START.test(raw)
}
