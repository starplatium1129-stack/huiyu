'use strict';

/**
 * scripts/maintenance/gate-quick.js — 按改动类型分层的精简门禁
 *
 * 用法：
 *   node scripts/maintenance/gate-quick.js                自动检测 git 改动选面积
 *   node scripts/maintenance/gate-quick.js ui|server|data|all|full [--verbose] [--all]
 *
 * 面积 → 步骤：
 *   ui     typecheck:app + vitest（纯前端改动，~1-2 分钟）
 *   server Anima/生成/视频/聊天/安全/桌面工具/控制 7 个契约套件（~2-3 分钟）
 *   data   聚合一致性 + 内容契约 + 分片/参考库/定稿/语料契约（~15 秒）
 *   all    ui + server + data 三块连跑
 *   full   ≙ npm run validate（check 编排 + vitest + unit + contract）+ 生产打包预算。
 *          与 `npm run check` 共用同一份步骤清单，不存在第二套"全量"口径（2026-09-05 P1-03）。
 *
 * 横切重构（目录改名、模块搬迁、依赖变更）请直接用 full——爆炸半径无法事先界定。
 */

const { spawnSync } = (require('node:child_process') as typeof import('node:child_process'));
const path = (require('node:path') as typeof import('node:path'));
const { contractJobs }: typeof import('../tests/contract-test-policy') = require('../tests/contract-test-policy');
const {
  runSuiteFiles,
  runUnitSuite,
  runContractSuite,
  runNpmScript,
  printExcerpt,
  formatDuration,
  root,
} = (require('../tests/run-quality-suite') as typeof import('../tests/run-quality-suite'));

const testsDir = path.join(root, 'scripts', 'tests');
interface GateOptions { verbose: boolean; keepGoing: boolean }
type GateArea = 'ui' | 'server' | 'data' | 'full';

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

function suiteFiles(names: readonly string[], label: string, { verbose, keepGoing }: GateOptions) {
  return runSuiteFiles(
    names.map((file: any) => ({ name: file, file: path.join(testsDir, file) })),
    { label, timeout: 180_000, verbose, keepGoing },
  );
}

const AREA_STEPS = {
  ui({ verbose, keepGoing }: GateOptions) {
    let code = runNpmStep('typecheck:app', 'typecheck:app', 300_000, verbose);
    if (code === 0 || keepGoing) code = runNpmStep('vitest', 'test:frontend', 300_000, verbose) || code;
    return code;
  },
  server({ verbose, keepGoing }: GateOptions) {
    const typecheck = runNpmStep('typecheck:node', 'typecheck:node', 300_000, verbose);
    if (typecheck && !keepGoing) return typecheck;
    return suiteFiles(
      [
        'test-anima-routes.js',
        'test-generation-routes.js',
        'test-video-routes.js',
        'test-chat.js',
        'test-security.js',
        'test-desktop-tools-route.js',
        'test-control-failure-contract.js',
      ],
      'server',
      { verbose, keepGoing },
    ) || typecheck;
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

function classifyFiles(files: readonly string[]): GateArea[] {
  const areas = new Set<GateArea>();
  for (const raw of files) {
    const p = raw.replace(/\\/g, '/');
    if (/^(scripts|desktop-tauri|tests|\.github)\//.test(p)
      || /^(package(?:-lock)?\.json|.*config\.[^/]+|deploy-desktop\.bat)$/.test(p)) return ['full'];
    if (/^(src|css|public)\//.test(p) || p === 'index.html') areas.add('ui');
    if (/^(routes|server|services)\//.test(p) || /^server\.(?:js|ts)$/.test(p)) areas.add('server');
    if (/^(data|assets)\//.test(p)) areas.add('data');
    if (!/^(docs\/|.*\.md$)/.test(p) && !/^(src|css|public|routes|server|services|data|assets)\//.test(p)
      && !['index.html', 'server.js', 'server.ts'].includes(p)) return ['full'];
  }
  return [...areas];
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
    console.log('用法: node scripts/maintenance/gate-quick.js [ui|server|data|all|full] [--verbose] [--all]');
    console.log('缺省按 git 改动自动选面积；--all 失败后继续；--verbose 展示完整输出（contract 按文件完成后输出）。');
    return 0;
  }
  const invalid = argv.filter((arg: any) => !['ui', 'server', 'data', 'all', 'full', '--verbose', '--all'].includes(arg));
  if (invalid.length || argv.filter((arg: any) => !arg.startsWith('--')).length > 1) {
    console.error(`无效门禁参数: ${argv.join(' ')}`);
    return 2;
  }
  const verbose = argv.includes('--verbose');
  const keepGoing = argv.includes('--all');
  const areaArg = argv.find((arg: any) => ['ui', 'server', 'data', 'all', 'full'].includes(arg)) as GateArea | 'all' | undefined;

  let areas: GateArea[];
  if (areaArg) {
    // 'full' 保持原样走下方 full 专属分支（含 check 套件与打包预算）；'all' 展开三块
    areas = areaArg === 'all' ? ['ui', 'server', 'data'] : [areaArg];
  } else {
    try { areas = detectAreas(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
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
  for (const area of areas) {
    if (exitCode && !keepGoing) break;
    console.log(`── gate ${area} ──`);
    if (area === 'ui') {
      exitCode = AREA_STEPS.ui({ verbose, keepGoing }) || exitCode;
      continue;
    }
    if (area === 'server') {
      exitCode = AREA_STEPS.server({ verbose, keepGoing }) || exitCode;
      continue;
    }
    if (area === 'data') {
      exitCode = AREA_STEPS.data({ verbose, keepGoing }) || exitCode;
      continue;
    }
    // full ≙ npm run check（run-check-parallel.js 编排，含后端/前端 typecheck、
    // eslint、风格/对比度/动效门禁、场景构建与优化/分级/校验、内容契约、参考 URL、
    // design:lint 及 test:check 的 check 套件）+ vitest + unit + contract + 生产打包预算。
    // 2026-09-05 审计 P1-03：此前 full 自拼 QUALITY_TEST_SUITES.check 文件子集，与
    // npm run check 的编排漂移；现直接复用同一编排，"全量通过"不再出现两套口径。
    // 缺省保持 fail-fast；--all 时阶段失败仍继续跑完并收集其余结果。
    const failPhase = (code: number) => {
      if (code === 0) return false;
      exitCode = 1;
      return !keepGoing;
    };
    if (failPhase(runNpmStep('check（质量门禁编排）', 'check', 900_000, verbose))) continue;
    if (failPhase(runNpmStep('vitest', 'test:frontend', 300_000, verbose))) continue;
    if (failPhase(runUnitSuite({ verbose }))) continue;
    if (failPhase(await runContractSuite({ verbose, keepGoing }))) continue;
    failPhase(runNpmStep('build（打包预算）', 'build:web:run', 600_000, verbose));
  }
  console.log(`gate 总计: ${exitCode === 0 ? 'PASS' : 'FAIL'} · ${formatDuration(Date.now() - started)}`);
  return exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}

export = { detectAreas, classifyFiles, main, AREA_STEPS };
