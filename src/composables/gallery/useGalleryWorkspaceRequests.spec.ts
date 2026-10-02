import { expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mocks, setup } from './galleryWorkspaceTestHarness'

it('retries a card that returns before its cancelled read settles without losing the new read ownership', async () => {
  const reads: Array<{ signal: AbortSignal; finish(blob: Blob): void }> = []
  mocks.getImage.mockImplementation((_id: string, signal: AbortSignal) => new Promise<Blob>(finish => { reads.push({ signal, finish }) }))
  const env = await setup()
  await env.intersect()
  env.gallery.searchQuery.value = 'no-matching-artwork'
  await flushPromises()
  expect(reads[0].signal.aborted).toBe(true)
  env.gallery.searchQuery.value = ''
  await flushPromises()
  await env.intersect()
  expect(reads).toHaveLength(2)
  reads[0].finish(new Blob(['cancelled original']))
  await flushPromises()
  await env.intersect()
  expect(reads).toHaveLength(2)
  expect(env.gallery.cardUrls).toEqual({})
  reads[1].finish(new Blob(['current original']))
  await flushPromises()
  expect(env.gallery.cardUrls[1]).toBe('blob:gallery-1')
  expect(env.gallery.missingImageIds.value.size).toBe(0)
  expect(URL.createObjectURL).toHaveBeenCalledOnce()
})
