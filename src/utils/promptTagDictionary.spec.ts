import { expect, it } from 'vitest'
import { createPromptTagDictionary, matchesPromptTag } from './promptTagDictionary'

const catalog = [
  { en: 'depth_of_field', cn: '景深', cat: 'Camera', aliases: ['dof'] },
  { en: 'close-up', cn: '特写', cat: 'Camera', aliases: ['portrait'] },
  { en: 'face_focus', cn: '特写', cat: 'Camera', aliases: ['portrait'] },
]
it('resolves canonical IDs, Chinese labels and aliases without losing weights or custom syntax', () => {
  const dictionary = createPromptTagDictionary(catalog)
  expect(dictionary.canonicalize('景深')).toBe('depth_of_field')
  expect(dictionary.canonicalize('Depth Of Field')).toBe('depth_of_field')
  expect(dictionary.canonicalize('(dof:1.25)')).toBe('(depth_of_field:1.25)')
  for (const raw of ['<lora:My_Model:0.8>', 'BREAK', '(custom_artist:1.2)', 'close-up', '特写', 'portrait']) {
    expect(dictionary.canonicalize(raw)).toBe(raw)
  }
})
it('canonical entries win over colliding aliases and ambiguous Chinese remains searchable', () => {
  const dictionary = createPromptTagDictionary([...catalog, { en: 'portrait', cat: 'Camera' }])
  expect(dictionary.canonicalize('portrait')).toBe('portrait')
  expect(catalog.filter(tag => matchesPromptTag(tag, '特写'))).toHaveLength(2)
  expect(matchesPromptTag(catalog[0], 'depth field')).toBe(true)
  expect(matchesPromptTag(catalog[0], 'dof')).toBe(true)
})
