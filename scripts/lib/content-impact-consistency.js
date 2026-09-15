'use strict';
const { loadDomain } = require('./content-history-snapshot');
const { compareReferenceProjection } = require('../maintenance/content-impact-references');

// Only import pure inspection functions. In particular do not import builders,
// stores with a process-global root, or the production-data contract test suite.
function inspectDomain(reader, domain) {
  const snapshot = loadDomain(reader, domain);
  if (domain === 'references') {
    try {
      const check = compareReferenceProjection(reader.json('data/character-reference-standards.json'), reader.json('data/character-reference-view.json'));
      snapshot.checks.push(check);
      snapshot.issues.push(...check.issues);
      if (check.status === 'unknown') { snapshot.complete = false; snapshot.unknown.push(check.reason); }
    } catch (error) { snapshot.complete = false; snapshot.unknown.push(error.message); }
  }
  return snapshot;
}

function summarizeConsistency(snapshot) {
  return { domain: snapshot.domain, status: snapshot.issues.length ? 'mismatch' : !snapshot.complete ? 'unknown'
    : snapshot.checks.length ? 'current' : 'not-derived',
  scope: 'Explicit JSON projections/fields only; no build, rendering or full-library validation',
  groups: Object.entries(snapshot.groups).map(([name, group]) => ({ name, complete: group.complete })),
  checks: snapshot.checks, issues: snapshot.issues, unknown: snapshot.unknown,
  untracked: ['compressed products', 'DATA_VERSION', 'schema/semantic validation', 'asset existence and review authenticity'] };
}

module.exports = { inspectDomain, summarizeConsistency };
