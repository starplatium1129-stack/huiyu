/** Missing versions are the supported pre-version format; numbered formats
 * migrate through the existing field allowlists. Never coerce version strings. */
export function assertChatVersion(value: unknown, current: number): void {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('聊天数据格式损坏，原件已保留，无法安全修改。')
  const version = (value as Record<string, unknown>).version
  if (version === undefined) return
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('聊天数据版本无效，原件已保留，无法安全修改。')
  }
  if (version > current) throw new Error('聊天数据来自更新版本，原件已保留，请升级后再发送或修改。')
}

export function assertStoredChatVersion(key: string, current: number): void {
  const raw = localStorage.getItem(key)
  if (raw !== null) assertChatVersion(JSON.parse(raw), current)
}
