#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/report-resource-manifest.js — audit:resource-manifest 入口（只读）
 *
 * 默认：生成 root/assets 资源清单（schemaVersion 1）并打印 JSON；不写任何文件，
 * 清单保存由调用者显式重定向到自己的输出目录。
 * --manifest <root内JSON>：校验清单（重复/非法/越界路径、缺失、字节与哈希），打印结果 JSON。
 * --manifest <旧清单> --compare-manifest <新清单>：差异比较（G7）。只读取 root 内这两份
 * 清单，不读取/哈希实际 assets；按精确路径输出新增/移除/改变/未改变；不用 generatedAt
 * 判定新旧，不按相同哈希猜测重命名；含未核验项或结构错误时不构成「完整一致」结论（退出 1）。
 * --root <目录>：替换数据根（默认仓库根）。--help/--plan 仅打印用法，不读取目标文件、
 * 不计算哈希。无隐式修复、删除或上传；不做任意 URL 抓取或全盘发现。
 *
 * 退出码契约：
 *   0  成功（生成无未核验项 / 校验全部通过 / 比较有效完成——存在差异本身不算失败）
 *   1  目标内容有问题（生成含未核验项；校验错误、清单格式错误或不支持的 schemaVersion；
 *      比较含结构错误或非空 unverified，未达成可宣称的一致结论）
 *   2  参数或环境问题（参数非法、--compare-manifest 缺少 --manifest、root/扫描根不可用、
 *      manifest 路径越界或不可读、内部异常）
 *
 * 哈希一致只证明字节一致；文件存在不代表内容已交付、图片质量或审核通过，
 * 清单不代表可信发布源。实现见 scripts/lib/resource-manifest.js。
 */

const path: typeof import('node:path') = require('node:path');
const { generateManifest, verifyManifest, compareManifestFiles, UsageError }: typeof import('../lib/resource-manifest') = require('../lib/resource-manifest');

const HELP = [
  'audit:resource-manifest [options] — 只读本地资源清单生成、校验与差异比较',
  '  （默认）                  生成并打印 root/assets 清单 JSON：root 相对 posix 路径、字节数、',
  '                            SHA-256；路径稳定排序；排除 assets/character-references，',
  '                            不跟随符号链接/junction，无法核验项单列 unverified',
  '  --manifest <root内JSON>   校验清单：重复路径、非法/越界路径（含编码分隔符与 junction）、',
  '                            文件缺失、字节或哈希不匹配；只核对已列条目，不发现未登记文件',
  '  --manifest <旧JSON>       差异比较：与 --compare-manifest <新JSON> 同用；只读取这两份',
  '  --compare-manifest <新JSON> 清单（root 内），不读取实际资产；按精确路径输出新增/移除/',
  '                            改变/未改变；不用 generatedAt 判定新旧，不按相同哈希猜测重命名；',
  '                            含未核验项或结构错误时不构成完整一致结论（退出 1）',
  '  --root <目录>             替换数据根（默认仓库根）',
  '  --help | --plan           打印本说明；不读取目标文件、不计算哈希',
  '只读：零写入，清单保存由调用者显式重定向到自己的输出目录。',
  '退出码：0 成功（有差异的比较本身不算失败）；1 发现未核验项或校验/格式/比较结构错误；',
  '2 参数或环境问题（含 --compare-manifest 缺少 --manifest）。',
  '哈希一致只证明字节一致；文件存在不代表内容已交付、图片质量或审核通过。',
].join('\n');

function main(args = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..', '..');
  let manifestPath = null;
  let compareManifestPath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '--plan') {
      console.log(HELP);
      return 0;
    } else if (arg === '--root' && args[i + 1] && !args[i + 1].startsWith('--')) {
      root = args[++i];
    } else if (arg === '--manifest' && args[i + 1] && !args[i + 1].startsWith('--')) {
      manifestPath = args[++i];
    } else if (arg === '--compare-manifest' && args[i + 1] && !args[i + 1].startsWith('--')) {
      compareManifestPath = args[++i];
    } else {
      console.error(`无法识别的参数: ${arg}（--help 查看用法）`);
      return 2;
    }
  }
  try {
    if (manifestPath && compareManifestPath) {
      const result = compareManifestFiles({ root, manifestPath, compareManifestPath });
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    if (compareManifestPath) {
      throw new UsageError('--compare-manifest 需要与 --manifest <旧清单> 同用：差异比较必须明确指定两份清单');
    }
    if (manifestPath) {
      const result = verifyManifest({ root, manifestPath });
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    const manifest = generateManifest({ root });
    console.log(JSON.stringify(manifest, null, 2));
    return manifest.unverified.length ? 1 : 0;
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
