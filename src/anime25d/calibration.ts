export const CALIBRATION_FIELDS = [
  { key: 'motion', label: '头身运动幅度', min: 0, max: 150, initial: 100, unit: '%' },
  { key: 'gaze', label: '视线跟随幅度', min: 0, max: 150, initial: 100, unit: '%' },
  { key: 'physics', label: '头发与饰品摆动', min: 0, max: 150, initial: 100, unit: '%' },
  { key: 'depth', label: '转头立体感', min: 0, max: 150, initial: 100, unit: '%' },
  { key: 'pivotX', label: '转头支点左右', min: -50, max: 50, initial: 0, unit: '% 脸宽' },
  { key: 'pivotY', label: '转头支点高低', min: -50, max: 50, initial: 0, unit: '% 脸高' },
  { key: 'eyeY', label: '闭眼差分高低', min: -15, max: 15, initial: 0, unit: '% 脸高' },
  { key: 'eyeScale', label: '闭眼差分大小', min: 60, max: 140, initial: 100, unit: '%' },
  { key: 'mouthY', label: '闭口差分高低', min: -15, max: 15, initial: 0, unit: '% 脸高' },
  { key: 'mouthScale', label: '口型大小', min: 60, max: 140, initial: 100, unit: '%' },
] as const

export type CalibrationKey = typeof CALIBRATION_FIELDS[number]['key']
export type AnimeCalibration = Record<CalibrationKey, number>

/** Relative corrections preserve the parser's model-specific automatic binding. */
export function normalizeCalibration(value?: unknown): AnimeCalibration {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(CALIBRATION_FIELDS.map(field => {
    const candidate = source[field.key]
    const number = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : field.initial
    return [field.key, Math.round(Math.max(field.min, Math.min(field.max, number)))]
  })) as AnimeCalibration
}

export function sameCalibration(a: AnimeCalibration, b: AnimeCalibration) {
  return CALIBRATION_FIELDS.every(({ key }) => a[key] === b[key])
}
