import { spawnSync } from 'node:child_process';
import path = require('node:path');
const { QUALITY_TEST_SUITES }: typeof import('./quality-test-inventory') = require('./quality-test-inventory');
const { printExcerpt, root }: typeof import('./run-quality-suite') = require('./run-quality-suite');
const { runTestProcessPool }: typeof import('../lib/test-process-pool') = require('../lib/test-process-pool');

const optional = ['tooling', 'release'] as const;
type OptionalLane = typeof optional[number];
interface OptionalSelection { lane: OptionalLane; files: readonly string[] }

// Explicit consumers include VM/CLI callers that a static import graph cannot discover.
const runnerTests = ['test-workflow-runner.js', 'test-quality-report.js', 'test-test-process-pool.js', 'test-quality-gates.js'];
const buildTests = ['test-typescript-build.js', 'test-typescript-development.js', 'test-runtime-generated.js', 'test-quality-gates.js'];
const TEST_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  'start.ps1': ['test-desktop-staging.js'],
  'control.bat': ['test-desktop-staging.js'],
  'scripts/workflow.ts': ['test-workflow-runner.js', 'test-workflow-conditions.js'],
  'scripts/lib/workflow-legacy.ts': ['test-workflow-runner.js', 'test-workflow-conditions.js'],
  'scripts/lib/rust-check-plan.ts': ['test-workflow-runner.js'],
  'scripts/maintenance/run-rust-runtime.ts': ['test-workflow-runner.js'],
  'scripts/maintenance/check-native-rust.ts': ['test-workflow-runner.js'],
  'scripts/lib/workflow-runner.ts': ['test-workflow-runner.js', 'test-workflow-conditions.js'],
  'scripts/lib/workflow-types.ts': ['test-workflow-runner.js', 'test-workflow-conditions.js'],
  'scripts/maintenance/report-workflow-conditions.ts': ['test-workflow-conditions.js'],
  'scripts/maintenance/gate-quick.ts': runnerTests,
  'scripts/tests/extract-wd14-untranslated.ts': ['test-untranslated-tags.js'],
  'scripts/tests/run-optional-test-lanes.ts': runnerTests,
  'scripts/tests/run-quality-suite.ts': runnerTests,
  'scripts/lib/test-process-pool.ts': runnerTests,
  'scripts/tests/contract-test-policy.ts': runnerTests,
  'scripts/tests/quality-report.ts': ['test-quality-report.js'],
  'scripts/maintenance/check-doc-links.ts': ['test-doc-redirects.js'],
  'scripts/lib/scene-write.ts': ['test-scene-write.js'],
  'scripts/lib/scene-change-set.ts': ['test-scene-change-set.js'],
  'scripts/maintenance/apply-scene-patch.ts': ['test-scene-patch.js'],
  'scripts/build-node.mts': buildTests,
  '.github/workflows/quality.yml': ['test-quality-gates.js', 'test-e2e-ci-split.js'],
  '.github/workflows/rust-runtime.yml': ['test-quality-gates.js'],
  '.github/workflows/windows-native.yml': ['test-quality-gates.js'],
  '.github/workflows/nightly-e2e.yml': ['test-quality-gates.js', 'test-e2e-ci-split.js'],
};
function consumerTests(file: string): readonly string[] | undefined {
  return TEST_CONSUMERS[file.replace(/\\/g, '/').replace(/\.mjs$/, '.mts').replace(/\.js$/, '.ts')];
}

function selectOptionalTests(files: readonly string[]): OptionalSelection[] {
  const selected = new Map<OptionalLane, Set<string>>();
  const includeLane = (lane: OptionalLane) => selected.set(lane, new Set(QUALITY_TEST_SUITES[lane]));
  const all = () => optional.map(lane => ({ lane, files: QUALITY_TEST_SUITES[lane] }));
  for (const raw of files) {
    const file = raw.replace(/\\/g, '/');
    if (/\.md$/.test(file) || /^docs\//.test(file)) continue;
    const consumers = consumerTests(file);
    if (consumers) {
      for (const name of consumers) {
        const lane = optional.find(lane => QUALITY_TEST_SUITES[lane].includes(name));
        if (!lane) continue;
        if (!selected.has(lane)) selected.set(lane, new Set());
        selected.get(lane)!.add(name);
      }
      continue;
    }
    const test = /^scripts\/tests\/(test-[^/]+)\.(ts|mts|js|mjs)$/.exec(file);
    if (test) {
      const name = test[1] + (['mts', 'mjs'].includes(test[2]) ? '.mjs' : '.js');
      const lane = optional.find(lane => QUALITY_TEST_SUITES[lane].includes(name));
      if (lane) {
        if (!selected.has(lane)) selected.set(lane, new Set());
        selected.get(lane)!.add(name);
      } else if (!Object.values(QUALITY_TEST_SUITES).some(files => files.includes(name))) return all();
      continue;
    }
    if (/^(package(?:-lock)?\.json|.*config\.[^/]+)$/.test(file) || /^\.github\//.test(file)) return all();
    if (/^runtime-rs\/(?:src\/|tests\/.*\.(?:rs|json)$|Cargo\.(?:toml|lock)$)/.test(file)) continue;
    if (/^runtime-rs\/native-/.test(file)) includeLane('release');
    else if (/^runtime-rs\//.test(file)) continue;
    else if (/^desktop-tauri\//.test(file) || file === 'deploy-desktop.bat'
      || /^src\/(platform\/desktop|types\/live2dNative|utils\/live2dNativeAdapter)/.test(file)) includeLane('release');
    else if (/^scripts\/maintenance\//.test(file)) {
      includeLane('tooling');
      if (/(desktop|tauri|installer|release|resource|offline|model-download)/.test(file)) includeLane('release');
    } else if (/^scripts\//.test(file) || /^tools\//.test(file)) return all();
    else if (!/^(src|data|assets|public|css)\//.test(file) && file !== 'index.html') return all();
  }
  return optional.filter(lane => selected.has(lane)).map(lane => ({
    lane, files: QUALITY_TEST_SUITES[lane].filter(file => selected.get(lane)!.has(file)),
  }));
}

function changedFiles(): string[] {
  if (process.env.CI && !process.env.AICS_HYGIENE_BASE_REF) throw new Error('Missing CI baseline; run all optional lanes');
  const base = process.env.AICS_HYGIENE_BASE_REF || 'HEAD';
  if (!/^(HEAD|[a-f0-9]{40,64})$/i.test(base) || /^0+$/.test(base)) throw new Error('Unavailable Git baseline; run all optional lanes');
  const collect = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error('Cannot read Git changes; run all optional lanes');
    return result.stdout.split('\0').filter(Boolean);
  };
  return [...collect(['diff', '--name-only', '-z', base, '--']), ...collect(['ls-files', '-z', '--others', '--exclude-standard'])];
}

async function main() {
  let selection: OptionalSelection[];
  try { selection = selectOptionalTests(changedFiles()); }
  catch (error) { console.log(String(error)); selection = optional.map(lane => ({ lane, files: QUALITY_TEST_SUITES[lane] })); }
  console.log(`optional tests: ${selection.map(({ lane, files }) => `${lane} ${files.length}/${QUALITY_TEST_SUITES[lane].length}`).join(', ') || 'none (product changes use core/related tests)'}`);
  let code = 0;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
  for (const { lane, files } of selection) {
    if (controller.signal.aborted) return 1;
    const run = await runTestProcessPool([{ name: lane, file: path.join(root, 'scripts/tests/run-quality-suite.js'), args: [lane, ...files] }],
      { cwd: root, jobs: 1, timeoutMs: 900_000, signal: controller.signal });
    const result = run.results[0];
    if (!result) return 1;
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${lane}: ${(result.duration / 1000).toFixed(1)}s`);
    if (!result.ok) { printExcerpt(result.output, lane); code = 1; break; }
  }
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  return code;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
export = { selectOptionalTests, consumerTests, changedFiles, main };
