'use strict';
const { keyFor }: typeof import('./content-history-snapshot') = require('./content-history-snapshot');
const { validId, object }: typeof import('./content-history-reader') = require('./content-history-reader');
type Snapshot = ReturnType<typeof import('./content-history-snapshot').loadDomain>;
type Row = Snapshot['rows'][number];
type Snapshots = Record<string, Snapshot | undefined>;

function target(kind: string, id: string, characterId: unknown = null) {
  return { kind, id, ...(characterId === null ? {} : { characterId }), key: keyFor(kind, id, characterId) };
}

function relations(row: Row, snapshots: Snapshots, unknown: string[]) {
  const value = row.value;
  const output: (ReturnType<typeof target> & { via: string })[] = [];
  const add = (kind: string, id: unknown, characterId: unknown = null, via = '') => {
    if (validId(id)) output.push({ ...target(kind, id, characterId), via });
  };
  if (row.kind === 'blueprint') {
    add('character', value.characterId, null, 'characterId');
    if (!validId(value.characterId)) unknown.push(`${row.file}#${row.id}: characterId unknown`);
    if (validId(value.outfitId)) add('outfit', value.outfitId, value.characterId, 'outfitId');
    else {
      const characters = snapshots.popular?.rows.filter(r => r.role === 'source' && r.kind === 'character' && r.id === value.characterId) || [];
      const outfits = characters.length === 1 ? characters[0].value.outfits : null;
      const validOutfits = Array.isArray(outfits) && outfits.every(object) ? outfits : [];
      const defaults = validOutfits.filter(o => o.default === true);
      if (validOutfits.length && validOutfits.every(o => typeof o.default === 'boolean' && typeof o.isDefault === 'boolean' && o.default === o.isDefault)
        && defaults.length === 1 && validOutfits.filter(o => o.id === defaults[0].id).length === 1) {
        add('outfit', defaults[0].id, value.characterId, 'proven-default-outfit');
      } else unknown.push(`${row.file}#${row.id}: omitted outfit has no unique consistent default; runtime fallback not assumed`);
    }
  } else if (row.kind === 'scene') {
    add('character', value.char, null, 'char');
    for (const characterId of Array.isArray(value.character) ? value.character : []) {
      add('character', characterId, null, 'character[]');
      if (!validId(characterId)) unknown.push(`${row.file}#${row.id}: character[] contains unknown id ${characterId}`);
    }
    if (validId(value.outfitId)) add('outfit', value.outfitId, value.char, 'outfitId');
    else if (value.outfitId !== undefined) unknown.push(`${row.file}#${row.id}: outfitId is not a valid id`);
  } else if (row.kind === 'outfit' || row.kind === 'reference-outfit') {
    add('character', row.characterId, null, 'owner');
    if (row.kind === 'reference-outfit') {
      add('outfit', row.id, row.characterId, 'outfitId');
      if (value.references !== undefined && !Array.isArray(value.references)) unknown.push(`${row.file}#${row.id}: reference perspectives unknown`);
      for (const reference of Array.isArray(value.references) ? value.references : []) {
        const id = object(reference) ? reference.id : undefined;
        add('perspective', id, null, 'references[].id');
        if (!validId(id)) unknown.push(`${row.file}#${row.id}: references[] contains unknown perspective id ${id}`);
      }
    }
  } else if (row.kind === 'reference-character') add('character', row.id, null, 'character-id');
  else if (row.kind === 'curation' || row.kind === 'retired') add('scene', row.id, null, 'scene-id');
  else if (row.kind === 'profile') {
    const ids = object(value.lora) ? value.lora.recommended_scene : undefined;
    if (ids !== undefined && !Array.isArray(ids)) unknown.push(`${row.file}#${row.id}: lora.recommended_scene unknown`);
    for (const id of Array.isArray(ids) ? ids : []) {
      add('scene', id, null, 'lora.recommended_scene');
      if (!validId(id)) unknown.push(`${row.file}#${row.id}: lora.recommended_scene contains unknown scene id ${id}`);
    }
  }
  return output;
}

function targetExists(snapshots: Snapshots, relation: ReturnType<typeof target>): boolean {
  const rows = (domain: string, kind: string) => snapshots[domain]?.rows.filter(row => row.role === 'source' && row.kind === kind) || [];
  if (relation.kind === 'character') {
    return relation.id === 'triad'
      || rows('characters', 'profile').some(row => row.id === relation.id)
      || rows('popular', 'character').some(row => row.id === relation.id)
      || rows('references', 'reference-character').some(row => row.id === relation.id);
  }
  if (relation.kind === 'outfit') {
    return rows('popular', 'outfit').some(row => row.id === relation.id && row.characterId === relation.characterId)
      || rows('references', 'reference-outfit').some(row => row.id === relation.id && row.characterId === relation.characterId);
  }
  if (relation.kind === 'scene') return rows('scenes', 'scene').some(row => row.id === relation.id);
  if (relation.kind === 'perspective') return rows('references', 'perspective').some(row => row.id === relation.id);
  return false;
}

function relationshipIssues(snapshots: Snapshots, { keys }: { keys?: ReadonlySet<string> } = {}) {
  const issues = [];
  const selected = (row: Row) => !keys || keys.has(row.key);
  const popular = snapshots.popular?.groups['popular:source'];
  const blueprints = snapshots.blueprints?.groups['blueprints:source'];
  if (popular?.complete) for (const character of popular.rows.filter(r => r.kind === 'character')) {
    const outfits = character.value.outfits;
    if (!Array.isArray(outfits) || !outfits.every(object)) continue;
    if (!selected(character) && !outfits.some(o => keys?.has(keyFor('outfit', o.id, character.id)))) continue;
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
      const candidates = popular.rows.filter(r => r.kind === 'character' && r.id === bp.value.characterId);
      if (!candidates.length) issues.push({ domain: 'blueprints', file: bp.file, id: bp.id, reason: 'dangling characterId' });
      else if (candidates.length === 1 && validId(bp.value.outfitId) && Array.isArray(candidates[0].value.outfits)
        && !candidates[0].value.outfits.some((o: unknown) => object(o) && o.id === bp.value.outfitId)) {
        issues.push({ domain: 'blueprints', file: bp.file, id: bp.id, reason: `dangling outfitId ${bp.value.characterId}/${bp.value.outfitId}` });
      }
    }
  }
  const scenes = snapshots.scenes?.groups['scenes:source'];
  if (scenes?.complete) for (const domain of ['curation', 'retired']) {
    const group = snapshots[domain]?.groups[`${domain}:source`];
    if (!group?.complete) continue;
    for (const row of group.rows) {
      if (!selected(row)) continue;
      const exists = scenes.rows.some(scene => scene.id === row.id);
      if ((domain === 'curation' && !exists) || (domain === 'retired' && exists)) issues.push({ domain, file: row.file, id: row.id,
        reason: domain === 'curation' ? 'curation references absent scene' : 'retired ID is still active' });
    }
  }
  const seen = new Set(issues.map(issue => `${issue.domain}|${issue.file}|${issue.id}|${issue.reason}`));
  for (const snapshot of Object.values(snapshots)) {
    if (!snapshot) continue;
    const group = snapshot.groups[`${snapshot.domain}:source`];
    if (!group?.complete) continue;
    for (const row of group.rows) {
      if (!selected(row) || snapshot.domain === 'retired') continue;
      for (const relation of relations(row, snapshots, [])) {
        if (targetExists(snapshots, relation)) continue;
        const issue = { domain: snapshot.domain, file: row.file, id: row.id,
          reason: `dangling ${relation.kind} ${relation.characterId ? `${relation.characterId}/` : ''}${relation.id} via ${relation.via}` };
        const key = `${issue.domain}|${issue.file}|${issue.id}|${issue.reason}`;
        if (!seen.has(key)) { seen.add(key); issues.push(issue); }
      }
    }
  }
  return issues;
}

export = { relations, relationshipIssues, target };
