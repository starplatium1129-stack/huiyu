import { expect, it } from 'vitest'
import { generationTask, canExecuteVideo } from './generationTask'

it('unifies backend states without inventing model loading or progress', () => {
  expect(generationTask('queued')).toMatchObject({ status: 'pending', stage: 'queued', active: true, progress: null })
  expect(generationTask('loading')).toMatchObject({ status: 'running', stage: 'loading' })
  expect(generationTask('running', NaN).progress).toBeNull()
  expect(generationTask('running', .4).progress).toBe(40)
  expect(generationTask('running', 40, 'percent').progress).toBe(40)
  expect(generationTask('succeeded')).toMatchObject({ status: 'completed', taskStatus: 'succeeded', active: false })
  expect(generationTask('unexpected')).toMatchObject({ status: 'unknown', taskStatus: 'interrupted' })
})
it('requires executable as well as available video models', () => {
  const model = { available: true, executable: true, modes: ['text'] }
  expect(canExecuteVideo(model, 'text', true)).toBe(true)
  expect(canExecuteVideo({ ...model, executable: false }, 'text', true)).toBe(false)
  expect(canExecuteVideo(model, 'image', true)).toBe(false)
  expect(canExecuteVideo(model, 'text', false)).toBe(false)
})
