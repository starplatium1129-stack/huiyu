import { hostApi, offHostEvent, onHostEvent } from './desktop/hostApi'

const observers = new Set<(visible: boolean) => void>()
let visible = true
let disconnect: (() => void) | undefined

function connect() {
  const label = hostApi()?.window.getCurrentWindow().label
  const event = label === 'atelier' || label === 'companion' || label === 'companion-chat'
    ? `aics:${label}-visibility` : undefined
  let hostVisible = true
  visible = !document.hidden
  function update() {
    const next = hostVisible && !document.hidden
    if (next === visible) return
    visible = next
    for (const observer of observers) observer(visible)
  }
  const subscription = event ? onHostEvent<unknown>(event, payload => {
    if (typeof payload === 'boolean') { hostVisible = payload; update() }
  }, 'current-window') : undefined
  document.addEventListener('visibilitychange', update)
  return () => {
    document.removeEventListener('visibilitychange', update)
    if (subscription !== undefined) offHostEvent(subscription)
  }
}

export function observeWindowVisibility(onChange: (visible: boolean) => void): () => void {
  disconnect ??= connect()
  observers.add(onChange)
  onChange(visible)
  return () => {
    observers.delete(onChange)
    if (!observers.size) { disconnect?.(); disconnect = undefined }
  }
}
