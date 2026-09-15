#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/verify-resource-pack.js — resource:verify-delta 入口（只读，G15）
 *
 * 核验增量候选包与给定基线的只读兼容性：纯函数层先复用 audit:resource-manifest 的清单
 * 结构检查，再核对 delta 元数据 kind/schema 与身份/数量字段形态；验证基线
 * contentIdentity/entryCount/totalBytes 与 delta.baseManifest 相符；以基线移除
 * delta.removed 后叠加候选 added/changed 重建目标条目，其身份三项必须与
 * delta.newManifest 相符；按实际集合关系重算 added/removed/changed/unchanged 并与
 * delta.totals、delta.candidate（files/bytes/zeroAssets）和候选 manifest 实际条目一致。
 * 不只对比总数：removed 每项必须确实存在于基线且 bytes/hash 相符，路径唯一且不得同时
 * 出现在候选中；候选与基线同路径同内容的条目不能冒充 changed。
 * IO 层只读取明确指定的基线 JSON、候选 manifest.json/delta.json 和候选已列资源（复用
 * 现有 verifyManifestEntries 核验候选实际字节）；不 stat/read 基线资产、不扫描安装目录；
 * 基线文件可已不存在，元数据仍可核验。清单/包目录/内部路径遵守 root 与真实路径边界，
 * 拒绝通过 junction 或坏路径访问外部目录。缺 delta.json 的全包不能按增量候选核验。
 *
 * 全程零写入、无安装/删除/网络。--help/--plan 仅打印用法，不读取目标文件。
 *
 * 退出码契约：
 *   0  核验通过（空候选与仅删除候选可合法通过）
 *   1  内容/不兼容（元数据缺失/损坏/不支持版本、清单结构错误或非空 unverified、基线或
 *      目标身份失配、totals/candidate 与实际不符、候选实际字节核验失败）
 *   2  参数/越界/环境（参数缺失或无法识别、root 不可用、基线清单越界/缺失/不可读、
 *      候选目录越界/缺失/不是目录/junction 逃逸、内部异常）
 *
 * 核验通过只表示「相对于给定基线可重建声明目标且候选字节匹配」，不是数字签名、可信
 * 来源、当前安装状态或质量验收。实现见 scripts/lib/resource-pack-verify.js。
 */

const path: typeof import('node:path') = require('node:path');
const { UsageError, verifyDeltaPack }: typeof import('../lib/resource-pack-verify') = require('../lib/resource-pack-verify');

const HELP = [
  'resource:verify-delta [options] — 增量候选包与基线的只读兼容核验（不是安装器，不代表已安装更新）',
  '  --base-manifest <root内JSON>  必填：导出该候选包时使用的基线清单；只做读取、结构检查与',
  '                                身份比对，不读取基线对应磁盘资产（removed 文件可已不存在）',
  '  --pack <root内候选目录>       必填：待核验的增量候选包目录（内含 manifest.json 与 delta.json；',
  '                                缺 delta.json 的全包不能按增量候选核验）',
  '  --root <目录>                 替换数据根（默认仓库根）',
  '  --help | --plan               打印本说明；不读取目标文件',
  '核验内容：基线/候选清单结构检查（复用 audit:resource-manifest 同套规则）、delta 元数据',
  'kind/schema 与身份/数量字段形态、基线 contentIdentity/entryCount/totalBytes 与',
  'delta.baseManifest 相符、基线移除 removed 叠加候选 added/changed 重建目标与',
  'delta.newManifest 相符、四类数量重算与 delta.totals 一致、delta.candidate 与候选实际',
  '条目一致、候选已列文件字节/SHA-256 与候选 manifest 一致（复用现有清单核验）。',
  '只读：全程零写入，只读取基线 JSON、候选 manifest.json/delta.json 与候选已列资源；',
  '不读取基线资产，不扫描安装目录；基线清单/候选目录/内部路径遵守 root 与真实路径边界，',
  'junction 或坏路径访问外部目录在读取前拒绝。',
  '退出码：0 核验通过（空候选与仅删除候选可合法通过）；1 内容/不兼容（元数据缺失/损坏/',
  '不支持版本、结构错误/非空 unverified、身份或数量失配、候选字节核验失败）；',
  '2 参数/越界/环境（参数缺失或无法识别、root 不可用、基线越界/缺失、候选目录越界/缺失/不是目录）。',
  '核验通过不是数字签名、可信来源、当前安装状态或质量验收。',
].join('\n');

function main(args = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..', '..');
  let baseManifestPath = null;
  let packPath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '--plan') {
      console.log(HELP);
      return 0;
    } else if (arg === '--root' && args[i + 1] && !args[i + 1].startsWith('--')) {
      root = args[++i];
    } else if (arg === '--base-manifest' && args[i + 1] && !args[i + 1].startsWith('--')) {
      baseManifestPath = args[++i];
    } else if (arg === '--pack' && args[i + 1] && !args[i + 1].startsWith('--')) {
      packPath = args[++i];
    } else {
      console.error(`无法识别的参数: ${arg}（--help 查看用法）`);
      return 2;
    }
  }
  if (!baseManifestPath || !packPath) {
    console.error('错误: --base-manifest <root内JSON> 与 --pack <root内候选目录> 均为必填（--help 查看用法）');
    return 2;
  }
  try {
    const result = verifyDeltaPack({ root, baseManifestPath, packPath });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`错误: ${err.message}`);
      return 2;
    }
    console.error(err && err.stack ? err.stack : String(err));
    return 2;
  }
}

if (require.main === module) process.exitCode = main();
export = { main, HELP };
