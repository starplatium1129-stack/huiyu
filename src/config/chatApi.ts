/**
 * 聊天 API 默认值单一来源。
 *
 * useChatStorage 的初始 settings 与 ChatApiSettings 的 vendor 预设原本各自
 * 硬编码同一批端点/模型/key —— 改一处另一处漂移。这里收敛为共享常量，
 * 两端都从这里取。
 */

/** 本机 CLIProxyAPI 网关（CPA-Manager-Plus / CLIProxyAPI 管理的本地多账号代理） */
export const CLIPROXY_BASE_URL = 'http://127.0.0.1:8317/v1'
/**
 * 聊天密钥不得通过 VITE_* 注入：Vite 会把这类值内联到浏览器包，任何拿到
 * dist 的人都能读取。默认保持为空，用户通过 ChatApiSettings 的安全凭据
 * 存储手动配置；网关侧托管配置也继续优先。
 */
export const CLIPROXY_API_KEY = ''
export const CLIPROXY_DEFAULT_MODEL = 'gemini-3.6-flash-high'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

export const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
export const OPENCODE_DEFAULT_MODEL = 'deepseek-v4-flash-free'

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const OPENCODE_GO_DEFAULT_MODEL = 'deepseek-v4-flash'
