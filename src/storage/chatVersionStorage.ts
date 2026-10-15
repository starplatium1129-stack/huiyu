import { assertProfileChatVersion, profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { assertChatJsonVersion } from '../utils/chatVersion.ts'

export function assertStoredChatVersion(key: string, current: number): void {
  if (!assertProfileChatVersion(key, current)) assertChatJsonVersion(localStorage.getItem(key), current)
}
