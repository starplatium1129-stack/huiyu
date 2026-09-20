export interface PortraitReferenceSize { width: number; height: number }

/** Scale by the fitted portrait, not the empty space beside it. */
export function portraitAreaMultiplier(aspect: number, width: number, height: number, reference: PortraitReferenceSize): number {
  if (![aspect, width, height, reference.width, reference.height].every(n => Number.isFinite(n) && n > 0)) return 1
  const fittedHeight = Math.min(height, width / aspect)
  const referenceHeight = Math.min(reference.height, reference.width / aspect)
  return (fittedHeight / referenceHeight) ** 2
}

export function preferredParticleCount(options: {
  density: 'backdrop' | 'ambient' | 'hero'; compact: boolean; lowMemory: boolean
  reduceMotion: boolean; lowEffects: boolean; quality: number
  portraitAspect?: number; width: number; height: number; reference?: PortraitReferenceSize
}): number {
  const { density, compact, lowMemory, reduceMotion, lowEffects, quality, portraitAspect, reference } = options
  let count = density === 'backdrop' ? (compact ? 220 : 380) : compact || lowMemory ? 520 : density === 'ambient' ? 780 : 1380
  if (portraitAspect) count = Math.max(count, reference ? 6000 : compact ? 2400 : density === 'hero' ? 8000 : 6000)
  if (reduceMotion) count = 420
  if (portraitAspect && reference) count *= portraitAreaMultiplier(portraitAspect, options.width, options.height, reference)
  // The archive's <=760px stage needs about 32k points; bound exceptional sizes.
  count = Math.min(48000, count)
  return Math.round(count * (reduceMotion && !reference ? 1 : (reference ? 1 : quality) * (lowEffects ? 0.65 : 1)))
}
