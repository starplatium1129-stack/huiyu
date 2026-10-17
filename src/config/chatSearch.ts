export const DEEPSEEK_SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search'
export type ChatSearchProvider = 'auto' | 'duckduckgo'

/** Credentials are supplied by the application, never by model tool arguments. */
export interface ChatSearchConnection {
  provider: ChatSearchProvider
  apiKey: string
  chatApi?: { baseUrl: string; apiKey: string }
  hostConfig?: boolean
}
