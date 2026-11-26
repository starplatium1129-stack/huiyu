import { inject, onScopeDispose, type InjectionKey } from 'vue'

export type ChatRoomDismissGuard = () => boolean | Promise<boolean>
export const chatRoomDismissGuardKey: InjectionKey<(guard: ChatRoomDismissGuard) => () => void> = Symbol('chat-room-dismiss-guard')

export function useChatRoomDismissGuard(guard: ChatRoomDismissGuard) {
  const unregister = inject(chatRoomDismissGuardKey, undefined)?.(guard)
  if (unregister) onScopeDispose(unregister)
}
