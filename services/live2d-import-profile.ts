type Profile = Record<string, any>
const object = (v: any): v is Profile => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v)
const range = (v: any) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && v[0] <= v[1]
function endpoints(v: any) {
  return object(v) && range(v.range) && Number.isFinite(v.closed) && Number.isFinite(v.open)
    && v.closed !== v.open && [v.closed, v.open].every(n => n >= v.range[0] && n <= v.range[1])
}

/** Validate only data consumed by the browser adapter; uploads cannot enable native code. */
export function validateImportProfile(value: unknown, restoringPrevious = false): Profile {
  if (!object(value) || JSON.stringify(value).length > 60000) throw new Error('Invalid adapter profile')
  const p = structuredClone(value)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  check(p.schemaVersion === 1 && id(p.profileId) && id(p.avatarId) && typeof p.profileVersion === 'string' && p.profileVersion.length <= 80, 'Invalid profile identity')
  check(Array.isArray(p.backendCompatibility) && p.backendCompatibility.includes('browser') && p.backendCompatibility.every((v: unknown) => v === 'browser' || restoringPrevious && v === 'native'), 'Imported calibration requires browser backend')
  check(object(p.parameterBindings), 'Parameter bindings required')
  const b = p.parameterBindings
  for (const key of ['blink', 'focus']) if (b[key] !== undefined) check(Array.isArray(b[key]) && b[key].length <= 256 && b[key].every(id), 'Invalid parameter IDs')
  if (b.mouth !== undefined) {
    check(object(b.mouth) && id(b.mouth.id) && Number.isFinite(b.mouth.scale), 'Invalid mouth binding')
    if (b.mouth.range !== undefined) check(range(b.mouth.range), 'Invalid mouth range')
    if (b.mouth.closed !== undefined || b.mouth.open !== undefined) check(!p.backendCompatibility.includes('native') && endpoints(b.mouth), 'Invalid mouth endpoints')
  }
  if (b.blinkCalibration !== undefined) {
    check(!p.backendCompatibility.includes('native') && object(b.blinkCalibration), 'Invalid blink calibration')
    for (const [key, value] of Object.entries(b.blinkCalibration)) check(b.blink?.includes(key) && endpoints(value), 'Invalid blink endpoints')
  }
  // Unsupported custom channels must not pass through unchecked.
  check(b.custom === undefined, 'Custom channels are not supported by this editor')
  if (p.emotionParams !== undefined) {
    check(object(p.emotionParams), 'Invalid emotion map')
    for (const [key, values] of Object.entries(p.emotionParams)) check(id(key) && object(values) && Object.entries(values).every(([key, value]) => id(key) && Number.isFinite(value)), 'Invalid emotion parameters')
  }
  if (p.interactions !== undefined) {
    check(object(p.interactions), 'Invalid interactions')
    for (const [key, v] of Object.entries(p.interactions) as [string, any][]) check(id(key) && object(v) && typeof v.group === 'string' && v.group.length > 0 && v.group.length <= 160 && typeof v.hint === 'string' && v.hint.length <= 500 && Number.isFinite(v.duration) && v.duration > 0 && v.duration <= 600000, 'Invalid interaction')
  }
  if (p.defaultInteractionId) check(p.interactions?.[p.defaultInteractionId], 'Unknown default interaction')
  if (p.stageHitZones !== undefined) {
    check(Array.isArray(p.stageHitZones) && p.stageHitZones.length <= 64, 'Invalid hit zones')
    for (const z of p.stageHitZones) check(object(z) && p.interactions?.[z.interactionId] && range([z.minY, z.maxY]) && z.minY >= 0 && z.maxY <= 1
      && (z.minX === undefined && z.maxX === undefined || range([z.minX, z.maxX]) && z.minX >= 0 && z.maxX <= 1), 'Invalid hit zone')
  }
  if (p.hitAreaMap !== undefined) check(object(p.hitAreaMap) && Object.entries(p.hitAreaMap).every(([key, v]) => id(key) && typeof v === 'string' && p.interactions?.[v]), 'Invalid hit area map')
  if (p.hitAreaFallbacks !== undefined) check(Array.isArray(p.hitAreaFallbacks) && p.hitAreaFallbacks.every(id), 'Invalid hit fallbacks')
  if (p.overlaySettle !== undefined) check(object(p.overlaySettle) && Number.isFinite(p.overlaySettle.settleMs) && p.overlaySettle.settleMs > 0 && object(p.overlaySettle.resetDefaults) && Object.entries(p.overlaySettle.resetDefaults).every(([key, v]) => id(key) && Number.isFinite(v)), 'Invalid settle parameters')
  if (p.layout !== undefined) {
    check(object(p.layout), 'Invalid layout')
    if (p.layout.scale !== undefined) check(Number.isFinite(p.layout.scale) && p.layout.scale > 0 && p.layout.scale <= 10, 'Invalid layout scale')
    if (p.layout.bubbleAnchor !== undefined) check(object(p.layout.bubbleAnchor) && [p.layout.bubbleAnchor.x, p.layout.bubbleAnchor.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1), 'Invalid bubble anchor')
  }
  check(object(p.verification) && ['detected', 'needs-confirmation', 'verified', 'unsupported', 'invalid'].includes(p.verification.status), 'Invalid verification')
  if (p.verification.status === 'verified') p.verification = { status: 'needs-confirmation', reason: '校准已保存；真实模型与设备表现仍待人工确认。' }
  return p
}
