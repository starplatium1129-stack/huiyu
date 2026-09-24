import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../../', import.meta.url)
const directory = new URL('data/popular/', root)
const files = readdirSync(directory).filter(name => name.endsWith('.json')).sort()
const characters = files.flatMap(file => {
  const data = JSON.parse(readFileSync(new URL(file, directory), 'utf8'))
  return (Array.isArray(data.characters) ? data.characters : []).map(character => ({
    file, id: character.id, displayName: character.displayName, franchise: character.franchise,
    identityTokens: character.identityTokens, exactTokens: character.exactTokens || [],
  }))
})
assert.ok(characters.length > 0, 'The popular character catalogue must not be empty')
assert.equal(new Set(characters.map(character => character.id)).size, characters.length, 'Duplicate character IDs')
const report = {
  characterCount: characters.length,
  franchiseCount: new Set(characters.map(character => character.franchise)).size,
  characters,
}
const outputDirectory = new URL('runtime/character-tag-audit/', root)
mkdirSync(outputDirectory, { recursive: true })
writeFileSync(new URL('catalogue.json', outputDirectory), JSON.stringify(report, null, 2) + '\n')
// Retain the exact public source inputs so this audit is reproducible offline.
// No environment variables, credentials, generated media or production files.
const sourcePaths = [
  ...files.map(file => `data/popular/${file}`),
  ...readdirSync(new URL('src/utils/', root)).filter(file => file.endsWith('.ts')).map(file => `src/utils/${file}`),
  'src/config/artistStyles.ts', 'src/config/promptConstants.ts',
  'src/composables/generation/useAnimaInpaint.ts',
  'scripts/tests/test-prompt-policy.ts', 'scripts/tests/test-prompt-compiler.ts',
  'scripts/tests/monolith-baseline.json',
  'docs/workflow.md', 'docs/engineering-contracts.md',
  '.agents/skills/studio-prompt-craft/references/anima.md',
]
const sources = Object.fromEntries(sourcePaths.map(path => [path, readFileSync(new URL(path, root), 'utf8')]))
writeFileSync(new URL('sources.json', outputDirectory), JSON.stringify(sources) + '\n')
console.log(JSON.stringify(report, null, 2))
console.log(`Catalogue audit written to ${fileURLToPath(outputDirectory)}`)
