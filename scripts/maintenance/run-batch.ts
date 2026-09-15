#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/run-batch.js — 统一批量调度器
 *
 * 合并 8 个 run-batch-*.js 的重复逻辑：
 *   run-batch-all-popular-attempt2.js
 *   run-batch-all-scenes-attempt2.js
 *   run-regen-popular-fails.js
 *   run-regen-scene-fails.js
 *   run-test-5-reconstructed.js etc.
 *
 * 原先每个文件硬编码 keys/ids、batchSize、concurrency，仅参数不同。
 * 现统一为一个脚本，兼容旧入口（旧脚本改为薄封装转发）。
 *
 * 用法:
 *   node scripts/maintenance/run-batch.js --source popular --batch-size 10 --concurrency 3
 *   node scripts/maintenance/run-batch.js --source scenes --keys sc001,sc002 --concurrency 2 --attempt 2
 *   node scripts/maintenance/run-batch.js --source popular --dry-run
 *   node scripts/maintenance/run-batch.js --help
 *
 * 兼容:
 *   旧脚本 `node scripts/maintenance/run-batch-all-popular-attempt2.js` 等仍可用（内部转发到本脚本），
 *   但推荐统一使用本脚本。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    source: null, // popular | scenes
    batchSize: null,
    concurrency: null,
    attempt: '2',
    gateway: 'http://127.0.0.1:3123',
    keys: null,
    ids: null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--source=')) opts.source = a.split('=')[1];
    else if (a === '--source') opts.source = args[++i];
    else if (a.startsWith('--batch-size=')) opts.batchSize = Number(a.split('=')[1]);
    else if (a === '--batch-size') opts.batchSize = Number(args[++i]);
    else if (a.startsWith('--concurrency=')) opts.concurrency = Number(a.split('=')[1]);
    else if (a === '--concurrency') opts.concurrency = Number(args[++i]);
    else if (a.startsWith('--attempt=')) opts.attempt = String(a.split('=')[1]);
    else if (a === '--attempt') opts.attempt = String(args[++i]);
    else if (a.startsWith('--gateway=')) opts.gateway = a.split('=')[1];
    else if (a === '--gateway') opts.gateway = args[++i];
    else if (a.startsWith('--keys=')) opts.keys = a.split('=')[1];
    else if (a === '--keys') opts.keys = args[++i];
    else if (a.startsWith('--ids=')) opts.ids = a.split('=')[1];
    else if (a === '--ids') opts.ids = args[++i];
  }
  return opts;
}

function printHelp() {
  console.log(`
统一批量调度器 — 替代 8 个 run-batch-*.js

用法:
  node scripts/maintenance/run-batch.js --source <popular|scenes> [options]

必选:
  --source <popular|scenes>   批量来源：popular=热门蓝图, scenes=场景库

可选:
  --batch-size <n>   每批数量 (默认 popular: 全部一次, scenes: 10)
  --concurrency <n>  并发数 (默认 popular: 3, scenes: 2)
  --attempt <n>      尝试轮次 (默认 2)
  --gateway <url>    ComfyUI gateway (默认 http://127.0.0.1:3123)
  --keys <list>      仅跑指定 popular keys，逗号分隔（覆盖 failed-*.txt）
  --ids <list>       仅跑指定 scene ids，逗号分隔
  --dry-run          仅打印将执行的命令，不实际跑
  --help, -h         显示此帮助

示例:
  node scripts/maintenance/run-batch.js --source popular
  node scripts/maintenance/run-batch.js --source scenes --batch-size 10 --concurrency 2
  node scripts/maintenance/run-batch.js --source popular --keys pc_raiden_shogun_tenshukaku --dry-run
  node scripts/maintenance/run-batch.js --source scenes --ids sc001,sc002,sc003 --attempt 3

旧入口兼容:
  node scripts/maintenance/run-batch-all-popular-attempt2.js  ->  本脚本 --source popular
  node scripts/maintenance/run-batch-all-scenes-attempt2.js   ->  本脚本 --source scenes --batch-size 10 --concurrency 2
`);
}

function readFailedList(source) {
  const file = source === 'popular' ? 'runtime/failed-popular-keys.txt' : 'runtime/failed-scene-ids.txt';
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    console.error(`未找到 ${file}，请先运行 dump-failed-*.js 或通过 --keys/--ids 显式指定`);
    process.exitCode = 1;
    return [];
  }
  return fs.readFileSync(full, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
}

function main() {
  const opts = parseArgs();
  if (opts.help || !opts.source) {
    if (!opts.source && !opts.help) console.error('错误: 需指定 --source popular|scenes\n');
    printHelp();
    process.exitCode = opts.help ? 0 : 1;
    return;
  }
  if (!['popular', 'scenes'].includes(opts.source)) {
    console.error(`--source 仅支持 popular|scenes，收到: ${opts.source}`);
    process.exitCode = 1;
    return;
  }

  const isPopular = opts.source === 'popular';
  const defaultBatchSize = isPopular ? 0 : 10; // 0 = 不分批
  const defaultConcurrency = isPopular ? 3 : 2;
  const batchSize = opts.batchSize != null ? opts.batchSize : defaultBatchSize;
  const concurrency = opts.concurrency != null ? opts.concurrency : defaultConcurrency;

  let items = [];
  if (opts.keys) items = opts.keys.split(',').map(s => s.trim()).filter(Boolean);
  else if (opts.ids) items = opts.ids.split(',').map(s => s.trim()).filter(Boolean);
  else items = readFailedList(opts.source);

  if (!items.length) {
    console.log(`[${opts.source}] 无待处理项`);
    return;
  }

  console.log(`[Batch ${opts.source}] 共 ${items.length} 项 | batchSize=${batchSize || 'ALL'} concurrency=${concurrency} attempt=${opts.attempt} gateway=${opts.gateway}`);

  const script = isPopular
    ? 'scripts/maintenance/generate-popular-showcase-anima11.js'
    : 'scripts/maintenance/generate-scene-showcase-anima11.js';
  const keyFlag = isPopular ? '--keys' : '--ids';

  // popular 不分批，scenes 分批
  const batches = batchSize > 0 ? Array.from({ length: Math.ceil(items.length / batchSize) }, (_, i) => items.slice(i * batchSize, (i + 1) * batchSize)) : [items];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    if (batches.length > 1) console.log(`\n=== Batch ${bi + 1}/${batches.length} (Count: ${batch.length}) ===`);
    const args = [
      script,
      '--gateway', opts.gateway,
      keyFlag, batch.join(','),
      '--force',
      '--attempt', opts.attempt,
      '--seed-attempt', opts.attempt,
      '--concurrency', String(concurrency),
    ];
    console.log(`> node ${args.join(' ')}`);
    if (opts.dryRun) continue;
    const res = spawnSync('node', args, { stdio: 'inherit', cwd: ROOT });
    if (res.status !== 0) {
      console.error(`Batch ${bi + 1} 失败，终止`);
      process.exitCode = res.status || 1;
      return;
    }
  }
  console.log(`\n[Batch ${opts.source}] 全部完成 (${items.length} 项)`);
}

if (require.main === module) main();
export = { parseArgs };
