import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';


const { isDeepStrictEqual: equal }: typeof import('node:util') = require('node:util');
const { collectGitHistory }: typeof import('./content-impact-git') = require('./content-impact-git');
const { localReader, canonicalSceneId }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
const { inspectDomain, summarizeConsistency }: typeof import('../lib/content-impact-consistency') = require('../lib/content-impact-consistency');
const { keyFor }: typeof import('../lib/content-history-snapshot') = require('../lib/content-history-snapshot');
const { relations, relationshipIssues, target }: typeof import('../lib/content-history-relations') = require('../lib/content-history-relations');
const { WORKFLOWS }: typeof import('../workflow') = require('../workflow');

function pathDomain(file: string) {
  if (/^data\/popular\//.test(file) || file === 'data/popular-characters.json') return 'popular';
  if (/^data\/blueprints\//.test(file) || file === 'data/scene-blueprints.json') return 'blueprints';
  if (/^data\/scenes\//.test(file) || /^data\/scenes(?:-(?:nene|natsume|shared|core|index))?\.json$/.test(file)) return 'scenes';
  return { 'data/characters.json': 'characters', 'data/curation.json': 'curation', 'data/retired-scenes.json': 'retired',
    'data/character-reference-standards.json': 'references', 'data/character-reference-view.json': 'references' }[file] || null;
}

function fieldDiff(before: any, after: any, prefix: any = ''): any {
  if (equal(before, after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [prefix || '/'];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((field: any) =>
    fieldDiff(before[field], after[field], `${prefix}/${field.replace(/~/g, '~0').replace(/\//g, '~1')}`));
}

function historyImpact(opts: any, captureSnapshots: any) {
  const result: any = { version: 2, readOnly: true,
    input: { base: opts.base, character: opts.character || null, outfit: opts.outfit || null, scene: opts.scene || null, paths: opts.paths || [] },
    mustChange: [], revalidate: [], related: [], unknown: [], recommendations: [], affected: [], consistency: [] };
  const add = (level: string, domain: string, object: string, reason: string) => result[level].push({ domain, object, reason });
  const recommend = (name: string) => {
    const definition = WORKFLOWS[name];
    if (definition && !result.recommendations.some((entry: any) => entry.name === name)) result.recommendations.push({ name,
      argv: ['node', 'scripts/workflow.js', name], nature: definition.run.nature, executed: false });
  };
  const { result: git, baseReader } = collectGitHistory(opts.root, opts.base);
  result.gitHistory = git;
  result.history = { entities: [], metadata: [], ordering: [], baseline: git.baseCommit, comparison: git.comparison,
    assetAcceptance: 'unverified', wholeLibrary: 'not-validated' };
  if (!baseReader) {
    add('mustChange', 'git-history', '--base', git.reason);
    result.unknown.push(git.reason, 'Historical comparison unavailable; no partial Git result used');
    result.incrementalPlan = buildPlan(result, [], ['Historical boundary unknown']);
    return result;
  }
  result.unknown.push(...git.unknown);
  const paths = [...new Set([...git.paths, ...(opts.paths || [])])];
  const direct = new Set<string>(paths.map(pathDomain).filter(Boolean) as string[]);
  if (opts.character) direct.add('popular');
  if (opts.scene) direct.add('scenes');
  const domains = new Set<string>(direct);
  if (direct.has('blueprints')) domains.add('popular');
  if (direct.has('references')) domains.add('popular');
  if (direct.has('popular')) for (const domain of ['blueprints', 'references', 'scenes']) domains.add(domain);
  if (direct.has('characters')) domains.add('scenes');
  if (domains.has('scenes') || direct.has('curation') || direct.has('retired')) {
    for (const domain of ['scenes', 'curation', 'retired', 'characters']) domains.add(domain);
  }
  for (const file of paths) if (!pathDomain(file)) {
    result.unknown.push(`${file}: untracked dependency/field domain; full validation required`);
    add('revalidate', 'untracked', file, 'Unknown or shared implementation path; full checks required, not executed');
  }
  let currentReader;
  try { currentReader = localReader(opts.root); } catch (error) {
    result.unknown.push(runtimeErrorMessage(error));
    add('mustChange', 'root', opts.root, runtimeErrorMessage(error));
    result.incrementalPlan = buildPlan(result, [], ['Working-tree reader unavailable']);
    return result;
  }
  const before: Record<string, any> = {};
  const after: Record<string, any> = {};
  for (const domain of domains) {
    before[domain] = inspectDomain(baseReader, domain);
    after[domain] = inspectDomain(currentReader, domain);
    for (const [side, snapshot] of [['base', before[domain]], ['working-tree', after[domain]]]) {
      result.consistency.push({ side, ...summarizeConsistency(snapshot) });
      result.unknown.push(...snapshot.unknown.map((message: any) => `${side}: ${message}`));
      for (const issue of snapshot.issues) {
        if (side === 'working-tree') add('mustChange', domain, issue.file + (issue.location ? `#${issue.location}` : ''), issue.reason);
        else result.unknown.push(`base: ${issue.file}: ${issue.reason}; baseline cannot certify prior validation`);
      }
    }
  }
  const oldRows = Object.values(before).flatMap((s: any) => s.rows);
  const newRows = Object.values(after).flatMap((s: any) => s.rows);
  const edges = new Map();
  for (const [side, snapshots, rows] of [['base', before, oldRows], ['working-tree', after, newRows]] as [string, any, any[]][]) {
    for (const row of rows) {
      const unknown: string[] = [];
      edges.set(row, { side, targets: relations(row, snapshots, unknown), unknown });
    }
  }
  const seeds = new Set();
  const globalReasons: any[] = [];
  for (const domain of domains) {
    const left = before[domain];
    const right = after[domain];
    for (const group of new Set([...Object.keys(left.groups), ...Object.keys(right.groups)])) {
      const oldGroup = left.groups[group] || { complete: false, rows: [] };
      const newGroup = right.groups[group] || { complete: false, rows: [] };
      const keys = new Set([...oldGroup.rows, ...newGroup.rows].map((row: any) => row.key));
      for (const key of keys) {
        const old = oldGroup.rows.filter((row: any) => row.key === key);
        const current = newGroup.rows.filter((row: any) => row.key === key);
        if (old.length === 1 && current.length === 1 && equal(old[0].value, current[0].value) && old[0].file === current[0].file) continue;
        const row = current[0] || old[0];
        seeds.add(key);
        let change;
        if (old.length > 1 || current.length > 1) change = 'ambiguous';
        else if (!old.length) change = oldGroup.complete ? 'added' : 'unresolved-addition';
        else if (!current.length) change = newGroup.complete ? 'removed' : 'unresolved-removal';
        else if (old[0].file !== current[0].file) change = equal(old[0].value, current[0].value) ? 'moved' : 'modified-and-moved';
        else change = 'modified';
        const oldRelations = old.flatMap((r: any) => edges.get(r).targets);
        const newRelations = current.flatMap((r: any) => edges.get(r).targets);
        const changedFields = old.length === 1 && current.length === 1 ? fieldDiff(old[0].value, current[0].value) : ['/'];
        result.history.entities.push({ ...target(row.kind, row.id, row.characterId || null), domain, role: row.role, group, change, changedFields,
          before: old.map((r: any) => ({ file: r.file, side: 'base' })), after: current.map((r: any) => ({ file: r.file, side: 'working-tree' })),
          beforeComplete: oldGroup.complete, afterComplete: newGroup.complete, oldRelations, newRelations,
          removedRelations: oldRelations.filter((r: any) => !newRelations.some((n: any) => equal(n, r))),
          addedRelations: newRelations.filter((r: any) => !oldRelations.some((n: any) => equal(n, r))) });
        if (change === 'ambiguous' || change.startsWith('unresolved')) result.unknown.push(`${domain}/${row.id}: ${change}; no authoritative absence inferred`);
        if (change !== 'modified' || !equal(oldRelations, newRelations)) globalReasons.push(`${domain}/${row.id}: identity, location or relation membership changed`);
      }
      const beforeKeys = oldGroup.rows.map((row: any) => row.key);
      const afterKeys = newGroup.rows.map((row: any) => row.key);
      if (!equal(beforeKeys, afterKeys)) {
        globalReasons.push(`${group}: global ID set/order requires full comparison`);
        const movedKeys = [...new Set([...beforeKeys, ...afterKeys])].filter((key: any) => beforeKeys.indexOf(key) !== afterKeys.indexOf(key));
        result.history.ordering.push({ domain, group, beforeKeys, afterKeys, affectedKeys: movedKeys,
          status: oldGroup.complete && newGroup.complete ? 'requires-full-check' : 'unknown' });
        for (const key of movedKeys) seeds.add(key);
      }
    }
    for (const file of new Set([...Object.keys(left.metadata), ...Object.keys(right.metadata)])) {
      if (equal(left.metadata[file], right.metadata[file])) continue;
      result.history.metadata.push({ domain, file, changedFields: fieldDiff(left.metadata[file], right.metadata[file]), status: 'requires-full-check' });
      globalReasons.push(`${file}: manifest, ordering, counts or container metadata changed`);
      for (const row of [...left.rows, ...right.rows]) seeds.add(row.key);
      if (file === 'data/scenes-index.json') for (const value of [left.metadata[file], right.metadata[file]]) {
        for (const id of [...(Array.isArray(value?.orderedIds) ? value.orderedIds : []), ...(Array.isArray(value?.tiers?.core) ? value.tiers.core : [])]) {
          if (canonicalSceneId(id)) seeds.add(keyFor('scene', id));
        }
      }
    }
  }
  // Explicit selectors add inspection targets; they never filter away other base differences.
  if (opts.character) seeds.add(keyFor(opts.outfit ? 'outfit' : 'character', opts.outfit || opts.character, opts.outfit ? opts.character : null));
  if (opts.scene) seeds.add(keyFor('scene', opts.scene));
  for (const row of [...oldRows, ...newRows]) if ((opts.paths || []).includes(row.file)) seeds.add(row.key);
  const affected = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of [...oldRows, ...newRows]) {
      if (!affected.has(row.key) && edges.get(row).targets.some((edge: any) => affected.has(edge.key))) {
        affected.add(row.key); grew = true;
      }
    }
  }
  // Include both former and current relation endpoints as context, without
  // recursively treating an unchanged parent as a change to all its children.
  const contexts = new Map();
  for (const row of [...oldRows, ...newRows].filter((r: any) => affected.has(r.key))) {
    for (const edge of edges.get(row).targets) contexts.set(edge.key, edge);
    result.unknown.push(...edges.get(row).unknown.map((message: any) => `${edges.get(row).side}: ${message}`));
  }
  const proofTargets: any[] = [];
  for (const key of new Set([...affected, ...contexts.keys()])) {
    const old = oldRows.filter((row: any) => row.key === key);
    const current = newRows.filter((row: any) => row.key === key);
    const identity = current[0] || old[0] || contexts.get(key);
    if (!identity) { result.unknown.push(`${key}: explicit target not found in either snapshot`); continue; }
    const locations = (rows: any[], side: string, role: string) => rows.filter((r: { role: string; }) => r.role === role).map((r: any) => ({ file: r.file, side }));
    const item: any = { ...target(identity.kind, identity.id, identity.characterId || null),
      impact: affected.has(key) ? 'revalidate' : 'related-context',
      oldRelations: old.flatMap((row: any) => edges.get(row).targets), newRelations: current.flatMap((row: any) => edges.get(row).targets),
      sources: [...locations(old, 'base', 'source'), ...locations(current, 'working-tree', 'source')],
      derived: [...locations(old, 'base', 'derived'), ...locations(current, 'working-tree', 'derived')] };
    result.affected.push(item);
    add(affected.has(key) ? 'revalidate' : 'related', identity.kind, identity.characterId ? `${identity.characterId}/${identity.id}` : identity.id,
      affected.has(key) ? 'Historical changed record or dependency in either snapshot; requires revalidation, no automatic rewrite' : 'Former/current relation endpoint; association alone does not require rewriting');
    if (affected.has(key)) proofTargets.push(item);
  }
  for (const issue of relationshipIssues(after)) add('mustChange', issue.domain, `${issue.file}#${issue.id}`, `${issue.reason} (current authoritative sources)`);
  for (const issue of relationshipIssues(before)) result.unknown.push(`base: ${issue.file}#${issue.id}: ${issue.reason}`);
  // Exact custom fields may be copied by a builder but their readers are not
  // automatically known. Conservative full selection is intentional.
  const scopedFields = new Set(['/prompt', '/negative', '/animaCaption']);
  for (const change of result.history.entities) if (change.changedFields.some((field: string) => !scopedFields.has(field))) {
    globalReasons.push(`${change.domain}/${change.id}: fields outside the narrow record-text predicate require full contracts`);
  }
  if (result.history.entities.length || result.history.metadata.length || result.history.ordering.length) {
    globalReasons.push('DATA_VERSION and compressed products are global/untracked projections; full content validation is required');
    result.revalidate.push({ domain: 'acceptance', object: 'compiled-input/render/review', reason: 'Changed content invalidates associated evidence; actual compilation/rendering and review are not executed or certified by this report' });
  }
  if (opts.showcaseManifests?.length) result.unknown.push('Historical showcase relationships are not tracked; explicitly provided manifests require separate current-state inspection and full coverage review');
  result.unknown.push(...currentReader.verify());
  result.evidence = { baseCommit: git.baseCommit, headCommit: git.headCommit, files: [...baseReader.evidence.values(), ...currentReader.evidence.values()],
    validity: 'Only these snapshot hashes; regenerate the plan after any input change', remoteAccess: false };
  result.unknown = [...new Set(result.unknown)];
  result.incrementalPlan = buildPlan(result, proofTargets, globalReasons);
  recommend('data:validate');
  if (result.incrementalPlan.mode === 'full') recommend('check:content');
  // Internal handoff only: raw records must never become part of the JSON report.
  if (captureSnapshots) captureSnapshots({ before, after, currentReader });
  return result;
}

function buildPlan(result: any, targets: any[], globalReasons: string[]) {
  const unknown = [...result.unknown];
  const reasons = [...new Set([...globalReasons, ...unknown])];
  const byGroup = result.history.entities;
  const proven = byGroup.filter((change: any) => ['popular', 'scenes', 'blueprints'].includes(change.domain)
    && change.beforeComplete && change.afterComplete && change.change !== 'ambiguous'
    && result.consistency.filter((entry: any) => entry.domain === change.domain).length === 2
    && result.consistency.filter((entry: any) => entry.domain === change.domain).every((entry: { groups: any[]; }) => entry.groups.every((group: any) => group.complete)));
  const full = reasons.length > 0;
  return { version: 1, preview: true, executed: false, mode: full ? 'full' : 'incremental',
    wholeLibrary: 'not-validated', baselineAcceptance: 'unknown (a commit identifies input, not a previously passed gate)',
    incrementalChecks: proven.length ? [{ id: 'source-derived-record-equality', nature: ['read-only'], scope: 'only enumerated stable IDs',
      targets: [...new Set(proven.map((item: any) => item.key))], status: 'preview',
      proof: 'Both manifests/containers were read; source and derived records are kept separate; record equality is independent of other IDs. Global ordering/count/version predicates remain full.',
      evidence: 'history.entities + consistency + evidence.files; no reuse after input hashes change' }] : [],
    dependencyChecks: targets.length ? [{ id: 'old-and-new-relationship-closure', nature: ['read-only'], status: unknown.length ? 'requires-full' : 'preview',
      targets: targets.map((row: any) => row.key), proof: 'Union of dependency edges from both snapshots, including former owners/outfits; unknown edges prevent claiming complete incremental coverage' }] : [],
    fullChecks: full ? [{ id: 'full-content-contracts', status: 'required-not-run', reasons }] : [],
    safety: 'No execution entry is provided. Registered recommendations may rebuild data; inspect their nature and isolate/authorize separately.',
    acceptance: 'A scoped equality/relationship pass never means all content, assets or rendering passed' };
}

export = { historyImpact, pathDomain, fieldDiff, buildPlan };
