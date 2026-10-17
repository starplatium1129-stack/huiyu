'use strict';

/**
 * scripts/maintenance/install-git-hooks.js —— postinstall 挂钩。
 * 清理指向已移除目录的旧配置，保留用户自设钩子。
 */

const { execFileSync }: typeof import('child_process') = require('child_process');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
function migrateHooks() {
  const root = path.resolve(__dirname, '../..');
  const options: ExecFileSyncOptionsWithStringEncoding = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
  let configured;
  try {
    configured = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], options).trim();
  } catch {
    return 'no local hooks override';
  }
  if (configured !== '.githooks' || fs.existsSync(path.join(root, '.githooks'))) return 'existing hooks preserved';
  execFileSync('git', ['config', '--local', '--unset-all', 'core.hooksPath'], options);
  return 'removed obsolete .githooks override';
}

if (require.main === module) console.log(`[hooks] ${migrateHooks()}`);
