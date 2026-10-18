import type { GateState, IdentityGroup, JsonRecord } from './delivery-types';
'use strict';
const { object }: typeof import('./delivery-paths') = require('./delivery-paths');
const get = (value: unknown, key: string): unknown => key.split('.').reduce<unknown>((a, k) => object(a) && Object.hasOwn(a, k) ? a[k] : undefined, value);
const MAIN_FIELDS = ['installation', 'deviceAcceptance', 'modelAcceptance'];
const gatePath = (value: unknown): value is string => typeof value === 'string' && /^(fullGate|gate|checks\.[a-zA-Z][a-zA-Z\d_]*)$/.test(value);
const identityGroup = (value: unknown): value is IdentityGroup => value === 'source' || value === 'build';
function set(value: JsonRecord, key: string, record: unknown) {
  const parts = key.split('.');
  if (!(gatePath(key) || MAIN_FIELDS.includes(key))) throw Error(`不支持的门禁字段: ${key}`);
  if (parts.length === 2) {
    value[parts[0]] ||= {};
    const parent = value[parts[0]];
    if (!object(parent)) throw Error('门禁 checks 必须为对象');
    parent[parts[1]] = record;
  }
  else value[key] = record;
}
function state(v: unknown): GateState {
  if (!object(v)) return 'unknown';
  const raw = v.status ?? v.result;
  const states: Record<string, GateState> = { pass: 'passed', passed: 'passed', fail: 'failed', failed: 'failed', unknown: 'unknown', unrun: 'unrun', 'not-run': 'unrun', pending: 'pending', skipped: 'unrun' };
  let s = typeof raw === 'string' ? (Object.hasOwn(states, raw.toLowerCase()) ? states[raw.toLowerCase()] : 'unknown') : typeof v.passed === 'boolean' ? (v.passed ? 'passed' : 'failed') : 'unknown';
  if (['failed', 'unexpected', 'runnerErrors'].some(k => typeof v[k] === 'number' && v[k] > 0) || (typeof v.exitCode === 'number' && v.exitCode !== 0)) s = 'failed';
  if (s === 'passed' && (Number(v.skipped) > 0 || Number(v.flaky) > 0)) s = 'pending';
  if (v.status !== undefined && v.result !== undefined && String(v.status).toLowerCase() !== String(v.result).toLowerCase()) s = 'failed';
  if (s === 'passed' && v.passed === false) s = 'failed';
  return s;
}
export = { MAIN_FIELDS, gatePath, identityGroup, get, set, state };
