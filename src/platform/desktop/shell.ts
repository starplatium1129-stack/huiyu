import { hostApi, invokeHost } from './hostApi'
import type { TaskRecord } from '../../../types/tasks'

export type DesktopCloseBehavior = 'tray' | 'quit'
export type DesktopShellAction = 'check-updates' | 'export-diagnostics'
interface ShortcutBinding { enabled: boolean; accelerator: string }
export interface DesktopShellPreferences {
  closeBehavior: DesktopCloseBehavior
  shortcuts: ShortcutBinding[]
}
interface ShortcutConflict { index: number; message: string }
interface PreferenceResult { preferences: DesktopShellPreferences; saved: boolean; conflicts: ShortcutConflict[] }

export const desktopShell = {
  readPreferences: () => invokeHost<PreferenceResult>('desktop_shell_preferences'),
  savePreferences: (preferences: DesktopShellPreferences) => invokeHost<PreferenceResult>('desktop_shell_set_preferences', { preferences }),
  readAutostart: () => invokeHost<boolean>('desktop_shell_autostart'),
  saveAutostart: (enabled: boolean) => invokeHost<boolean>('desktop_shell_set_autostart', { enabled }),
  readCompanion: () => invokeHost<boolean>('desktop_shell_companion_state'),
  toggleCompanion: () => invokeHost<void>('desktop_shell_toggle_companion'),
  taskProgress: (active: boolean, progress: number | null) => invokeHost<void>('desktop_shell_task_progress', { active, progress }),
  notifyTask: (taskId: string, kind: TaskRecord['kind']) => invokeHost<void>('desktop_shell_notify_task', { taskId, kind }),
  onAutostart: (listener: (enabled: boolean) => void) => listen('aics:desktop-autostart', listener),
  onCompanion: (listener: (visible: boolean) => void) => listen('aics:desktop-companion', listener),
}

function listen<T>(event: string, listener: (value: T) => void): () => void {
  let disposed = false
  let remove: (() => void) | undefined
  void hostApi()?.event.listen<T>(event, ({ payload }) => { if (!disposed) listener(payload) }, { target: 'atelier' })
    .then(stop => { if (disposed) stop(); else remove = stop }).catch(() => {})
  return () => { disposed = true; remove?.() }
}

/** A tray request survives until the owning component is listening, including a cold atelier start. */
export function onDesktopShellMenuAction(action: DesktopShellAction, listener: () => void): () => void {
  let disposed = false
  let remove: (() => void) | undefined
  const consume = async () => {
    try {
      if (await invokeHost<boolean>('desktop_shell_take_action', { action }) && !disposed) listener()
    } catch { /* The atelier may be closing. */ }
  }
  void hostApi()?.event.listen(`desktop-${action}`, () => { if (!disposed) void consume() }, { target: 'atelier' })
    .then(stop => {
      if (disposed) stop()
      else { remove = stop; void consume() }
    }).catch(() => {})
  return () => { disposed = true; remove?.() }
}
