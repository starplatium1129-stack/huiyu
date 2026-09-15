/** Stable scene identities: three digits through 999, then unpadded safe integers. */
export function isSceneId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^sc(?:\d{3}|[1-9]\d{3,})$/.test(value)) return false
  const number = Number(value.slice(2))
  return Number.isSafeInteger(number) && number > 0
}

export function formatSceneId(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('场景编号必须是正安全整数')
  return 'sc' + String(number).padStart(3, '0')
}

export function nextSceneId(activeIds: Iterable<string> = [], retiredIds: Iterable<string> = []): string {
  let highest = 0
  for (const ids of [activeIds, retiredIds]) {
    for (const id of ids) {
      if (!isSceneId(id)) throw new Error('现有场景编号不规范，停止分配：' + String(id))
      highest = Math.max(highest, Number(id.slice(2)))
    }
  }
  if (highest === Number.MAX_SAFE_INTEGER) throw new Error('场景编号已达到安全整数上限，无法继续分配')
  return formatSceneId(highest + 1)
}

/** The server candidate is a lower bound, not a reservation. Include local reservations. */
export function allocateSceneId(candidate: string, occupiedIds: Iterable<string>): string {
  if (!isSceneId(candidate)) throw new Error('服务端返回的场景编号不规范，请重新读取')
  const localNext = nextSceneId(occupiedIds)
  return Number(candidate.slice(2)) >= Number(localNext.slice(2)) ? candidate : localNext
}
