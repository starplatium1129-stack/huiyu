const { test }: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const { spawnSync }: typeof import('node:child_process') = require('node:child_process')
const toolFile = path.join(__dirname, 'extract-wd14-untranslated' + path.extname(__filename))
const { extractCoverage }: typeof import('./extract-wd14-untranslated') = require(toolFile)
const { resolveTagMeaning }: typeof import('../../src/utils/tagMeaning.ts') = require('../../src/utils/tagMeaning.ts')

test('current dictionaries and weighted aliases count as covered; partial and preposition fallbacks remain candidates', () => {
  const tags = ['headpat', '1girl', 'symbol_shaped_pupils', 'standing_on_tiptoe', '(DOF:+1.25)', 'mystery_shirt', 'happy_on_fixture']
  const characterTags = ["(jeanne_d'arc_alter_(fate):0.85)", 'fixture_character_(series)']
  const sample = { engine: 'pixai', tags, characterTags }
  const original = JSON.stringify(sample)
  const report = extractCoverage(original, 'json')
  assert.deepEqual(report.totals, { general: { full: 5, partial: 1, english: 1 }, character: { full: 1, partial: 0, english: 1 } })
  assert.deepEqual(report.general, [
    { tag: 'happy_on_fixture', count: 1, meaning: 'Happy On Fixture', coverage: 'english' },
    { tag: 'mystery_shirt', count: 1, meaning: 'mystery · 衬衫', coverage: 'partial' },
  ])
  assert.equal(report.character[0].tag, 'fixture_character_(series)')
  assert.equal(resolveTagMeaning('fixture', '官方 CG').coverage, 'full')
  assert.equal(resolveTagMeaning('fixture', 'Custom English').coverage, 'english')
  assert.equal(JSON.stringify(sample), original)
})

test('saved JSONL uses sample frequency and CSV keeps Danbooru counts without rewriting local input', t => {
  const runtime = path.resolve(__dirname, '../../runtime')
  fs.mkdirSync(runtime, { recursive: true })
  const root = fs.mkdtempSync(path.join(runtime, 'untranslated-tags-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const lines = [
    { engine: 'pixai', tags: ['rare_fixture', 'repeated_fixture', 'mystery_shirt'], characterTags: ['fixture_character'], scores: { rare_fixture: 0.99, repeated_fixture: 0.3 } },
    { engine: 'pixai', tags: ['repeated_fixture', 'headpat'], characterTags: ['fixture_character'], scores: { repeated_fixture: 0.4 } },
  ].map(sample => JSON.stringify(sample)).join('\n')
  const input = path.join(root, 'results.jsonl')
  fs.writeFileSync(input, lines)
  const run = spawnSync(process.execPath, [
    ...(toolFile.endsWith('.ts') ? ['--experimental-transform-types'] : []),
    toolFile, '--input', input, '--general-top', '1', '--character-top', '1', '--json',
  ], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const report = JSON.parse(run.stdout)
  assert.equal(report.frequency, 'sample-occurrences')
  assert.deepEqual(report.totals.general, { full: 1, partial: 1, english: 2 })
  assert.equal(report.general[0].tag, 'repeated_fixture')
  assert.equal(report.general[0].count, 2)
  assert.equal(report.character[0].count, 2)
  assert.equal(fs.readFileSync(input, 'utf8'), lines)

  const csv = 'tag_id,name,category,count\n1,headpat,0,1000\n2,mystery_shirt,0,80\n3,happy_on_fixture,0,100\n4,fixture_character_(series),4,75\n5,general,9,900\n'
  const legacy = extractCoverage(csv, 'csv')
  assert.equal(legacy.frequency, 'danbooru-count')
  assert.deepEqual(legacy.general.map(row => [row.tag, row.count, row.coverage]), [
    ['happy_on_fixture', 100, 'english'], ['mystery_shirt', 80, 'partial'],
  ])
  assert.equal(legacy.character[0].count, 75)
})
