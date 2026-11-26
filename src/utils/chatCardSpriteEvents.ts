const EVENT_NAME = 'huiyu-card-sprites-changed'

export function dispatchChatCardSpritesChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(EVENT_NAME))
  }
}

export function onChatCardSpritesChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT_NAME, listener)
  return () => window.removeEventListener(EVENT_NAME, listener)
}
