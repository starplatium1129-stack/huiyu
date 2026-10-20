import { normalizeKey } from './promptPrimitives'

// Conservative adoption heuristics, not calibrated accuracy guarantees.
const MIN_WINNING_SCORE = 0.6
const MIN_SCORE_GAP = 0.2
const COUNT = /^([1-9]\d*)(\+?)(girls?|boys?|others?|people)$/
const MULTIPLE = /^(?:multiple_(?:girls|boys|others|people)|crowd|group)$/
const MULTI_VIEW = /^(?:break|comic|[234]koma|panels?|multiple_(?:panels|views|frames)|split_(?:screen|view|image)|diptych|triptych|collage|montage|sequence|before_and_after|transformation|reference_sheet|character_sheet|reflection|mirror)$/

/**
 * Free subjects keep their identity, clothing, palette and mixed environments.
 * Only clearly weaker, narrowly contradictory predictions are removed; uncertain
 * scores and multiple views retain the source. This never edits manual input.
 */
export function resolveFreeInterrogateTags(
  tags: readonly string[],
  scores: Readonly<Record<string, unknown>> | undefined,
  characterTags: readonly string[],
): { tags: string[]; removed: string[] } {
  const confidence = new Map<string, number | undefined>()
  for (const tag of tags) {
    const key = normalizeKey(tag), value = scores?.[tag]
    const score = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
    const previous = confidence.get(key)
    confidence.set(key, previous === undefined ? score : Math.max(previous, score ?? previous))
  }
  const keys = [...confidence.keys()]
  if (keys.some(key => MULTI_VIEW.test(key))) return { tags: [...tags], removed: [] }
  const removed = new Set<string>()
  const wins = (winner: number | undefined, loser: number | undefined) =>
    winner !== undefined && loser !== undefined && winner >= MIN_WINNING_SCORE && winner - loser >= MIN_SCORE_GAP

  // Synonyms within a group can coexist. Missing evidence keeps every candidate.
  function resolve(groups: string[][]) {
    const present = groups.map(group => group.filter(key => confidence.has(key) && !removed.has(key))).filter(group => group.length)
    if (present.length < 2 || present.some(group => group.some(key => confidence.get(key) === undefined))) return
    const ranked = present.map(group => ({ keys: group, score: Math.max(...group.map(key => confidence.get(key)!)) }))
      .sort((a, b) => b.score - a.score)
    if (!wins(ranked[0].score, ranked[1].score)) return
    for (const group of ranked.slice(1)) for (const key of group.keys) removed.add(key)
  }

  // Sunset, moonlight, city lights, indoor/outdoor and mixed weather are compatible
  // visual details, so do not apply the bound-character merger's broad categories.
  resolve([['day', 'daytime', 'daylight', 'noon'], ['night', 'nighttime', 'midnight']])

  const counts = keys.flatMap(key => {
    const match = COUNT.exec(key)
    return match ? [{ key, count: Number(match[1]), atLeast: Boolean(match[2]), kind: match[3].replace(/s$/, '') }] : []
  })
  // Different kinds add up (1girl + 1boy); lower bounds such as 6+girls are
  // compatible with several exact counts and are deliberately left alone.
  for (const kind of new Set(counts.map(item => item.kind))) {
    const exact = counts.filter(item => item.kind === kind && !item.atLeast)
    resolve([...new Set(exact.map(item => item.count))].map(count => exact.filter(item => item.count === count).map(item => item.key)))
  }

  const retainedCounts = counts.filter(item => !removed.has(item.key))
  const kinds = new Set(retainedCounts.map(item => item.kind))
  const plural = keys.filter(key => !removed.has(key) && (MULTIPLE.test(key)
    || retainedCounts.some(item => item.key === key && (item.count > 1 || item.atLeast))))
  const multipleSubjects = plural.length > 0 || kinds.size > 1 || new Set(characterTags.map(normalizeKey)).size > 1
  if (multipleSubjects) {
    // Never delete companions merely to satisfy "solo". Only remove solo when
    // plural counts, or every kind in a mixed group, provide stronger evidence.
    const pluralScore = Math.max(-1, ...plural.map(key => confidence.get(key) ?? -1))
    const mixedScore = kinds.size > 1 ? Math.min(...retainedCounts.map(item => confidence.get(item.key) ?? -1)) : -1
    if (wins(Math.max(pluralScore, mixedScore), confidence.get('solo'))) removed.add('solo')
  } else {
    // 1girl alone does not exclude other subjects or animals. Require an explicit
    // solo prediction before resolving subject-specific poses and expressions.
    const singleSubject = (confidence.get('solo') ?? 0) >= MIN_WINNING_SCORE
    if (singleSubject) {
      resolve([['standing'], ['sitting'], ['lying']])
      resolve([['open_mouth'], ['closed_mouth']])
      // A wink is intentional asymmetry; gaze direction is not an open-eye state.
      if (!keys.some(key => /^(?:one_eye_closed|wink|winking)$/.test(key))) {
        resolve([['open_eyes', 'wide_eyes'], ['closed_eyes', 'eyes_closed']])
      }
    }
  }

  return {
    tags: tags.filter(tag => !removed.has(normalizeKey(tag))),
    removed: tags.filter(tag => removed.has(normalizeKey(tag))),
  }
}
