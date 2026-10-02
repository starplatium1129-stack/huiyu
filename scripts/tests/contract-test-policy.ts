/** Reviewed ownership boundaries, not a blanket permission to parallelize new tests. */
const CONTRACT_ISOLATION: Readonly<Record<string, { cost: number; fixture: string }>> = Object.freeze({
  'test-maintenance-recovery.js': { cost: 48, fixture: 'maintenance-recovery-fixture: unique tmp root, owned fork handles and leases' },
  'test-maintenance-recovery-boundaries.js': { cost: 7, fixture: 'maintenance-recovery-fixture: unique tmp root and owned fork handles' },
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
