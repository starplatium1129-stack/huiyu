/**
 * videoPromptProse.ts — 出图词条流 → 视频提示词自然语言（确定性转换，零依赖）。
 *
 * MiniMax H3 是自然语言模型，直接吃 Danbooru 词条流（1girl, red hair, …）
 * 语义碎片化、效果差。这里做「主体/外观语法化组装」：
 *   - 过滤质量/安全/评分类无意义词条（safe / score_9 / masterpiece …）
 *   - 剥离 Danbooru 权重括号（(masterpiece:1.2) → masterpiece）与整词括号，
 *     下划线 token 转空格（surtr_(arknights) → surtr (arknights)，与
 *     AGENTS.md「exactTokens 括号消歧按 Anima 空格规则」同向，避免 H3 收到下划线 token）
 *   - 主体计数词（1girl / solo …）与外观词（red hair / blue eyes …）
 *     组装进主句（a girl with red hair and blue eyes, …）
 *   - 其余词条（服装/场景/动作/角色标识）原样保留；tag 转译会引入错误语义。
 *   - 已像自然语言的提示词（Anima prose 等）原样返回，不误伤
 *   - 含 CJK 的输入（中文 story / 场景描述）原样返回——按 ASCII 逗号重拼会
 *     把「，」改写成「, 」造成标点残渣（2026-08-15 审计实锤）
 */

/** 出图提示词里对视频无语义的质量/安全/评分词条 */
const DROP_TAG = /^(safe|score_\d+|best quality|high quality|masterpiece|absurdres|highres|newest|ultra[- ]detailed|amateur|official art|rating:\S+|source:\S+)$/i

/** 主体计数词 → 自然语言短语 */
const SUBJECT_PHRASE: Record<string, string> = {
  '1girl': 'a girl',
  '2girls': 'two girls',
  '1boy': 'a boy',
  '2boys': 'two boys',
  '1woman': 'a woman',
  '1man': 'a man',
  'solo': 'solo',
  'no_humans': 'no humans',
}

/** CJK 与全角标点（含中文逗号）——命中即视为自然语言散文，禁止按 tag 重拼。 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/**
 * 逐 token 规范化：
 * 1. 剥 Danbooru 权重括号「(tag:1.2)」→ tag（masterpiece 等随后被 DROP_TAG 丢弃）；
 * 2. 剥一层整词包裹括号「(tag)」→ tag（权重剥完后仍整词包裹的强调括号）；
 * 3. 下划线 token → 空格（H3/Anima 都是空格规则的自然语言模型，下划线会当噪声）。
 */
function normalizeToken(token: string): string {
  let value = token.trim()
  // 权重括号必须最先剥：只剥贴在此 token 首尾、内容含「:数字」的那一对。
  value = value.replace(/^\((.+):\d+(?:\.\d+)?\)$/, '$1')
  // 整词包裹的强调括号（括号成对且包裹整个 token）剥一层。
  if (/^\(.+\)$/.test(value)
    && (value.match(/\(/g) || []).length === (value.match(/\)/g) || []).length) {
    value = value.slice(1, -1)
  }
  return value.replace(/_/g, ' ').trim()
}

function looksLikeTagStream(prompt: string): boolean {
  const tokens = prompt.split(',').map(token => token.trim()).filter(Boolean)
  if (tokens.length < 5) return false
  const hasSubject = tokens.some(token => Object.prototype.hasOwnProperty.call(SUBJECT_PHRASE, normalizeToken(token).toLowerCase()))
  if (hasSubject) return true
  const avgLength = tokens.reduce((sum, token) => sum + token.length, 0) / tokens.length
  return avgLength <= 25
}

/**
 * 词条流 → 视频提示词自然语言；已像自然语言的输入原样返回。
 * 例：safe, 1girl, solo, red hair, red eyes, techwear, dorm room
 *   → a girl with red hair and red eyes, solo, techwear, dorm room
 */
export function tagsToVideoProse(prompt: string): string {
  const input = String(prompt || '').trim()
  if (!input) return ''
  // CJK 散文（中文 story / 场景描述）原样返回：按逗号重拼会改写中文标点。
  if (CJK_RE.test(input)) return input
  if (!looksLikeTagStream(input)) return input

  const tokens = input.split(',').map(token => token.trim()).filter(Boolean)
  const kept: string[] = []
  let subject = ''
  let hair = ''
  let eyes = ''
  for (const token of tokens) {
    const normalized = normalizeToken(token)
    const lower = normalized.toLowerCase()
    if (!normalized) continue
    if (DROP_TAG.test(normalized)) continue
    if (Object.prototype.hasOwnProperty.call(SUBJECT_PHRASE, lower) && !subject) {
      subject = SUBJECT_PHRASE[lower]
      continue
    }
    if (/hair$/i.test(lower) && !hair) {
      hair = normalized
      continue
    }
    if (/eyes?$/i.test(lower) && !eyes) {
      eyes = normalized
      continue
    }
    kept.push(normalized)
  }

  const looks = [hair, eyes].filter(Boolean)
  const head = subject
    ? `${subject}${looks.length ? ' with ' + looks.join(' and ') : ''}`
    : looks.length ? `a figure with ${looks.join(' and ')}` : ''
  return [head, ...kept].filter(Boolean).join(', ')
}
