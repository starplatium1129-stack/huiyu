'use strict';
const { keyFor } = require('./content-history-snapshot');
const { validId } = require('./content-history-reader');

function target(kind, id, characterId = null) {
  return { kind, id, ...(characterId === null ? {} : { characterId }), key: keyFor(kind, id, characterId) };
}

function relations(row, snapshots, unknown) {
  const value = row.value;
  const output = [];
  const add = (kind, id, characterId = null, via = '') => {
    if (validId(id)) output.push({ ...target(kind, id, characterId), via });
  };
  if (row.kind === 'blueprint') {
    add('character', value.characterId, null, 'characterId');
    if (!validId(value.characterId)) unknown.push(`${row.file}#${row.id}: characterId unknown`);
    if (validId(value.outfitId)) add('outfit', value.outfitId, value.characterId, 'outfitId');
    else {
      const characters = snapshots.popular?.rows.filter((r) => r.role === 'source' && r.kind === 'character' && r.id === value.characterId) || [];
      const outfits = characters.length === 1 ? characters[0].value.outfits : null;
      const defaults = outfits?.filter((o) => o.default === true);
      if (outfits?.length && outfits.every((o) => typeof o.default === 'boolean' && typeof o.isDefault === 'boolean' && o.default === o.isDefault)
        && defaults.length === 1 && outfits.filter((o) => o.id === defaults[0].id).length === 1) {
        add('outfit', defaults[0].id, value.characterId, 'proven-default-outfit');
      } else unknown.push(`${row.file}#${row.id}: omitted outfit has no unique consistent default; runtime fallback not assumed`);
    }
  } else if (row.kind === 'scene') {
    add('character', value.char, null, 'char');
    if (validId(value.outfitId)) add('outfit', value.outfitId, value.char, 'outfitId');
  } else if (row.kind === 'outfit' || row.kind === 'reference-outfit') {
    add('character', row.characterId, null, 'owner');
    if (row.kind === 'reference-outfit') {
      add('outfit', row.id, row.characterId, 'outfitId');
      if (value.references !== undefined && !Array.isArray(value.references)) unknown.push(`${row.file}#${row.id}: reference perspectives unknown`);
      for (const reference of Array.isArray(value.references) ? value.references : []) add('perspective', reference?.id, null, 'references[].id');
    }
  } else if (row.kind === 'reference-character') add('character', row.id, null, 'character-id');
  else if (row.kind === 'curation' || row.kind === 'retired') add('scene', row.id, null, 'scene-id');
  else if (row.kind === 'profile') {
    const ids = value.lora?.recommended_scene;
    if (ids !== undefined && !Array.isArray(ids)) unknown.push(`${row.file}#${row.id}: lora.recommended_scene unknown`);
    for (const id of Array.isArray(ids) ? ids : []) add('scene', id, null, 'lora.recommended_scene');
  }
  return output;
}

function relationshipIssues(snapshots) {
  const issues = [];
  const popular = snapshots.popular?.groups['popular:source'];
  const blueprints = snapshots.blueprints?.groups['blueprints:source'];
  if (popular?.complete) for (const character of popular.rows.filter((r) => r.kind === 'character')) {
    const outfits = character.value.outfits;
    if (!Array.isArray(outfits)) continue;
    const complete = outfits.length && outfits.every((o) => typeof o.default === 'boolean' && typeof o.isDefault === 'boolean');
    if (outfits.some((o) => typeof o.default === 'boolean' && typeof o.isDefault === 'boolean' && o.default !== o.isDefault)
      || ['default', 'isDefault'].some((field) => outfits.filter((o) => o[field] === true).length > 1)
      || (complete && outfits.filter((o) => o.default).length !== 1)) {
      issues.push({ domain: 'popular', file: character.file, id: character.id, reason: 'default/isDefault flags do not identify one consistent outfit' });
    }
  }
  if (popular?.complete && blueprints?.complete) {
    for (const bp of blueprints.rows) {
      const candidates = popular.rows.filter((r) => r.kind === 'character' && r.id === bp.value.characterId);
      if (!candidates.length) issues.push({ domain: 'blueprints', file: bp.file, id: bp.id, reason: 'dangling characterId' });
      else if (candidates.length === 1 && validId(bp.value.outfitId) && Array.isArray(candidates[0].value.outfits)
        && !candidates[0].value.outfits.some((o) => o.id === bp.value.outfitId)) {
        issues.push({ domain: 'blueprints', file: bp.file, id: bp.id, reason: `dangling outfitId ${bp.value.characterId}/${bp.value.outfitId}` });
      }
    }
  }
  const scenes = snapshots.scenes?.groups['scenes:source'];
  if (scenes?.complete) for (const domain of ['curation', 'retired']) {
    const group = snapshots[domain]?.groups[`${domain}:source`];
    if (!group?.complete) continue;
    for (const row of group.rows) {
      const exists = scenes.rows.some((scene) => scene.id === row.id);
      if ((domain === 'curation' && !exists) || (domain === 'retired' && exists)) issues.push({ domain, file: row.file, id: row.id,
        reason: domain === 'curation' ? 'curation references absent scene' : 'retired ID is still active' });
    }
  }
  return issues;
}

module.exports = { relations, relationshipIssues, target };
