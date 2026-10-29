import type { Component } from 'vue'

export type RoomPage = 'chat' | 'companion' | 'companion-chat'
const flights = new Map<RoomPage, Promise<{ default: Component }>>()
const pages = {
  chat: () => import('@/views/ChatView.vue'),
  companion: () => import('@/views/CompanionView.vue'),
  'companion-chat': () => import('@/views/CompanionChatView.vue'),
}
export const loadRoomComponent = (page: RoomPage): Promise<{ default: Component }> => pages[page]()

/** Keep history admission before room setup, while the navigation shell paints. */
export function loadRoom(page: RoomPage): Promise<{ default: Component }> {
  const pending = flights.get(page)
  if (pending) return pending
  const current = Promise.all([
    loadRoomComponent(page),
    import('@/utils/localCompanions').then(module => module.loadLocalCompanions()),
    import('@/platform/web/profileStorage').then(module => module.ensureProfileChatHistory()),
  ]).then(([component]) => component).finally(() => {
    if (flights.get(page) === current) flights.delete(page)
  })
  flights.set(page, current)
  return current
}
