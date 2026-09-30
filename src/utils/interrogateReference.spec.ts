import { describe, expect, it } from 'vitest'
import { splitReferenceTags } from './interrogateReference'

describe('reference identity isolation', () => {
  it('excludes reference identity regardless of whether a target has that domain', () => {
    const result = splitReferenceTags(['blue_hair', 'green_eyes', 'long_hair', 'twintails', '1girl', 'solo', 'sitting', 'library'])
    expect(result.excludedIdentity).toEqual(['blue_hair', 'green_eyes', 'long_hair', 'twintails', '1girl', 'solo'])
    expect(result.tags).toEqual(['sitting', 'library'])
    expect(result.uncertain).toEqual([])
  })

  it('normalizes and deduplicates known names without requiring the current character', () => {
    const result = splitReferenceTags(['Fixture A', 'fixture_a', 'fixture_(series)', 'catalog_character', 'white coat', 'white_coat'], {
      knownCharacterTags: ['fixture_a', 'fixture_(series)'],
      catalog: [{ en: 'catalog character', cat: 'Character' }],
    })
    expect(result.excludedIdentity).toEqual(['fixture_a', 'fixture_(series', 'catalog_character'])
    expect(result.tags).toEqual(['white_coat'])
  })

  it('covers species and permanent visual traits missing from the conflict domains', () => {
    const tags = ['elf', 'pointy_ears', 'animal_ears', 'fox_ears', 'cat_ears', 'fox_tail', 'tail', 'angel_wings', 'horns', 'halo',
      'dark_skin', 'pale_skin', 'heterochromia', 'star-shaped_eyes', 'slit_pupils', 'aqua_hair', 'teal_hair', 'curly_hair', 'freckles', 'mole_under_eye']
    const result = splitReferenceTags(tags)
    expect(result.tags).toEqual([])
    expect(result.uncertain).toEqual([])
    expect(result.excludedIdentity).toHaveLength(tags.length)
    expect(result.excludedIdentity).toContain('star_shaped_eyes')
  })

  it('keeps reliable garments even when legacy character exact tokens contain them', () => {
    const result = splitReferenceTags(['fixture_character', 'school_uniform', 'white_coat', 'hair_ribbon', 'cat_ear_headband'], {
      knownCharacterTags: ['fixture_character', 'school_uniform', 'white_coat', 'hair_ribbon', 'cat_ear_headband'],
    })
    expect(result.tags).toEqual(['school_uniform', 'white_coat', 'hair_ribbon', 'cat_ear_headband'])
    expect(result.excludedIdentity).toEqual(['fixture_character'])
  })

  it('retains explicit wearable animal motifs and ordinary reference clothes', () => {
    const tags = ['cat_ear_headband', 'rabbit_ears_headband', 'horned_helmet', 'wing_earrings', 'fox_tail_ribbon',
      'hair_ribbon', 'hairclip', 'hair_flower', 'glasses', 'crown', 'white_shirt', 'coat', 'boots', 'kimono']
    const result = splitReferenceTags(tags)
    expect(result.tags).toEqual(tags)
    expect(result.excludedIdentity).toEqual([])
    expect(result.uncertain).toEqual([])
  })

  it('does not trust Clothing as proof that species features are wearable', () => {
    const result = splitReferenceTags(['elf', 'angel_wings', 'halo', 'cat_ear_headband'], {
      catalog: ['elf', 'angel_wings', 'halo', 'cat_ear_headband'].map(en => ({ en, cat: 'Clothing' })),
    })
    expect(result.excludedIdentity).toEqual(['elf', 'angel_wings', 'halo'])
    expect(result.tags).toEqual(['cat_ear_headband'])
  })

  it('uses Appearance selectively and sends ambiguous Body entries for review', () => {
    const result = splitReferenceTags(['hair_ribbon', 'hair_blowing', 'bokeh', 'blue_hair', 'freckles', 'unknown_body_trait', 'wet_hair', 'water_droplets', 'bare_shoulders', 'backless'], {
      catalog: [
        ...['hair_ribbon', 'hair_blowing', 'bokeh', 'blue_hair'].map(en => ({ en, cat: 'Appearance' })),
        ...['freckles', 'unknown_body_trait', 'wet_hair', 'water_droplets', 'bare_shoulders', 'backless'].map(en => ({ en, cat: 'Body' })),
      ],
    })
    expect(result.tags).toEqual(['hair_ribbon', 'hair_blowing', 'bokeh', 'wet_hair', 'water_droplets', 'bare_shoulders', 'backless'])
    expect(result.excludedIdentity).toEqual(['blue_hair', 'freckles'])
    expect(result.uncertain).toEqual(['unknown_body_trait'])
  })

  it('preserves pose, camera, environment and temporary hair state', () => {
    const tags = ['sitting', 'sitting_on_chair', 'holding_cup', 'looking_at_viewer', 'closed_eyes', 'from_above', 'library',
      'white_background', 'rain', 'window_light', 'wet_hair', 'messy_hair', 'windblown_hair', 'red_ears']
    expect(splitReferenceTags(tags)).toEqual({ tags, excludedIdentity: [], uncertain: [] })
  })

  it('does not let free caption sentences or compound lists pass as atomic tags', () => {
    const prose = ['A woman with blue hair sits beside a window.', 'blue hair, white coat', 'She wears a coat',
      'blue_haired_girl_wearing_a_white_coat', 'long_blue_hair_and_white_shirt', 'a_person', 'sitting by the window',
      'A_blue_haired_woman', '坐在窗边', '<lora:fixture:1>', 'fixture_(unknown_series)']
    const result = splitReferenceTags([...prose, 'looking at viewer', '(blue_hair:1.2)', 'white coat'])
    expect(result.uncertain).toEqual(prose)
    expect(result.tags).toEqual(['looking_at_viewer', 'white_coat'])
    expect(result.excludedIdentity).toEqual(['blue_hair'])
  })

  it('is repeatable, keeps order and does not mutate its inputs', () => {
    const tags = Object.freeze(['blue_hair', 'sitting', ' sitting ', '', 'library'])
    const options = Object.freeze({ knownCharacterTags: Object.freeze(['fixture']), catalog: Object.freeze([{ en: 'blue_hair', cat: 'Appearance' }]) })
    const expected = { tags: ['sitting', 'library'], excludedIdentity: ['blue_hair'], uncertain: [] }
    expect(splitReferenceTags(tags, options)).toEqual(expected)
    expect(splitReferenceTags(tags, options)).toEqual(expected)
    expect(tags).toEqual(['blue_hair', 'sitting', ' sitting ', '', 'library'])
  })
})

it('withholds unfamiliar identity-shaped fields instead of treating an empty domain as permission', () => {
  const result = splitReferenceTags(['cerulean_hair', 'unfamiliar_eyes', 'feathered_skin', 'human', 'white_coat', 'closed_eyes'])
  expect(result.uncertain).toEqual(['cerulean_hair', 'unfamiliar_eyes', 'feathered_skin'])
  expect(result.excludedIdentity).toEqual(['human'])
  expect(result.tags).toEqual(['white_coat', 'closed_eyes'])
})
