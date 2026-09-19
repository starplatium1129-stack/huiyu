import type { EmotionRuntimeConfig } from '../utils/emotionRuntime'
import type { Live2DAdapterProfile } from './adapterProfile'

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
