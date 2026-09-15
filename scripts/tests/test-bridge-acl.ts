import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';
/*
 * 回归保护（2026-08-20 实障）：桌宠桥新增 IPC 命令后若漏配 Tauri ACL，
 * 前端走 invoke 的命令会被 "Command xxx not allowed by ACL" 拒绝，
 * 而 E2E 用 mock 桥测不到、热键/托盘走 Rust 直调也测不到。
 * 本测试静态核对：shim 的 invoke 命令 ⊆ build.rs 命令清单 ⊆ 各 capability 放行。
 */
const { readFileSync }: typeof import('node:fs') = require('node:fs');
const { join }: typeof import('node:path') = require('node:path');
const assert: typeof import('node:assert') = require('node:assert');

const root = join(__dirname, '..', '..');
const srcTauri = join(root, 'desktop-tauri', 'src-tauri');

function read(rel: string) {
  return readFileSync(join(srcTauri, rel), 'utf8');
}

/** shim.rs 里所有 invoke('cmd') 的命令名 */
function shimCommands() {
  const src = read('src/shim.rs');
  const set = new Set();
  for (const m of src.matchAll(/invoke\(\s*'([a-z_0-9]+)'/g)) set.add(m[1]);
  // 手动补：不在 shim 字符串里、但仍会被前端直接 invoke 的核心/插件命令不算业务命令，跳过
  return set;
}

/** build.rs AppManifest commands["..."] 清单 */
function buildRsCommands() {
  const src = read('build.rs');
  const set = new Set();
  for (const m of src.matchAll(/"([a-z_0-9]+)"/g)) set.add(m[1]);
  return set;
}

function capability(rel: string) {
  return JSON.parse(read(rel));
}

function permissionIds(cap: { permissions: unknown; }) {
  return new Set((cap.permissions || []).filter((p: string) => p.startsWith('allow-')));
}

function snakeToKebab(name: unknown) {
  return name.replace(/_/g, '-');
}

function main() {
  const shim = shimCommands();
  const build = buildRsCommands();
  const defaultCap = capability('capabilities/default.json');
  const live2dCap = capability('capabilities/companion-live2d.json');
  const allowed = new Set([
    ...permissionIds(defaultCap),
    ...permissionIds(live2dCap),
  ]);

  // 1) shim invoke 的命令都必须在 build.rs 清单（否则连 permission toml 都不会生成）
  const missingInBuild = [...shim].filter((c) => !build.has(c));
  assert.deepStrictEqual(
    missingInBuild,
    [],
    `shim 里 invoke 了但 build.rs 命令清单缺失（将导致 ACL 拒绝）: ${missingInBuild.join(', ')}`,
  );

  // 2) build.rs 的命令都必须被某个 capability allow-<kebab> 放行
  const notAllowed = [...build].filter((c) => !allowed.has(`allow-${snakeToKebab(c)}`));
  assert.deepStrictEqual(
    notAllowed,
    [],
    `build.rs 命令未在任何 capability 放行（将导致 "not allowed by ACL"）: ${notAllowed.join(', ')}`,
  );

  // 3) 桥相关窗口必须都在 default capability 覆盖（预览 WebView 也会走 IPC）
  const winSet = new Set(defaultCap.windows || []);
  for (const w of ['companion', 'companion-chat', 'atelier']) {
    assert.ok(winSet.has(w), `default capability 的 windows 缺 ${w}（该窗口任何 IPC 都会被 ACL 拒）`);
  }

  console.log(`[bridge-acl] shim ${shim.size} 命令 ⊆ build.rs ${build.size} 个，全部放行；windows 覆盖 OK`);
  console.log('  shim:', [...shim].sort().join(', '));
}

try {
  main();
} catch (e) {
  console.error('[bridge-acl] FAIL:');
  console.error(runtimeErrorMessage(e));
  process.exit(1);
}
