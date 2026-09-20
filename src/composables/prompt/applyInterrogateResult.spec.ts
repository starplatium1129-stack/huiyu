import { expect, it, vi } from 'vitest'
import { applyInterrogateResult } from './applyInterrogateResult'

it.each(['tag', 'caption'])('never applies historical demo results in %s mode', async mode => {
  const pb = { manualTags: new Set(['smile']), visualDescription: 'original', flash: vi.fn() }
  await applyInterrogateResult(pb as unknown as Parameters<typeof applyInterrogateResult>[0], {
    engine: 'heuristic', mode, tags: ['school_uniform'], caption: 'demo caption',
  })
  expect([...pb.manualTags]).toEqual(['smile'])
  expect(pb.visualDescription).toBe('original')
  expect(pb.flash).toHaveBeenCalledWith(expect.stringContaining('演示标签未写入'))
})
