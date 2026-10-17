import { normalizeKey, splitBreaks, tokenize } from './promptPrimitives.ts'

type CameraAxis = 'framing' | 'elevation' | 'direction'

const axes: Record<CameraAxis, ReadonlySet<string>> = {
  framing: new Set(['extreme_close_up', 'close_up', 'close_up_detail', 'portrait_shot',
    'face_focus', 'upper_face', 'medium_shot', 'upper_body', 'cowboy_shot', 'waist_up',
    'half_body', 'bust', 'full_body', 'wide_shot', 'long_shot', 'establishing_shot']),
  elevation: new Set(['low_angle', 'from_below', 'high_angle', 'from_above',
    'eye_level', 'overhead_shot', 'bird\'s_eye_view']),
  direction: new Set(['side_view', 'profile', 'front_view', 'back_view', 'from_behind',
    'three_quarter_view']),
}

function cameraAxis(token: string): CameraAxis | undefined {
  const key = normalizeKey(token)
  return (Object.keys(axes) as CameraAxis[]).find(axis => axes[axis].has(key))
}

// Replace photographic phrases only, never turn actions such as "looking back" into camera directions.
const cameraPhrase = /\b(?:extreme[ _-]close[ _-]up|close[ _-]up|(?:medium|cowboy|wide|long|establishing)[ _-]shot|(?:wide[ _-])?full[ _-]body(?:[ _-](?:view|shot))?|waist[ _-]up(?:[ _-]view)?|(?:low|high)[ _-]angle|(?:side|front|back|three[ _-]quarter)[ _-]view|eye[ _-]level)\b/gi
const multipleFrames = /\b(?:triptych|diptych|(?:two|three|multiple)[ _-](?:horizontal[ _-])?panels)\b/i

export function hasCameraPhrase(prose: string): boolean { return new RegExp(cameraPhrase).test(prose) }

/** Read only the camera field: descriptive body poses elsewhere are not camera controls. */
export function cameraTokensFromText(text = ''): string[] {
  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ')
    .replace(/medium close up/g, 'close up').replace(/medium full shot/g, 'cowboy shot')
    .replace(/upper body to knees/g, 'cowboy shot').replace(/\b(?:upper|half) body\b/g, 'medium shot')
    .replace(/(?:front|rear|back) 3\/4 view/g, 'three quarter view')
    .replace(/\bfrom below\b/g, 'low angle').replace(/\bfrom above\b/g, 'high angle')
    .replace(/\b(?:overhead|top down)\b/g, 'high angle').replace(/\bside profile\b/g, 'side view')
    .replace(/全身(?:远景)?/g, ' full body ').replace(/半身(?:中景)?|中景/g, ' medium shot ')
    .replace(/局部特写/g, ' extreme close up ').replace(/近景|特写/g, ' close up ')
    .replace(/俯视|俯拍/g, ' high angle ').replace(/仰视|仰拍/g, ' low angle ')
  const phrases: string[] = normalized.match(cameraPhrase) || []
  if (/\bpov\b|\bfirst person\b|主观/.test(normalized)) phrases.push('pov')
  return [...new Set(phrases.map(phrase => /full[ _-]body/i.test(phrase) ? 'full body'
    : /waist[ _-]up/i.test(phrase) ? 'waist up' : phrase))]
}

/** Preserve independent crop/angle directions when a single director dimension changes. */
export function renderCameraProse(prose: string, controls: string[]): string {
  if (multipleFrames.test(prose)) return prose
  const chosen = new Map<CameraAxis, string>()
  for (const token of controls.flatMap(tokenize)) {
    const axis = cameraAxis(token)
    if (axis && !chosen.has(axis)) chosen.set(axis, normalizeKey(token).replace(/_/g, ' ').replace(/close up/g, 'close-up'))
  }
  return prose.replace(cameraPhrase, phrase => {
    const axis = /full[ _-]body|waist[ _-]up/i.test(phrase) ? 'framing' : cameraAxis(phrase)
    return axis ? chosen.get(axis) ?? phrase : phrase
  })
}

/** A crop and an angle can coexist; manual choices and director controls win within each BREAK. */
export function resolveCameraTags(tags: string[], manual: string[], controls: string[]): string[] {
  return splitBreaks(tags.join(', ')).flatMap((section, index) => {
    const tokens = tokenize(section)
    if (multipleFrames.test(section)) return index ? ['BREAK', ...tokens] : tokens
    const keys = new Set(tokens.map(normalizeKey))
    const chosen = new Map<CameraAxis, string>()
    for (const token of [...manual.flatMap(tokenize), ...controls.flatMap(tokenize), ...tokens]) {
      const axis = cameraAxis(token)
      if (axis && keys.has(normalizeKey(token)) && !chosen.has(axis)) chosen.set(axis, token)
    }
    const emitted = new Set<CameraAxis>()
    const resolved = tokens.flatMap(token => {
      const axis = cameraAxis(token)
      if (!axis) return [token]
      if (emitted.has(axis)) return []
      emitted.add(axis)
      return [chosen.get(axis)!]
    })
    return index ? ['BREAK', ...resolved] : resolved
  })
}
