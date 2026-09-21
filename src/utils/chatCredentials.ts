import type { CompanionDesktopBridge } from '@/types/desktop'

const session = new Map<string, string>()
const writes = new Map<string, Promise<void>>()
type CredentialBridge = Pick<CompanionDesktopBridge, 'readChatCredential' | 'writeChatCredential'>

/** Web credentials live only in this page's memory. Desktop never falls back to plaintext. */
export function createChatCredentials(bridge: CredentialBridge | undefined = window.companionDesktop) {
  function requireBridge() {
    if (!bridge?.readChatCredential || !bridge.writeChatCredential) {
      throw new Error('当前桌面版本不支持安全凭据，请更新后重试；原配置已保留。')
    }
    return { read: bridge.readChatCredential.bind(bridge), write: bridge.writeChatCredential.bind(bridge) }
  }
  async function write(endpoint: string, secret: string) {
    if (bridge) {
      const secure = requireBridge()
      await secure.write(endpoint, secret)
      if ((await secure.read(endpoint) || '') !== secret) throw new Error('安全凭据读回验证失败；原配置已保留。')
    } else {
      if (secret) session.set(endpoint, secret)
      else session.delete(endpoint)
      if ((session.get(endpoint) || '') !== secret) throw new Error('会话凭据保存失败。')
    }
  }
  async function locked<T>(endpoint: string, action: () => Promise<T>): Promise<T> {
    if (navigator.locks?.request) return navigator.locks.request(`huiyu-chat-credential:${endpoint.replace(/\/+$/, '')}`, action)
    if (bridge) throw new Error('此桌面环境不支持安全迁移锁，原配置已保留，请更新后重试。')
    return action()
  }
  async function save(endpoint: string, secret: string, commit?: () => void) {
    const previous = writes.get(endpoint) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => locked(endpoint, async () => {
      await write(endpoint, secret)
      commit?.()
    }))
    writes.set(endpoint, next)
    try { await next } finally { if (writes.get(endpoint) === next) writes.delete(endpoint) }
  }
  async function load(endpoint: string, legacy: string, options?: { isCurrent: () => boolean; commit: (secret: string) => void }) {
    return locked(endpoint, async () => {
      // Recheck the browser migration source after acquiring the cross-window
      // lock: another page may have saved or cleared the key while we waited.
      let secret: string
      if (legacy && (!options || options.isCurrent())) {
        await write(endpoint, legacy)
        secret = legacy
      } else secret = bridge ? (await requireBridge().read(endpoint) || '') : (session.get(endpoint) || '')
      options?.commit(secret)
      return secret
    })
  }
  return { save, load, desktop: Boolean(bridge) }
}
