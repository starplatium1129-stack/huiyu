import type { CompanionChatImage, CompanionDrawingDraft } from '@/types/companionDrawing'

export interface ChatReplyVariant {
  content: string
  mid: string
  stopped: boolean
  recalledMemories?: string[]
  drawingDrafts?: CompanionDrawingDraft[]
  images?: CompanionChatImage[]
}
export interface ChatMessage extends ChatReplyVariant {
  role: 'user' | 'assistant'
  replyId?: string
  variants?: ChatReplyVariant[]
}
export interface ChatBranch {
  id: string
  name: string
  createdAt: number
  parentId?: string
  forkMessageId?: string
  messages: ChatMessage[]
}
export interface ChatConversation {
  activeId: string
  selectionRevision: number
  branches: ChatBranch[]
}

export interface ChatState {
  version: number
  historiesRevision: number
  historiesRevisions: Record<string, number>
  active: string
  histories: Record<string, ChatMessage[]>
  conversations: Record<string, ChatConversation>
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
