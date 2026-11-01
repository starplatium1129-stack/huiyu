/** Reference HiRes recipe. Keep the chosen canvas and seed when applying it. */
export const ANIMA_HIRES_PRESET = {
  steps: 30, cfg: 5.5, sampler: 'euler', scheduler: 'normal',
  hiresFix: true, hiresScale: 1.5, hiresDenoise: 0.8,
  hiresSteps: 10, hiresCfg: 5.5, hiresUpscaler: '4x-UltraSharp',
} as const
