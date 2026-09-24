import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../../', import.meta.url)
const directory = new URL('data/popular/', root)
const characters = readdirSync(directory).filter(name => name.endsWith('.json')).sort().flatMap(file => {
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
console.log(JSON.stringify(report, null, 2))
console.log(`Catalogue audit written to ${fileURLToPath(outputDirectory)}`)
