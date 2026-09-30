import { describe, expect, it } from 'vitest'
import { showcaseDestination } from './showcaseDestination'
import type { ShowcaseEntry } from './showcaseManifest'
const entry = { id: 'pc_raiden_raiden_garden', char: 'raiden', type: 'popular', title: 'Garden', story: '', category: '', rating: 'All', attempt: 1 } satisfies ShowcaseEntry
const characters = [{ id: 'raiden' }]
describe('showcase handoff', () => {
  it('preserves an exact owned blueprint without generating', () => {
    const result = showcaseDestination(entry, characters, [{ id: 'raiden_garden', characterId: 'raiden' }])
    expect(result.to).toBe('/prompt-builder?popular=raiden&blueprint=raiden_garden')
  })
  it('does not bind another character blueprint or invent a missing one', () => {
    expect(showcaseDestination(entry, characters, [{ id: 'raiden_garden', characterId: 'someone_else' }]).to).toBe('/prompt-builder?popular=raiden')
    expect(showcaseDestination(entry, [], []).to).toBe('/popular-scenes')
  })
  it('routes other sample types to the appropriate tools', () => {
    expect(showcaseDestination({ ...entry, type: 'artist' }, [], []).to).toBe('/style')
    expect(showcaseDestination({ ...entry, type: 'lora' }, [], []).to).toBe('/lora')
    expect(showcaseDestination({ ...entry, type: 'scene', id: 'sc001' }, [], []).to).toBe('/prompt-builder?scene=sc001&step=4')
  })
})
