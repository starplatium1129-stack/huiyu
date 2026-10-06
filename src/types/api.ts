/**
 * 网关 API 的响应契约。
 *
 * 修的是审计 C-7：`ControlView.vue` 把 `/api/status` 整体当 `any`，
 * `SceneManagerView.vue` 把整个领域模型声明为 `any[]` —— 于是字段拼错、
 * 后端改名、可选字段忘判空，全都要等运行时才炸，而它们恰好都在破坏性
 * 操作路径上（改 host、启停服务、写回 data/scenes）。
 *
 * 共享请求 wire DTO 位于仓库根 types/，前端展示契约留在此文件。
 */

// ── 统一错误信封（server/http-envelope.js）────────────────────────────────
export interface ApiFailure {
  ok: false
  error: string
  /** 技术细节，可直接展示给本机用户 */
  detail?: string
  /** 机器可判别，如 QUEUE_FULL / RATE_LIMITED */
  code?: string
  retryAfterSeconds?: number
}

export interface ChatStatus { online: boolean; model: string; models: Array<{ name: string; parameters?: string }> }
export type HostConfig =
  | { ok?: true; configured: false; model?: string; baseUrl?: string }
  | { ok?: true; configured: true; model: string; baseUrl: string }
export type ConfiguredHostConfig = Extract<HostConfig, { configured: true }>
export interface ProviderTestResult { ok: true; models: string[] }
export interface TtsStatus { online: boolean; voices: Record<string, boolean>; engine?: string; streamingPcm?: boolean; translation?: { ready: boolean }; activeVoice?: string; error?: string }
export interface VoicePrepareResult { ok: true; voice: string; translation: boolean; prepareMs?: number }
export interface TranslateResult { sourceLanguage?: string; targetLanguage?: string; translation: string; segments?: unknown[] }
export interface Live2DStatusResponse { models: Record<string, unknown> }
export interface SDStatusResponse { online: boolean; checkpoint: string; models: string[]; samplers: string[]; schedulers: string[]; upscalers: string[] }

// ── 控制面板 ───────────────────────────────────────────────────────────────
export type TunnelStatus = 'active' | 'waiting' | 'disabled'

export interface ControlOperationView {
  id: string
  kind: string
  label: string
  status: 'running' | 'completed' | 'failed'
  stageIndex: number
  stages: string[]
  message: string
  startedAt: number
  finishedAt: number
  error: string
}

export interface VoiceProfileView {
  refAudioPath?: string
  promptText?: string
  promptLang?: string
  textLang?: string
  gptWeightsPath?: string
  sovitsWeightsPath?: string
  loraWeightsPath?: string
  [key: string]: unknown
}

/** GET /api/status —— 探测失败时是 200 + ok:false + degraded:true，不是 500 */
export interface ControlStatus {
  ok: boolean
  running: boolean
  /** 探测失败时为 true，字段仍然齐全但全是保守值 */
  degraded?: boolean
  error?: string
  sdOnline: boolean
  comfyOnline: boolean
  ttsOnline: boolean
  ollamaOnline: boolean
  llama?: { online:boolean; managed:boolean; host:string; model?:string|null; label?:string }
  ollamaModels: string[]
  ollamaVram: number
  webuiManaged: boolean
  comfyManaged: boolean
  modeBusy: boolean
  operation: ControlOperationView | null
  sdHost: string
  comfyHost: string
  ttsHost: string
  ttsEngine?: 'gpt-sovits' | 'voxcpm2'
  ollamaHost: string
  localLink: string
  shareLinkAvailable: boolean
  tunnelStatus: TunnelStatus
  tunnelAvailable: boolean
  uptime: number
  autoStartVoice?: boolean
  restartRequired?: boolean
  savedConfig?: ControlConfigPayload & { ollamaHost?: string }
  voices: Partial<Record<'nene' | 'natsume', VoiceProfileView>>
  scripts: { voiceStart: boolean; voiceStop: boolean; webui: boolean; comfy: boolean }
  /** 前端构建状态：公网分享伺服 dist/，源码过期时 stale=true */
  webBuild?: ControlWebBuildStatus
  /** 服务自愈看门狗状态：restarting/attempt 表示正在自动拉起 */
  selfHealing?: {
    running: boolean
    services: Record<string, {
      healthy: boolean
      managed: boolean
      restarting: boolean
      attempt: number
      lastError: string
      lastRestartAt: number
    }>
  }
}

export interface ControlWebBuildStatus {
  distReady: boolean
  builtAt: string | null
  stale: boolean
}

/** GET /api/logs */
export interface ControlLogs {
  logs: string[]
  total: number
  operation: ControlOperationView | null
}

/** POST /api/service/* 与 /api/mode 的成功响应 */
export interface ControlActionResult {
  ok: true
  pending?: boolean
  operation?: ControlOperationView | null
  message?: string
}

export interface ControlShareLinkResult {
  ok: true
  shareLink: string
}

export interface ControlConfigPayload {
  sdHost: string
  comfyHost: string
  ttsHost: string
  ttsEngine?: 'gpt-sovits' | 'voxcpm2'
  voices: Partial<Record<'nene' | 'natsume', VoiceProfileView>>
}

export interface ControlConfigResult {
  ok: true
  sdHost: string
  comfyHost: string
  ttsHost: string
  ollamaHost: string
  restartRequired?: boolean
  message?: string
}

export interface ControlPreferenceResult {
  ok: true
  autoStartVoice: boolean
}

export interface ControlDiagnostics {
  timestamp: string
  uptime: number
  port: number
  sdHost: string
  comfyHost: string
  ttsHost: string
  ollamaHost: string
  sceneShowcaseDir: string
  disableTunnel: boolean
  runtimeConfig: Record<string, unknown>
  token: { present: boolean; length: number; suffix: string }
  scripts: {
    voiceStart: string
    voiceStop: string
    webui: string
    voiceStartExists: boolean
    voiceStopExists: boolean
    webuiExists: boolean
  }
  nodeVersion: string
  platform: string
  operation: ControlOperationView | null
}

// ── 场景管理领域模型 ────────────────────────────────────────────────────────
export type SceneRating = 'All' | 'R15' | 'R18'
export type SceneCharacter = 'nene' | 'natsume' | 'triad' | 'both' | string

/**
 * 场景编辑器的字段集。
 *
 * 索引签名保留：`data/scenes/*.json` 里还有一批只被维护脚本读的字段
 * （sourceAudit、attempt 之类），编辑器要能原样读写回去而不丢字段 ——
 * 变更集中的 upsert 仍保存完整记录，丢字段等于静默删数据。
 */
export interface SceneDraft {
  id: string
  title: string
  category: string
  char: SceneCharacter
  lora: string
  emotion: string
  season: string
  time: string
  timeOfDay: string
  rating: SceneRating
  character?: string[]
  mature?: boolean
  location: string
  weather: string
  camera: string
  lighting: string
  tags: string[]
  usage: string[]
  story: string
  storyJa: string
  prompt: string
  negative: string
  [key: string]: unknown
}

export interface CurationData {
  curatedSceneIds?: string[]
  signatureSceneIds?: string[]
  personaCoreSceneIds?: string[]
  personaCoreReasons?: Record<string, string>
  reviewSceneIds?: string[]
  recommendationReasons?: Record<string, string>
  [key: string]: unknown
}

export interface MaintenanceFailure extends ApiFailure {
  rolledBack?: boolean
  dataIntegrity?: 'restored' | 'INCONSISTENT'
  recovery?: string
}

export type HomeHeroCharacter = 'nene' | 'natsume'

export interface HomeHeroManifestEntry {
  image: string
  updatedAt: string | null
  source?: 'upload'
}

export interface HomeHeroManifestResult {
  ok: true
  version: number
  entries: Partial<Record<HomeHeroCharacter, HomeHeroManifestEntry>>
}

export interface ShowcaseSaveResult {
  ok: true
  file: string
  thumb: string
  backup: string
  message?: string
}

export interface HomeHeroSaveResult {
  ok: true
  character: HomeHeroCharacter
  action: 'replace' | 'reset'
  backup: string
  message?: string
}

export interface MaintenanceBuildWebResult {
  ok: true
  durationMs: number
  error: string | null
  tail: string
  webBuild: ControlWebBuildStatus
}
