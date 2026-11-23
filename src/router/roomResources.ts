import type { Component } from 'vue'
import { whenStartupProfileReady } from '@/platform/startupProfile'
import { getDesktopWindowRole } from '@/platform/desktop/runtime'

export type RoomPage = 'chat' | 'companion' | 'companion-chat'
const flights = new Map<string, Promise<{ default: Component }>>()
const pages = {
  chat: () => import('@/views/ChatView.vue'),
  companion: () => import('@/views/CompanionView.vue'),
  'companion-chat': () => import('@/views/CompanionChatView.vue'),
}
export const loadRoomComponent = (page: RoomPage): Promise<{ default: Component }> => pages[page]()

/** Keep history admission before room setup, while the navigation shell paints. */
export function loadRoom(page: RoomPage, requestedCharacter = ''): Promise<{ default: Component }> {
  const key = `${page}:${requestedCharacter}`
  const pending = flights.get(key)
  if (pending) return pending
  const current = Promise.all([
    loadRoomComponent(page),
    whenStartupProfileReady().then(async () => {
      const { loadActiveCompanion, savedCompanionCharacter } = await import('./companionResources')
      const selected = savedCompanionCharacter()
      const isDesktopPet = page === 'companion' && getDesktopWindowRole() === 'companion'
      await Promise.all([
        loadActiveCompanion(selected),
        requestedCharacter && requestedCharacter !== selected ? loadActiveCompanion(requestedCharacter).catch(() => {}) : undefined,
        isDesktopPet ? undefined : import('@/platform/web/profileStorage').then(module => module.ensureProfileChatHistory()),
      ])
    }),
  ]).then(([component]) => component).finally(() => {
    if (flights.get(key) === current) flights.delete(key)
  })
  flights.set(key, current)
  return current
}
