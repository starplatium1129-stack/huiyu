// Small patches for the existing diagram. Each badge owns only its text.
export function paintSignal(badge, signal) {
  const label = typeof signal?.label === 'string' ? signal.label : '暂无观测'
  if (badge.textContent !== label) badge.textContent = label
  badge.dataset.museState = signal?.state ?? 'unknown'
}

// track contains only a decorative marker. Keep the count in the visible caption.
// count = messages at this stage; moving = current work confirmed by the collector.
export function paintTraffic(track, caption, { label, count, moving = false }) {
  const known = Number.isSafeInteger(count) && count >= 0
  const text = known ? label + ' · ' + count + ' 条' : label
  if (caption.textContent !== text) caption.textContent = text
  track.dataset.museMoving = String(moving === true && known && count > 0)
}

// Call observed() only for a new successful local snapshot. On a read failure
// call unavailable(). The caller owns the normal page refresh and its cleanup.
export function bindFlowMotion(root, pauseButton, snapshotMaxAgeMs = 12_000) {
  let lastSample
  let staleTimer
  let paused = false
  let valid = false
  function update() {
    root.dataset.museMotion = valid && !paused && !document.hidden ? 'on' : 'off'
  }
  function unavailable() {
    clearTimeout(staleTimer)
    valid = false
    root.dataset.museFresh = 'false'
    update()
  }
  function observed(sampleAt, ageMs) {
    if (!Number.isSafeInteger(sampleAt) || sampleAt <= 0 || !Number.isFinite(ageMs)
      || ageMs < 0 || ageMs >= snapshotMaxAgeMs) {
      unavailable()
      return
    }
    if (lastSample !== undefined && sampleAt <= lastSample) return
    lastSample = sampleAt
    clearTimeout(staleTimer)
    valid = true
    root.dataset.museFresh = 'true'
    update()
    staleTimer = setTimeout(unavailable, snapshotMaxAgeMs - ageMs)
  }
  function toggle() {
    paused = !paused
    pauseButton.setAttribute('aria-pressed', String(paused))
    update()
  }
  // The existing button uses the stable accessible name “暂停链路动效”.
  pauseButton.setAttribute('aria-pressed', 'false')
  pauseButton.addEventListener('click', toggle)
  document.addEventListener('visibilitychange', update)
  unavailable()
  return {
    observed, unavailable,
    destroy() {
      unavailable()
      pauseButton.removeEventListener('click', toggle)
      document.removeEventListener('visibilitychange', update)
    },
  }
}
