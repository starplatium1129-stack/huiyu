/** Reviewed ownership boundaries, not a blanket permission to parallelize new tests. */
const CONTRACT_ISOLATION: Readonly<Record<string, { cost: number; fixture: string }>> = Object.freeze({
  'test-maintenance-blueprint-transaction.js': { cost: 120, fixture: 'aics-blueprint-save-* tmp root; AICS_DATA_ROOT/AICS_APP_ROOT; HTTP listen(0)' },
  'test-maintenance-recovery.js': { cost: 48, fixture: 'maintenance-recovery-fixture: unique tmp root, owned fork handles and leases' },
  'test-scene-maintenance-save.js': { cost: 39, fixture: 'aics-scenes-save-* tmp root; AICS_DATA_ROOT; HTTP listen(0)' },
  'test-maintenance-transaction-routes.js': { cost: 18, fixture: 'maintenance-transaction-route-fixture: unique tmp project and HTTP listen(0)' },
  'test-anima-routes.js': { cost: 18, fixture: 'gateway-test-stack: unique runtime, mock upstreams and HTTP listen(0); cleanup fixture in tmp' },
  'test-maintenance-read-barrier.js': { cost: 16, fixture: 'maintenance-recovery-fixture: unique tmp root; HTTP listen(0)' },
  'test-resource-gateway.js': { cost: 10, fixture: 'resource-gateway-fixture: unique program/runtime/artwork roots and HTTP listen(0)' },
  'test-maintenance-recovery-boundaries.js': { cost: 7, fixture: 'maintenance-recovery-fixture: unique tmp root and owned fork handles' },
  'test-resource-reference-gateway.js': { cost: 2, fixture: 'resource-gateway-fixture: unique program/runtime/artwork roots and HTTP listen(0)' },
});

function contractJobs(value = process.env.CONTRACT_TEST_JOBS): number {
  if (value === undefined) return 2;
  if (!/^[1-4]$/.test(value)) throw new Error('CONTRACT_TEST_JOBS must be an integer from 1 to 4');
  return Number(value);
}

function planContractTests(files: readonly string[], jobs: number) {
  // jobs=1 preserves the original order for reproducible serial comparisons.
  const parallel = jobs === 1 ? [] : files.filter(file => Object.hasOwn(CONTRACT_ISOLATION, file))
    .sort((a, b) => CONTRACT_ISOLATION[b].cost - CONTRACT_ISOLATION[a].cost);
  const selected = new Set(parallel);
  return { parallel, serial: files.filter(file => !selected.has(file)) };
}

export = { CONTRACT_ISOLATION, contractJobs, planContractTests };
