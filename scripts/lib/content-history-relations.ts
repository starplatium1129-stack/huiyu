'use strict';
const { keyFor }: typeof import('./content-history-snapshot') = require('./content-history-snapshot');
const { validId }: typeof import('./content-history-reader') = require('./content-history-reader');

function target(kind: string, id: string, characterId = null) {
  return { kind, id, ...(characterId === null ? {} : { characterId }), key: keyFor(kind, id, characterId) };
}

function relations(row: any, snapshots: any, unknown: string[]) {
  const value = row.value;
  const output: any = [];
  const add = (kind: string, id: string, characterId = null, via = '') => {
    if (validId(id)) output.push({ ...target(kind, id, characterId), via });
  };
  if (row.kind === 'blueprint') {
    add('character', value.characterId, null, 'characterId');
    if (!validId(value.characterId)) unknown.push(`${row.file}#${row.id}: characterId unknown`);
    if (validId(value.outfitId)) add('outfit', value.outfitId, value.characterId, 'outfitId');
    else {
      const characters = snapshots.popular?.rows.filter((r: any) => r.role === 'source' && r.kind === 'character' && r.id === value.characterId) || [];
      const outfits = characters.length === 1 ? characters[0].value.outfits : null;
      const defaults = outfits?.filter((o: { default: boolean; }) => o.default === true);
      if (outfits?.length && outfits.every((o: any) => typeof o.default === 'boolean' && typeof o.isDefault === 'boolean' && o.default === o.isDefault)
        && defaults.length === 1 && outfits.filter((o: any) => o.id === defaults[0].id).length === 1) {
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

function relationshipIssues(snapshots: any, { keys } = {}) {
  const issues = [];
  const selected = (row: any) => !keys || keys.has(row.key);
  const popular: any = snapshots.popular?.groups['popular:source'];
  const blueprints: any = snapshots.blueprints?.groups['blueprints:source'];
  if (popular?.complete) for (const character of popular.rows.filter((r: { kind: string; }) => r.kind === 'character')) {
    if (!selected(character) && !(character.value.outfits || []).some((o: any) => keys?.has(keyFor('outfit', o.id, character.id)))) continue;
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
      if (!selected(bp)) continue;
      const candidates = popular.rows.filter((r: any) => r.kind === 'character' && r.id === bp.value.characterId);
      if (!candidates.length) issues.push({ domain: 'blueprints', file: bp.file, id: bp.id, reason: 'dangling characterId' });
      else if (candidates.length === 1 && validId(bp.value.outfitId) && Array.isArray(candidates[0].value.outfits)
        && !candidates[0].value.outfits.some((o: any) => o.id === bp.value.outfitId)) {
        issues.push({ domain: 'blueprints', file: bp.file, id: bp.id, reason: `dangling outfitId ${bp.value.characterId}/${bp.value.outfitId}` });
      }
    }
  }
  const scenes: any = snapshots.scenes?.groups['scenes:source'];
  if (scenes?.complete) for (const domain of ['curation', 'retired']) {
    const group: any = snapshots[domain]?.groups[`${domain}:source`];
    if (!group?.complete) continue;
    for (const row of group.rows) {
      if (!selected(row)) continue;
      const exists = scenes.rows.some((scene: any) => scene.id === row.id);
      if ((domain === 'curation' && !exists) || (domain === 'retired' && exists)) issues.push({ domain, file: row.file, id: row.id,
        reason: domain === 'curation' ? 'curation references absent scene' : 'retired ID is still active' });
    }
  }
  return issues;
}

export = { relations, relationshipIssues, target };
