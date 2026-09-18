import type { TagEntry, TagManifest, TagDictionaryOutput } from './tag-store';

export interface TagDictionaryPolicy {
  duplicates?: Record<string, { canonical: string; members: string[]; meaning?: string }>;
  aliasOverrides?: Record<string, { target: string; shadowed: string[] }>;
}

export const tagKey = (value: string): string => value.trim().toLowerCase().replace(/[\s\-/]+/g, '_');
function text(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${context} must be a non-empty string`);
}
function safeKey(value: string): string {
  const key = tagKey(value);
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Reserved tag key: ${key}`);
  return key;
}
function record(value: unknown, context: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`);
}
function sameMembers(actual: string[], expected: unknown): boolean {
  return Array.isArray(expected) && expected.every(item => typeof item === 'string')
    && new Set(expected).size === expected.length && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export function validateTagManifest(value: unknown): asserts value is TagManifest {
  const manifest = value as TagManifest | null;
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Tag manifest must have version 1 and a non-empty files array');
  }
  const files = new Set<string>();
  const categories = new Set<string>();
  for (const entry of manifest.files) {
    record(entry, 'Tag manifest entry');
    text(entry.file, 'Tag shard file');
    text(entry.category, 'Tag shard category');
    const file = entry.file.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*\.json$/i.test(entry.file) || file === 'manifest.json'
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.json$/i.test(file)) throw new Error(`Unsafe tag shard filename: ${entry.file}`);
    if (files.has(file)) throw new Error(`Duplicate tag shard file: ${entry.file}`);
    if (categories.has(entry.category.toLowerCase())) throw new Error(`Duplicate tag category: ${entry.category}`);
    if (entry.category !== entry.category.trim()) throw new Error(`Untrimmed tag category: ${entry.category}`);
    if (!Number.isInteger(entry.count) || Number(entry.count) < 0) throw new Error(`Invalid tag count: ${entry.file}`);
    if (entry.label !== undefined) text(entry.label, `${entry.file} label`);
    files.add(file);
    categories.add(entry.category.toLowerCase());
  }
  if (manifest.dictionary !== undefined) {
    record(manifest.dictionary, 'Tag dictionary policy');
    for (const field of ['duplicates', 'aliasOverrides'] as const) {
      if (manifest.dictionary[field] !== undefined) record(manifest.dictionary[field], `Tag dictionary ${field}`);
    }
  }
}

/** Legacy duplicate IDs remain intact; every collision must have an explicit,
 * exact membership decision in the manifest. New/changed collisions fail closed.
 */
export function buildValidatedTagDictionary(value: unknown, policy: TagDictionaryPolicy = {}): TagDictionaryOutput {
  if (!Array.isArray(value)) throw new Error('Tags must be an array');
  record(policy, 'Tag dictionary policy');
  const tags = value as TagEntry[];
  const byId = new Map<string, TagEntry>();
  const groups = new Map<string, TagEntry[]>();
  for (const tag of tags) {
    record(tag, 'Tag entry');
    for (const field of ['id', 'cat', 'en', 'cn'] as const) text(tag[field], `Tag ${tag.id || '?'} ${field}`);
    if (tag.id !== tag.id.trim() || tag.cat !== tag.cat.trim()) throw new Error(`Untrimmed tag ID/category: ${tag.id}`);
    if (byId.has(tag.id)) throw new Error(`Duplicate tag ID: ${tag.id}`);
    if (tag.weight !== undefined && (typeof tag.weight !== 'number' || !Number.isFinite(tag.weight) || tag.weight < 0)) throw new Error(`Invalid tag weight: ${tag.id}`);
    if (tag.desc !== undefined && typeof tag.desc !== 'string') throw new Error(`Invalid tag description: ${tag.id}`);
    for (const field of ['aliases', 'related'] as const) {
      if (tag[field] === undefined) continue;
      if (!Array.isArray(tag[field])) throw new Error(`Tag ${tag.id} ${field} must be an array`);
      for (const item of tag[field]!) text(item, `Tag ${tag.id} ${field}`);
    }
    const key = safeKey(tag.en);
    byId.set(tag.id, tag);
    const group = groups.get(key) ?? [];
    group.push(tag);
    groups.set(key, group);
  }
  const meanings = new Map<string, string>();
  const canonical = new Map<string, TagEntry>();
  const usedDuplicates = new Set<string>();
  for (const [key, group] of groups) {
    let chosen = group[0];
    if (group.length > 1) {
      const decision = policy.duplicates?.[key];
      if (!decision || !sameMembers(group.map(tag => tag.id), decision.members)) throw new Error(`Unresolved duplicate tag: ${key} (${group.map(tag => tag.id).join(', ')})`);
      const selected = group.find(tag => tag.id === decision.canonical);
      if (!selected) throw new Error(`Invalid canonical tag: ${key}`);
      chosen = selected;
      if (decision.meaning !== undefined) text(decision.meaning, `Canonical meaning ${key}`);
      usedDuplicates.add(key);
    }
    canonical.set(key, chosen);
    meanings.set(key, policy.duplicates?.[key]?.meaning ?? chosen.cn);
  }
  for (const key of Object.keys(policy.duplicates ?? {})) if (!usedDuplicates.has(key)) throw new Error(`Stale duplicate tag decision: ${key}`);
  const aliases = new Map<string, string>();
  const aliasOwners = new Map<string, string>();
  const usedOverrides = new Set<string>();
  for (const tag of tags) {
    for (const related of tag.related ?? []) if (!byId.has(related)) throw new Error(`Tag ${tag.id} references unknown related ID: ${related}`);
    const owner = tagKey(tag.en);
    for (const alias of tag.aliases ?? []) {
      const key = safeKey(alias);
      if (key === owner) continue;
      if (aliasOwners.has(key) && aliasOwners.get(key) !== owner) throw new Error(`Ambiguous tag alias: ${alias}`);
      const shadowed = groups.get(key);
      if (shadowed && key !== owner) {
        const decision = policy.aliasOverrides?.[key];
        if (!decision || !sameMembers(shadowed.map(item => item.id), decision.shadowed)
          || byId.get(decision.target)?.en !== tag.en) throw new Error(`Alias shadows a canonical tag without a decision: ${alias}`);
        usedOverrides.add(key);
      }
      aliasOwners.set(key, owner);
      aliases.set(key, canonical.get(owner)!.en);
    }
  }
  for (const key of Object.keys(policy.aliasOverrides ?? {})) if (!usedOverrides.has(key)) throw new Error(`Stale alias override: ${key}`);
  return { version: 1, meanings: Object.fromEntries(meanings), aliases: Object.fromEntries(aliases) };
}
