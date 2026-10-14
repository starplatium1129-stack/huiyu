import type { EmotionRuntimeConfig } from '../utils/emotionRuntime'
import type { Live2DAdapterProfile } from './adapterProfile'

const MANUAL_EMOTIONS = { happy: '开心', gentle: '温柔', shy: '害羞', sad: '难过', serious: '认真' } as const

/** Parameter expressions stay separate from authored exp3 files used for outfits. */
export function profileExpressionOptions(profile?: Live2DAdapterProfile): { id: string; label: string }[] {
  const params = profile?.emotionParams
  const neutral = params?.neutral
  // Arbitrary imported parameters can be neutral at 1 or -1. A manual face
  // needs an explicitly calibrated baseline for every owned parameter.
  if (!params || !neutral || Object.values(params).some(values => Object.keys(values).some(id => !(id in neutral)))) return []
  return Object.entries(MANUAL_EMOTIONS)
    .filter(([name]) => Object.entries(params[name] || {}).some(([id, value]) => value !== neutral[id]))
    .map(([name, label]) => ({ id: `emotion:${name}`, label }))
}

/** Generic affect timing with only the selected model's authored parameter map. */
export function profileEmotionConfig(profile?: Live2DAdapterProfile): EmotionRuntimeConfig | undefined {
  if (!profile?.emotionParams) return undefined
  const params = profile.emotionParams
  return {
    emotionVAD: {
      neutral: { valence: 0, arousal: 0, dominance: 0 },
      happy: { valence: 0.75, arousal: 0.5, dominance: 0.2 },
      gentle: { valence: 0.35, arousal: -0.3, dominance: 0.1 },
      shy: { valence: 0.4, arousal: -0.1, dominance: -0.4 },
      sad: { valence: -0.6, arousal: -0.25, dominance: -0.3 },
      serious: { valence: -0.1, arousal: 0.3, dominance: 0.35 },
    },
    emotionParams: { neutral: params.neutral || {}, happy: params.happy || {}, gentle: params.gentle || {},
      shy: params.shy || {}, sad: params.sad || {}, serious: params.serious || {} },
    reactionParams: {},
  }
}
