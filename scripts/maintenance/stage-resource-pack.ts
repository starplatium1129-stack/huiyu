#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/stage-resource-pack.js — resource:pack 入口（离线资源候选包暂存导出）
 *
 * 默认：只预览复制计划（JSON，stdout），零写入；但会读取清单并核验源文件（读取不是零读取）。
 * --apply：先复用现有清单核验（结构/重复/越界/排除域/未核验项/缺失/字节/哈希任一失败即拒绝），
 *   通过后把清单已列普通文件复制到 <root>/scripts/archive/resource-packs/<包名>/ 新目录，
 *   保留 assets/... 相对结构并写入 manifest.json（可被 audit:resource-manifest 复核）。
 *   复制走专用暂存目录，逐项读回核验字节/SHA-256，整体复核后才放到最终包名并做发布后验收；
 *   源变化、写入失败、目标冲突不报告成功，暂存目录保留并给出路径。
 * --base-manifest <root内旧JSON>（与 --manifest <新JSON> 同用，缺 --manifest 退出 2）：
 *   增量候选包模式（G13）。复用 audit:resource-manifest 的纯比较，只复制 added/changed 项；
 *   unchanged 不进候选文件，removed 仅作为差异记录、不删除任何资源。旧清单只做结构核验、
 *   不读取其对应磁盘资产；新清单仍按全包同套完整核验；任一清单结构错误/非空 unverified 拒绝。
 *   候选 manifest.json 只列实际复制的条目（可被现有 verifier 复核），另写 delta.json 记录
 *   旧/新清单内容身份（稳定 path/bytes/sha256，不含 generatedAt）、四类数量与移除路径；
 *   两个元数据都在最终改名前读回核对。增量产物不是完整可安装包，不能当作已安装更新；
 *   零差异时输出明确的零资产候选。复制/暂存/发布协议与全包模式相同。
 * 目标只要已存在（含空目录）即拒绝，不覆盖旧包；目标祖先链中的符号链接/junction 被拒绝。
 * --root <目录>：替换数据根（默认仓库根）。--help/--plan 仅打印用法，不读取目标文件。
 *
 * 不是安装器/下载器：不转换/重采样图片，不执行复制内容，不做 ZIP 解压/安装，无网络行为，
 * 不写安装目录之外由 --root 指定范围以外的任何位置。输出只称「候选包已通过字节核验」，
 * 不代表图片质量、审核或部署完成。实现见 scripts/lib/resource-pack.js 与
 * scripts/lib/resource-pack-delta.js。
 *
 * 退出码契约：
 *   0  成功（预览计划可行 / 候选包已通过字节核验并落盘）
 *   1  目标或内容问题（非 Windows apply、清单核验失败/格式错误/不支持 schemaVersion、目标已存在、
 *      目标祖先链含链接、复制或核验失败、发布后验收失败；增量模式含任一清单结构错误/非空 unverified）
 *   2  参数或环境问题（包名非法、参数缺失或无法识别、root 不可用、清单路径越界或不可读）
 */

const path: typeof import('node:path') = require('node:path');
const { UsageError, planResourcePack, stageResourcePack }: typeof import('../lib/resource-pack') = require('../lib/resource-pack');
const { planResourcePackDelta, stageResourcePackDelta }: typeof import('../lib/resource-pack-delta') = require('../lib/resource-pack-delta');

const HELP = [
  'resource:pack [options] — 离线资源候选包暂存导出（受控复制；不是安装器或下载器）',
  '  --manifest <root内JSON>   必填：新清单（先复用 audit:resource-manifest 同套核验，',
  '                            重复/越界/排除域/未核验项/缺失/错大小/错哈希任一失败即拒绝）',
  '  --base-manifest <旧JSON>  可选：与 --manifest 同用切换为增量候选包（只复制 added/changed 项；',
  '                            unchanged 不进包，removed 仅记录不删除；候选写 manifest.json 与 delta.json；',
  '                            产物是增量候选，不是完整可安装包）；旧清单只做结构核验、不读取其磁盘资产',
  '  --name <包名>             必填：仅字母、数字、下划线、短横线（1-64 字符，无路径片段）',
  '  --root <目录>             替换数据根（默认仓库根）',
  '  --apply                   仅 Windows 支持；实际复制到 <root>/scripts/archive/resource-packs/<包名>/ 新目录；',
  '                            默认（不带 --apply）只预览计划，零写入',
  '  --help | --plan           打印本说明；不读取目标文件',
  '预览会读取清单并核验源文件（读取不是零读取），但不写任何路径；--apply 复制经专用暂存目录，',
  '逐项读回核验字节/SHA-256 并整体复核后才放到最终包名；失败保留暂存目录并给出路径。',
  '目标已存在（含空目录）即拒绝；不覆盖旧包；目标祖先链拒绝符号链接/junction。',
  '退出码：0 成功；1 目标或内容问题（核验失败、目标已存在、复制/发布核验失败）；',
  '2 参数或环境问题（包名非法、root 不可用、清单越界或不可读）。',
  '候选包已通过字节核验仅表示复制内容与清单一致；不代表图片质量、审核或部署完成。',
].join('\n');

function main(args: any = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..', '..');
  let manifestPath = null;
  let baseManifestPath = null;
  let name = null;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '--plan') {
      console.log(HELP);
      return 0;
    } else if (arg === '--root' && args[i + 1] && !args[i + 1].startsWith('--')) {
      root = args[++i];
    } else if (arg === '--manifest' && args[i + 1] && !args[i + 1].startsWith('--')) {
      manifestPath = args[++i];
    } else if (arg === '--base-manifest' && args[i + 1] && !args[i + 1].startsWith('--')) {
      baseManifestPath = args[++i];
    } else if (arg === '--name' && args[i + 1] && !args[i + 1].startsWith('--')) {
      name = args[++i];
    } else if (arg === '--apply') {
      apply = true;
    } else {
      console.error(`无法识别的参数: ${arg}（--help 查看用法）`);
      return 2;
    }
  }
  if (baseManifestPath && !manifestPath) {
    console.error('错误: --base-manifest 需要与 --manifest <新JSON> 同用（无 --base-manifest 时为全包模式）');
    return 2;
  }
  try {
    let result;
    if (baseManifestPath) {
      result = apply
        ? stageResourcePackDelta({ root, name, manifestPath, baseManifestPath })
        : planResourcePackDelta({ root, name, manifestPath, baseManifestPath });
    } else {
      result = apply
        ? stageResourcePack({ root, name, manifestPath })
        : planResourcePack({ root, name, manifestPath });
    }
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } catch (err: any) {
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
