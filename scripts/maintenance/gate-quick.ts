'use strict';

/**
 * scripts/maintenance/gate-quick.js — 按改动类型分层的精简门禁
 *
 * 用法：
 *   node scripts/maintenance/gate-quick.js                自动检测 git 改动选面积
 *   node scripts/maintenance/gate-quick.js ui|style|rust|data|all|full [--verbose] [--all]
 *
 * 面积 → 步骤：
 *   ui     typecheck:app + vitest；自动模式按导入图选择相关单测，显式 ui 跑全部
 *   style  字面值、双主题对比度、颜色、动画扫描；不跑无关 TS/单测
 *   rust   现行后端 fmt、Clippy 与隔离 Rust 行为测试
 *   data   聚合一致性 + 内容契约 + 分片/参考库/定稿/语料契约（~15 秒）
 *   all    ui + style + rust + data 各领域连跑
 *   full   check 编排 + rust:check + vitest + unit + contract + optional + 生产打包预算。
 *          与 `npm run check` 共用同一份步骤清单，不存在第二套"全量"口径（2026-09-05 P1-03）。
 *
 * 横切重构（目录改名、模块搬迁、依赖变更）请直接用 full——爆炸半径无法事先界定。
 */

const { spawnSync } = (require('node:child_process') as typeof import('node:child_process'));
const path = (require('node:path') as typeof import('node:path'));
const fs: typeof import('node:fs') = require('node:fs');
const { contractJobs }: typeof import('../tests/contract-test-policy') = require('../tests/contract-test-policy');
const { QUALITY_TEST_SUITES, qualityTestMetadata }: typeof import('../tests/quality-test-inventory') = require('../tests/quality-test-inventory');
const { loadLaneManifest }: typeof import('../tests/run-e2e-lane') = require('../tests/run-e2e-lane');
const { writeQualityReport, classifyFailure }: typeof import('../tests/quality-report') = require('../tests/quality-report');
const { runTestProcessPool }: typeof import('../lib/test-process-pool') = require('../lib/test-process-pool');
const {
  runSuiteFiles,
  runUnitSuite,
  runContractSuite,
  runNpmScript,
  printExcerpt,
  formatDuration,
  SUITE_TIMEOUT_MS,
  root,
} = (require('../tests/run-quality-suite') as typeof import('../tests/run-quality-suite'));

const testsDir = path.join(root, 'scripts', 'tests');
interface GateOptions { verbose: boolean; keepGoing: boolean }
type GateArea = 'ui' | 'style' | 'rust' | 'data' | 'tests' | 'browser' | 'full';
interface GatePlan { areas: GateArea[]; testFiles: string[]; frontendFiles?: string[]; browserFiles?: string[] }
const registeredTests = new Map(Object.entries(QUALITY_TEST_SUITES)
  .flatMap(([suite, files]) => files.map(file => [file, suite as keyof typeof QUALITY_TEST_SUITES] as const)));
const browserSpecs = new Set(loadLaneManifest().specs.filter(spec => ['critical', 'nightly'].includes(spec.lane))
  .map(spec => `tests/e2e/${spec.file}`));

async function runTool(name: string, file: string, args: string[], { verbose }: GateOptions) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let step: import('../lib/test-process-pool').TestProcessResult;
  try {
    const { results } = await runTestProcessPool([{ name, file, args }], { cwd: root, jobs: 1, timeoutMs: 600_000, signal: controller.signal });
    step = results[0];
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  step ??= { name, ok: false, reason: 'INTERRUPTED', duration: 0, output: '' };
  writeQualityReport(name, [{ name, status: step.ok ? 'passed' : 'failed', duration: step.duration,
    output: step.output, reason: step.reason, timeoutMs: 600_000,
    failureKind: classifyFailure({ status: step.exitCode ?? (step.ok ? 0 : 1), signal: step.signal,
      error: step.timedOut ? { code: 'ETIMEDOUT' } : step.errorCode ? { code: step.errorCode } : undefined }, step.output) }], step.duration);
  console.log(`${step.ok ? '✔' : '✘'} ${name} ${formatDuration(step.duration)} ${step.reason}`);
  if (verbose) console.log(step.output.trimEnd());
  else if (!step.ok) printExcerpt(step.output, name);
  if (step.ok && /No test files found/.test(step.output)) console.log('没有相关前端单测；本次只完成类型检查，页面风险需定向浏览器验收。');
  return step.ok ? 0 : 1;
}

function runNpmStep(name: string, script: string, timeout: number, verbose: boolean) {
  if (verbose) {
    const started = Date.now();
    const child = spawnSync(`npm run ${script}`, {
      cwd: root,
      stdio: 'inherit',
      timeout,
      shell: true,
    });
    const ok = child.status === 0;
    console.log(`${ok ? '✔' : '✘'} ${name} ${formatDuration(Date.now() - started)}${ok ? '' : ` exit ${child.status ?? '?'}`}`);
    return ok ? 0 : 1;
  }
  const step = runNpmScript(script, timeout);
  if (step.ok) {
    console.log(`✔ ${name} ${formatDuration(step.duration)}`);
    return 0;
  }
  console.log(`✘ ${name} ${formatDuration(step.duration)} ${step.reason}`);
  printExcerpt(step.output, name);
  return 1;
}

const AREA_STEPS = {
  rust(options: GateOptions) {
    return runTool('rust:check', path.join(root, 'scripts/maintenance/run-rust-runtime.js'), ['check'], options);
  },
  tests(files: readonly string[], { verbose, keepGoing }: GateOptions) {
    if (files.some(file => registeredTests.get(file) !== 'check')) {
      (require('../lib/ensure-data-build') as typeof import('../lib/ensure-data-build')).ensureAll({ onlyIfMissing: true });
    }
    return runSuiteFiles(files.map(file => ({
      name: file, file: path.join(testsDir, file), timeoutMs: qualityTestMetadata(file).timeoutMs ?? SUITE_TIMEOUT_MS[registeredTests.get(file)!],
    })), { label: 'changed-tests', timeout: 180_000, verbose, keepGoing });
  },
  async ui({ verbose, keepGoing }: GateOptions, files?: readonly string[]) {
    // App typechecking includes a catalog-backed frontend test. Fresh worktrees
    // need that ignored artifact, not a full data rebuild or a broader test lane.
    (require('../lib/ensure-data-build') as typeof import('../lib/ensure-data-build')).ensurePopularBuilt({ onlyIfMissing: true });
    let code = runNpmStep('typecheck:app', 'typecheck:app', 300_000, verbose);
    if (code === 0 || keepGoing) code = (files?.length
      ? await runTool('vitest related', path.join(root, 'node_modules/vitest/vitest.mjs'),
        ['related', '--run', '--passWithNoTests', ...files], { verbose, keepGoing })
      : runNpmStep('vitest', 'test:frontend', 300_000, verbose)) || code;
    return code;
  },
  browser(files: readonly string[], options: GateOptions) {
    return runTool('changed E2E specs (existing dist)', require.resolve('@playwright/test/cli'),
      ['test', ...files, `--max-failures=${options.keepGoing ? 0 : 1}`], options);
  },
  style({ verbose, keepGoing }: GateOptions) {
    return runSuiteFiles(['scan-style-literals', 'check-contrast', 'lint-colors', 'lint-animations'].map(name => ({
      name, file: path.join(root, 'scripts/maintenance', `${name}.js`), args: ['--check'],
    })), { label: 'style', timeout: 180_000, verbose, keepGoing });
  },
  data({ verbose, keepGoing }: GateOptions) {
    return runSuiteFiles(
      [
        { name: 'build-scenes --check', file: path.join(root, 'scripts', 'maintenance', 'build-scenes.js'), args: ['--check'] },
        { name: 'popular:build --check', file: path.join(root, 'scripts', 'maintenance', 'build-popular.js'), args: ['--check'] },
        { name: 'reference:build --check', file: path.join(root, 'scripts', 'maintenance', 'build-references.js'), args: ['--check'] },
        { name: 'blueprints:build --check', file: path.join(root, 'scripts', 'maintenance', 'build-blueprints.js'), args: ['--check'] },
        { name: 'tags:build --check', file: path.join(root, 'scripts', 'maintenance', 'build-tags.js'), args: ['--check'] },
        { name: 'test-tag-shards', file: path.join(testsDir, 'test-tag-shards.js') },
        { name: 'validate-content-contracts', file: path.join(root, 'scripts', 'maintenance', 'validate-content-contracts.js') },
        { name: 'test-scene-shard-integrity', file: path.join(testsDir, 'test-scene-shard-integrity.js') },
        { name: 'test-popular-shard-integrity', file: path.join(testsDir, 'test-popular-shard-integrity.js') },
        { name: 'test-blueprint-shard-integrity', file: path.join(testsDir, 'test-blueprint-shard-integrity.js') },
        { name: 'test-character-reference-contract', file: path.join(testsDir, 'test-character-reference-contract.js') },
        { name: 'test-pinned-scene-prompts', file: path.join(testsDir, 'test-pinned-scene-prompts.js') },
        { name: 'test-prompt-corpus', file: path.join(testsDir, 'test-prompt-corpus.js') },
      ],
      { label: 'data', timeout: 120_000, verbose, keepGoing },
    );
  },
};

function classifyFiles(files: readonly string[]): GatePlan {
  const areas = new Set<GateArea>();
  const testFiles = new Set<string>();
  const frontendFiles = new Set<string>(), browserFiles = new Set<string>();
  let allFrontend = false;
  const full = (): GatePlan => ({ areas: ['full'], testFiles: [] });
  for (const raw of files) {
    const p = raw.replace(/\\/g, '/');
    if (/^runtime-rs\/(?:src\/|tests\/.*\.(?:rs|json)$|Cargo\.(?:toml|lock)$)/.test(p)) { areas.add('rust'); continue; }
    if (/^src\/.*\.(?:spec|test)\.ts$/.test(p) && !fs.existsSync(path.join(root, p))) return full();
    if (/^(src|css)\/.*\.css$/.test(p)) { areas.add('style'); continue; }
    if (browserSpecs.has(p) && fs.existsSync(path.join(root, p))) {
      areas.add('browser');
      browserFiles.add(p);
      continue;
    }
    const testName = /^scripts\/tests\/(test-[^/]+\.(?:ts|mts|js|mjs))$/.exec(p)?.[1]
      .replace(/\.mts$/, '.mjs').replace(/\.ts$/, '.js');
    if (testName && registeredTests.has(testName)
      && fs.existsSync(path.join(testsDir, testName.replace(/\.mjs$/, '.mts').replace(/\.js$/, '.ts')))) {
      areas.add('tests');
      testFiles.add(testName);
      continue;
    }
    if (/^(scripts|desktop-tauri|tests|\.github)\//.test(p)
      || /^(package(?:-lock)?\.json|.*config\.[^/]+|deploy-desktop\.bat)$/.test(p)) return full();
    if (/^(src|css|public)\//.test(p) || p === 'index.html') {
      areas.add('ui');
      if (/^src\/.*\.(?:ts|vue)$/.test(p) && fs.existsSync(path.join(root, p))) frontendFiles.add(p);
      else allFrontend = true;
    }
    if (/^(data|assets)\//.test(p)) areas.add('data');
    if (!/^(docs\/|.*\.md$)/.test(p) && !/^(src|css|public|data|assets)\//.test(p)
      && p !== 'index.html') return full();
  }
  return { areas: [...areas], testFiles: [...testFiles],
    ...(!allFrontend && frontendFiles.size ? { frontendFiles: [...frontendFiles] } : {}),
    ...(browserFiles.size ? { browserFiles: [...browserFiles] } : {}) };
}

function detectAreas() {
  const collect = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`Git 改动检测失败: ${result.error?.message || result.stderr}`);
    return result.stdout.split('\0').filter(Boolean);
  };
  return classifyFiles([...collect(['diff', '--name-only', '-z', 'HEAD']), ...collect(['ls-files', '-z', '--others', '--exclude-standard'])]);
}

async function main(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node scripts/maintenance/gate-quick.js [ui|style|rust|data|all|full] [--verbose] [--all]');
    console.log('缺省按 git 改动自动选面积；--all 失败后继续；--verbose 展示完整输出（contract 按文件完成后输出）。');
    return 0;
  }
  const invalid = argv.filter((arg: any) => !['ui', 'style', 'rust', 'data', 'all', 'full', '--verbose', '--all'].includes(arg));
  if (invalid.length || argv.filter((arg: any) => !arg.startsWith('--')).length > 1) {
    console.error(`无效门禁参数: ${argv.join(' ')}`);
    return 2;
  }
  const verbose = argv.includes('--verbose');
  const keepGoing = argv.includes('--all');
  const areaArg = argv.find((arg: any) => ['ui', 'style', 'rust', 'data', 'all', 'full'].includes(arg)) as GateArea | 'all' | undefined;

  let areas: GateArea[];
  let testFiles: string[] = [];
  let frontendFiles: string[] | undefined, browserFiles: string[] = [];
  if (areaArg) {
    // 'full' 走完整门禁；'all' 展开领域检查。
    areas = areaArg === 'all' ? ['ui', 'style', 'rust', 'data'] : [areaArg];
  } else {
    try { ({ areas, testFiles, frontendFiles, browserFiles = [] } = detectAreas()); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
    if (!areas.length) {
      console.log('gate:quick 未检测到需运行门禁的代码改动（可能仅文档）；显式指定面积或用 full。');
      return 0;
    }
    console.log(`gate:quick 自动检测面积: ${areas.join(' + ')}`);
  }

  let exitCode = 0;
  if (areas.includes('full')) {
    try { contractJobs(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  }
  const started = Date.now();
  // Prepare generated entries once for all selected Node/browser areas.
  if (!areas.includes('full') && areas.some(area => ['tests', 'rust', 'data', 'browser'].includes(area))) {
    exitCode = runNpmStep('build:runtime', 'build:runtime', 300_000, verbose);
    if (exitCode) return exitCode;
  }
  // Test-only edits do not change the SPA. Mixed UI/data edits need a new dist.
  if (areas.includes('browser') && areas.some(area => ['ui', 'style', 'data'].includes(area))) {
    exitCode = runNpmStep('build (changed UI/data)', 'build:web:run', 600_000, verbose);
    if (exitCode) return exitCode;
  }
  for (const area of areas) {
    if (exitCode && !keepGoing) break;
    console.log(`── gate ${area} ──`);
    if (area === 'tests') {
      exitCode = AREA_STEPS.tests(testFiles, { verbose, keepGoing }) || exitCode;
      continue;
    }
    if (area === 'ui') {
      exitCode = await AREA_STEPS.ui({ verbose, keepGoing }, frontendFiles) || exitCode;
      continue;
    }
    if (area === 'browser') {
      exitCode = await AREA_STEPS.browser(browserFiles, { verbose, keepGoing }) || exitCode;
      continue;
    }
    if (area === 'style') {
      exitCode = AREA_STEPS.style({ verbose, keepGoing }) || exitCode;
      continue;
    }
    if (area === 'rust') {
      exitCode = await AREA_STEPS.rust({ verbose, keepGoing }) || exitCode;
      continue;
    }
    if (area === 'data') {
      exitCode = AREA_STEPS.data({ verbose, keepGoing }) || exitCode;
      continue;
    }
    // full ≙ npm run check（run-check-parallel.js 编排，含 Node/Vue typecheck、
    // eslint、风格/对比度/动效门禁、场景构建与优化/分级/校验、内容契约、参考 URL、
    // design:lint 及 test:check 的 check 套件）+ rust:check + vitest + unit + contract + 生产打包预算。
    // 2026-09-05 审计 P1-03：此前 full 自拼 QUALITY_TEST_SUITES.check 文件子集，与
    // npm run check 的编排漂移；现直接复用同一编排，"全量通过"不再出现两套口径。
    // 缺省保持 fail-fast；--all 时阶段失败仍继续跑完并收集其余结果。
    const failPhase = (code: number) => {
      if (code === 0) return false;
      exitCode = 1;
      return !keepGoing;
    };
    if (failPhase(runNpmStep('check（质量门禁编排）', 'check', 900_000, verbose))) continue;
    if (failPhase(await AREA_STEPS.rust({ verbose, keepGoing }))) continue;
    if (failPhase(runNpmStep('vitest', 'test:frontend', 300_000, verbose))) continue;
    if (failPhase(runUnitSuite({ verbose }))) continue;
    if (failPhase(await runContractSuite({ verbose, keepGoing }))) continue;
    if (failPhase(runNpmStep('optional suites for changed consumers', 'test:optional', 900_000, verbose))) continue;
    failPhase(runNpmStep('build（打包预算）', 'build:web:run', 600_000, verbose));
  }
  console.log(`gate 总计: ${exitCode === 0 ? 'PASS' : 'FAIL'} · ${formatDuration(Date.now() - started)}`);
  return exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}

export = { detectAreas, classifyFiles, main, AREA_STEPS };
