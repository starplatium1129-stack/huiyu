import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';
const { isDeepStrictEqual: equal }: typeof import('node:util') = require('node:util');
const { object, validId, canonicalSceneId }: typeof import('./content-history-reader') = require('./content-history-reader');

const TIERS = ['curatedSceneIds', 'signatureSceneIds', 'personaCoreSceneIds'];
const PRODUCTS: Record<string, string> = { popular: 'data/popular-characters.json', blueprints: 'data/scene-blueprints.json', scenes: 'data/scenes.json' };
const ENTITY: Record<string, string> = { popular: 'character', blueprints: 'blueprint', scenes: 'scene', characters: 'profile', curation: 'curation', retired: 'retired' };
const keyFor = (kind: string, id: any, characterId: any = null) => JSON.stringify([kind, characterId, id]);

function loadDomain(reader: { json: (file: string) => any; read: (file: string) => any; list: (dir: string) => string[]; }, domain: string) {
  const result: any = { domain, complete: true, rows: [], groups: {}, metadata: {}, unknown: [], issues: [], checks: [], files: [] };
  const issue = (file: string, reason: string) => result.issues.push({ file, reason });
  const unknown = (file: string, reason: string) => { result.complete = false; result.unknown.push(`${file}: ${reason}`); };
  const json = (file: string) => {
    if (!result.files.includes(file)) result.files.push(file);
    return reader.json(file);
  };
  const read = (file: string, validate: (v: any) => boolean): any => {
    const value = json(file);
    if (!validate(value)) throw new Error(`${file}: invalid container/IDs`);
    return value;
  };
  const validRows = (rows: any, scene: any = false) => Array.isArray(rows) && rows.every((row: any) => object(row) && (scene ? canonicalSceneId(row.id) : validId(row.id)));
  const put = (group: string, file: string, kind: string, id: any, value: any, extra: Record<string, any> = {}) => {
    const row: any = { group, file, domain, role: group.includes(':derived:') ? 'derived' : 'source', kind, id, value, ...extra };
    row.key = keyFor(kind, id, kind.includes('outfit') ? row.characterId : null);
    result.rows.push(row);
    result.groups[group] ||= { complete: true, rows: [] };
    result.groups[group].rows.push(row);
  };
  const entities = (group: string, file: string, values: any[]) => {
    result.groups[group] ||= { complete: true, rows: [] };
    for (const row of values) {
      put(group, file, ENTITY[domain], row.id, row);
      if (domain !== 'popular') continue;
      if (!validRows(row.outfits)) { result.groups[group].complete = false; unknown(file, `${row.id}: outfits invalid`); continue; }
      for (const outfit of row.outfits) put(group, file, 'outfit', outfit.id, outfit, { characterId: row.id });
    }
  };
  const metadata = (file: string, value: { [s: string]: any; }|ArrayLike<any>, omit: string|string[]) => {
    result.metadata[file] = Object.fromEntries(Object.entries(value).filter(([key]: any) => !omit.includes(key)));
  };
  const product = (file: string, expected: any, validate: (v: any) => boolean, rowSelector: (v: any) => any = (v: any) => v) => {
    try {
      const actual = read(file, validate);
      const group = `${domain}:derived:${file}`;
      if (ENTITY[domain] && domain !== 'curation') entities(group, file, rowSelector(actual));
      if (object(actual)) metadata(file, actual, ['characters', 'blueprints']);
      const status = expected === undefined ? 'unknown' : equal(actual, expected) ? 'current' : 'mismatch';
      const raw = reader.read(file).raw;
      result.checks.push({ file, status, comparison: 'JSON structure, values and array order',
        serialization: expected === undefined ? 'unknown' : raw === JSON.stringify(expected, null, 2) + '\n' ? 'current' : 'different',
        scope: 'domain-projection', sourceFiles: [...new Set([`data/${domain}/manifest.json`,
          ...result.rows.filter((row: any) => row.role === 'source').map((row: any) => row.file),
          ...(file === 'data/scenes-core.json' ? ['data/curation.json'] : [])])] });
      if (status === 'mismatch') issue(file, 'source/derived projection mismatch; current snapshot, not attributed to this change');
      if (status === 'unknown') unknown(file, 'source projection could not be proved');
    } catch (error) {
      result.groups[`${domain}:derived:${file}`] = { complete: false, rows: [] };
      result.checks.push({ file, status: 'unknown', reason: runtimeErrorMessage(error), scope: 'domain-projection' });
      unknown(file, runtimeErrorMessage(error));
    }
  };

  if (Object.hasOwn(PRODUCTS, domain)) {
    const directory = `data/${domain}`;
    const sourceGroup = `${domain}:source`;
    result.groups[sourceGroup] = { complete: true, rows: [] };
    const recordsKey = domain === 'popular' ? 'characters' : 'blueprints';
    const shape = domain === 'scenes' ? (v: any) => validRows(v, true) : (v: any) => object(v) && validRows(v[recordsKey]);
    let sourceComplete = true;
    const sourceRows: any[] = [];
    try {
      const manifestFile = `${directory}/manifest.json`;
      const manifest = read(manifestFile, (v: any) => object(v) && Array.isArray((v as any).files)
        && (v as any).files.every((e: any) => object(e) && typeof e.file === 'string' && /^[^/\\:\x00]+\.json$/.test(e.file)
          && e.file !== 'manifest.json' && e.file !== '..json')
        && new Set((v as any).files.map((e: any) => e.file)).size === (v as any).files.length);
      result.metadata[manifestFile] = manifest;
      if (!manifest.files.length) issue(manifestFile, 'empty source manifest is not accepted by the store builder');
      const names = reader.list(directory);
      const managed = new Set(['manifest.json']);
      for (const entry of manifest.files) {
        let files = [entry.file];
        try {
          if (domain === 'scenes') {
            const stem = entry.file.slice(0, -5);
            const batches = names.filter((file: string) => file.startsWith(`${stem}.`) && /^\d+\.json$/.test(file.slice(stem.length + 1)))
              .sort((a: string, b: string) => Number(a.slice(stem.length + 1, -5)) - Number(b.slice(stem.length + 1, -5)));
            if (batches.length) {
              files = batches;
              if (names.includes(entry.file) || batches.some((file: string, i: number) => file !== `${stem}.${i + 1}.json`)) throw new Error('ambiguous source: batch gap/noncanonical number or single file coexists');
            }
          }
          const loaded: any[] = [];
          for (const name of files) {
            managed.add(name);
            const file = `${directory}/${name}`;
            const value = read(file, shape);
            const rows = domain === 'scenes' ? value : value[recordsKey];
            if (domain !== 'scenes') metadata(file, value, [recordsKey]);
            for (const row of rows) loaded.push({ file, row });
          }
          if (entry.count !== undefined && (!Number.isInteger(entry.count) || entry.count !== loaded.length)) issue(manifestFile, `${entry.file}: count mismatch`);
          for (const { file, row } of loaded) {
            if (domain === 'scenes' && entry.character && row.char && entry.character !== row.char) issue(file, `${row.id}: char conflicts with manifest character`);
            entities(sourceGroup, file, [row]);
            sourceRows.push(row);
          }
        } catch (error) { sourceComplete = false; unknown(`${directory}/${entry.file}`, runtimeErrorMessage(error)); }
      }
      for (const file of names) if (file.endsWith('.json') && !managed.has(file)) {
        sourceComplete = false;
        unknown(`${directory}/${file}`, 'unregistered source file; no authoritative membership inferred');
      }
    } catch (error) { sourceComplete = false; unknown(directory, runtimeErrorMessage(error)); }
    result.groups[sourceGroup].complete &&= sourceComplete;
    if (domain === 'scenes' && sourceRows.some((row) => !Number.isSafeInteger(Number(row.id.slice(2))))) {
      sourceComplete = false;
      result.groups[sourceGroup].complete = false;
      unknown(directory, 'scene numeric ordering exceeds the current store safe-integer range');
    }
    if (domain === 'scenes') sourceRows.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    const expected = sourceComplete ? domain === 'scenes' ? sourceRows : { version: domain === 'popular' ? 1 : 2, [recordsKey]: sourceRows } : undefined;
    product(PRODUCTS[domain], expected, shape, (value: any) => domain === 'scenes' ? value : value[recordsKey]);
    if (domain === 'scenes') {
      const grouped: Record<string, any[]> = { nene: [], natsume: [], shared: [] };
      const seen = new Set();
      for (const scene of sourceRows) {
        if (seen.has(scene.id)) continue;
        seen.add(scene.id);
        grouped[scene.char === 'natsume' ? 'natsume' : scene.char === 'triad' ? 'shared' : 'nene'].push(scene);
      }
      for (const [group, rows] of Object.entries(grouped)) product(`data/scenes-${group}.json`, sourceComplete ? rows : undefined, shape);
      let coreIds: any;
      try {
        const curation = read('data/curation.json', (v: any) => object(v) && TIERS.every((tier) => Array.isArray((v as any)[tier]) && (v as any)[tier].every(canonicalSceneId)));
        result.metadata['data/curation.json'] = curation;
        coreIds = curation.personaCoreSceneIds.slice(0, 2000).filter((id: any) => seen.has(id));
      } catch (error) { unknown('data/curation.json', runtimeErrorMessage(error)); }
      const byId = new Map(sourceRows.map((row) => [row.id, row]));
      product('data/scenes-core.json', sourceComplete && coreIds ? coreIds.map((id: any) => byId.get(id)) : undefined, shape);
      const index = sourceComplete && coreIds ? { version: 1, total: sourceRows.length,
        shards: Object.fromEntries(Object.entries(grouped).map(([key, rows]: any) => [key, { file: `scenes-${key}.json`, count: rows.length }])),
        tiers: { core: coreIds }, orderedIds: sourceRows.map((row) => row.id) } : undefined;
      // Index contains global ordering/count constraints, not scene records.
      try {
        const actual = read('data/scenes-index.json', object);
        result.metadata['data/scenes-index.json'] = actual;
        const status = index === undefined ? 'unknown' : equal(actual, index) ? 'current' : 'mismatch';
        result.checks.push({ file: 'data/scenes-index.json', status, scope: 'global-counts-order-tiers', comparison: 'JSON projection' });
        if (status === 'mismatch') issue('data/scenes-index.json', 'source/derived counts, ordering or core membership mismatch');
        if (status === 'unknown') unknown('data/scenes-index.json', 'projection unknown');
      } catch (error) { unknown('data/scenes-index.json', runtimeErrorMessage(error)); }
    }
  } else if (['characters', 'curation', 'retired'].includes(domain)) {
    const file = ({ characters: 'data/characters.json', curation: 'data/curation.json', retired: 'data/retired-scenes.json' } as Record<string, string>)[domain]!;
    const group = `${domain}:source`;
    result.groups[group] = { complete: true, rows: [] };
    try {
      const value: any = json(file);
      if (domain === 'characters') {
        if (!validRows(value)) throw new Error('invalid profile IDs');
        entities(group, file, value);
      } else if (domain === 'retired') {
        if (!object(value) || !validRows(value.records, true)) throw new Error('invalid retired records');
        entities(group, file, value.records);
        metadata(file, value, ['records']);
      } else {
        if (!object(value) || !TIERS.every((tier) => Array.isArray(value[tier]) && value[tier].every(canonicalSceneId))) throw new Error('invalid curation tiers');
        for (const id of new Set(TIERS.flatMap((tier) => value[tier]))) {
          put(group, file, 'curation', id, { id, tiers: TIERS.filter((tier) => value[tier].includes(id)) });
        }
        // Order and repeated members matter even when the per-ID membership is unchanged.
        result.metadata[file] = value;
        for (const tier of TIERS) if (new Set(value[tier]).size !== value[tier].length) issue(file, `${tier}: duplicate member IDs`);
      }
    } catch (error) { result.groups[group].complete = false; unknown(file, runtimeErrorMessage(error)); }
  } else if (domain === 'references') {
    for (const [role, file] of [['source', 'data/character-reference-standards.json'], ['derived', 'data/character-reference-view.json']]) {
      const group = role === 'source' ? 'references:source' : `references:derived:${file}`;
      result.groups[group] = { complete: true, rows: [] };
      try {
        const value: any = json(file);
        if (!object(value)) throw new Error('invalid reference container');
        const characters: any = role === 'source' ? value.characters : Object.entries(value).map(([id, row]: any) => ({ ...row, id }));
        if (!validRows(characters) || characters.some((row: any) => !Array.isArray(row.outfits)
          || row.outfits.some((outfit: any) => !object(outfit) || !validId(role === 'source' ? outfit.id : outfit.outfitId)
            || (role === 'derived' && (!Array.isArray(outfit.references) || outfit.references.some((ref: any) => !object(ref) || !validId(ref.id))))))) throw new Error('invalid reference character/outfit records');
        if (role === 'source') {
          if (!validRows(value.perspectives)) throw new Error('invalid perspective IDs');
          for (const perspective of value.perspectives) put(group, file, 'perspective', perspective.id, perspective);
          metadata(file, value, ['characters', 'perspectives']);
        }
        for (const character of characters) {
          put(group, file, 'reference-character', character.id, character);
          for (const outfit of character.outfits) {
            const id = role === 'source' ? outfit?.id : outfit?.outfitId;
            if (!object(outfit) || !validId(id)) throw new Error('invalid reference outfit ID');
            put(group, file, 'reference-outfit', id, outfit, { characterId: character.id });
          }
        }
      } catch (error) {
        result.groups[group].complete = false;
        unknown(file, runtimeErrorMessage(error));
      }
    }
  } else unknown(domain, 'untracked domain');

  for (const [group, data] of Object.entries<any>(result.groups)) {
    const keys = new Set();
    for (const row of data.rows) {
      if (keys.has(row.key)) { issue(row.file, `${row.kind} ${row.id}: duplicate stable ID (${group})`); data.complete = false; }
      keys.add(row.key);
    }
    if (!data.complete) result.complete = false;
  }
  return result;
}

export = { loadDomain, TIERS, PRODUCTS, keyFor };
