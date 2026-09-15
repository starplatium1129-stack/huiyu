import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
/**
 * 定稿场景提示词保护（pinned scene prompts）
 *
 * 背景：2026-08-26/27 的多批全量优化（氛围词补全、质量要素融合等）曾把用户
 * 实拍验证过的优质场景提示词改坏。本工具把「历史上定点手工修过 / 官方 CG
 * 对齐过」的场景清单固化为字节级基线；任何后续改动必须显式 --capture 才能过门禁。
 *
 * 用法：
 *   node scripts/maintenance/pin-scene-prompts.js            # 报告漂移（默认 --source=auto）
 *   node scripts/maintenance/pin-scene-prompts.js --apply    # 回滚被批次覆盖的字段到目标来源
 *   node scripts/maintenance/pin-scene-prompts.js --capture  # 以当前工作区为新一版基线（改动须先真实出图自测）
 *   node scripts/maintenance/pin-scene-prompts.js --check    # 门禁：与基线逐字节一致，否则退出码 1
 *   --source=auto|baseline|history                           # 目标来源，默认 auto
 *
 * 目标来源与无历史环境（如浅克隆）：
 *   auto     优先按历史定点提交定位目标。历史不可用时 --report 降级为 baseline 并打印提示；
 *            而 --apply 直接失败——宁可不改，也不在不知道目标的情况下写盘。
 *   baseline 显式以 data/prompt-pinned-scenes.json 为目标，完全不依赖 Git 历史。
 *   history  强制历史来源，不可用即失败，不降级。
 * 写盘模式（--apply/--capture）一律先整体校验再落盘：基线为空、条目缺来源、场景不存在或
 * ID 重复都会在改动任何分片之前报错退出。--capture 沿用既有基线的成员与来源，因此不需要
 * 历史对象也不会丢条目；它只重写 pinnedAt 与受保护字段，不改变清单范围。
 *
 * PINNED_SOURCES 的判定依据是提交信息（定点xN / 官方CG / 恢复手工 / 按实拍还原），
 * 取值窗口从 2026-08-22 倒推优化批次开始；更早的定点修已被底模换代（v14→v21）淘汰，
 * 冻结它们会复活过期写法。sc033/sc234 以 PNG 字节基准为准（source: png-reference）。
 */
'use strict';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(ROOT, 'data', 'prompt-pinned-scenes.json');
const SHARDS_DIR = path.join(ROOT, 'data', 'scenes');

/** 渲染链路锁定的字段（story/tags/location 等属 UI/检索元数据，不锁） */
const PIN_FIELDS = ['prompt', 'negative', 'animaCaption', 'recommendedSize', 'rating', 'mature'];

/** 手工/定点修复波次：提交 -> 触及场景（时间顺序由 git 时间戳决定，不依赖书写顺序） */
const PINNED_SOURCES = {
  b1ccfc0: ['sc264', 'sc277'],
  '64a3152': ['sc105', 'sc142', 'sc152', 'sc234', 'sc263', 'sc267'],
  '8532c04': ['sc267'],
  '8a6255b': ['sc267'],
  '31b439f': ['sc300'],
  aba1a54: ['sc285'],
  edf9def: ['sc299', 'sc301', 'sc302', 'sc303', 'sc304'],
  '3d07e1a': ['sc025', 'sc052', 'sc011', 'sc037', 'sc046', 'sc141', 'sc156', 'sc163'],
  '3dc7c45': ['sc003', 'sc034', 'sc038'],
  '8bccaa1': ['sc030'],
  '61f4ab9': ['sc022', 'sc032', 'sc040', 'sc088', 'sc101', 'sc107', 'sc109', 'sc113', 'sc119', 'sc125', 'sc129', 'sc137', 'sc158', 'sc190', 'sc248', 'sc254', 'sc256'],
  d149ee2: ['sc097', 'sc101', 'sc107', 'sc109', 'sc129', 'sc137', 'sc144', 'sc153', 'sc158', 'sc166', 'sc301'],
  '97ee431': ['sc263', 'sc264', 'sc267', 'sc272', 'sc273', 'sc274', 'sc276', 'sc279', 'sc299', 'sc302', 'sc303', 'sc304', 'sc305'],
  '2bf23e1': ['sc097', 'sc101', 'sc107', 'sc109', 'sc129', 'sc137', 'sc144', 'sc153', 'sc158', 'sc166', 'sc260', 'sc261', 'sc262', 'sc263', 'sc264', 'sc265', 'sc266', 'sc267', 'sc268', 'sc269', 'sc270', 'sc271', 'sc272', 'sc273', 'sc274', 'sc275', 'sc276', 'sc278', 'sc279', 'sc281', 'sc282', 'sc283', 'sc284', 'sc285', 'sc299', 'sc301', 'sc302', 'sc303', 'sc304', 'sc305'],
  '35e5382': ['sc008', 'sc017', 'sc039', 'sc043', 'sc044', 'sc090', 'sc102', 'sc103', 'sc106', 'sc142', 'sc152', 'sc168', 'sc240', 'sc242', 'sc251'],
  a530053: ['sc018', 'sc019', 'sc072', 'sc080', 'sc103', 'sc192', 'sc207', 'sc228', 'sc233', 'sc238', 'sc246'],
  b7171c2: ['sc060', 'sc136', 'sc164', 'sc170', 'sc204', 'sc231', 'sc232', 'sc234', 'sc305'],
  d240d4a: ['sc234'],
  '616c406': ['sc033'],
};

/** 以 PNG 内嵌元数据逐一验证过的场景：工作区现状即权威，无需历史回滚 */
const PNG_AUTHORED = new Set(['sc033', 'sc234']);

/** 每个受保护场景的最后（按提交时间）一次定点修来源 */
function newestSourceByScene() {
  const stampCache = new Map();
  const stampOf = (commit: string) => {
    if (!stampCache.has(commit)) {
      stampCache.set(commit, Number(execFileSync('git', ['show', '-s', '--format=%ct', commit], { cwd: ROOT, stdio: 'pipe' }).toString().trim()));
    }
    return stampCache.get(commit);
  };
  const best = new Map();
  for (const [commit, ids] of Object.entries(PINNED_SOURCES)) {
    for (const id of ids) {
      if (!best.has(id) || stampOf(commit) > stampOf(best.get(id))) best.set(id, commit);
    }
  }
  return best;
}

function pick(entry: { [x: string]: unknown; }) {
  const out: Record<string, any> = {};
  for (const f of PIN_FIELDS) out[f] = entry[f];
  return out;
}

function diffFields(current: { [x: string]: unknown; }, target: any) {
  const drift: any[] = [];
  for (const f of PIN_FIELDS) {
    if (JSON.stringify(current[f]) !== JSON.stringify(target[f])) drift.push(f);
  }
  return drift;
}

function gitScene(commit: unknown, id: unknown) {
  const raw = execFileSync('git', ['show', `${commit}:data/scenes.json`], { cwd: ROOT, maxBuffer: 5e8, stdio: 'pipe' }).toString();
  return JSON.parse(raw).find((s: any) => s.id === id) || null;
}

function loadShards() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SHARDS_DIR, 'manifest.json'), 'utf8'));
  const { expandShardFiles }: typeof import('../lib/scene-store') = require('../lib/scene-store');
  const shards: any[] = [];
  for (const entry of manifest.files) {
    // 批次感知：存在 base.1.json 时按批次展开，否则读单文件
    for (const file of expandShardFiles(entry)) {
      const p = path.join(SHARDS_DIR, file);
      shards.push({ file, arr: JSON.parse(fs.readFileSync(p, 'utf8')) });
    }
  }
  return shards;
}

/** 当前受保护条目索引（同一份分片实例，供 apply 原地修改后统一落盘）：id -> {file, arr, entry} */
function indexShards(shards: any) {
  const out = new Map();
  for (const { file, arr } of shards) {
    for (const entry of arr) if (entry && entry.id) {
      if (out.has(entry.id)) throw new Error(`重复场景 ID: ${entry.id}`);
      out.set(entry.id, { file, arr, entry });
    }
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const mode = process.argv[2] || '--report';
const source = process.argv.find((arg: any) => arg.startsWith('--source='))?.slice(9) || 'auto';

function readBaseline() {
  const payload = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  if (!payload.scenes || Array.isArray(payload.scenes) || !Object.keys(payload.scenes).length) {
    throw new Error('定稿基线为空或格式错误，不能降级或覆盖');
  }
  for (const [id, entry] of Object.entries(payload.scenes)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.pinSource) || !entry.pinSource.length) {
      throw new Error(`定稿基线 ${id} 缺少有效来源`);
    }
  }
  return payload.scenes;
}

function resolveTargets() {
  if (source === 'baseline') return { targets: new Map(Object.entries(readBaseline())), origin: 'baseline' };
  try {
    const sources = newestSourceByScene();
    const targets = new Map();
    for (const [id, commit] of sources) {
      if (PNG_AUTHORED.has(id)) continue;
      const entry = gitScene(commit, id);
      if (!entry) throw new Error(`${commit} 中缺少 ${id}`);
      targets.set(id, { ...pick(entry), pinSource: [commit] });
    }
    return { targets, origin: 'history' };
  } catch (error) {
    if (source === 'history' || mode === '--apply') {
      throw new Error('历史来源不可用。请补齐 Git 历史；或显式使用 --source=baseline 对齐已保存基线。未写入任何场景。', { cause: error });
    }
    console.warn('历史来源不可用；本次报告降级为已保存基线（baseline），不代表历史来源复验。');
    return { targets: new Map(Object.entries(readBaseline())), origin: 'baseline' };
  }
}

try {
if (!['--report', '--apply', '--capture', '--check'].includes(mode) || !['auto', 'baseline', 'history'].includes(source)
    || process.argv.slice(3).some((arg: any) => !/^--source=(auto|baseline|history)$/.test(arg))) {
  console.error(`usage: node ${path.basename(__filename)} [--report|--apply|--capture|--check] [--source=auto|baseline|history]`);
  process.exitCode = 2;
} else if (mode === '--check') {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('baseline 缺失：先运行 --capture 生成 data/prompt-pinned-scenes.json');
    process.exitCode = 1;
  } else {
    const baseline = readBaseline();
    const entries = indexShards(loadShards());
    let bad = 0;
    for (const [id, want] of Object.entries(baseline)) {
      const hit = entries.get(id);
      if (!hit) { console.error(`[FAIL] ${id}: 场景已被删除`); bad += 1; continue; }
      const drift = diffFields(pick(hit.entry), want);
      if (drift.length) {
        console.error(`[FAIL] ${id}: 字段漂移 ${drift.join(',')}（pinSource=${(want.pinSource || []).join(',')}）`);
        bad += 1;
      }
    }
    console.log(bad
      ? `pinned gate FAILED: ${bad}/${Object.keys(baseline).length}`
      : `pinned gate OK: ${Object.keys(baseline).length} 个定稿场景与基线逐字节一致`);
    process.exitCode = bad ? 1 : 0;
  }
} else if (mode === '--capture') {
  const entries = indexShards(loadShards());
  // An existing reviewed baseline owns both membership and provenance. Capturing
  // its current fields must not require historical Git objects or drop entries.
  const previous = fs.existsSync(BASELINE_PATH) ? readBaseline() : null;
  const sources = previous
    ? new Map(Object.entries(previous).map(([id, entry]: any) => [id, entry.pinSource]))
    : new Map([...newestSourceByScene()].map(([id, commit]: any) => [id, PNG_AUTHORED.has(id) ? ['png-reference'] : [commit]]));
  const scenes: Record<string, any> = {};
  for (const [id] of sources) {
    const hit = entries.get(id);
    if (!hit) throw new Error(`受保护场景 ${id} 不存在于分片`);
    scenes[id] = {
      ...pick(hit.entry),
      pinSource: sources.get(id),
    };
  }
  const payload = {
    description: '定稿场景提示词字节基线 —— 由 scripts/maintenance/pin-scene-prompts.js 维护；改动须经真实出图自测后用 --capture 更新',
    pinnedAt: new Date().toISOString().slice(0, 19),
    scenes,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`captured baseline: ${Object.keys(scenes).length} scenes -> data/prompt-pinned-scenes.json`);
} else {
  // --report / --apply
  const shards = loadShards();
  const entries = indexShards(shards);
  const { targets, origin } = resolveTargets();
  // Validate the entire operation before changing any shard.
  for (const [id] of targets) if (!entries.has(id)) throw new Error(`受保护场景 ${id} 不存在于分片；未写入任何场景`);
  const applied: any[] = [];
  let drifted = 0;
  for (const [id, version] of targets) {
    const hit = entries.get(id);
    const target = pick(version);
    const drift = diffFields(pick(hit.entry), target);
    if (!drift.length) continue;
    drifted += 1;
    console.log(`[drift] ${id} source=${origin} fields=${drift.join(',')}`);
    if (mode === '--apply') {
      for (const field of PIN_FIELDS) {
        if (target[field] === undefined) delete hit.entry[field];
        else hit.entry[field] = target[field];
      }
      applied.push(`${id} <- ${origin} (${drift.join(',')})`);
    }
  }
  if (mode === '--apply') {
    const touchedFiles = new Set(applied.map((line: any) => entries.get(line.slice(0, line.indexOf(' <'))).file));
    for (const { file, arr } of shards) {
      if (touchedFiles.has(file)) fs.writeFileSync(path.join(SHARDS_DIR, file), JSON.stringify(arr, null, 2) + '\n');
    }
    console.log(`\napplied rollback (${origin}): ${applied.length}/${targets.size} scenes, rewrote shard files: ${[...touchedFiles].join(', ')}`);
    console.log('下一步: npm run scenes:build && 本工具 --check；更新基线前仍须真实出图验证。');
  } else {
    console.log(drifted
      ? `\n${drifted}/${targets.size} 条定稿场景与 ${origin} 不一致`
      : `\n全部 ${targets.size} 个定稿场景与 ${origin} 一致`);
  }
}
} catch (error) {
  console.error(runtimeErrorMessage(error));
  process.exitCode = 1;
}
