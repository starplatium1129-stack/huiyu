import { normalizeKey, splitBreaks, tokenize } from './promptPrimitives.ts'

type CameraAxis = 'framing' | 'elevation' | 'direction'

const axes: Record<CameraAxis, ReadonlySet<string>> = {
  framing: new Set(['extreme_close_up', 'medium_close_up', 'close_up', 'close_up_detail', 'portrait_shot',
    'face_focus', 'upper_face', 'medium_shot', 'upper_body', 'cowboy_shot', 'waist_up',
    'half_body', 'bust', 'full_body', 'wide_shot', 'long_shot', 'establishing_shot']),
  elevation: new Set(['low_angle', 'from_below', 'high_angle', 'from_above',
    'eye_level', 'overhead_shot', 'bird\'s_eye_view']),
  direction: new Set(['side_view', 'from_side', 'profile', 'front_view', 'back_view', 'from_behind',
    'three_quarter_view']),
}

function cameraAxis(token: string): CameraAxis | undefined {
  const key = normalizeKey(token)
  if (/^(?:front|rear|back|side)_three_quarter_view$/.test(key)) return 'direction'
  return (Object.keys(axes) as CameraAxis[]).find(axis => axes[axis].has(key))
}

// Replace photographic phrases only, never turn actions such as "looking back" into camera directions.
const cameraPhrase = /\b(?:(?:extreme|medium)[ _-]close[ _-]up|close[ _-]up|(?:medium|cowboy|wide|long|establishing)[ _-]shot|(?:wide[ _-])?full[ _-]body(?:[ _-](?:view|shot))?|waist[ _-]up(?:[ _-]view)?|(?:low|high|dutch)[ _-]angle|overhead[ _-]shot|bird's[ _-]eye[ _-]view|(?:(?:front|rear|back|side)[ _-])?three[ _-]quarter[ _-]view|(?:side|front|back)[ _-]view|eye[ _-]level)\b/gi
const multipleFrames = /\b(?:triptych|diptych|(?:two|three|multiple)[ _-](?:horizontal[ _-])?panels)\b/i

export function hasCameraPhrase(prose: string): boolean { return new RegExp(cameraPhrase).test(prose) }

/** Read only the camera field: descriptive body poses elsewhere are not camera controls. */
export function cameraTokensFromText(text = ''): string[] {
  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ')
    .replace(/medium closeup/g, 'medium close up')
    .replace(/\bwide medium shot\b/g, 'wide shot, medium shot')
    .replace(/\b(cowboy|medium|wide) (?:two|group) shot\b/g, '$1 shot')
    .replace(/medium[- ]full(?:[- ]frontal)?(?: dynamic)?(?: anime)?(?: tracking)? shot/g, (_, front: string) => `cowboy shot${front ? ', front view' : ''}`)
    .replace(/\bmedium[- ]portrait\b/g, 'medium shot')
    .replace(/\bmedium tracking shot\b/g, 'medium shot')
    .replace(/\bwide (?:cinematic|dynamic|anime|horizontal|ensemble)(?: sports| concert| pool)?(?: action)?(?: shot| landscape)?\b/g, 'wide shot')
    .replace(/\bpanoramic(?: beach)? shot\b/g, 'wide shot')
    .replace(/\bintimate (?:close shot|dramatic angle)\b/g, 'close-up')
    .replace(/\bdynamic[ -]angle\b/g, 'low angle')
    .replace(/\bfrontal(?: (?:shot|view))?\b/g, 'front view')
    .replace(/upper body to knees/g, 'cowboy shot').replace(/\b(?:upper|half) body\b/g, 'medium shot')
    .replace(/\bfull[ _-]shot\b/g, 'full body')
    .replace(/\brear angle\b/g, 'back view')
    .replace(/\b(front|rear|back|side) 3\/4(?: view)?/g, '$1 three quarter view')
    .replace(/\bthree quarter (front|rear|back|side)(?: view)?\b/g, '$1 three quarter view')
    .replace(/\b(front|rear|back|side) three quarter(?: view)?\b/g, '$1 three quarter view')
    .replace(/\b3\/4(?: dynamic)? perspective/g, 'three quarter view')
    .replace(/\b(low|high) three quarter angle/g, '$1 angle, three quarter view')
    .replace(/\b(low|high) dynamic angle/g, '$1 angle').replace(/\bside perspective\b/g, 'side view')
    .replace(/\bfrom below\b/g, 'low angle').replace(/\bfrom above\b/g, 'high angle')
    .replace(/\bfrom (?:the )?side\b/g, 'side view').replace(/\bfrom (?:the )?(?:back|behind)\b/g, 'back view')
    .replace(/\b(?:directly )?(?:overhead|top down)(?: (?:shot|view))?\b/g, 'overhead shot').replace(/\bside profile\b/g, 'side view')
    .replace(/全身(?:远景)?/g, ' full body ').replace(/远景/g, ' wide shot, full body ').replace(/全景|横幅(?:构图)?/g, ' wide shot, full body ').replace(/七分身/g, ' cowboy shot ')
    .replace(/三分之二(?:侧面|角度|视角)?/g, ' three quarter view ')
    .replace(/半身近景|中近景/g, ' medium close up ').replace(/半身特写/g, ' close up ')
    .replace(/半身(?:中景)?|中景/g, ' medium shot ').replace(/平视/g, ' eye level ')
    .replace(/局部特写|细节特写/g, ' extreme close up ').replace(/近景|特写/g, ' close up ')
    .replace(/俯视|俯拍|俯看|俯角|微俯(?:角)?/g, ' high angle ')
    .replace(/仰视|仰拍|仰看|仰角|微仰(?:角)?/g, ' low angle ')
    .replace(/低视角|低角度|低机位/g, ' low angle ')
    .replace(/高视角|高角度|高机位/g, ' high angle ')
    .replace(/侧后(?:方|景|拍)?|后侧(?:方|景|拍)?/g, ' rear three quarter view ')
    .replace(/侧面|侧方|侧向|侧景|侧拍/g, ' side view ')
    .replace(/后视|后方/g, ' back view ')
    .replace(/正面/g, ' front view ')
    .replace(/倾斜(?:电影感)?构图|荷兰角/g, ' dutch angle ')
    .replace(/镜面反射(?:构图)?/g, ' medium shot ')
    .replace(/广角/g, ' wide shot ')
  const phrases: string[] = normalized.match(cameraPhrase) || []
  if (/\bpov\b|\bfirst person\b|主观|第一人称/.test(normalized)) phrases.push('pov')
  const tokens = [...new Set(phrases.map(phrase => /full[ _-]body/i.test(phrase) ? 'full body'
    : /waist[ _-]up/i.test(phrase) ? 'waist up' : phrase))]
  return tokens.includes('overhead shot') ? tokens.filter(token => token !== 'high angle') : tokens
}

/** Inherited dropdown categories must not broaden authored full-body/cowboy framing. */
export function mergeCameraControls(selected: string[], authored: string[], inherited: boolean): string[] {
  if (!inherited) return [...selected, ...authored]
  const authoredAxes = new Set(authored.map(cameraAxis).filter(Boolean))
  return [...authored, ...selected.filter(token => !authoredAxes.has(cameraAxis(token)))]
}

/** Preserve independent crop/angle directions when a single director dimension changes. */
export function renderCameraProse(prose: string, controls: string[]): string {
  if (multipleFrames.test(prose)) return prose
  const chosen = new Map<CameraAxis, string>()
  for (const token of controls.flatMap(tokenize)) {
    const axis = cameraAxis(token)
    if (axis && !chosen.has(axis)) chosen.set(axis, normalizeKey(token).replace(/_/g, ' ')
      .replace(/close up/g, 'close-up').replace(/^from side$/, 'side view').replace(/^from behind$/, 'back view'))
  }
  const adjusted = prose.replace(cameraPhrase, phrase => {
    const axis = /full[ _-]body|waist[ _-]up/i.test(phrase) ? 'framing' : cameraAxis(phrase)
    return axis ? chosen.get(axis) ?? phrase : phrase
  })
  // This sentence-opening camera cue is distinct from a hand or light located above.
  const elevation = chosen.get('elevation')
    ?.replace(/from above|overhead shot|bird's eye view/, 'high angle').replace('from below', 'low angle')
  return adjusted.replace(/(^|[.!?]\s+)(?:seen |viewed )?from (?:directly )?(above|below)(?=[,\s])/gi,
    (phrase, boundary: string, direction: string) => elevation
      && elevation !== (direction.toLowerCase() === 'above' ? 'high angle' : 'low angle')
      ? `${boundary}Seen ${elevation === 'eye level' ? 'at' : 'from a'} ${elevation}` : phrase)
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
