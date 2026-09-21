/**
 * 本地存储键统一登记 —— 备份/恢复与死键清理的唯一白名单来源。
 *
 * 规则：
 * - 新增 localStorage 持久化键必须登记到这里（或使用登记过的前缀）；
 * - 备份只收集 LIVE 键；恢复只写 LIVE 键；DEAD 键在备份导出时清理；
 * - IndexedDB（aics_kv_store / aics_image_store）由 useBackup 直接读取，
 *   不在这里登记。
 */

/** 精确活键：全站仍在读写的 localStorage 键。 */
export const COMPANION_LIVE2D_KEY = 'aics_companion_live2d_v1'
export const LIVE2D_QUALITY_KEY = 'aics_live2d_quality_v1'
export const COMPANION_BEHAVIOR_KEY = 'aics_companion_behavior_v1'
export const COMPANION_AFFECTION_KEY = 'aics_companion_affection_v1'
/** 角色窗 → 聊天窗的实时状态通道（低频繁写入，storage 事件跨窗下发） */
export const COMPANION_CHAT_LIVE_KEY = 'aics_companion_chat_live_v1'
/** Transient cross-window signals, deliberately excluded from backup/restore. */
export const CHAT_ARCHIVE_CHANGED_KEY = 'aics_chat_archive_changed'
export const CHAT_ARCHIVE_KV_KEY = 'chat_archive_v1'
export const CHAT_TURN_KEY = 'aics_chat_turn_v1'
export const CHAT_RELAY_RECEIPT_KEY = 'aics_chat_relay_receipt_v1'
export const ROOM_PRESENTATION_KEY = 'aics_room_presentation_v1'
/** Per-character, per-surface presentation preferences, safe to restore. */
export const STAGE_FRAMING_KEY = 'aics_stage_framing_v1'
export const RETIRED_COMPANION_CHAT_KEY = 'aics_retired_companion_chat_v1'
export const SPEECH_INPUT_KEY = 'aics_speech_input_v1'
/** 绘图页引擎选择；键名保持不变以兼容已保存的 Anima 偏好。 */
export const DRAW_ENGINE_KEY = 'aics_draw_engine'
export const THEME_KEY = 'aics_theme'
export const DESKTOP_START_PAGE_KEY = 'aics_desktop_start_page'
export const DESKTOP_LAST_PAGE_KEY = 'aics_desktop_last_page'
export const INTERFACE_SOUND_KEY = 'aics_interface_sound_v1'
/** 成人内容展示开关（灵感场景页/热门场景页共用语义：本机默认开）。 */
export const MATURE_SETTING_KEY = 'aics_show_mature'
export const TUNNEL_OFF_KEY = 'aics_tunnel_off'
export const CHAT_THINKING_KEY = 'aics_chat_thinking_v1'
export const CHAT_USER_PROFILE_KEY = 'aics_user_profile_v1'
export const CHAT_MEMORY_KEY = 'aics_chat_memories_v1'
/** 高频偏好单独保存，避免每次输入或调音量重写聊天历史。 */
export const CHAT_VOLUME_KEY = 'aics_chat_volume_v1'
export const CHAT_DRAFT_PREFIX = 'aics_chat_draft_v1:'
/** Local deletion tombstone; never exported/restored from an older backup. */
export const CHAT_RESET_KEY = 'aics_chat_reset_v1'
export const GUEST_GUIDE_DISMISSED_KEY = 'aics_guest_guide_dismissed'
/** 出图自动入册开关（2026-08-31 用户偏好：默认关，直出成片不再自动进作品册）。 */
export const AUTO_SAVE_TO_GALLERY_KEY = 'aics_auto_save_to_gallery'

/**
 * 上次成功备份的时间戳（localStorage）——活键但刻意不参与备份导出：
 * 恢复时不应把旧环境的备份时间戳覆盖到新环境。
 */
export const BACKUP_AT_KEY = 'aics_backup_last_at'

// ── IndexedDB / sessionStorage 键登记 ──
// 这两类不参与 localStorage 备份白名单（见文件头规则），但常量化在这里统一出处，
// 杜绝同一键名在多处以字面量重复定义（曾致 aics_pb_history 散落 9 处）。

/** 任务中心摘要（IndexedDB；不包含图片或可执行回调）。 */
export const TASK_CENTER_KV_KEY = 'aics_task_center_v1'
/** 作品册历史（IndexedDB aics_kv_store 主存储；localStorage 同名键仅作旧数据迁移读取）。 */
export const ARTWORK_HISTORY_KV_KEY = 'aics_pb_history'
/** 历史损坏隔离区（storageHealth 使用，刻意不参与备份导出）。 */
export const ARTWORK_HISTORY_QUARANTINE_KEY = 'aics_pb_history_quarantine'
/** 作品册项目（IndexedDB 主存储；useBackup / 作品册 / 导演台共用）。 */
export const ARTWORK_PROJECTS_KV_KEY = 'aics_pb_projects'
/**
 * 作品册软删回收站（IndexedDB，2026-08-30 UX 审计 P0-8）。软删条目保留
 * 30 天（图片与缩略图在 purge 前不删），期间可整条恢复；超期由作品册
 * 挂载时的懒清理真删。刻意不参与备份导出：回收站属于会话期补救通道。
 */
export const ARTWORK_TRASH_KV_KEY = 'aics_pb_trash'
/** 绘图页 → 视频页单图跨页上下文（sessionStorage，容量敏感故不入 localStorage 备份）。 */
export const VIDEO_CONTEXT_KEY = 'aics_video_ctx'
/** 分镜短片批量带入上下文（sessionStorage）。 */
export const VIDEO_SHOTS_CONTEXT_KEY = 'aics_video_shots_ctx'
/** 剧本模式分幕 → 分镜短片跨页上下文（sessionStorage，2026-08-23 剧本模式激活）。 */
export const VIDEO_SCENARIO_CONTEXT_KEY = 'aics_video_scenario_ctx'
/**
 * 视频页创作草稿（sessionStorage，2026-09-06 体验报告 F1）：
 * 模式/描述/参数/首帧图 IndexedDB 引用，切页与刷新后恢复；图片本体在 IndexedDB。
 */
export const VIDEO_DRAFT_KEY = 'aics_video_draft_v1'
/** 视频在途/最近任务记录（sessionStorage）：离页后按 jobId 重连真实状态。 */
export const VIDEO_TASK_KEY = 'aics_video_task_v1'
/** 分镜短片编辑草稿（sessionStorage）：镜头列表 + 身份锚点 + 参考卡元信息。 */
export const VIDEO_SHOTS_DRAFT_KEY = 'aics_video_shots_draft_v1'
/** 分镜整批任务记录（sessionStorage）：离页后按 batchId 重连真实进度。 */
export const VIDEO_SHOTS_BATCH_KEY = 'aics_video_shots_batch_v1'
/** 绘图页未入册临时成片指针（sessionStorage，2026-09-06 体验报告 F2；blob 在 IndexedDB）。 */
export const TEMP_RESULT_KEY = 'aics_pb_temp_result_v1'

/**
 * SD 出图队列快照（2026-08-30 UX 审计 P0-5）。队列任务在离开绘图页 / 刷新后
 * 经此快照恢复。活键但刻意不参与备份导出：恢复到新环境时的陈旧队列没有
 * 价值（引用的 checkpoint / LoRA 可能不存在），只在本机会话内往返。
 */
export const SD_QUEUE_SNAPSHOT_KEY = 'aics_sd_queue_snapshot_v1'

export const LIVE_LOCAL_KEYS = [
  DESKTOP_START_PAGE_KEY,
  DESKTOP_LAST_PAGE_KEY,
  THEME_KEY,
  INTERFACE_SOUND_KEY,
  'aics_sd_last_success_v1',
  'aics_pb_last_draft',
  'aics_pb_director_mode',
  'aics_scene_favorites',
  'aics_recent_scenes',
  'aics_hidden_scenes',
  'aics_scene_usage_v1',
  MATURE_SETTING_KEY,
  TUNNEL_OFF_KEY,
  'aics_chat_v1',
  'aics_chat_model',
  'aics_chat_api_drafts',
  'aics_chat_archive_v1',
  CHAT_THINKING_KEY,
  CHAT_USER_PROFILE_KEY,
  CHAT_MEMORY_KEY,
  CHAT_VOLUME_KEY,
  COMPANION_LIVE2D_KEY,
  LIVE2D_QUALITY_KEY,
  STAGE_FRAMING_KEY,
  RETIRED_COMPANION_CHAT_KEY,
  COMPANION_BEHAVIOR_KEY,
  COMPANION_AFFECTION_KEY,
  SPEECH_INPUT_KEY,
  DRAW_ENGINE_KEY,
  GUEST_GUIDE_DISMISSED_KEY,
  AUTO_SAVE_TO_GALLERY_KEY,
] as const

/** 动态前缀活键：聊天草稿按角色独立保存。 */
export const LIVE_LOCAL_PREFIXES = [
  CHAT_DRAFT_PREFIX,
] as const

/** 死键：已无写入者、内容已迁移或废弃，备份导出时清理。 */
export const DEAD_LOCAL_KEYS = [
  'aics_sd_settings_v1',
  'aics_projects',
  'aics_pending_scene',
] as const

export function isLiveLocalKey(key: string): boolean {
  if ((LIVE_LOCAL_KEYS as readonly string[]).includes(key)) return true
  return (LIVE_LOCAL_PREFIXES as readonly string[]).some(prefix => key.startsWith(prefix))
}

export function isDeadLocalKey(key: string): boolean {
  return (DEAD_LOCAL_KEYS as readonly string[]).includes(key)
}

interface KeyedStorage {
  length: number
  key(index: number): string | null
  getItem(key: string): string | null
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

/** 遍历真实存储，只收集活键（含动态前缀）。 */
export function collectLiveLocalSettings(storage: KeyedStorage): Record<string, string> {
  const out: Record<string, string> = {}
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key || !isLiveLocalKey(key)) continue
    const value = storage.getItem(key)
    if (value != null) out[key] = value
  }
  return out
}

/** 清理死键；返回实际删除数量。 */
export function cleanDeadLocalKeys(storage: KeyedStorage): number {
  const removed: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && isDeadLocalKey(key)) removed.push(key)
  }
  for (const key of removed) {
    try { storage.removeItem(key) } catch { /* 隐私模式忽略 */ }
  }
  return removed.length
}

/** 备份恢复时只允许写入活键。 */
export function isRestorableLocalKey(key: string): boolean {
  return isLiveLocalKey(key)
}
