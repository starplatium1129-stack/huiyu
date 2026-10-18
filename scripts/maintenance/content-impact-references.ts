import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';


const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { object }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
const { isDeepStrictEqual: equal }: typeof import('node:util') = require('node:util');
type Identity<K extends string> = Record<string, unknown> & Record<K, string>;
type ViewOutfit = Identity<'outfitId'> & { references: Identity<'id'>[] };
type ViewCharacter = Record<string, unknown> & { outfits: ViewOutfit[] };
function idRows<K extends string>(rows: unknown, key: K): rows is Identity<K>[] {
  return Array.isArray(rows) && rows.every((row: unknown) => object(row) && typeof row[key] === 'string' && row[key].trim())
    && new Set(rows.map((row: Identity<K>) => row[key])).size === rows.length;
}
const validView = (value: unknown): value is Record<string, ViewCharacter> => object(value)
  && Object.values(value).every(character => object(character) && idRows(character.outfits, 'outfitId') && character.outfits.every(outfit => idRows(outfit.references, 'id')));
type Projection = {
  file: string; status: 'unknown' | 'current' | 'mismatch'; scope: string; sourceFiles: string[]; untracked: string[];
  issues: { file: string; location: string; reason: string }[]; reason?: string;
};

// Pure mirror contract. URL/pending/review and actual assets depend on other
// writers and the filesystem; they are deliberately not inferred from prose.
function compareReferenceProjection(standards: unknown, view: unknown) {
  const result: Projection = { file: 'data/character-reference-view.json', status: 'unknown', scope: 'reference-mirror-fields',
    sourceFiles: ['data/character-reference-standards.json'], issues: [],
    untracked: ['URL/fileName/pending/review and asset existence', 'popular-to-standards generation: hard-coded heroines, asset filtering and merge writers'] };
  if (!object(standards) || !idRows(standards.characters, 'id') || !idRows(standards.perspectives, 'id') || !validView(view)
    || !standards.characters.every((character): character is Identity<'id'> & { outfits: Identity<'id'>[] } => idRows(character.outfits, 'id'))) {
    result.reason = 'invalid or duplicate reference identities; no partial mirror accepted';
    return result;
  }
  const check = (location: string, actual: unknown, expected: unknown) => {
    if (!equal(actual, expected)) result.issues.push({ file: result.file, location, reason: 'reference source/derived field mismatch' });
  };
  check('character-ids', Object.keys(view).sort(), standards.characters.map(c => c.id).sort());
  for (const character of standards.characters) {
    const actual = view[character.id];
    if (!actual) continue;
    check(`${character.id}/characterId`, actual.characterId, character.id);
    for (const field of ['displayName', 'source', 'identityProse']) check(`${character.id}/${field}`, actual[field], character[field]);
    check(`${character.id}/outfit-ids`, actual.outfits.map(o => o.outfitId).sort(), character.outfits.map(o => o.id).sort());
    const defaults = character.outfits.filter(o => o.isDefault === true);
    if (defaults.length !== (character.outfits.length ? 1 : 0)) result.issues.push({ file: result.sourceFiles[0], location: character.id, reason: 'reference default outfit count is invalid' });
    for (const outfit of character.outfits) {
      const projection = actual.outfits.find(o => o.outfitId === outfit.id);
      if (!projection) continue;
      for (const [target, source] of [['outfitName', 'name'], ['prose', 'prose']]) check(`${character.id}/${outfit.id}/${target}`, projection[target], outfit[source]);
      for (const field of ['isDefault', 'isNsfw']) check(`${character.id}/${outfit.id}/${field}`, projection[field], outfit[field] === true);
      check(`${character.id}/${outfit.id}/perspective-ids`, projection.references.map(r => r.id), standards.perspectives.map(p => p.id));
      for (const reference of projection.references) {
        const perspective = standards.perspectives.find(p => p.id === reference.id);
        if (!perspective) continue;
        for (const field of ['name', 'shotType', 'lens', 'targetUsage']) check(`${character.id}/${outfit.id}/${reference.id}/${field}`, reference[field], perspective[field]);
      }
    }
  }
  result.status = result.issues.length ? 'mismatch' : 'current';
  return result;
}

// Index declarations only. Never resolve reference URLs or asset roots.
type Reference = Record<string, unknown> & { pending?: boolean; url?: string | null };
type ReferenceEvidence = { characterId: string; outfitId: string | null; status: string; total: number | null; pendingCount: number | null; urlDeclaredCount: number | null; reviewDeclaredCount: number | null; reviewStatus: string; assetStatus: string; reason: string };
function referenceImpact(opts: { root: string; character?: string; outfit?: string }, selected: ReadonlySet<string>, result: { referenceEvidence?: ReferenceEvidence[]; unknown: string[] }, add: (level: 'related' | 'revalidate', domain: string, object: string, reason: string) => unknown) {
  const file = 'data/character-reference-view.json';
  const evidence: ReferenceEvidence[] = [];
  result.referenceEvidence = evidence;
  if (!selected.size) return;
  let view: Record<string, unknown> | undefined;
  let failure;
  try {
    const root = fs.realpathSync(opts.root);
    const real = fs.realpathSync(path.join(root, file));
    const relative = path.relative(root, real);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('view 真实路径超出 root');
    if (!fs.statSync(real).isFile()) throw new Error('view 必须为普通文件');
    const value: unknown = JSON.parse(fs.readFileSync(real, 'utf8'));
    if (!object(value)) throw new Error('view 必须为角色索引对象');
    view = value;
  } catch (error) { failure = runtimeErrorMessage(error); }
  for (const characterId of selected) {
    // An explicit outfit restricts its explicit character, not other path-selected characters.
    const outfit = characterId === opts.character ? opts.outfit : null;
    const emit = (outfitId: string | null, status: string, references: readonly Reference[] | null = null, reason = '') => {
      const item = { characterId, outfitId, status, total: references?.length ?? null,
        pendingCount: references ? references.filter(r => r.pending === true || typeof r.url !== 'string' || !r.url.trim()).length : null,
        urlDeclaredCount: references ? references.filter(r => typeof r.url === 'string' && Boolean(r.url.trim())).length : null,
        reviewDeclaredCount: references ? references.filter(r => Object.hasOwn(r, 'review')).length : null,
        reviewStatus: references?.some(r => Object.hasOwn(r, 'review')) ? 'declared-unverified' : 'unknown',
        assetStatus: 'unverified', reason };
      if (references?.length) item.status = item.pendingCount ? 'pending' : 'declared-unverified';
      evidence.push(item);
      if (['unknown', 'missing', 'empty'].includes(item.status)) result.unknown.push(`${characterId}/${outfitId ?? '*'}: reference ${item.status}；${reason}`);
    };
    if (failure || !view) { emit(outfit || null, 'unknown', null, failure); continue; }
    if (!Object.hasOwn(view, characterId)) { emit(outfit || null, 'missing', null, '角色未登记'); continue; }
    const character = view[characterId];
    const forms = object(character) ? character.outfits : undefined;
    if (!idRows(forms, 'outfitId')) {
      emit(outfit || null, 'unknown', null, '服装登记缺失、损坏或重复'); continue;
    }
    const matches = forms.filter(f => !outfit || f.outfitId === outfit);
    if (!matches.length) emit(outfit || null, outfit ? 'missing' : 'empty', null, '无所选服装登记');
    for (const form of matches) {
      const target = `${characterId}/${form.outfitId}`;
      add('related', 'reference', target, '参考 view 显式登记关联');
      add('revalidate', 'reference', target, 'view 登记关联；未核实标准镜像、URL、图片或审核状态');
      if (!Object.hasOwn(form, 'references')) emit(form.outfitId, 'missing', null, 'references 未登记');
      else if (!Array.isArray(form.references) || !form.references.every((r: unknown): r is Reference => object(r)
        && (r.pending === undefined || typeof r.pending === 'boolean') && (r.url === undefined || r.url === null || typeof r.url === 'string'))) {
        emit(form.outfitId, 'unknown', null, 'references 损坏，未统计部分记录');
      } else emit(form.outfitId, 'empty', form.references, '仅统计索引声明；未验证素材根、资产存在性或审核真实性');
    }
  }
}
export = { referenceImpact, compareReferenceProjection };
