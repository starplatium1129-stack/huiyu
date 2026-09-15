import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathLike } from 'node:fs';

// 与网关共用参考图根目录；缺素材仍然失败，不将开发机缺图变成虚假通过。
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { resolveCharRefRoot }: typeof import('../../server/config') = require('../../server/config');
const { resolveContentRoot }: typeof import('../lib/content-contract-root') = require('../lib/content-contract-root');

function auditReferenceView(data: { [s: string]: unknown; }|ArrayLike<unknown>, root: string, env: any = process.env) {
  const appRoot = path.resolve(env.AICS_APP_ROOT || root);
  const assetsRoot = path.resolve(env.AICS_ASSETS_ROOT || path.join(appRoot, 'assets'));
  const refRoot = resolveCharRefRoot(appRoot, env, env.AI_WORKSPACE_ROOT);
  const structureOnly = env.AICS_REFERENCE_AUDIT_MODE === 'structure';
  const result = { total: 0, missing: 0, pending: 0, unverified: 0, refRoot, errors: [] };
  for (const [id, profile] of Object.entries(data)) {
    const seen = new Set();
    for (const outfit of profile.outfits || []) {
      if (seen.has(outfit.outfitId)) result.errors.push(id + ': duplicate outfit ' + outfit.outfitId);
      seen.add(outfit.outfitId);
      for (const ref of outfit.references || []) {
        if (ref.pending === true) { result.pending++; continue; }
        result.total++;
        let target = '';
        const url = typeof ref.url === 'string' ? ref.url : '';
        const prefix = url.startsWith('/character-references/') ? '/character-references/' :
          url.startsWith('/assets/') ? '/assets/' : '';
        const base = prefix === '/character-references/' ? refRoot : assetsRoot;
        const validationBase = base || path.join(appRoot, '.external-reference-audit');
        if (prefix) {
          try {
            const suffix = decodeURIComponent(url.slice(prefix.length));
            const candidate = path.resolve(validationBase, suffix);
            const relative = path.relative(validationBase, candidate);
            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !/[?#\0]/.test(suffix)) target = candidate;
          } catch { /* 无效编码视作断链，不访问越界路径。 */ }
        }
        if (target && !base && structureOnly && prefix === '/character-references/') {
          result.unverified++;
          continue;
        }
        let exists = false;
        try { exists = Boolean(target) && fs.statSync(target).isFile(); } catch { /* 缺图 */ }
        if (!exists) {
          result.missing++;
          if (result.missing <= 15) result.errors.push(id + '/' + outfit.outfitId + ': ' + (url || '(missing URL)'));
        }
      }
    }
  }
  return result;
}

const HELP = [
  'check:ref-urls — 参考库 URL 断链门禁（按当前索引，pending 不算已发布）',
  '用法: node scripts/maintenance/check-ref-urls.js [--root <完整项目根>] [--help|--plan]',
  '  --root <完整项目根>  替换数据根；优先级 --root > AICS_DATA_ROOT > AICS_APP_ROOT > 仓库根。',
  '                       view 一律从 <root>/data/character-reference-view.json 读取，并把审计',
  '                       appRoot 对齐到该根，不与另一套环境根交叉读取。',
  '  --help | --plan      打印本说明；不读取任何目标文件。',
  '显式素材根配置保持既有含义，不会被清除：AICS_CHARACTER_REF_ROOT（失效不静默换根）、',
  'AICS_ASSETS_ROOT、AI_WORKSPACE_ROOT；AICS_REFERENCE_AUDIT_MODE=structure 仅结构审计。',
  '只读门禁：不修改索引、不写 pending、不自动查找素材。',
  '退出码：0 无断链；1 审计发现断链/重复，或缺 view / 坏 JSON（消息含具体路径）；',
  '2 参数或环境问题（未知/重复/缺值参数、根不可用）。',
].join('\n');

function parseArgs(args: string|unknown[]) {
  const parsed: any = { help: false, plan: false, root: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '--plan') {
      if (seen.has(arg)) return { error: '重复参数: ' + arg };
      seen.add(arg);
      if (arg === '--help') parsed.help = true; else parsed.plan = true;
    } else if (arg === '--root') {
      if (seen.has('--root')) return { error: '重复参数: --root' };
      const value: any = args[i + 1];
      if (!value || value.startsWith('--')) return { error: '参数缺值: --root <完整项目根>' };
      seen.add('--root');
      parsed.root = value;
      i++;
    } else {
      return { error: '无法识别的参数: ' + arg + '（--help 查看用法）' };
    }
  }
  return parsed;
}

function isDirectory(candidate: PathLike) {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

function main(args: any = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  if (parsed.error) {
    console.error('错误: ' + parsed.error);
    return 2;
  }
  if (parsed.help || parsed.plan) {
    console.log(HELP);
    return 0;
  }
  // 数据根与审计 appRoot 同源：env 里残留的另一套根（如 AICS_APP_ROOT）被对齐覆盖，
  // 避免 view 读 AICS_DATA_ROOT 而素材查 AICS_APP_ROOT 的双根交叉。
  const root = parsed.root ? path.resolve(parsed.root) : resolveContentRoot(process.env);
  if (!isDirectory(root)) {
    console.error('错误: 根目录不可用（不存在或不是目录）: ' + root);
    return 2;
  }
  const viewPath = path.join(root, 'data', 'character-reference-view.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(viewPath, 'utf8'));
  } catch (error) {
    console.error('错误: 视图文件缺失或无法解析: ' + viewPath + '（' + runtimeErrorMessage(error) + '）');
    return 1;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('错误: 视图文件不是角色对象表: ' + viewPath);
    return 1;
  }
  let result;
  try {
    result = auditReferenceView(data, root, Object.assign({}, process.env, { AICS_APP_ROOT: root }));
  } catch (error) {
    console.error('错误: 视图内容无法审计: ' + viewPath + '（' + runtimeErrorMessage(error) + '）');
    return 1;
  }
  console.log('total urls:', result.total, '| missing:', result.missing, '| pending:', result.pending,
    '| unverified:', result.unverified, '| refRoot:', result.refRoot || '(not configured)');
  for (const error of result.errors) console.error('REFERENCE:', error);
  if (result.errors.length) {
    console.error('先核对 AICS_CHARACTER_REF_ROOT / AI_WORKSPACE_ROOT 与素材同步；不要用修改索引或 pending 掩盖缺图。');
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();
export = { auditReferenceView, main, HELP };
