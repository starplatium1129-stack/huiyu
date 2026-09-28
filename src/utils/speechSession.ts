/**
 * 语音会话状态机（纯 TS，无 DOM）。
 *
 * 唤醒词激活连续对话 → 会话内直接说话 → 结束词退出。
 * 这里只管理会话意愿；采集/识别与忙碌门控由 useVoiceInput 和调用方管理，
 * 安静时段与勿扰的抑制由调用方在启动自动监听前检查。
 */

import type { SpeechInputConfig } from './speechInputConfig'

export type SpeechSessionState =
  | 'disabled'        // 语音输入未启用
  | 'waitingForWake'  // 自动监听中，等待唤醒词
  | 'waitingForReply' // 已提交，等待角色回复
  | 'continuousReady' // 连续会话中，等待下一轮语音
  | 'ending'          // 已命中结束词，等最后一轮回复完成

export type SessionTextAction = 'submit' | 'end' | 'ignore'

export interface SpeechSessionHandle {
  /** 应用配置并重置会话（enabled/wakeEnabled 变化时调用） */
  applyConfig(config: SpeechInputConfig, fallbackWakeWord?: string): void
  state(): SpeechSessionState
  /** 连续会话是否激活（waitingForReply/continuousReady/ending） */
  isSessionActive(): boolean
  /** 当前是否需要持续自动监听（空闲且已启用自动监听） */
  shouldAutoListen(): boolean
  /** 唤醒词判定：识别文本命中唤醒词 → 激活会话 */
  onWakeText(text: string): boolean
  /** 会话内识别文本判定：结束词 → 'end'；非空 → 'submit'；空 → 'ignore' */
  onSessionText(text: string): SessionTextAction
  /** 回复链路空闲：按当前态恢复（continuousReady 或回 waitingForWake） */
  markReplyIdle(): void
  /** 会话手动退出（如用户主动关闭连续对话） */
  endSession(): void
  onChange(listener: () => void): () => void
}

function normalizeWords(words: string[]): string[] {
  return [...new Set(words.map(word => word.trim()).filter(word => word.length > 0))]
}

export function createSpeechSession(): SpeechSessionHandle {
  let config: SpeechInputConfig | null = null
  let wakeWords: string[] = []
  let endWords: string[] = []
  let state: SpeechSessionState = 'disabled'
  const listeners = new Set<() => void>()
  function notify(): void { listeners.forEach(listener => listener()) }
  function setState(next: SpeechSessionState): void {
    if (state === next) return
    state = next
    notify()
  }

  function toWaiting(): void {
    setState(config?.wakeEnabled ? 'waitingForWake' : 'disabled')
  }

  return {
    applyConfig(next: SpeechInputConfig, fallbackWakeWord?: string): void {
      config = next
      const wake = normalizeWords(next.wakeWords)
      if (wake.length === 0 && fallbackWakeWord && fallbackWakeWord.trim()) {
        wake.push(fallbackWakeWord.trim())
      }
      wakeWords = wake
      endWords = normalizeWords(next.endWords)
      if (endWords.length === 0) endWords = ['结束对话']
      toWaiting()
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    state(): SpeechSessionState {
      return state
    },

    isSessionActive(): boolean {
      return state === 'waitingForReply' || state === 'continuousReady' || state === 'ending'
    },

    shouldAutoListen(): boolean {
      if (!config?.enabled || !config.wakeEnabled) return false
      return state === 'waitingForWake' || state === 'continuousReady'
    },

    onWakeText(text: string): boolean {
      const trimmed = text.trim()
      if (!trimmed) return false
      const hit = wakeWords.some(word => trimmed === word || trimmed.includes(word))
      if (!hit) return false
      if (state === 'waitingForWake' || state === 'continuousReady') {
        setState('continuousReady')
      }
      return true
    },

    onSessionText(text: string): SessionTextAction {
      const trimmed = text.trim()
      if (!trimmed) return 'ignore'
      if (state === 'ending') return 'ignore'
      if (endWords.some(word => trimmed === word || trimmed.includes(word))) {
        setState('ending')
        return 'end'
      }
      if (state === 'waitingForReply') {
        return 'ignore'
      }
      setState('waitingForReply')
      return 'submit'
    },

    markReplyIdle(): void {
      if (state === 'waitingForReply') {
        setState('continuousReady')
      } else if (state === 'ending') {
        toWaiting()
      }
    },

    endSession(): void {
      toWaiting()
    },
  }
}
