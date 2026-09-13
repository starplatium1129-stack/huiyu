#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/report-resource-manifest.js — audit:resource-manifest 入口（只读）
 *
 * 默认：生成 root/assets 资源清单（schemaVersion 1）并打印 JSON；不写任何文件，
 * 清单保存由调用者显式重定向到自己的输出目录。
 * --manifest <root内JSON>：校验清单（重复/非法/越界路径、缺失、字节与哈希），打印结果 JSON。
 * --root <目录>：替换数据根（默认仓库根）。--help/--plan 仅打印用法，不读取目标文件、
 * 不计算哈希。无隐式修复、删除或上传；不做任意 URL 抓取或全盘发现。
 *
 * 退出码契约：
 *   0  成功（生成无未核验项 / 校验全部通过）
 *   1  目标内容有问题（生成含未核验项；校验错误、清单格式错误或不支持的 schemaVersion）
 *   2  参数或环境问题（参数非法、root/扫描根不可用、manifest 路径越界或不可读、内部异常）
 *
 * 哈希一致只证明字节一致；文件存在不代表内容已交付、图片质量或审核通过，
 * 清单不代表可信发布源。实现见 scripts/lib/resource-manifest.js。
 */

const path = require('node:path');
const { generateManifest, verifyManifest, UsageError } = require('../lib/resource-manifest');

const HELP = [
  'audit:resource-manifest [options] — 只读本地资源清单生成与校验',
  '  （默认）                  生成并打印 root/assets 清单 JSON：root 相对 posix 路径、字节数、',
  '                            SHA-256；路径稳定排序；排除 assets/character-references，',
  '                            不跟随符号链接/junction，无法核验项单列 unverified',
  '  --manifest <root内JSON>   校验清单：重复路径、非法/越界路径（含编码分隔符与 junction）、',
  '                            文件缺失、字节或哈希不匹配；只核对已列条目，不发现未登记文件',
  '  --root <目录>             替换数据根（默认仓库根）',
  '  --help | --plan           打印本说明；不读取目标文件、不计算哈希',
  '只读：零写入，清单保存由调用者显式重定向到自己的输出目录。',
  '退出码：0 成功；1 发现未核验项或校验/格式错误；2 参数或环境问题。',
  '哈希一致只证明字节一致；文件存在不代表内容已交付、图片质量或审核通过。',
].join('\n');

function main(args = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..', '..');
  let manifestPath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '--plan') {
      console.log(HELP);
      return 0;
    } else if (arg === '--root' && args[i + 1] && !args[i + 1].startsWith('--')) {
      root = args[++i];
    } else if (arg === '--manifest' && args[i + 1] && !args[i + 1].startsWith('--')) {
      manifestPath = args[++i];
    } else {
      console.error(`无法识别的参数: ${arg}（--help 查看用法）`);
      return 2;
    }
  }
  try {
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
module.exports = { main, HELP };
