export type AnimaPixelUpscaler = '4x-UltraSharp' | 'Remacri'

/** UltraSharp refinement settings. The first pass uses the selected model's sampling settings. */
export const ANIMA_HIRES_PRESET = {
  hiresFix: true, hiresScale: 1.5, hiresDenoise: 0.8,
  hiresSteps: 10, hiresCfg: 5.5, hiresUpscaler: '4x-UltraSharp',
} as const
