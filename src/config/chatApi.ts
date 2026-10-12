/** Chat Completions presets verified against official docs on 2026-10-11.
 * Sources and protocol limits: docs/guides/setup-and-models.md#房间-api-连接
 * Presets are suggestions, never proof of account access. Saved model IDs stay unchanged.
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'
export const CLIPROXY_BASE_URL = 'http://127.0.0.1:8317/v1'
export const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
export const OPENCODE_DEFAULT_MODEL = 'deepseek-v4.1-flash'
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const OPENCODE_GO_DEFAULT_MODEL = ''

export type ApiVendor = 'deepseek' | 'openai' | 'gemini' | 'openrouter' | 'siliconflow'
  | 'qwen' | 'kimi' | 'cliproxy' | 'lmstudio' | 'ollama' | 'opencode' | 'opencode-go' | 'custom'
export interface ChatApiPreset {
  value: ApiVendor
  label: string
  note: string
  baseUrl: string
  models: Array<{ value: string; label: string }>
  keyRequired: boolean
  keyUrl?: string
  docsUrl?: string
  help: string
  local?: boolean
}
const models = (...values: string[]) => values.map(value => ({ value, label: value }))

export const CHAT_API_PRESETS: ChatApiPreset[] = [
  { value: 'deepseek', label: 'DeepSeek', note: '官方按量 API', baseUrl: DEEPSEEK_BASE_URL,
    models: models(DEEPSEEK_DEFAULT_MODEL, 'deepseek-v4-pro'), keyRequired: true,
    keyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/',
    help: '先到开放平台获取 API Key，再粘贴到下方。deepseek-flash 是当前 Flash 官方模型 ID。房间工具请搭配关闭思考；已有旧模型配置不会自动替换。' },
  { value: 'openai', label: 'OpenAI', note: '官方按量 API', baseUrl: 'https://api.openai.com/v1',
    models: models('gpt-6-luna'), keyRequired: true,
    keyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
    help: 'API 单独计费，不使用 ChatGPT 订阅额度。Luna 支持当前聊天协议；启用房间工具时固定使用不思考模式。GPT-6.1 Sol / Astra 的工具调用需要 Responses 协议，暂不推荐在此使用。' },
  { value: 'gemini', label: 'Google Gemini', note: 'AI Studio API', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: models('gemini-3.8-flash'), keyRequired: true,
    keyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    help: '使用 Google AI Studio 的 Gemini API Key。这里连接官方 OpenAI 兼容接口；可用地区、额度和计费以你的项目为准。' },
  { value: 'openrouter', label: 'OpenRouter', note: '多模型聚合', baseUrl: 'https://openrouter.ai/api/v1',
    models: [], keyRequired: true, keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/quickstart',
    help: '可选 Claude、Gemini 等聊天模型。先获取模型列表，再选择服务商/模型 ID；价格、可用性和工具能力以该模型页面为准。' },
  { value: 'siliconflow', label: '硅基流动', note: '国内多模型', baseUrl: 'https://api.siliconflow.cn/v1',
    models: [], keyRequired: true, keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/docs/userguide/quickstart',
    help: '从硅基流动控制台获取密钥。模型 ID 带有组织前缀，请从返回的模型列表选择可对话模型；不要填写展示名称。' },
  { value: 'qwen', label: '通义千问', note: '百炼 · 北京', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: models('qwen3.8-flash', 'qwen3.7-plus'), keyRequired: true,
    keyUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions',
    help: '使用百炼按量 API Key。本预设为北京地域；其他地域或工作空间专属域名请按官方说明修改地址，勿混用 Coding / Token Plan 专用密钥。' },
  { value: 'kimi', label: 'Kimi', note: '官方按量 API', baseUrl: 'https://api.moonshot.cn/v1',
    models: models('kimi-k2.6'), keyRequired: true, keyUrl: 'https://platform.kimi.com/console/api-keys',
    docsUrl: 'https://platform.kimi.com/docs/get-api-key',
    help: '使用 Kimi 开放平台 API Key。K2.6 可关闭思考用于日常对话。K3 要求跨轮完整思考上下文，当前房间尚未接入；不要将其作为本页面的默认模型。' },
  { value: 'cliproxy', label: 'CLIProxyAPI', note: '已有本机代理', baseUrl: CLIPROXY_BASE_URL,
    models: [], keyRequired: false, local: true, docsUrl: 'https://help.router-for.me/',
    help: '先启动你已配置的 CLIProxyAPI / CPA 管理器并启用 API 服务。默认端口 8317；Key 填代理自己设置的访问密钥。模型来自代理已授权的账号，并非本机离线推理。' },
  { value: 'lmstudio', label: 'LM Studio', note: '已有本地模型', baseUrl: 'http://127.0.0.1:1234/v1',
    models: [], keyRequired: false, local: true, docsUrl: 'https://lmstudio.ai/docs/developer/core/server',
    help: '先在 LM Studio 下载并加载聊天模型，在 Developer 页面启动本地服务。默认端口 1234；未开启认证时 Key 可留空，然后测试连接选择模型。' },
  { value: 'ollama', label: 'Ollama API', note: '已有本地服务', baseUrl: 'http://127.0.0.1:11434/v1',
    models: [], keyRequired: false, local: true, docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    help: '先启动 Ollama 并下载聊天模型（ollama pull 模型名）。默认端口 11434，无需 Key；也可在对话设置切换“已有 Ollama”自动发现。本地模型与 Ollama 云模型不同。' },
  { value: 'opencode', label: 'OpenCode Zen', note: '按量 / 限时模型', baseUrl: OPENCODE_BASE_URL,
    models: models(OPENCODE_DEFAULT_MODEL, 'kimi-k2.6', 'minimax-m3'), keyRequired: true,
    keyUrl: 'https://opencode.ai/auth', docsUrl: 'https://opencode.ai/docs/zen/',
    help: '只选择支持 Chat Completions 的模型。免费模型可能限时下架，不保证永久免费；Claude / Gemini 等原生协议模型不能直接用本页面调用。' },
  { value: 'opencode-go', label: 'OpenCode Go', note: '旧配置 · 编码套餐', baseUrl: OPENCODE_GO_BASE_URL,
    models: [], keyRequired: true, keyUrl: 'https://opencode.ai/auth', docsUrl: 'https://opencode.ai/docs/go/',
    help: '保留已有配置。官方将 Go 定位为编码代理套餐，角色聊天不属于其典型使用场景；建议改用上面的按量 API，不预填推荐模型。' },
  { value: 'custom', label: '自定义', note: 'OpenAI 兼容', baseUrl: '', models: [], keyRequired: false,
    help: '填写服务商的 Chat Completions Base URL 与模型 ID。仅支持 OpenAI 兼容聊天格式，不直接支持 Anthropic Messages 或 Responses。远程地址必须为 HTTPS。' },
]

export function chatApiPreset(vendor: ApiVendor): ChatApiPreset {
  return CHAT_API_PRESETS.find(preset => preset.value === vendor) ?? CHAT_API_PRESETS[CHAT_API_PRESETS.length - 1]!
}
export function chatApiVendorFor(baseUrl: string): ApiVendor {
  const endpoint = baseUrl.trim().replace(/\/+$/, '')
  const preset = CHAT_API_PRESETS.find(preset => preset.baseUrl && preset.baseUrl === endpoint)
  if (preset) return preset.value
  // DeepSeek documents both forms; don't classify look-alike or arbitrary proxy hosts.
  return endpoint === `${DEEPSEEK_BASE_URL}/v1` ? 'deepseek' : 'custom'
}
export function chatApiAddressError(baseUrl: string): string {
  if (!baseUrl.trim()) return '请填写 API 地址。'
  try {
    const url = new URL(baseUrl)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '远程地址必须使用 HTTPS；只有本机回环地址可用 HTTP。'
    if (url.username || url.password || url.search || url.hash) return '地址不能带账号、密钥、查询参数或锚点；Key 请填在专用输入框。'
    if (baseUrl.length > 500) return 'API 地址过长。'
    return ''
  } catch { return '请填写完整 API 地址，例如 https://api.example.com/v1。' }
}
