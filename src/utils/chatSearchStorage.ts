import { createChatCredentials } from './chatCredentials'
import { CHAT_SEARCH_KEY } from './storageKeys'
import { DEEPSEEK_SEARCH_ENDPOINT, type ChatSearchProvider } from '@/config/chatSearch'
import { profileLocalStorage, flushProfileWrites } from '@/platform/web/profileStorage'

const credentials = createChatCredentials()
export function readChatSearchPreference(): { provider: ChatSearchProvider; revision: string } {
  const raw = JSON.parse(profileLocalStorage.getItem(CHAT_SEARCH_KEY) || 'null')
  if (raw && (raw.version !== 1 || !['auto', 'duckduckgo'].includes(raw.provider))) throw new Error('搜索配置格式不受支持，请更新应用后重试。')
  return { provider: raw?.provider || 'auto', revision: typeof raw?.revision === 'string' ? raw.revision : '' }
}
export async function loadChatSearchSettings(usage: 'editor' | 'search' = 'editor') {
  const preference = readChatSearchPreference()
  if (usage === 'search' && preference.provider === 'duckduckgo') return { ...preference, apiKey: '' }
  return { ...preference, apiKey: await credentials.load(DEEPSEEK_SEARCH_ENDPOINT, '') }
}
export async function saveChatSearchSettings(provider: ChatSearchProvider, apiKey: string) {
  if (apiKey.length > 1000 || /[\u0000-\u0020\u007f]/.test(apiKey)) throw new Error('搜索密钥不能包含空白、控制字符或超过 1000 个字符。')
  await credentials.save(DEEPSEEK_SEARCH_ENDPOINT, apiKey)
  const revision = crypto.randomUUID()
  profileLocalStorage.setItem(CHAT_SEARCH_KEY, JSON.stringify({ version: 1, provider, revision }))
  await flushProfileWrites()
  return revision
}
