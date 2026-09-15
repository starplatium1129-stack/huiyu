'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const servicesRoot = path.join(root, 'services');
const {
  emitRuntime,
  findByteDrift,
  getRuntimeGeneratedInventory,
  listGeneratedFiles,
  listTrackedGeneratedFiles,
}: typeof import('../maintenance/runtime-generated-files') = require('../maintenance/runtime-generated-files');

/**
 * services 运行时产物契约（2026-08-22 出库后版本）：
 *  - 产物（.js/.d.ts）不再进 Git，由 `npm run build:runtime` 就地生成；
 *  - 本测试自给自足：fresh clone 缺产物时就地编译补齐（同时保障
 *    桌面 staging 与 Tauri 打包链路的输入），随后要求与源零字节漂移；
 *  - Git 侧反向断言：任何运行时产物被重新追踪都视为违规。
 */
test('services runtime outputs are generated in place, untracked, and drift-free', () => {
  const inventory = getRuntimeGeneratedInventory(root);
  assert.ok(inventory.sourceFiles.length > 0, 'runtime tsconfig must include service sources');

  let onDisk = listGeneratedFiles(servicesRoot);
  if (onDisk.length < inventory.generatedFiles.length) {
    // fresh clone / 产物缺失：就地构建补齐（等价 npm run build:runtime）
    emitRuntime(root, inventory, servicesRoot);
    onDisk = listGeneratedFiles(servicesRoot);
    console.log('[runtime-generated] outputs compiled in place (self-heal)');
  }

  // Git 反向断言：产物一律不得被追踪
  const tracked = listTrackedGeneratedFiles(root, servicesRoot);
  assert.deepEqual(tracked, [], 'runtime outputs must not be tracked by Git (they are generated)');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-runtime-emit-'));
  try {
    emitRuntime(root, inventory, tempDir);
    const emitted = listGeneratedFiles(tempDir);
    assert.deepEqual(emitted, inventory.generatedFiles, 'runtime source/output set must stay one-to-one');

    // 孤儿产物：源已删除但旧 .js/.d.ts 仍残留磁盘
    const expectedSet = new Set(inventory.generatedFiles);
    const orphan = onDisk.filter((file) => !expectedSet.has(file));
    assert.deepEqual(orphan, [], 'orphan runtime outputs; remove obsolete services .js/.d.ts');

    assert.deepEqual(
      findByteDrift(inventory.generatedFiles, servicesRoot, tempDir),
      [],
      'runtime output is stale; run npm run build:runtime',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
