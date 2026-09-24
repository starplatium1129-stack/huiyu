import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { createPromptPlan, renderPromptPlan } = require('../../src/utils/promptCompiler.ts')
const { renderPromptPlan: renderCorePlan } = require('../../src/utils/promptCompilerCore.ts')
const { escapeKnownLiteralTags, escapeLiteralTagParentheses } = require('../../src/utils/promptLiteralTags.ts')
const kaltsit = "kal'tsit (arknights)"

for (const name of [kaltsit, 'ciel_(tsukihime)', 'rem (re:zero)', 'medea_(caster)_(fate)', 'a$&_name (series)']) {
  test(`literal name is escaped exactly once: ${name}`, () => {
    const escaped = escapeLiteralTagParentheses(name)
    assert.equal(escapeKnownLiteralTags(name, [name]), escaped)
    assert.equal(escapeKnownLiteralTags(escaped, [name]), escaped)
    assert.equal(escapeKnownLiteralTags(escaped, [escaped]), escaped)
  })
}

test('outer weights, plain emphasis, unregistered text, BREAK and scores retain their meaning', () => {
  const text = `(${kaltsit}:1.2), (soft_lighting:1.3), (smile), score_7 BREAK other (series)`
  const expected = `(${escapeLiteralTagParentheses(kaltsit)}:1.2), (soft_lighting:1.3), (smile), score_7 BREAK other (series)`
  assert.equal(escapeKnownLiteralTags(text, [kaltsit, '(smile)', '(soft_lighting:1.3)']), expected)
  assert.equal(escapeKnownLiteralTags(`prefix_${kaltsit}`, [kaltsit]), `prefix_${kaltsit}`)
})

test('actual compiler protects character names without rewriting source tags or captions', () => {
  const plan = createPromptPlan({ identity: `${kaltsit}, 1girl, arknights`, exactTokens: [kaltsit],
    manual: ['(soft_lighting:1.2)'], subjectProse: "Kal'tsit from Arknights, the medical director." })
  const original = JSON.stringify(plan)
  const rendered = renderPromptPlan(plan, 'anima')
  assert.ok(rendered.prompt.startsWith(escapeLiteralTagParentheses(kaltsit)))
  assert.ok(rendered.prompt.includes('(soft lighting:1.2)'))
  assert.equal(rendered.prompt.split('\n').slice(1).join('\n'), renderCorePlan(plan, 'anima').prompt.split('\n').slice(1).join('\n'))
  assert.equal(rendered.prompt.split('\n')[0].split(', ').filter(tag => tag === 'arknights').length, 1)
  assert.equal(JSON.stringify(plan), original)
  assert.equal(JSON.parse(JSON.stringify({ prompt: rendered.prompt })).prompt, rendered.prompt)
})

test('character aliases outside exactTokens are also protected', () => {
  const plan = createPromptPlan({ identity: 'kazusa (blue archive), blue_archive', controls: ['kyouyama_kazusa'], exactTokens: ['kyouyama_kazusa'] })
  assert.ok(renderPromptPlan(plan, 'anima').prompt.includes('kazusa \\(blue archive\\)'))
})

test('already escaped exact tokens retain underscore spelling', () => {
  const name = 'ciel_(tsukihime)'
  const escaped = escapeLiteralTagParentheses(name)
  const plan = createPromptPlan({ identity: escaped, exactTokens: [name] })
  assert.equal(renderPromptPlan(plan, 'anima').prompt, escaped)
})

test('Krea and SD core contracts are unchanged', () => {
  const plan = createPromptPlan({ identity: `${kaltsit}, 1girl`, subjectProse: "Kal'tsit from Arknights." })
  for (const engine of ['krea2', 'sd']) assert.deepEqual(renderPromptPlan(plan, engine), renderCorePlan(plan, engine))
})

test('studio anchors, score spelling and already escaped artists are unchanged', () => {
  const plan = createPromptPlan({ identity: 'ayachi_nene, 1girl', controls: ['nene_witch_canonical'],
    exactTokens: ['ayachi_nene', 'nene_witch_canonical'], artists: ['@hiten \\(hitenkei\\)'], manual: ['score_7'] })
  assert.deepEqual(renderPromptPlan(plan, 'anima'), renderCorePlan(plan, 'anima'))
})

const directory = new URL('../../data/popular/', import.meta.url)
const characters = readdirSync(directory).filter(file => file.endsWith('.json')).sort().flatMap(file => {
  const shard = JSON.parse(readFileSync(new URL(file, directory), 'utf8'))
  return Array.isArray(shard.characters) ? shard.characters : []
})
assert.ok(characters.length > 0)
for (const character of characters) {
  test(`catalogue identity compiles without raw name parentheses: ${character.id}`, () => {
    const literals = [...character.identityTokens, ...(character.exactTokens || [])]
    const plan = createPromptPlan({ identity: character.identityTokens.join(', '), controls: character.exactTokens || [], exactTokens: character.exactTokens || [] })
    const result = renderPromptPlan(plan, 'anima').prompt
    // Existing deduplication can choose a space alias over an underscore exact alias.
    // Compare with the actual old tag stream, rather than demanding every raw alias survive.
    const baseline = renderCorePlan(plan, 'anima').prompt
    const expected = baseline.replace(/[()]/g, '\\$&')
    assert.equal(result, expected)
    assert.equal(escapeKnownLiteralTags(result, literals), result)
  })
}

const { buildPopularPromptPlan, parsePopularCharacter, defaultOutfit } = require('../../src/utils/popularContent.ts')
for (const source of characters) {
  test(`popular builder keeps identity/caption boundaries for both engines: ${source.id}`, () => {
    const character = parsePopularCharacter(source)
    assert.ok(character)
    const original = JSON.stringify(character)
    for (const engine of ['anima', 'krea2']) {
      const result = buildPopularPromptPlan({ character, outfit: defaultOutfit(character), blueprint: null, engine })
      assert.ok(result)
      const baseline = renderCorePlan(result.plan, engine)
      const [tags, ...caption] = baseline.prompt.split('\n')
      const expected = engine === 'anima' ? [tags.replace(/[()]/g, '\\$&'), ...caption].join('\n') : baseline.prompt
      assert.equal(result.prompt, expected)
    }
    assert.equal(JSON.stringify(character), original)
  })
}

// Execute the actual submit function with isolated upload/model/FileReader boundaries.
// No Vue app, HTTP endpoint, GPU or model is invoked by these request-construction checks.
const { stripTypeScriptTypes } = require('node:module')
const inpaintSource = stripTypeScriptTypes(readFileSync(new URL('../../src/composables/generation/animaInpaintSubmit.ts', import.meta.url), 'utf8'))
  .replace(/^import[^\n]+\n/gm, '')
  .replace('export async function submitAnimaInpaint', 'async function submitAnimaInpaint')
const inpaintFactory = new Function('resolveInpaintRequestBinding', 'apiClient', 'escapeKnownLiteralTags', 'FileReader',
  `${inpaintSource}\nreturn submitAnimaInpaint`)
for (const scenario of ['raw popular identity', 'already escaped popular identity', 'studio LoRA identity']) {
  test(`inpaint request preserves literal names and outfit weights: ${scenario}`, async () => {
    const requests = []
    const popular = scenario !== 'studio LoRA identity'
    const identity = scenario === 'already escaped popular identity' ? escapeLiteralTagParentheses(kaltsit) : kaltsit
    class FakeReader {
      readAsDataURL() { this.result = 'data:image/png;base64,fixture'; this.onload() }
    }
    const submit = inpaintFactory(
      () => ({ modelId: 'fixture-anima', character: popular ? 'none' : 'nene', loraId: null, width: 832, height: 1216 }),
      { request: async () => ({ ok: true, name: 'fixture.png' }) }, escapeKnownLiteralTags, FakeReader)
    await submit({ newOutfitPrompt: '(blue_coat:1.2), (soft lighting)', negativePrompt: 'bad hands', imageBlob: {} }, {
      pb: { flash() {} }, animaState: { value: { width: 832, height: 1216, models: [], modelId: 'fixture-anima', loraStrength: 1 } },
      displayResultUrl: { value: 'fixture://previous' }, generateAnima: async request => requests.push(request),
      isPopular: { value: popular }, popularIdentityTokens: { value: [identity, 'arknights'] },
      inpaintOpen: { value: true }, inpaintOriginalUrl: { value: null }, inpaintCompareActive: { value: false },
      inpaintCharacter: { value: popular ? null : 'nene' },
    })
    assert.equal(requests.length, 1)
    const prefix = popular ? `${escapeLiteralTagParentheses(kaltsit)}, arknights` : 'ayachi_nene'
    assert.equal(requests[0].prompt, `${prefix}, (blue_coat:1.2), (soft lighting)`)
    assert.equal(requests[0].character, popular ? 'none' : 'nene')
  })
}
