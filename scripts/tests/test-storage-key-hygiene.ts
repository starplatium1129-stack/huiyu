'use strict';

import { PathLike } from 'node:fs';

/**
 * 存储键卫生扫描 —— 防止已登记的存储键再次以字面量散落到各处。
 *
 * 背景：'aics_pb_history' 曾在 9 个文件里以字面量重复定义，靠注释人工同步；
 * 一处改名即静默分叉（历史上 'aics_projects' vs 'aics_pb_projects' 分叉过一次，
 * 导致备份/恢复与作品册各操作一套数据）。现统一出处为 src/utils/storageKeys.ts，
 * 本扫描作为防回潮门禁。
 *
 * 规则：
 * - 已登记键的字面量只允许出现在「白名单文件」（登记出处 / 刻意零依赖的核心）；
 * - *.spec.ts 豁免：测试有意断言真实落盘键名（端到端验证持久化契约）；
 * - 新增受管键时把键名与出处加进 REGISTERED_KEYS 即可。
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const root = path.resolve(__dirname, '..', '..');
const srcRoot = path.join(root, 'src');

/** 受管键 → 允许出现字面量的文件（相对仓库根，正斜杠）。 */
const REGISTERED_KEYS = {
  'aics_live2d_quality_v1': ['src/utils/storageKeys.ts'],
  'aics_pb_history': [
    'src/utils/storageKeys.ts',
    // 零依赖纯逻辑核心（被 scripts/tests/test-desktop-import.js 直接 require），
    // 刻意不引入任何模块 —— 见文件头契约注释。
    'src/utils/desktopImportCore.ts',
  ],
  'aics_pb_history_quarantine': ['src/utils/storageKeys.ts'],
  'aics_pb_projects': ['src/utils/storageKeys.ts'],
  'aics_video_ctx': ['src/utils/storageKeys.ts'],
  'aics_video_shots_ctx': ['src/utils/storageKeys.ts'],
  'aics_show_mature': ['src/utils/storageKeys.ts'],
};

function listSourceFiles(dir: string) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('registered storage keys appear as literals only in their canonical modules', () => {
  const files = listSourceFiles(srcRoot);
  assert.ok(files.length > 100, 'src 源文件扫描数异常，检查目录结构');

  const violations: any = [];
  for (const file of files) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    if (relative.endsWith('.spec.ts')) continue;
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const [key, allowed] of Object.entries(REGISTERED_KEYS)) {
      if (allowed.includes(relative)) continue;
      lines.forEach((line, index) => {
        if (line.includes(`'${key}'`) || line.includes(`"${key}"`)) {
          violations.push(`${relative}:${index + 1} 出现裸键 '${key}'（请改从 @/utils/storageKeys 引入常量）`);
        }
      });
    }
  }

  assert.deepEqual(violations, [], `存储键字面量散落 ${violations.length} 处：\n${violations.join('\n')}`);
});
