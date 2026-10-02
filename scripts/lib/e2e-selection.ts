/** Start only the isolated servers needed by exact Playwright file selections.
 * Unknown filters retain both stacks; project=desktop alone also includes specs
 * which explicitly address the gateway. Never reuse an operator's service. */
import path = require('node:path');

const MOCK_SPECS = /(?:flows|anima-quick|office-code|page-experience-flows)\.spec\.ts$/;
const GATEWAY_SPECS = new Set([
  'page-experience-docs.spec.ts', 'page-experience-workspaces.spec.ts', 'interaction-polish.spec.ts',
]);
const VALUE_OPTIONS = new Set([
  '--project', '--grep', '-g', '--grep-invert', '-G', '--output', '--workers', '-j', '--repeat-each',
  '--retries', '--timeout', '--max-failures', '--reporter', '--shard', '--config', '-c',
  '--browser', '--global-timeout', '--last-failed-file', '--run-agents', '--test-list', '--test-list-invert',
  '--trace', '--tsconfig', '--ui-host', '--ui-port', '--update-source-method',
]);

function readSelection(argv: readonly string[], knownSpecs: readonly string[]) {
  const files: string[] = [], projects: string[] = [];
  let unknown = false;
  for (let index = argv[0] === 'test' ? 1 : 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('-')) {
      const [option, inline] = arg.split('=', 2);
      const value = inline ?? (VALUE_OPTIONS.has(option) ? argv[++index] : undefined);
      if (option === '--project') {
        projects.push(value ?? '');
        while (argv[index + 1] && !argv[index + 1].startsWith('-')) projects.push(argv[++index]);
      }
      if (inline === undefined && ['--debug', '--only-changed', '--update-snapshots', '-u'].includes(option)
        && argv[index + 1] && !argv[index + 1].startsWith('-')) index++;
      // Test lists can include files which are absent from positional filters.
      if (option === '--test-list') unknown = true;
      continue;
    }
    const file = path.posix.basename(arg.replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, ''));
    if (!knownSpecs.includes(file)) unknown = true;
    else files.push(file);
  }
  return { files, projects, unknown };
}

/** Bare Playwright runs share the automated lane boundary. Explicit file/regex
 * filters and test lists remain usable for targeted manual/device acceptance. */
function selectE2eSpecs(argv: readonly string[], specs: readonly { file: string; lane: string }[]): string[] {
  const { files, unknown } = readSelection(argv, specs.map(spec => spec.file));
  return specs.filter(spec => files.length || unknown || ['critical', 'nightly'].includes(spec.lane))
    .map(spec => spec.file);
}

function selectE2eServers(argv: readonly string[], knownSpecs: readonly string[]): Array<'web' | 'gateway'> {
  const { files, projects, unknown } = readSelection(argv, knownSpecs);
  if (unknown || projects.some(project => !['desktop', 'flows'].includes(project))) return ['web', 'gateway'];
  if (!files.length) return projects.length === 1 && projects[0] === 'flows' ? ['gateway'] : ['web', 'gateway'];
  const selected = files.filter(file => !projects.length || projects.includes(MOCK_SPECS.test(file) ? 'flows' : 'desktop'));
  return [
    ...(selected.some(file => !MOCK_SPECS.test(file)) ? ['web' as const] : []),
    ...(selected.some(file => MOCK_SPECS.test(file) || GATEWAY_SPECS.has(file)) ? ['gateway' as const] : []),
  ];
}

export = { MOCK_SPECS, GATEWAY_SPECS, selectE2eSpecs, selectE2eServers };
