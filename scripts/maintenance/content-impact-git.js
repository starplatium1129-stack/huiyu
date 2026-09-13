'use strict';
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { TextDecoder } = require('node:util');

// NUL records preserve spaces, quotes and newlines. Disable rename detection so
// both old and new names remain in the conservative path set.
function collectGitChanges(root) {
  const result = { status: 'error', raw: [], paths: [], reason: '' };
  try {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key) && key !== 'GIT_OPTIONAL_LOCKS') delete env[key];
    const run = (args) => {
      const output = childProcess.spawnSync('git', args, { cwd: root, env, timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const record = { args, status: output.status, stdout: output.stdout?.toString('utf8') || '', stderr: output.stderr?.toString('utf8') || '' };
      result.raw.push(record);
      if (output.error || output.status !== 0) throw new Error(output.error?.message || `Git 命令失败：${record.stderr}`);
      return new TextDecoder('utf-8', { fatal: true }).decode(output.stdout);
    };
    const top = run(['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
    if (fs.realpathSync(top) !== fs.realpathSync(root)) throw new Error('--root 必须为 Git 工作树根目录，不能把父仓库路径映射到子目录');
    const paths = [];
    for (const args of [
      ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
      ['ls-files', '--others', '--exclude-standard', '-z', '--'],
    ]) {
      const raw = run(args);
      if (raw && !raw.endsWith('\0')) throw new Error('Git 路径输出缺少 NUL 终止符');
      for (const file of raw ? raw.slice(0, -1).split('\0') : []) {
        if (!file || file.includes('\\') || file.includes(':') || file.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Git 路径不可安全解析');
        paths.push(file);
      }
    }
    result.paths = [...new Set(paths)];
    result.status = 'collected';
    result.reason = 'HEAD 对比涵盖 staged/unstaged，另收集 untracked；重命名保留旧/新路径，仅表示路径变化，不推断内容语义或历史关系。';
  } catch (error) { result.reason = error.message; }
  return result;
}
module.exports = { collectGitChanges };
