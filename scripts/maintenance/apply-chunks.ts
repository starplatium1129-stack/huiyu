#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * scripts/maintenance/apply-chunks.js — 统一合并脚本
 *
 * 收敛 4 个重复脚本：
 *   apply-all-chunks.js (1-5)
 *   apply-all-popular-chunks.js (1-17)
 *   apply-chunk-maps.js (1-2)
 *   apply-all-scene-chunks.js / apply-all-scene-refinements.js (1-3 scenes)
 *
 * 用法:
 *   node scripts/maintenance/apply-chunks.js --target popular --chunks 1-17
 *   node scripts/maintenance/apply-chunks.js --target popular --chunks 1,2,5
 *   node scripts/maintenance/apply-chunks.js --target scenes
 *   node scripts/maintenance/apply-chunks.js --help
 *
 * 兼容: 旧脚本仍可用，但推荐统一使用本脚本 + workflow 入口
 *   node scripts/workflow.js showcase:batch 等已收敛 batch，此脚本收敛 apply
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: any = { target: null, chunks: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--target=')) opts.target = a.split('=')[1];
    else if (a === '--target') opts.target = args[++i];
    else if (a.startsWith('--chunks=')) opts.chunks = a.split('=')[1];
    else if (a === '--chunks') opts.chunks = args[++i];
  }
  return opts;
}

function printHelp() {
  console.log(`
统一合并脚本 — 收敛 4 个 apply-*.js

用法:
  node scripts/maintenance/apply-chunks.js --target <popular|scenes> [--chunks <range>] [--help]

参数:
  --target <popular|scenes>  必选：popular=热门蓝图, scenes=场景库
  --chunks <range>           可选：如 1-5, 1,2,5, 1-17（默认 popular:1-17, scenes:1-3）
  --help, -h                 显示此帮助

示例:
  node scripts/maintenance/apply-chunks.js --target popular
  node scripts/maintenance/apply-chunks.js --target popular --chunks 1-5
  node scripts/maintenance/apply-chunks.js --target scenes --chunks 1-3

旧入口映射:
  apply-all-chunks.js              -> --target popular --chunks 1-5
  apply-all-popular-chunks.js      -> --target popular --chunks 1-17
  apply-chunk-maps.js              -> --target popular --chunks 1-2
  apply-all-scene-chunks.js        -> --target scenes --chunks 1-3
`);
}

function parseChunks(str: string|null, max: number) {
  if (!str) return Array.from({ length: max }, (_: any, i: any) => i + 1);
  const out = new Set();
  for (const part of str.split(',')) {
    const p = part.trim();
    if (p.includes('-')) {
      const [s, e] = p.split('-').map(Number);
      for (let i = s; i <= e; i++) if (i >= 1 && i <= max) out.add(i);
    } else {
      const n = Number(p);
      if (n >= 1 && n <= max) out.add(n);
    }
  }
  return [...out].sort((a: any, b: any) => a - b);
}

function applyPopular(chunks: any) {
  const bpFile = path.join(ROOT, 'data', 'scene-blueprints.json');
  const bpData = JSON.parse(fs.readFileSync(bpFile, 'utf8'));
  const blueprints = bpData.blueprints || bpData;

  const allChunks: Record<string, any> = {};
  for (const n of chunks) {
    const file = path.join(__dirname, `refine-map-chunk${n}.js`);
    if (!fs.existsSync(file)) {
      console.warn(`跳过不存在的 chunk${n}: ${file}`);
      continue;
    }
    Object.assign(allChunks, require(file));
  }

  let merged = 0;
  for (const bp of blueprints) {
    const map = allChunks[bp.id];
    if (!map) continue;
    if (map.promptTokens) bp.promptTokens = map.promptTokens;
    if (map.promptProse) bp.promptProse = map.promptProse;
    if (map.nsfwTokens) bp.nsfwTokens = map.nsfwTokens;
    if (map.nsfwProse) bp.nsfwProse = map.nsfwProse;
    if (map.negativeTokens) bp.negativeTokens = map.negativeTokens;
    merged++;
  }

  fs.writeFileSync(bpFile, JSON.stringify(bpData, null, 2) + '\n', 'utf8');
  console.log(`[apply-chunks popular] 合并 ${chunks.join(',')} → ${merged} 蓝图已更新`);
}

function applyScenes(chunks: any) {
  const allMaps: Record<string, any> = {};
  for (const n of chunks) {
    const file = path.join(__dirname, `refine-map-scenes-chunk${n}.js`);
    if (!fs.existsSync(file)) {
      console.warn(`跳过不存在的 scenes-chunk${n}: ${file}`);
      continue;
    }
    Object.assign(allMaps, require(file));
  }

  // 实际使用 data/scenes/*.json（跳过 manifest.json 等非场景数组文件）
  const sceneDir = path.join(ROOT, 'data', 'scenes');
  const files = fs.existsSync(sceneDir)
    ? fs.readdirSync(sceneDir).filter((f: any) => f.endsWith('.json') && f !== 'manifest.json')
    : [];

  let total = 0;
  for (const file of files) {
    const full = path.join(sceneDir, file);
    const arr = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!Array.isArray(arr)) continue;
    let cnt = 0;
    for (const s of arr) {
      const map = allMaps[s.id];
      if (!map) continue;
      if (map.prompt) s.prompt = map.prompt;
      if (map.tags) s.tags = map.tags;
      if (map.animaCaption) s.animaCaption = map.animaCaption;
      if (map.negative) s.negative = map.negative;
      cnt++; total++;
    }
    if (cnt) {
      fs.writeFileSync(full, JSON.stringify(arr, null, 2) + '\n', 'utf8');
      console.log(`[apply-chunks scenes] ${file} → ${cnt} 场景`);
    }
  }

  // 重建聚合
  try {
    const { loadSceneShards, writeAggregate } = require(path.join(ROOT, 'scripts', 'lib', 'scene-store'));
    const { scenes } = loadSceneShards();
    writeAggregate(scenes);
    console.log(`[apply-chunks scenes] 聚合重建 ${scenes.length} 场景`);
  } catch (e) {
    console.warn('[apply-chunks scenes] 聚合重建跳过:', runtimeErrorMessage(e));
  }
  console.log(`[apply-chunks scenes] 合并 ${chunks.join(',')} → ${total} 场景`);
}

function main() {
  const opts = parseArgs();
  if (opts.help || !opts.target) {
    if (!opts.target && !opts.help) console.error('错误: 需指定 --target popular|scenes\n');
    printHelp();
    process.exitCode = opts.help ? 0 : 1;
    return;
  }
  if (!['popular', 'scenes'].includes(opts.target)) {
    console.error(`--target 仅支持 popular|scenes，收到: ${opts.target}`);
    process.exitCode = 1;
    return;
  }

  if (opts.target === 'popular') {
    const chunks = parseChunks(opts.chunks, 17);
    applyPopular(chunks);
  } else {
    const chunks = parseChunks(opts.chunks, 3);
    applyScenes(chunks);
  }
}

if (require.main === module) main();
export = { parseChunks };
