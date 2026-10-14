import { invokeHost, onHostEvent, offHostEvent } from './hostApi'

export type CompanionDialogueSide = 'left' | 'right'

export async function resizeCompanionDialogue(width: number, height: number): Promise<number> {
  const limit = await invokeHost<unknown>('resize_companion_dialogue', { width, height })
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) throw new Error('对白可用高度无效')
  return limit
}

export function onCompanionDialogueSide(listener: (side: CompanionDialogueSide) => void): () => void {
  const id = onHostEvent<unknown>('aics:chat-dock-side', value => {
    if (value === 'left' || value === 'right') listener(value)
  })
  return () => offHostEvent(id)
}

export async function companionDialogueVisible(): Promise<boolean> {
  const state = await invokeHost<unknown>('get_state')
  return Boolean(state && typeof state === 'object' && 'chatVisible' in state && state.chatVisible === true)
}

export function onCompanionDialogueVisibility(listener: (visible: boolean) => void): () => void {
  const id = onHostEvent<unknown>('aics:chat-visibility', value => {
    if (typeof value === 'boolean') listener(value)
  })
  return () => offHostEvent(id)
}
