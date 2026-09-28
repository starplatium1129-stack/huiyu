import { describe, expect, it } from 'vitest'
import { buildGeneratedSceneDraft, parseGeneratedRecipe } from './generatedSceneDraft'
import { parseSceneBlueprint } from './popularContent'
import type { HistoryEntry } from '@/types/promptHistory'
import type { PopularCharacter } from '@/types/character'
import { buildPopularPromptPlan } from './popularPromptBuilder'
import { createPromptPlan, renderPromptPlan } from './promptCompiler'

const details = { id: 'sc999', title: '雨后窗边', story: '她望向雨后的街道。', rating: 'All' as const }
const actual = '1girl, (quiet window, rain:1.2)\nShe watches the rain.'
const source = (overrides: Partial<HistoryEntry> = {}) => ({ recipe: { engine: 'anima' as const,
  subject: 'studio' as const, character: 'nene', prompt: actual, negative: overrides.engine === 'krea2' ? '' : 'text, watermark',
  seed: 42, size: '832x1216', ...overrides } })

describe('generated scene drafts', () => {
  it.each(['nene', 'natsume', 'triad'])('keeps %s actual prompt and independently copies parameters', char => {
    const input = source({ character: char, emotion: ['calm'], image_url: 'private-image', loras: [{ id: 'selected', strength: 0.7 }] })
    const result = buildGeneratedSceneDraft(input, details)
    expect(result.kind).toBe('scene')
    if (result.kind !== 'scene') throw new Error('scene expected')
    const provenance = parseGeneratedRecipe(result.draft.generatedRecipe)
    expect(result.draft.prompt).toBe(actual)
    expect(result.draft.negative).toBe('text, watermark')
    expect(result.draft.character).toEqual(char === 'triad' ? ['nene', 'natsume'] : [char])
    expect(provenance.parameters).not.toHaveProperty('image_url')
    expect(provenance.parameters).not.toHaveProperty('prompt')
    input.recipe.emotion?.push('changed')
    expect(provenance.parameters.emotion).toEqual(['calm'])
    expect(provenance.parameters.loras).toEqual([{ id: 'selected', strength: 0.7 }])
  })

  it.each(['sd', 'anima', 'krea2'] as const)('maps %s popular request once into its engine field', engine => {
    const result = buildGeneratedSceneDraft(source({ engine, subject: 'popular', characterId: 'example', outfitId: 'raincoat', negative: '' }),
      { ...details, id: 'bp_saved', compositionIntent: 'group' })
    expect(result.kind).toBe('blueprint')
    if (result.kind !== 'blueprint') throw new Error('blueprint expected')
    expect(result.draft.outfitId).toBe('raincoat')
    expect(result.draft.compositionIntent).toBe('group')
    expect(result.draft.promptProse).toBe(engine === 'krea2' ? actual : '')
    expect(result.draft.promptTokens).toEqual(engine === 'krea2' ? [] : [actual])
    expect(parseSceneBlueprint(result.draft)?.generatedRecipe?.prompt).toBe(actual)
  })

  it('requires completed prompt, recorded engine, known studio identity and popular outfit', () => {
    expect(() => buildGeneratedSceneDraft(source({ prompt: '' }), details)).toThrow()
    expect(() => buildGeneratedSceneDraft(source({ engine: undefined }), details)).toThrow()
    expect(() => buildGeneratedSceneDraft(source({ character: 'unknown' }), details)).toThrow()
    expect(() => buildGeneratedSceneDraft(source({ subject: 'popular', characterId: 'example' }), details)).toThrow()
    expect(() => buildGeneratedSceneDraft(source({ size: undefined }), details)).toThrow()
  })

  it('refuses a saved blueprint whose engine fields disagree with its provenance', () => {
    const result = buildGeneratedSceneDraft(source({ subject: 'popular', characterId: 'example', outfitId: 'raincoat' }), { ...details, id: 'bp_saved' })
    if (result.kind !== 'blueprint') throw new Error('blueprint expected')
    expect(() => parseSceneBlueprint({ ...result.draft, promptProse: 'silently changed' })).toThrow('不一致')
  })

  it('keeps Krea negative empty without copying another engine default', () => {
    expect(() => buildGeneratedSceneDraft(source({ engine: 'krea2', negative: 'old panel default' }), details)).toThrow()
    const result = buildGeneratedSceneDraft(source({ engine: 'krea2', negative: '' }), details)
    expect(parseGeneratedRecipe(result.draft.generatedRecipe).negative).toBe('')
    expect(() => parseGeneratedRecipe({ version: 1, engine: 'krea2', prompt: actual, negative: 'invalid', parameters: {} })).toThrow()
  })

  it.each(['anima', 'krea2'] as const)('retains a concrete event through the %s popular compiler', engine => {
    const prompt = engine === 'anima' ? '1girl, raincoat, window, rain\nShe watches the rain.' : 'A woman in a raincoat watches the rain beside a window.'
    const result = buildGeneratedSceneDraft(source({ engine, prompt, subject: 'popular', characterId: 'example', outfitId: 'raincoat' }), { ...details, id: 'bp_saved' })
    if (result.kind !== 'blueprint') throw new Error('blueprint expected')
    const outfit = { id: 'raincoat', name: 'Raincoat', prose: 'a raincoat', tokens: ['raincoat'], default: true }
    const character: PopularCharacter = { id: 'example', displayName: 'Example', originalName: 'Example', franchise: 'fixture',
      aliases: [], identityProse: 'An adult woman with brown hair', identityTokens: ['1girl', 'brown_hair'], exactTokens: [], exactPrefixes: [],
      recommendedEngine: engine, supportedEngines: [engine], adultEligibility: 'adult', outfits: [outfit] }
    const compiled = buildPopularPromptPlan({ engine, character, outfit, blueprint: result.draft, adultEnabled: false })
    expect(compiled?.prompt).toMatch(/watches the rain/i)
    expect(compiled?.prompt).toMatch(/raincoat/i)
    if (engine === 'krea2') expect(compiled?.negative).toBe('')
    expect(compiled?.prompt).not.toBe(prompt)
  })

  it('retains a Krea studio event when the reusable scene is compiled again', () => {
    const prompt = 'An adult woman in a raincoat watches the rain beside a window.'
    const result = buildGeneratedSceneDraft(source({ engine: 'krea2', prompt }), details)
    if (result.kind !== 'scene') throw new Error('scene expected')
    const plan = createPromptPlan({ identity: '1girl, brown_hair', scenePrompt: result.draft.prompt, scene: result.draft })
    expect(renderPromptPlan(plan, 'krea2').prompt).toMatch(/watches the rain/i)
  })
})
