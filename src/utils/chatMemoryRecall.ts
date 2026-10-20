import type { ChatMemoryItem, ChatMemoryState } from './chatMemoryCore'

// Small, local vocabulary expansion. User-authored topics remain authoritative;
// this is lexical recall and never claims to understand contradictory facts.
const concepts = [
  ['生日', '生辰', 'birthday', '出生日期'],
  ['喜欢', '喜爱', '爱好', '偏好', '最爱', 'favorite', 'favourite', 'hobby'],
  ['讨厌', '不喜欢', '厌恶', 'dislike', 'hate'],
  ['工作', '职业', '上班', 'job', 'career'],
  ['住址', '居住', '住在', '家乡', 'address', 'hometown'],
  ['过敏', '忌口', '不能吃', 'allergy', 'allergic'],
  ['称呼', '名字', '姓名', '叫我', 'name', 'nickname'],
  ['约定', '承诺', '答应', 'promise'],
] as const
const stopWords = new Set(['什么', '怎么', '知道', '记得', '可以', '这个', '那个', '我们', '你们', '的是', '我的', '你的', 'the', 'and', 'you', 'what', 'that'])
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

function terms(value: string): Set<string> {
  const text = value.normalize('NFKC').toLocaleLowerCase().slice(0, 1200)
  const result = new Set<string>()
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike && segment.segment.length > 1 && !stopWords.has(segment.segment)) result.add(segment.segment)
  }
  for (const sequence of text.match(/[\u3400-\u9fff]+/g) || []) {
    for (let index = 0; index < sequence.length - 1; index++) {
      const term = sequence.slice(index, index + 2)
      if (!stopWords.has(term)) result.add(term)
    }
  }
  concepts.forEach((words, index) => { if (words.some(word => text.includes(word))) result.add(`concept:${index}`) })
  return result
}

export interface RecalledChatFact {
  item: ChatMemoryItem
  matched: string[]
  score: number
}

export function rankChatFacts(state: ChatMemoryState, character: string, query: string): RecalledChatFact[] {
  const queryTerms = terms(query)
  const latest = new Map<string, ChatMemoryItem>()
  for (const item of state.byCharacter[character] || []) {
    const key = item.topic?.normalize('NFKC').trim().toLocaleLowerCase() || item.id
    const previous = latest.get(key)
    if (!previous || item.updatedAt > previous.updatedAt || item.updatedAt === previous.updatedAt && item.id > previous.id) latest.set(key, item)
  }
  const candidates = [...latest.values()].map(item => ({ item, terms: terms(`${item.topic || ''} ${item.text}`) }))
  const frequency = new Map<string, number>()
  candidates.forEach(candidate => candidate.terms.forEach(term => frequency.set(term, (frequency.get(term) || 0) + 1)))
  return candidates.map(candidate => {
    const matched = [...queryTerms].filter(term => candidate.terms.has(term))
    const score = matched.reduce((sum, term) => sum + Math.log(1 + candidates.length / (frequency.get(term) || 1)), 0)
      / Math.sqrt(Math.max(1, candidate.terms.size))
    return { item: candidate.item, matched, score }
  }).filter(candidate => candidate.matched.length)
    .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id))
}

export function selectChatFacts(state: ChatMemoryState, character: string, query: string, limit = 4, budget = 1000): RecalledChatFact[] {
  const out: RecalledChatFact[] = []
  let used = 0
  for (const candidate of rankChatFacts(state, character, query)) {
    const { item } = candidate
    if (out.length >= Math.max(0, limit)) break
    const text = item.topic ? `【${item.topic}】${item.text}` : item.text
    if (used + text.length > budget) continue
    out.push(candidate)
    used += text.length
  }
  return out
}
export function recallChatFacts(state: ChatMemoryState, character: string, query: string, limit = 4, budget = 1000): string[] {
  return selectChatFacts(state, character, query, limit, budget).map(({item}) => item.topic ? `【${item.topic}】${item.text}` : item.text)
}
