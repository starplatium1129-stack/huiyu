import { describe, expect, it } from 'vitest'
import type { ArtworkRecord } from '@/types/artwork'
import { artworkIndexById, formatDate } from './galleryHelpers'

describe('gallery viewer identity', () => {
  const items = [{ id: 7 }, { id: '8' }] as ArtworkRecord[]

  it('resolves numeric and persisted string ids without falling back to list position', () => {
    expect(artworkIndexById(items, '7')).toBe(0)
    expect(artworkIndexById(items, 8)).toBe(1)
    expect(artworkIndexById(items, 'missing')).toBe(-1)
    expect(artworkIndexById(items, null)).toBe(-1)
  })
})

it('keeps local artwork dates and invalid historical timestamps readable', () => {
  const timestamp = new Date(2026, 9, 3, 12, 5).getTime()
  expect(formatDate(timestamp)).toBe(new Date(timestamp).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
  expect(formatDate(Number.NaN)).toBe('时间未记录')
})
