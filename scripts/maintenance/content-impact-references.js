'use strict';
const fs = require('node:fs');
const path = require('node:path');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Index declarations only. Never resolve reference URLs or asset roots.
function referenceImpact(opts, selected, result, add) {
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
  } catch (error) { failure = error.message; }
  for (const characterId of selected) {
    // An explicit outfit restricts its explicit character, not other path-selected characters.
    const outfit = characterId === opts.character ? opts.outfit : null;
    const emit = (outfitId, status, references = null, reason = '') => {
      const item = { characterId, outfitId, status, total: references?.length ?? null,
        pendingCount: references ? references.filter((r) => r.pending === true || typeof r.url !== 'string' || !r.url.trim()).length : null,
        urlDeclaredCount: references ? references.filter((r) => typeof r.url === 'string' && Boolean(r.url.trim())).length : null,
        reviewDeclaredCount: references ? references.filter((r) => Object.hasOwn(r, 'review')).length : null,
        reviewStatus: references?.some((r) => Object.hasOwn(r, 'review')) ? 'declared-unverified' : 'unknown',
        assetStatus: 'unverified', reason };
      if (references?.length) item.status = item.pendingCount ? 'pending' : 'declared-unverified';
      result.referenceEvidence.push(item);
      if (['unknown', 'missing', 'empty'].includes(item.status)) result.unknown.push(`${characterId}/${outfitId ?? '*'}: reference ${item.status}；${reason}`);
    };
    if (failure) { emit(outfit || null, 'unknown', null, failure); continue; }
    if (!Object.hasOwn(view, characterId)) { emit(outfit || null, 'missing', null, '角色未登记'); continue; }
    const forms = view[characterId]?.outfits;
    if (!Array.isArray(forms) || forms.some((f) => !object(f) || typeof f.outfitId !== 'string' || !f.outfitId.trim())
      || new Set(forms.map((f) => f.outfitId)).size !== forms.length) {
      emit(outfit || null, 'unknown', null, '服装登记缺失、损坏或重复'); continue;
    }
    const matches = forms.filter((f) => !outfit || f.outfitId === outfit);
    if (!matches.length) emit(outfit || null, outfit ? 'missing' : 'empty', null, '无所选服装登记');
    for (const form of matches) {
      const target = `${characterId}/${form.outfitId}`;
      add('related', 'reference', target, '参考 view 显式登记关联');
      add('revalidate', 'reference', target, 'view 登记关联；未核实标准镜像、URL、图片或审核状态');
      if (!Object.hasOwn(form, 'references')) emit(form.outfitId, 'missing', null, 'references 未登记');
      else if (!Array.isArray(form.references) || form.references.some((r) => !object(r)
        || (r.pending !== undefined && typeof r.pending !== 'boolean') || (r.url !== undefined && r.url !== null && typeof r.url !== 'string'))) {
        emit(form.outfitId, 'unknown', null, 'references 损坏，未统计部分记录');
      } else emit(form.outfitId, 'empty', form.references, '仅统计索引声明；未验证素材根、资产存在性或审核真实性');
    }
  }
}
module.exports = { referenceImpact };
