export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  mid: string
  stopped: boolean
  recalledMemories?: string[]
}

export interface ChatState {
  version: number
  historiesRevision: number
  historiesRevisions: Record<string, number>
  active: string
  histories: Record<string, ChatMessage[]>
  settings: {
    model: string
    provider: 'local' | 'api'
    apiBaseUrl: string
    apiModel: string
    apiKey: string
    webSearchEnabled: boolean
    live2dEnabled: boolean
    live2dOutfit: string
    live2dOutfits: Record<string, string>
    autoVoice: boolean
    volume: number
    drafts: Record<string, string>
  }
}
