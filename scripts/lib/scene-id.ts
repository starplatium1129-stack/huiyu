'use strict';

// Existing IDs keep their spelling; numbers beyond 999 simply gain digits.
function isSceneId(value: string|unknown[]) {
  if (typeof value !== 'string' || !/^sc(?:\d{3}|[1-9]\d{3,})$/.test(value)) return false;
  const number = Number(value.slice(2));
  return Number.isSafeInteger(number) && number > 0;
}

function formatSceneId(number: unknown) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('场景编号必须是正安全整数');
  return 'sc' + String(number).padStart(3, '0');
}

function nextSceneId(activeIds = [], retiredIds = []) {
  let highest = 0;
  for (const ids of [activeIds, retiredIds]) {
    for (const id of ids) {
      if (!isSceneId(id)) throw new Error('现有场景编号不规范，停止分配：' + String(id));
      highest = Math.max(highest, Number(id.slice(2)));
    }
  }
  if (highest === Number.MAX_SAFE_INTEGER) {
    throw Object.assign(new Error('场景编号已达到安全整数上限'), { code: 'SCENE_ID_EXHAUSTED' });
  }
  return formatSceneId(highest + 1);
}

function missingSceneIdRanges(activeIds = [], retiredIds = []) {
  const numbers = [...new Set([...activeIds, ...retiredIds].filter(isSceneId).map(id => Number(id.slice(2))))].sort((a, b) => a - b);
  const missing = [];
  let expected = 1;
  for (const number of numbers) {
    if (number > expected) missing.push({ start: expected, end: number - 1, count: number - expected });
    expected = number + 1;
  }
  return missing;
}

export = { isSceneId, formatSceneId, nextSceneId, missingSceneIdRanges };
