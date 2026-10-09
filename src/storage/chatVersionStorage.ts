import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { assertChatVersion } from '../utils/chatVersion.ts'

export function assertStoredChatVersion(key: string, current: number): void {
  const raw = localStorage.getItem(key)
  if (raw !== null) {
    const value: unknown = JSON.parse(raw)
    if (value === null) throw new Error('聊天数据格式损坏，原件已保留。')
    assertChatVersion(value, current)
  }
}
