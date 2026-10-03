/**
 * Offline glossary coverage for saved PixAI results or a WD14 frequency CSV.
 * node scripts/tests/extract-wd14-untranslated.js --input <JSON|JSONL|CSV>
 *   [--general-top 300] [--character-top 80] [--json]
 * Legacy generalTop/characterTop arguments and AICS_WD14_MODEL_DIR remain supported.
 * Reads only; English fallbacks and partial glosses remain translation candidates.
 */
const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const { resolveTagMeaning }: typeof import('../../src/utils/tagMeaning.ts') = require('../../src/utils/tagMeaning.ts')

type Coverage = ReturnType<typeof resolveTagMeaning>['coverage']
type Category = 'general' | 'character'
interface TagRow { tag: string; count: number; meaning: string; coverage: Coverage }
interface CoverageCounts { full: number; partial: number; english: number }
interface CoverageReport {
  source: 'pixai' | 'wd14-csv'
  frequency: 'sample-occurrences' | 'danbooru-count'
  totals: Record<Category, CoverageCounts>
  general: TagRow[]
  character: TagRow[]
}

function extractCoverage(input: string, format: 'json' | 'jsonl' | 'csv', generalTop = 300, characterTop = 80): CoverageReport {
  const rows: Record<Category, Map<string, number>> = { general: new Map(), character: new Map() }
  const add = (category: Category, tag: string, count: number) => {
    rows[category].set(tag, (rows[category].get(tag) || 0) + count)
  }
  if (format === 'csv') {
    const skip = new Set(['general', 'sensitive', 'questionable', 'explicit'])
    for (const line of input.trim().split(/\r?\n/).slice(1)) {
      // WD14 CSV quotes tags that contain commas; do not split inside those names.
      const columns = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map(value => value.replace(/^"|"$/g, '').replace(/""/g, '"'))
      const [, tag, category, rawCount] = columns
      if (!tag || skip.has(tag) || (category !== '0' && category !== '4')) continue
      const count = Number(rawCount)
      if (!Number.isFinite(count) || count < 0) throw new Error(`无效 WD14 频次：${tag}`)
      add(category === '0' ? 'general' : 'character', tag, count)
    }
  } else {
    const parsed: unknown = format === 'jsonl'
      ? input.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      : JSON.parse(input.replace(/^\uFEFF/, ''))
    const samples = Array.isArray(parsed) ? parsed : [parsed]
    for (const sample of samples) {
      if (!sample || typeof sample !== 'object') throw new Error('输入必须为 PixAI 本地结果或结果数组')
      const result = sample as Record<string, unknown>
      if (result.engine !== 'pixai') throw new Error('输入必须为 PixAI 本地结果或结果数组')
      for (const [category, values] of [['general', result.tags], ['character', result.characterTags]] as const) {
        if (!Array.isArray(values) || values.some(tag => typeof tag !== 'string' || !tag.trim())) throw new Error(`PixAI ${category} 词条无效`)
        // The number of samples containing a tag is frequency; scores are confidence.
        for (const tag of new Set<string>(values)) add(category, tag, 1)
      }
    }
  }
  const totals: Record<Category, CoverageCounts> = {
    general: { full: 0, partial: 0, english: 0 }, character: { full: 0, partial: 0, english: 0 },
  }
  const candidates = (category: Category, top: number) => [...rows[category]]
    .map(([tag, count]) => {
      const result = resolveTagMeaning(tag)
      totals[category][result.coverage]++
      return { tag, count, ...result }
    })
    .filter(row => row.coverage !== 'full')
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, top)
  return {
    source: format === 'csv' ? 'wd14-csv' : 'pixai',
    frequency: format === 'csv' ? 'danbooru-count' : 'sample-occurrences',
    totals, general: candidates('general', generalTop), character: candidates('character', characterTop),
  }
}

function main(args = process.argv.slice(2)): number {
  try {
    let inputFile = ''
    let generalTop = 300
    let characterTop = 80
    let json = false
    let positional = 0
    const count = (value: string | undefined) => {
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('top 必须为非负整数')
      return Number(value)
    }
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === '--input') {
        inputFile = args[++index]
        if (!inputFile || inputFile.startsWith('--')) throw new Error('--input 缺少本地文件路径')
      } else if (arg === '--general-top') generalTop = count(args[++index])
      else if (arg === '--character-top') characterTop = count(args[++index])
      else if (arg === '--json') json = true
      else if (arg === '--help') {
        console.log('node scripts/tests/extract-wd14-untranslated.js --input <PixAI JSON|JSONL|WD14 CSV> [--general-top 300] [--character-top 80] [--json]')
        return 0
      } else if (/^\d+$/.test(arg) && positional < 2) {
        if (positional++ === 0) generalTop = count(arg)
        else characterTop = count(arg)
      } else throw new Error(`未知参数：${arg}`)
    }
    if (!inputFile && process.env.AICS_WD14_MODEL_DIR) {
      const modelDir = process.env.AICS_WD14_MODEL_DIR
      inputFile = fs.readdirSync(modelDir).filter(file => /\.onnx$/i.test(file))
        .map(file => path.join(modelDir, file.slice(0, -5) + '.csv')).find(file => fs.existsSync(file)) || ''
    }
    if (!inputFile) throw new Error('请用 --input 指定本地 PixAI 结果，或设置 AICS_WD14_MODEL_DIR')
    const extension = path.extname(inputFile).toLowerCase()
    if (!['.csv', '.json', '.jsonl'].includes(extension)) throw new Error('输入仅支持 JSON、JSONL 或 CSV')
    const report = extractCoverage(fs.readFileSync(inputFile, 'utf8'), extension.slice(1) as 'csv' | 'json' | 'jsonl', generalTop, characterTop)
    if (json) console.log(JSON.stringify(report))
    else {
      console.log(`频次来源：${report.frequency === 'sample-occurrences' ? '本地样本出现次数' : 'Danbooru 词表出现次数'}`)
      for (const category of ['general', 'character'] as const) {
        const summary = report.totals[category]
        console.log(`=== ${category} · 完整中文 ${summary.full} / 部分中文 ${summary.partial} / 英文回退 ${summary.english} ===`)
        report[category].forEach(row => console.log(`${row.tag}  #${row.count}  [${row.coverage}] ${row.meaning}`))
      }
    }
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (require.main === module) process.exitCode = main()
export = { extractCoverage, main }
