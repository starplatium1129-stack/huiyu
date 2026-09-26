import { profileDraftStorage as sessionStorage } from '../platform/web/profileStorage.ts'
import { TEMP_RESULT_KEY } from '@/utils/storageKeys'
import type { AnimaJobMetadata, AnimaResultContext } from '@/types/anima'
import type { DrawEngine } from '@/storage/settingsRepository'

/**
 * 未入册临时成片记录（2026-09-06 体验报告 F2）。
 *
 * 用户偏好是「默认不自动入册」（AUTO_SAVE_TO_GALLERY 默认关），但 blob URL
 * 随页面卸载即失效——此前一次切页/刷新，未点「保存快照」的成片就永远消失。
 *
 * 设计：每次直出成功即把 blob 写入 IndexedDB（廉价、本地），sessionStorage
 * 只存指针与参数快照；入册成功/用户显式丢弃时清除；新成片替换旧记录并回收
 * 旧 blob。容量恒定为「最近一张」，不会无界堆积。
 */

export type TempResultContext = AnimaResultContext

export interface TempResultRecord {
  /** IndexedDB 图片 id（blob 本体所在）。 */
  imageId: string
  engine: DrawEngine
  prompt: string
  negative: string
  seed: number | null
  size: string
  /** Anima/Krea 完整任务元数据（恢复时重建会话结果用）。 */
  animaMetadata?: AnimaJobMetadata | null
  /** F3 冻结上下文：出图时的角色/服装/蓝图/场景/故事。 */
  context?: TempResultContext | null
  savedAt: number
}

function isRecord(value: unknown): value is TempResultRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<TempResultRecord>
  return typeof record.imageId === 'string' && record.imageId.length > 0
    && typeof record.engine === 'string'
}

/** 读取临时记录；损坏/非法载荷视为无记录。 */
export function readTempResult(): TempResultRecord | null {
  try {
    const raw = sessionStorage.getItem(TEMP_RESULT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 写入临时记录；存储失败返回 false（调用方负责提示，不静默吞）。 */
export function writeTempResult(record: TempResultRecord): boolean {
  try {
    sessionStorage.setItem(TEMP_RESULT_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

export function clearTempResult(): void {
  try { sessionStorage.removeItem(TEMP_RESULT_KEY) } catch { /* 隐私模式忽略 */ }
}
