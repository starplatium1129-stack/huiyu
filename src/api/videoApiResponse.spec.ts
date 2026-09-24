import { describe, expect, it } from 'vitest'
import type { VideoBatch, VideoJob, VideoStatusResponse, VideoStoryboard } from './videoApi'
import { isVideoBatch, isVideoJob, isVideoStatusResponse, isVideoStoryboard } from './videoApiResponse'

const job: VideoJob = {
  id: 'video-1', status: 'running', provider: 'comfy', progress: 0.25,
  estimatedSeconds: 80, elapsedSeconds: 20, modelId: 'minimax-h3', prompt: 'a quiet room',
  width: 832, height: 480, duration: 3, fps: 24, seed: 7, createdAt: 1,
  resultAvailable: false, resultUrl: null, error: null, code: null,
}
const batch: VideoBatch = {
  id: 'batch-1', status: 'running', modelId: 'minimax-h3', aspectRatio: 'landscape', quality: 'standard', steps: 8,
  linkLastFrame: true, progress: { total: 2, succeeded: 1, failed: 0 }, createdAt: 1,
  shots: [{ index: 1, status: 'succeeded', prompt: 'one', dialogue: null, shotSize: 'medium', camera: 'still', motion: 'subtle', duration: 3, seed: 1, attempts: 1, error: null, code: null, resultAvailable: true, resultUrl: '/result' }],
  concatAvailable: false, concatUrl: null,
}
const status: VideoStatusResponse = {
  ok: true, online: false, pending: 0, maxPending: 2,
  models: [{ id: 'minimax-h3', label: 'H3', family: 'H3', tier: 'local', summary: 'fixture', executable: true, available: true, reason: 'ready', modes: ['text'], requirements: [], missing: [] }],
  qualities: [{ id: 'standard', label: '标准', summary: 'fixture', sizes: { landscape: '832 × 480' } }],
  defaults: { modelId: 'minimax-h3', aspectRatio: 'landscape', duration: 3, camera: 'still', motion: 'subtle', quality: 'standard' },
  t8: { available: false, reason: 'fixture' },
}
const storyboard: VideoStoryboard = {
  title: 'fixture', blueprintId: 'blueprint-1', characterId: 'nene', beats: ['one'],
  shots: [{ prompt: 'a quiet room', dialogue: null, shotSize: 'medium', camera: 'still', motion: 'subtle', duration: 3, firstFramePrompt: null }],
}

describe('video API response contracts', () => {
  it('accepts complete job and batch projections', () => {
    expect(isVideoJob(job)).toBe(true)
    expect(isVideoBatch(batch)).toBe(true)
  })

  it.each([
    ['missing result ownership', () => isVideoJob({ ...job, resultAvailable: 'yes' })],
    ['out-of-range progress', () => isVideoJob({ ...job, progress: 1.2 })],
    ['empty identity', () => isVideoJob({ ...job, modelId: '' })],
    ['malformed batch progress', () => isVideoBatch({ ...batch, progress: { total: 2, succeeded: 3, failed: 0 } })],
    ['malformed shot status', () => isVideoBatch({ ...batch, shots: [{ ...batch.shots[0], status: 'unknown' }] })],
  ])('rejects %s', (_name, validate) => {
    expect(validate()).toBe(false)
  })

  it('requires complete status defaults and storyboard shot fields', () => {
    expect(isVideoStatusResponse(status)).toBe(true)
    expect(isVideoStatusResponse({ ...status, defaults: { ...status.defaults, camera: 'unknown' } })).toBe(false)
    expect(isVideoStoryboard(storyboard)).toBe(true)
    expect(isVideoStoryboard({ ...storyboard, shots: [{ ...storyboard.shots[0], duration: '3' }] })).toBe(false)
  })
})
