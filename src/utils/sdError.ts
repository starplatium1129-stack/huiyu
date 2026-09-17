// SD 出图错误分类与恢复建议 — 从重构前 tools/sd-error.js 迁移
// 目的：失败时给出可执行的下一步，而不是丢一句 "生成失败"

export type SDErrorKind =
  | 'cancelled' | 'oom' | 'lora' | 'model' | 'sampler'
  | 'timeout' | 'gateway' | 'offline' | 'parameters' | 'unknown'

export type SDRecoveryId =
  | 'retry_light' | 'retry_without_lora' | 'retry_current_model'
  | 'retry_safe_sampler' | 'recheck_connection' | 'open_settings'

export interface SDRecoveryAction {
  id: SDRecoveryId
  label: string
}

export interface SDErrorReport {
  kind: SDErrorKind
  title: string
  message: string
  action: SDRecoveryAction | null
  details: string
  /** 产生本次错误的后端；UI 据此判断恢复动作是否适用。 */
  backend: SDBackend
}

/**
 * 出图后端（2026-08-30 UX 审计）。
 *
 * 本分类器原先只在 SD/WebUI 路径被调用，文案里写死了「WebUI」。Anima / Krea 2
 * 走的是 ComfyUI——同一条错误（比如 OOM）却让用户去检查一个他根本没在用的后
 * 端，比不给提示更糟。这里把后端变成入参，一套规则服务两条链路；恢复动作是
 * 否适用仍由 UI 判断（Comfy 侧没有「切回 WebUI 当前模型」这类动作）。
 */
export type SDBackend = 'webui' | 'comfy'

const BACKEND_LABEL: Record<SDBackend, string> = {
  webui: 'SD WebUI',
  comfy: 'ComfyUI',
}

const BACKEND_OFFLINE_HINT: Record<SDBackend, string> = {
  webui: '请确认 SD 后端已启动并启用 --api；恢复后可重新检测，不会静默提交新任务。',
  comfy: '请确认 ComfyUI 已启动、地址配置正确且模型已放置到位；恢复后可重新检测，不会静默提交新任务。',
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function errorRecord(error: unknown): Record<string, unknown> {
  return typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : {}
}

export function errorText(error: unknown): string {
  const source = errorRecord(error)
  let message = clean(source.message || (typeof error === 'string' ? error : ''))
  const detail = clean(source.detail)
  if (detail && !message.includes(detail)) message += (message ? ' · ' : '') + detail
  return message.slice(0, 1200)
}

function report(
  kind: SDErrorKind, title: string, message: string,
  action: SDRecoveryAction | null, details: string, backend: SDBackend,
): SDErrorReport {
  return { kind, title, message, action, details, backend }
}

export function classifySDError(error: unknown, backend: SDBackend = 'webui'): SDErrorReport {
  const source = errorRecord(error)
  const text = errorText(error)
  const lower = text.toLowerCase()
  const status = Number(source.status) || 0
  const name = clean(source.name)
  const be = BACKEND_LABEL[backend] ?? BACKEND_LABEL.webui

  if (name === 'AbortError') {
    return report('cancelled', '已停止生成', '本次出图任务已停止，当前的画面配置与 Prompt 已妥善保留。', null, text, backend)
  }
  if (/cuda out of memory|out of memory|outofmemory|显存不足|显存溢出|vram/.test(lower)) {
    return report('oom', '显存不足',
      '当前解析度或高清修复占用过高。可尝试关闭高清修复或微调分辨率后重试。',
      { id: 'retry_light', label: '降低负载后重试' }, text, backend)
  }
  if (/lora.*(not found|missing|could not|cannot find)|could not find.*lora|unknown lora|找不到.*lora/.test(lower)) {
    return report('lora', 'LoRA 不可用',
      `当前角色 LoRA 未能在 ${be} 中载入。可先跳过 LoRA 继续出图，随后检查模型文件路径。`,
      { id: 'retry_without_lora', label: '跳过 LoRA 重试' }, text, backend)
  }
  if (/checkpoint.*(not found|missing|could not|cannot find)|model.*(not found|missing|could not find)|找不到.*模型|找不到.*checkpoint/.test(lower)) {
    return report('model', '模型不可用',
      `所选底模未在 ${be} 中挂载${backend === 'webui' ? '。可一键切回 WebUI 当前活动模型' : '，请检查模型文件名与放置目录'}。`,
      { id: 'retry_current_model', label: '改用当前模型重试' }, text, backend)
  }
  if (/sampler.*(not found|invalid|unknown)|scheduler.*(not found|invalid|unknown)|采样器.*(不存在|无效)|调度器.*(不存在|无效)/.test(lower)) {
    return report('sampler', '采样器设置不可用',
      `当前 ${be} 未兼容此组采样器或调度器。可一键恢复为通用推荐组合。`,
      { id: 'retry_safe_sampler', label: '恢复稳定采样器重试' }, text, backend)
  }
  if (name === 'TimeoutError' || /请求超时|timed out|timeout/.test(lower)) {
    return report('timeout', '生成超时',
      `${be} 正在加载模型或推理占用较高。微调分辨率与高清修复后更容易顺利成图。`,
      { id: 'retry_light', label: '降低负载后重试' }, text, backend)
  }
  if (status === 404) {
    return report('gateway', 'SD 网关不可用',
      '当前页面未检测到可用的绘图网关。请检查出图参数中的服务地址，或前往控制面板启动服务。',
      { id: 'open_settings', label: '查看出图参数' }, text, backend)
  }
  if (name === 'NetworkError' || status === 502 || status === 503
      || /未响应|无法连接|connection refused|econnrefused|network/.test(lower)) {
    return report('offline', `${be} 未连接`,
      BACKEND_OFFLINE_HINT[backend] ?? BACKEND_OFFLINE_HINT.webui,
      { id: 'recheck_connection', label: '重新检测连接' }, text, backend)
  }
  if (status === 400 || /validationerror|invalid request|bad request|参数.*无效/.test(lower)) {
    return report('parameters', '出图参数被拒绝',
      '模型端拒绝了当前参数组合。请检查底模、分辨率、采样器与高清修复配置。',
      { id: 'open_settings', label: '查看出图参数' }, text, backend)
  }
  return report('unknown', '生成失败',
    '已保留 Prompt 与当前参数。检查配置后可随时再次提交。',
    { id: 'open_settings', label: '查看出图参数' }, text, backend)
}

/** 稳定回退组合：采样器/调度器不被支持时用 */
export const SAFE_SAMPLING = { sampler: 'Euler a', scheduler: '' }

/** 降负载方案：OOM / 超时时用 */
export const LIGHT_LOAD = { size: '832x1216', hiresFix: false }
