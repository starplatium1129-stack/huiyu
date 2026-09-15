import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

import { PathLike } from 'node:fs';

const path: typeof import('node:path') = require('node:path');
const { isDeepStrictEqual: equal }: typeof import('node:util') = require('node:util');
const { inspectDomain, summarizeConsistency }: typeof import('./content-impact-consistency') = require('./content-impact-consistency');
const { localReader }: typeof import('./content-history-reader') = require('./content-history-reader');
const { PRODUCTS }: typeof import('./content-history-snapshot') = require('./content-history-snapshot');
const { relations, relationshipIssues }: typeof import('./content-history-relations') = require('./content-history-relations');

const DOMAINS = ['popular', 'blueprints', 'scenes', 'characters', 'curation', 'retired', 'references'];
const CODE_ROOT = path.resolve(__dirname, '../..');
const UNTRACKED = [
  'DATA_VERSION and compressed companions require the full content gate',
  'Unexported popular/blueprint semantic predicates and field readers require the full content gate',
  'Asset existence, human review, rendering and publication are not certified by structure checks',
];

const FIELD_VALIDATION = {
  popular: { rules: ['src/utils/popularContent.ts:parsePopularCharacter', 'content-history-relations.js:relationshipIssues'], unknown: ['Normalized/dropped input fields', 'Complete writer coverage', 'Model semantics'] },
  blueprints: { rules: ['src/utils/popularContent.ts:parseSceneBlueprint', 'content-history-relations.js:relationshipIssues'], unknown: ['Optional normalized fields', 'Complete writer coverage', 'Model semantics'] },
  scenes: { rules: ['content-history-snapshot.js:loadDomain', 'validate-scenes.js scalar prompt/negative/rating/mature contracts'], unknown: ['Unexported full scene policy', 'Rendering', 'Other field readers/writers'] },
  characters: { rules: ['validate-content-contracts.js:validateContent'], unknown: ['Portrait existence', 'Fields outside the exported predicate'] },
  references: { rules: ['scripts/contracts/character-reference-standards.schema.json', 'scripts/contracts/character-reference-view.schema.json', 'content-impact-references.js:compareReferenceProjection'], unknown: ['Assets/review authenticity', 'Writer dependency completeness'] },
};

function selectExecution(report: any, forceFull = false, context: any) {
  const reasons = [];
  if (forceFull) reasons.push('Explicit --full');
  if (!report || report.gitHistory?.status !== 'compared') reasons.push('No proved historical comparison');
  if (report) {
    reasons.push(...report.unknown);
    const knownPaths = new Set((report.evidence?.files || []).map((entry: any) => entry.file));
    for (const snapshots of [context?.before, context?.after]) for (const snapshot of Object.values(snapshots || {})) {
      for (const [file, value] of Object.entries(snapshot.metadata)) if (file.endsWith('/manifest.json')) {
        for (const entry of value.files || []) knownPaths.add(path.posix.join(path.posix.dirname(file), entry.file));
      }
    }
    for (const file of new Set([...(report.gitHistory?.paths || []), ...(report.input?.paths || [])])) {
      if (!knownPaths.has(file)) reasons.push(`${file}: no traced source, product or declared logical group; require full`);
    }
    if (report.history.metadata.length || report.history.ordering.length) reasons.push('Global manifest/order/count projection changed');
    for (const change of report.history.entities) {
      if (!['blueprints', 'scenes'].includes(change.domain) || change.change !== 'modified'
        || !change.beforeComplete || !change.afterComplete
        || change.changedFields.some((field: string) => !['/prompt', '/negative', '/animaCaption'].includes(field))
        || !equal(change.oldRelations, change.newRelations)) reasons.push(`${change.domain}/${change.id}: membership, relation or untracked fields require full structure checks`);
    }
    if (!report.history.entities.length) reasons.push('No record delta proved; explicit targets or an empty diff do not prove a full baseline');
  }
  const mode = reasons.length ? 'full' : 'incremental';
  const targets = (report?.affected || []).filter((row: { impact: string; }) => row.impact === 'revalidate').map((row: any) => row.key);
  return { mode, reasons: [...new Set(reasons)], targets: mode === 'incremental' ? [...new Set(targets)] : null,
    predicateScope: mode === 'full' ? 'all supported structural domains' : 'enumerated stable IDs; complete indexes read for proof',
    fullGate: 'required-not-run', wholeLibrary: 'not-validated' };
}

function outcome(id: string, scope: string|unknown[], issues = [], unknown = []) {
  return { id, scope, executed: true, status: issues.length ? 'failed' : unknown.length ? 'unknown' : 'passed', issues, unknown };
}

function recordEquality(snapshots: { [x: string]: unknown; }, keys: Set<unknown>) {
  const issues = [], unknown = [];
  for (const key of keys) {
    const [kind, , id] = JSON.parse(key);
    const domain = { blueprint: 'blueprints', scene: 'scenes', character: 'popular', outfit: 'popular' }[kind];
    if (!domain) { unknown.push(`${key}: no record projection predicate`); continue; }
    const snapshot: any = snapshots[domain];
    if (!snapshot?.complete) { unknown.push(`${key}: incomplete source/derived index`); continue; }
    const source = snapshot.rows.filter((row: any) => row.role === 'source' && row.key === key);
    if (source.length !== 1) { issues.push({ key, reason: 'Source identity is absent or ambiguous' }); continue; }
    const value = source[0].value;
    for (const [group, data] of Object.entries(snapshot.groups).filter(([name]) => name.includes(':derived:'))) {
      const file = group.slice(group.indexOf(':derived:') + 9);
      let count = 1;
      if (domain === 'scenes' && file !== PRODUCTS.scenes) {
        const owner = value.char === 'natsume' ? 'natsume' : value.char === 'triad' ? 'shared' : 'nene';
        count = file === 'data/scenes-core.json'
          ? snapshot.metadata['data/curation.json'].personaCoreSceneIds.slice(0, 2000).filter((v: unknown) => v === id).length
          : Number(file === `data/scenes-${owner}.json`);
      }
      const actual = data.rows.filter((row: any) => row.key === key);
      if (!data.complete) unknown.push(`${file}: incomplete projection`);
      else if (actual.length !== count || actual.some((row: any) => !equal(row.value, value))) issues.push({ key, file, reason: 'Selected source/derived record mismatch' });
    }
  }
  return outcome('record-equality', [...keys], issues, unknown);
}

function relationCheck(snapshots: { [s: string]: unknown; }|ArrayLike<unknown>, keys?: Set<unknown>|undefined) {
  const unknown = [];
  for (const snapshot of Object.values(snapshots)) {
    if (!snapshot.groups[`${snapshot.domain}:source`]?.complete) unknown.push(`${snapshot.domain}: source relationship coverage incomplete`);
    for (const row of snapshot.rows.filter((row: any) => row.role === 'source' && (!keys || keys.has(row.key)))) relations(row, snapshots, unknown);
  }
  return outcome('source-relationships', keys ? [...keys] : 'all supported source IDs', relationshipIssues(snapshots, { keys }), [...new Set(unknown)]);
}

function runtimeFieldChecks(snapshots: { [s: string]: unknown; }|ArrayLike<unknown>, keys?: Set<unknown>|undefined) {
  const issues = [], unknown = [], coverage = [];
  let parsers;
  try { parsers = (require('../../src/utils/popularContent.ts') as typeof import('../../src/utils/popularContent.ts')); }
  catch (error) { unknown.push(`Existing runtime parsers unavailable: ${runtimeErrorMessage(error)}`); }
  for (const snapshot of Object.values(snapshots)) for (const row of snapshot.rows) {
    if (row.role !== 'source' || (keys && !keys.has(row.key))) continue;
    if (!['character', 'blueprint', 'scene'].includes(row.kind)) continue;
    const value = row.value;
    try {
      if (row.kind === 'scene') {
        // Only these scalar contracts from validate-scenes are claimed here.
        // Prompt semantics, the other required fields and rendering remain full.
        for (const field of ['prompt', 'negative']) if (typeof value[field] !== 'string' || !value[field].trim()) {
          issues.push({ key: row.key, field, reason: 'Scene text field must be a nonempty string' });
        }
        if (value.mature !== undefined && typeof value.mature !== 'boolean') issues.push({ key: row.key, field: 'mature', reason: 'Expected boolean' });
        if (value.rating !== undefined && !['All', 'R15', 'R18'].includes(value.rating)) issues.push({ key: row.key, field: 'rating', reason: 'Unknown rating enum' });
        if ((value.rating === 'R18') !== (value.mature === true)) issues.push({ key: row.key, reason: 'Rating/mature interlock mismatch' });
        coverage.push({ key: row.key, rule: 'validate-scenes scalar fields; full semantic rule not executed', unknownFields: Object.keys(value).filter((field) => !['id', 'prompt', 'negative', 'rating', 'mature'].includes(field)) });
      } else if (parsers) {
        const parsed = row.kind === 'character' ? parsers.parsePopularCharacter(value) : parsers.parseSceneBlueprint(value);
        if (!parsed || parsed.id !== value.id) issues.push({ key: row.key, reason: 'Runtime parser rejected identity' });
        coverage.push({ key: row.key, rule: `src/utils/popularContent.ts:${row.kind === 'character' ? 'parsePopularCharacter' : 'parseSceneBlueprint'}`,
          unknownFields: Object.keys(value).filter((field) => !Object.hasOwn(parsed || {}, field)),
          boundary: 'Runtime parser acceptance only; normalized/dropped fields and model semantics are not certified' });
      }
    } catch (error) { issues.push({ key: row.key, reason: runtimeErrorMessage(error) }); }
  }
  return { ...outcome('runtime-field-contracts', keys ? [...keys] : 'all supported source rows', issues, unknown), coverage };
}

function fullFieldChecks(reader: any, snapshots: any) {
  const checks = [];
  // The exported validator is pure. Do not call its CLI or private I/O helpers.
  try {
    const { validateContent }: typeof import('../maintenance/validate-content-contracts') = require('../maintenance/validate-content-contracts');
    const data = { characters: reader.json('data/characters.json'), loras: reader.json('data/loras.json'), scenes: reader.json('data/scenes.json') };
    const issues = validateContent(data, () => true).map((reason) => ({ reason }));
    checks.push(outcome('existing-core-field-contract', 'validateContent; portrait existence excluded', issues));
  } catch (error) { checks.push(outcome('existing-core-field-contract', 'core fields', [], [runtimeErrorMessage(error)])); }
  for (const name of ['standards', 'view']) {
    try {
      const Ajv: typeof import('ajv') = require('ajv');
      const schema = require(`../contracts/character-reference-${name}.schema.json`);
      const validate = new Ajv({ allErrors: true }).compile(schema);
      const valid = validate(reader.json(`data/character-reference-${name}.json`));
      checks.push(outcome(`existing-reference-${name}-schema`, 'all declared schema fields', valid ? [] : validate.errors.map((error: any) => ({
        path: error.instancePath, schemaPath: error.schemaPath, reason: error.message,
      }))));
    } catch (error) { checks.push(outcome(`existing-reference-${name}-schema`, 'reference fields', [], [runtimeErrorMessage(error)])); }
  }
  const unknown = [];
  for (const domain of ['characters', 'popular', 'blueprints', 'scenes']) {
    const fields = [...new Set((snapshots[domain]?.rows || []).filter((row: { role: string; }) => row.role === 'source').flatMap((row: { value: any; }) => Object.keys(row.value)))];
    unknown.push({ domain, observedFields: fields.sort(), semanticCoverage: 'unknown beyond explicit exported predicates and JSON projections' });
  }
  return { checks, fields: unknown, ruleRoot: CODE_ROOT };
}

function executePredicates(selection: { mode: string; targets: Iterable<unknown>|null|undefined; }, context: any, root: PathLike) {
  const reader = context?.currentReader || localReader(root);
  const snapshots = { ...(context?.after || {}) };
  const checks = [];
  let fieldCoverage: { domain: string; observedFields: unknown[]; semanticCoverage: string; }[] = [];
  if (selection.mode === 'full') {
    for (const domain of DOMAINS) {
      snapshots[domain] ||= inspectDomain(reader, domain);
      const summary = summarizeConsistency(snapshots[domain]);
      checks.push(outcome(`structure-and-projection:${domain}`, 'complete domain', summary.issues, summary.unknown));
    }
    checks.push(relationCheck(snapshots));
    checks.push(runtimeFieldChecks(snapshots));
    const fields = fullFieldChecks(reader, snapshots);
    checks.push(...fields.checks);
    fieldCoverage = fields.fields;
  } else {
    const keys = new Set(selection.targets);
    checks.push(recordEquality(snapshots, keys), relationCheck(snapshots, keys), runtimeFieldChecks(snapshots, keys));
  }
  const drift = reader.verify();
  checks.push(outcome('input-stability', 'all read files and directory membership', [], drift));
  const failed = checks.some((check) => check.status === 'failed');
  const unknown = checks.some((check) => check.status === 'unknown');
  return { executed: true, status: failed ? 'failed' : unknown ? 'incomplete' : 'passed-scoped',
    selection, checks, fieldCoverage, untracked: UNTRACKED,
    fullGate: { status: 'required-not-run', reason: 'These predicates do not replace the full content gate; no implicit-writing builder was invoked' },
    evidence: [...reader.evidence.values()], wholeLibrary: 'not-validated', exitCode: failed ? 1 : 3 };
}

export = { DOMAINS, UNTRACKED, FIELD_VALIDATION, selectExecution, executePredicates, recordEquality, relationCheck, fullFieldChecks, runtimeFieldChecks };
