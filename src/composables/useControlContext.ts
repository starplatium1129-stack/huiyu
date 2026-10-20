import { inject, provide, type InjectionKey } from 'vue'
import { useControlStatus } from './useControlStatus'
import { useControlActions } from './useControlActions'
import { useToast } from './useToast'

type ControlContext = {
  status: ReturnType<typeof useControlStatus>
  actions: ReturnType<typeof useControlActions>
}
const key: InjectionKey<ControlContext> = Symbol('control-room')

// The room owns one polling loop and one set of drafts across all sections.
export function provideControlContext() {
  const toast = useToast()
  function showToast(message: string, isError = false) {
    if (isError) toast.error(message)
    else toast.info(message)
  }
  const status = useControlStatus({ showToast })
  const context = { status, actions: useControlActions(status, { showToast }) }
  provide(key, context)
  return context
}

export function useControlContext() {
  const context = inject(key)
  if (!context) throw new Error('Control panels must be inside the control room')
  return context
}
