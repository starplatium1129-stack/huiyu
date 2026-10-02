import { hostApi, invokeHost, onHostEvent, offHostEvent } from './hostApi.ts'
export function getDesktopUpdater() {
  if (!hostApi()) return null
  return {
    check: () => invokeHost<string | null>('desktop_update_check'),
    install: () => invokeHost<boolean>('desktop_update_install'),
    cancel: () => invokeHost<boolean>('desktop_update_cancel'),
    onFound: (listener: (version: string) => void) => onHostEvent<unknown>('desktop-update-found', value => { if (typeof value === 'string') listener(value) }),
    onProgress: (listener: (text: string) => void) => onHostEvent<unknown>('desktop-update-progress', value => { if (typeof value === 'string') listener(value) }),
    off: offHostEvent,
  }
}
