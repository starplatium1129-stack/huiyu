import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathLike } from 'node:fs';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
const { isDeepStrictEqual: equal }: typeof import('node:util') = require('node:util');

// Pure mirror contract. URL/pending/review and actual assets depend on other
// writers and the filesystem; they are deliberately not inferred from prose.
function compareReferenceProjection(standards: any, view: any) {
  const result: any = { file: 'data/character-reference-view.json', status: 'unknown', scope: 'reference-mirror-fields',
    sourceFiles: ['data/character-reference-standards.json'], issues: [],
    untracked: ['URL/fileName/pending/review and asset existence', 'popular-to-standards generation: hard-coded heroines, asset filtering and merge writers'] };
  const idRows = (rows: unknown[], key: string) => Array.isArray(rows) && rows.every((row: any) => object(row) && typeof row[key] === 'string' && row[key].trim())
    && new Set(rows.map((row: any) => row[key])).size === rows.length;
  if (!object(standards) || !idRows(standards.characters, 'id') || !idRows(standards.perspectives, 'id') || !object(view)
    || standards.characters.some((c: any) => !idRows(c.outfits, 'id'))
    || Object.values(view).some((c: any) => !object(c) || !idRows(c.outfits, 'outfitId') || c.outfits.some((o: any) => !idRows(o.references, 'id')))) {
    result.reason = 'invalid or duplicate reference identities; no partial mirror accepted';
    return result;
  }
  const check = (location: string, actual: unknown, expected: unknown) => {
    if (!equal(actual, expected)) result.issues.push({ file: result.file, location, reason: 'reference source/derived field mismatch' });
  };
  check('character-ids', Object.keys(view).sort(), standards.characters.map((c: any) => c.id).sort());
  for (const character of standards.characters) {
    const actual = view[character.id];
    if (!actual) continue;
    check(`${character.id}/characterId`, actual.characterId, character.id);
    for (const field of ['displayName', 'source', 'identityProse']) check(`${character.id}/${field}`, actual[field], character[field]);
    check(`${character.id}/outfit-ids`, actual.outfits.map((o: any) => o.outfitId).sort(), character.outfits.map((o: any) => o.id).sort());
    const defaults = character.outfits.filter((o: { isDefault: boolean; }) => o.isDefault === true);
    if (defaults.length !== (character.outfits.length ? 1 : 0)) result.issues.push({ file: result.sourceFiles[0], location: character.id, reason: 'reference default outfit count is invalid' });
    for (const outfit of character.outfits) {
      const projection = actual.outfits.find((o: any) => o.outfitId === outfit.id);
      if (!projection) continue;
      for (const [target, source] of [['outfitName', 'name'], ['prose', 'prose']]) check(`${character.id}/${outfit.id}/${target}`, projection[target], outfit[source]);
      for (const field of ['isDefault', 'isNsfw']) check(`${character.id}/${outfit.id}/${field}`, projection[field], outfit[field] === true);
      check(`${character.id}/${outfit.id}/perspective-ids`, projection.references.map((r: any) => r.id), standards.perspectives.map((p: any) => p.id));
      for (const reference of projection.references) {
        const perspective = standards.perspectives.find((p: any) => p.id === reference.id);
        if (!perspective) continue;
        for (const field of ['name', 'shotType', 'lens', 'targetUsage']) check(`${character.id}/${outfit.id}/${reference.id}/${field}`, reference[field], perspective[field]);
      }
    }
  }
  result.status = result.issues.length ? 'mismatch' : 'current';
  return result;
}

// Index declarations only. Never resolve reference URLs or asset roots.
function referenceImpact(opts: any, selected: any, result: any, add: any) {
  const file = 'data/character-reference-view.json';
  result.referenceEvidence = [];
  if (!selected.size) return;
  let view;
  let failure;
  try {
    const root = fs.realpathSync(opts.root);
    const real = fs.realpathSync(path.join(root, file));
    const relative = path.relative(root, real);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('view 真实路径超出 root');
    if (!fs.statSync(real).isFile()) throw new Error('view 必须为普通文件');
    view = JSON.parse(fs.readFileSync(real, 'utf8'));
    if (!object(view)) throw new Error('view 必须为角色索引对象');
  } catch (error) { failure = runtimeErrorMessage(error); }
  for (const characterId of selected) {
    // An explicit outfit restricts its explicit character, not other path-selected characters.
    const outfit = characterId === opts.character ? opts.outfit : null;
    const emit = (outfitId: unknown, status: string, references: any = null, reason: any = '') => {
      const item = { characterId, outfitId, status, total: references?.length ?? null,
        pendingCount: references ? references.filter((r: { pending: boolean; url: string; }) => r.pending === true || typeof r.url !== 'string' || !r.url.trim()).length : null,
        urlDeclaredCount: references ? references.filter((r: { url: string; }) => typeof r.url === 'string' && Boolean(r.url.trim())).length : null,
        reviewDeclaredCount: references ? references.filter((r: object) => Object.hasOwn(r, 'review')).length : null,
        reviewStatus: references?.some((r: object) => Object.hasOwn(r, 'review')) ? 'declared-unverified' : 'unknown',
        assetStatus: 'unverified', reason };
      if (references?.length) item.status = item.pendingCount ? 'pending' : 'declared-unverified';
      result.referenceEvidence.push(item);
      if (['unknown', 'missing', 'empty'].includes(item.status)) result.unknown.push(`${characterId}/${outfitId ?? '*'}: reference ${item.status}；${reason}`);
    };
    if (failure) { emit(outfit || null, 'unknown', null, failure); continue; }
    if (!Object.hasOwn(view, characterId)) { emit(outfit || null, 'missing', null, '角色未登记'); continue; }
    const forms = view[characterId]?.outfits;
    if (!Array.isArray(forms) || forms.some((f: any) => !object(f) || typeof f.outfitId !== 'string' || !f.outfitId.trim())
      || new Set(forms.map((f: any) => f.outfitId)).size !== forms.length) {
      emit(outfit || null, 'unknown', null, '服装登记缺失、损坏或重复'); continue;
    }
    const matches = forms.filter((f: any) => !outfit || f.outfitId === outfit);
    if (!matches.length) emit(outfit || null, outfit ? 'missing' : 'empty', null, '无所选服装登记');
    for (const form of matches) {
      const target = `${characterId}/${form.outfitId}`;
      add('related', 'reference', target, '参考 view 显式登记关联');
      add('revalidate', 'reference', target, 'view 登记关联；未核实标准镜像、URL、图片或审核状态');
      if (!Object.hasOwn(form, 'references')) emit(form.outfitId, 'missing', null, 'references 未登记');
      else if (!Array.isArray(form.references) || form.references.some((r: { pending: any; url: any; }) => !object(r)
        || (r.pending !== undefined && typeof r.pending !== 'boolean') || (r.url !== undefined && r.url !== null && typeof r.url !== 'string'))) {
        emit(form.outfitId, 'unknown', null, 'references 损坏，未统计部分记录');
      } else emit(form.outfitId, 'empty', form.references, '仅统计索引声明；未验证素材根、资产存在性或审核真实性');
    }
  }
}
export = { referenceImpact, compareReferenceProjection };
