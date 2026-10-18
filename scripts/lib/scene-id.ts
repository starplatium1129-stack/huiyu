'use strict';

// Existing IDs keep their spelling; numbers beyond 999 simply gain digits.
function isSceneId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^sc(?:\d{3}|[1-9]\d{3,})$/.test(value)) return false;
  const number = Number(value.slice(2));
  return Number.isSafeInteger(number) && number > 0;
}

function formatSceneId(number: number) {
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw new Error('场景编号必须是正安全整数');
  return 'sc' + String(number).padStart(3, '0');
}

function missingSceneIdRanges(activeIds: readonly unknown[] = [], retiredIds: readonly unknown[] = []) {
  const numbers = [...new Set([...activeIds, ...retiredIds].filter(isSceneId).map(id => Number(id.slice(2))))].sort((a, b) => a - b);
  const missing = [];
  let expected = 1;
  for (const number of numbers) {
    if (number > expected) missing.push({ start: expected, end: number - 1, count: number - expected });
    expected = number + 1;
  }
  return missing;
}

export = { isSceneId, formatSceneId, missingSceneIdRanges };
