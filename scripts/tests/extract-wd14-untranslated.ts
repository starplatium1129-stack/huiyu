/**
 * 提取 WD14 词表中尚未收录中文释义的高频词（按 Danbooru 出现次数排序）。
 *
 * 用途：扩充 src/utils/tagMeaningZh.ts 的下一批词条。
 *   node scripts/tests/extract-wd14-untranslated.js [generalTop] [characterTop]
 *
 * 输出两段：general 高频 / character 高频，人工翻译后追加进
 * tagMeaningZh.ts 的 WD14_ZH（键为 cleanTag 归一形式：小写、连字符转下划线、
 * 整词括号保留，如 jeanne_d'arc_alter_(fate)）。
 */
const fs: typeof import('fs') = require('fs')

const WD14_CSV = process.env.AICS_WD14_MODEL_DIR
  ? fs.readdirSync(process.env.AICS_WD14_MODEL_DIR)
      .filter(f => /\.onnx$/i.test(f))
      .map(base => (require('path') as typeof import('path')).join(process.env.AICS_WD14_MODEL_DIR, base.slice(0, -5) + '.csv'))
      .find(p => fs.existsSync(p))
  : 'E:/code/2/lora/AI/ComfyUI/custom_nodes/ComfyUI-WD14-Tagger/models/wd-v1-4-moat-tagger-v2.csv'
if (!WD14_CSV || !fs.existsSync(WD14_CSV)) { console.error('找不到 WD14 CSV，请设置 AICS_WD14_MODEL_DIR'); process.exit(1) }

function loadDicts() {
  const files = ['src/utils/tagMeaning.ts', 'src/utils/tagMeaningZh.ts']
  const dicts = []
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    for (const name of ['EXACT_MEANINGS', 'WORD_MEANINGS', 'WD14_ZH']) {
      const m = src.match(new RegExp('const ' + name + ': Record<string, string> = \\{([\\s\\S]*?)\\n\\}'))
      if (!m) continue
      const dict: any = {}
      for (const line of m[1].split('\n')) {
        for (const pair of line.split(',')) {
          const kv = pair.match(/^\s*(?:'([^']*)'|"([^"]*)"|([a-z0-9_+]+)):\s*'([^']*)'/)
          if (kv) dict[kv[1] || kv[2] || kv[3]] = kv[4]
        }
      }
      dicts.push(dict)
    }
  }
  return dicts
}
const [EXACT, WORD, WD14]: any = loadDicts()

function cleanTag(t: string) {
  let raw = String(t || '').trim()
  if (/^\(.+\)$/.test(raw)) raw = raw.replace(/^\(+|\)+$/g, '')
  return raw.toLowerCase().replace(/[\s\-/]+/g, '_')
}
function known(tag: string) {
  const n = cleanTag(tag)
  if (EXACT[n] || WORD[n] || WD14[n]) return true
  const words = n.split('_').filter(Boolean)
  return words.some(w => WORD[w] || WD14[w])
}

const SKIP = new Set(['general', 'sensitive', 'questionable', 'explicit'])
const lines = fs.readFileSync(WD14_CSV, 'utf8').split(/\r?\n/).filter(Boolean)
const general = []
const character = []
for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split(',')
  const name = parts[1] || ''
  const cat = parts[2]
  const count = Number(parts[3]) || 0
  if (!name || SKIP.has(name) || known(name)) continue
  if (cat === '0') general.push({ name, count })
  else if (cat === '4') character.push({ name, count })
}
const byCount = (a: { count: number; }, b: { count: number; }) => b.count - a.count
general.sort(byCount)
character.sort(byCount)
const takeGeneral = Number(process.argv[2] || 300)
const takeCharacter = Number(process.argv[3] || 80)
console.log('=== general top', takeGeneral, '===')
general.slice(0, takeGeneral).forEach(g => console.log(`${g.name}  #${g.count}`))
console.log('=== character top', takeCharacter, '===')
character.slice(0, takeCharacter).forEach(c => console.log(`${c.name}  #${c.count}`))
