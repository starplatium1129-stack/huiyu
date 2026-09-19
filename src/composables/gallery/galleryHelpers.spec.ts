import { describe, expect, it } from 'vitest'
import type { ArtworkRecord } from '@/types/artwork'
import { artworkIndexById } from './galleryHelpers'

describe('gallery viewer identity', () => {
  const items = [{ id: 7 }, { id: '8' }] as ArtworkRecord[]

  it('resolves numeric and persisted string ids without falling back to list position', () => {
    expect(artworkIndexById(items, '7')).toBe(0)
    expect(artworkIndexById(items, 8)).toBe(1)
    expect(artworkIndexById(items, 'missing')).toBe(-1)
    expect(artworkIndexById(items, null)).toBe(-1)
  })
})
