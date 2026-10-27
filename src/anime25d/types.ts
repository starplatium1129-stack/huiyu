import type { AnimeCalibration } from './calibration'

export interface AnimeRig {
  fingerprint: string
  canvas: { w: number; h: number }
  anchors: { face: { cx: number; cy: number; x0: number; x1: number; y0: number; y1: number } }
  layers: { name: string }[]
  warnings: string[]
}

export interface AnimeFrame {
  time: number
  pose: AnimePose
  reduced: boolean
}

/** Model-local deformation channels, independent of Live2D parameter IDs. */
export interface AnimePose {
  angleX: number; angleY: number; angleZ: number; body: number
  eyeX: number; eyeY: number; eyeOpenL: number; eyeOpenR: number
  brow: number; browAngSym: number; mouthOpen: number; mouthForm: number
  breath: number; breathHead: number
}

export interface AnimeRenderer {
  render(input: AnimeFrame): void
  calibrate(value: AnimeCalibration): void
  destroy(): void
}

declare global {
  interface Window {
    HuiyuAnime25D?: { create(canvas: HTMLCanvasElement, rig: AnimeRig): AnimeRenderer }
  }
}
