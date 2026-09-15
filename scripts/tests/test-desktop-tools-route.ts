'use strict';

/**
 * 桌面本地工具执行器测试（routes/desktop-tools.js —— Tauri 壳经网关 /api/desktop-tools 调用）。
 *
 * 由已退役 Electron 版 desktop/toolRunner.ts 的 test-companion-tools.js 移植：
 * - 路径白名单、大小写不敏感、读写上限、命令执行与未知工具拒绝（直接测 runTool 纯函数）；
 * - 真实 HTTP 路由装配（断言 /api/desktop-tools 输出，含 localOnly 拒绝代理头）。
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const express: typeof import('express') = require('express');
const vm: typeof import('node:vm') = require('node:vm');
const { setTimeout: delay }: typeof import('node:timers/promises') = require('node:timers/promises');
const { runToolProcess }: typeof import('../../server/tool-process') = require('../../server/tool-process');
const { killPid }: typeof import('../../server/process-tree') = require('../../server/process-tree');

const {
  runTool: runToolUntrusted,
  isPathInsideWorkspace,
  resolveWorkspacePath,
  createDesktopToolsRouter,
}: typeof import('../../routes/desktop-tools.js') = require('../../routes/desktop-tools.js');

// Existing command lifecycle tests explicitly exercise the operator-enabled profile.
function runTool(root, name, args, context) {
  return runToolUntrusted(root, name, args, { trustedCommands: true, ...context });
}

test('默认文件工具拒绝外向目录链接，允许内部链接与新文件', async () => {
  const parent = tempWorkspace();
  const root = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, 'inside'));
  fs.writeFileSync(path.join(outside, 'marker.txt'), 'OUTSIDE_FIXTURE');
  fs.writeFileSync(path.join(root, 'inside', 'marker.txt'), 'INSIDE_FIXTURE');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, path.join(root, 'outward'), linkType);
  fs.symlinkSync(path.join(root, 'inside'), path.join(root, 'inward'), linkType);
  try {
    for (const [name, args] of [
      ['read_file', { path: 'outward/marker.txt' }],
      ['read_image', { path: 'outward/marker.txt' }],
      ['list_files', { path: 'outward' }],
      ['write_file', { path: 'outward/new/deep.txt', content: 'must not write' }],
    ]) {
      const denied = await runToolUntrusted(root, name, args);
      assert.equal(denied.ok, false, name);
      assert.match(denied.output, /工作区外/);
    }
    assert.equal(fs.existsSync(path.join(outside, 'new')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'marker.txt'), 'utf8'), 'OUTSIDE_FIXTURE');
    assert.equal((await runToolUntrusted(root, 'read_file', { path: 'inward/marker.txt' })).output, 'INSIDE_FIXTURE');
    assert.equal((await runToolUntrusted(root, 'write_file', { path: 'inward/new/deep.txt', content: 'inside' })).ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'inside/new/deep.txt'), 'utf8'), 'inside');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('通用命令必须由操作员启用，模型参数不能声明信任', async () => {
  const root = tempWorkspace();
  const app = express();
  app.use(createDesktopToolsRouter({ config: { AI_WORKSPACE_ROOT: root, DESKTOP_TRUSTED_COMMANDS: false } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const args = { command: 'node', args: ['--version'], trustedCommands: true };
    const direct = await runToolUntrusted(root, 'run_command', args);
    assert.equal(direct.code, 'TRUSTED_EXECUTION_REQUIRED');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/desktop-tools`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'run_command', args, trustedCommands: true, commandMode: 'trusted' }),
    });
    assert.equal((await response.json()).code, 'TRUSTED_EXECUTION_REQUIRED');
    const info = await runToolUntrusted(root, 'get_workspace_info', {});
    assert.equal(JSON.parse(info.output).commandMode, 'disabled');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('受信任命令档：实际 npm/npx 版本查询与含空格工作目录', async () => {
  const parent = tempWorkspace();
  const root = path.join(parent, 'workspace with spaces');
  fs.mkdirSync(root);
  try {
    for (const command of ['npm', 'npx']) {
      const result = await runTool(root, 'run_command', { command, args: ['--version'] });
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /^\d+\.\d+\.\d+/);
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.cjs' } }));
    fs.writeFileSync(path.join(root, 'check.cjs'), "console.log(JSON.stringify(process.argv.slice(2))); process.exit(3);");
    const failed = await runTool(root, 'run_command', { command: 'npm', args: ['run', 'verify', '--', 'argument with spaces'] });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'COMMAND_FAILED');
    assert.match(failed.output, /argument with spaces/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('受信任 npm 脚本取消后，包装器下的父子进程均退出', async () => {
  const parent = tempWorkspace();
  const root = path.join(parent, 'npm workspace with spaces');
  fs.mkdirSync(root);
  const controller = new AbortController();
  let pids = [];
  try {
    writeProcessTree(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { wait: 'node tree.cjs' } }));
    const pending = runTool(root, 'run_command', { command: 'npm', args: ['run', 'wait'] }, { signal: controller.signal });
    await waitFor(() => fs.existsSync(path.join(root, 'ready.json')));
    pids = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
    assert.ok(pids.every(isAlive));
    controller.abort();
    assert.equal((await pending).code, 'ABORT_ERR');
    await waitFor(() => pids.every(pid => !isAlive(pid)));
  } finally {
    controller.abort(); pids.filter(isAlive).forEach(killPid);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('工具路由沿用注入的网关工作区，进程环境不能覆盖它', async () => {
  const root = tempWorkspace();
  const app = express();
  app.use(createDesktopToolsRouter({ config: { AI_WORKSPACE_ROOT: root, DESKTOP_TRUSTED_COMMANDS: false } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/desktop-tools`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'get_workspace_info', args: {} }),
    });
    const result = await response.json();
    assert.equal(JSON.parse(result.output).workspaceRoot, root);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aics-tools-'));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'process lifecycle condition did not settle');
    await delay(25);
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writeProcessTree(root) {
  fs.writeFileSync(path.join(root, 'tree.cjs'), [
    "const fs = require('node:fs');",
    "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "child.once('spawn', () => fs.writeFileSync('ready.json', JSON.stringify([process.pid, child.pid])));",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
}

function nativeBridge(base) {
  const source = fs.readFileSync(path.join(__dirname, '../../desktop-tauri/src-tauri/src/shim.rs'), 'utf8');
  const script = source.match(/pub const COMPANION_SHIM_JS: &str = r#"([\s\S]*?)"#;/)?.[1];
  assert.ok(script, 'native bridge source must be available');
  const window = { __TAURI__: { core: { invoke: async () => ({}) }, event: { listen: async () => () => {}, emit: async () => {} } } };
  vm.runInNewContext(script, {
    window, location: { pathname: '/prompt-builder' },
    document: { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 0, clearTimeout: () => {}, console: { log() {}, error() {} },
    fetch: (url, options) => fetch(base + url, options),
  });
  return window.companionDesktop;
}

test('run_command：取消已启动进程及子进程，不影响其他请求', async () => {
  const root = tempWorkspace();
  const controller = new AbortController();
  let pids = [];
  try {
    writeProcessTree(root);
    const pending = runTool(root, 'run_command', { command: 'node', args: ['tree.cjs'] }, { signal: controller.signal });
    await waitFor(() => fs.existsSync(path.join(root, 'ready.json')));
    pids = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
    assert.ok(pids.every(isAlive));
    const other = runTool(root, 'run_command', { command: 'node', args: ['-e', "setTimeout(() => console.log('independent'), 300)"] });
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ABORT_ERR');
    await waitFor(() => pids.every(pid => !isAlive(pid)));
    assert.deepEqual(await other, { ok: true, output: 'independent' });
  } finally {
    controller.abort();
    pids.filter(isAlive).forEach(killPid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run_command：提前取消、超时、输出超限和非零退出均不能冒充成功', async () => {
  const root = tempWorkspace();
  try {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runTool(root, 'write_file', { path: 'never.txt', content: 'must not be written' }, { signal: controller.signal });
    assert.equal(cancelled.code, 'ABORT_ERR');
    assert.equal(fs.existsSync(path.join(root, 'never.txt')), false);
    await assert.rejects(runToolProcess('node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, timeout: 300 }), { code: 'COMMAND_TIMEOUT' });
    const overflow = await runTool(root, 'run_command', { command: 'node', args: ['-e', "process.stdout.write('x'.repeat(100000))"] });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.code, 'COMMAND_OUTPUT_LIMIT');
    const failed = await runTool(root, 'run_command', { command: 'node', args: ['-e', "console.log('partial output'); process.exit(2)"] });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'COMMAND_FAILED');
    assert.match(failed.output, /partial output/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('生产桌面桥取消：真实 HTTP 断开后终止网关内工具进程树', async () => {
  const root = tempWorkspace();
  const previous = process.env.AI_WORKSPACE_ROOT;
  process.env.AI_WORKSPACE_ROOT = root;
  const app = express();
  app.use(createDesktopToolsRouter({ config: { AI_WORKSPACE_ROOT: root, DESKTOP_TRUSTED_COMMANDS: true } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const controller = new AbortController();
  let pids = [];
  try {
    writeProcessTree(root);
    const bridge = nativeBridge(`http://127.0.0.1:${server.address().port}`);
    const pending = bridge.runTool('run_command', { command: 'node', args: ['tree.cjs'] }, { signal: controller.signal }).catch(error => error);
    await waitFor(() => fs.existsSync(path.join(root, 'ready.json')));
    pids = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
    controller.abort();
    assert.equal((await pending).name, 'AbortError');
    await waitFor(() => pids.every(pid => !isAlive(pid)));
  } finally {
    controller.abort();
    pids.filter(isAlive).forEach(killPid);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.AI_WORKSPACE_ROOT;
    else process.env.AI_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('路径白名单：拒绝绝对路径与 .. 逃逸', () => {
  const root = tempWorkspace();
  try {
    assert.throws(() => resolveWorkspacePath(root, 'C:/Windows/System32'), /相对路径/);
    assert.throws(() => resolveWorkspacePath(root, '/etc/passwd'), /相对路径/);
    assert.throws(() => resolveWorkspacePath(root, '../outside'), /\.\./);
    assert.throws(() => resolveWorkspacePath(root, 'a/../../b'), /\.\./);
    assert.equal(resolveWorkspacePath(root, ''), path.resolve(root));
    assert.equal(resolveWorkspacePath(root, 'x/y.txt'), path.join(path.resolve(root), 'x', 'y.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('路径边界：Windows 大小写不敏感', () => {
  const root = tempWorkspace();
  try {
    const nested = path.join(root, 'SubDir', 'File.txt');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'ok');
    const resolved = resolveWorkspacePath(root, 'subdir/file.txt');
    assert.equal(isPathInsideWorkspace(root, resolved), true);
    assert.equal(isPathInsideWorkspace(root, path.join(root, 'SUBdir', '..', '..', '..', 'Windows')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('list_files：列出目录内容（含子目录标记）', async () => {
  const root = tempWorkspace();
  try {
    fs.mkdirSync(path.join(root, 'dir-a'));
    fs.writeFileSync(path.join(root, 'file-a.txt'), 'hello');
    const result = await runTool(root, 'list_files', { path: '' });
    assert.equal(result.ok, true);
    assert.match(result.output, /dir-a\//);
    assert.match(result.output, /file-a\.txt/);
    assert.match(result.output, /共 2 项/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file：文本可读、二进制拒绝、超限拒绝', async () => {
  const root = tempWorkspace();
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), '你好，世界');
    const text = await runTool(root, 'read_file', { path: 'note.txt' });
    assert.equal(text.ok, true);
    assert.equal(text.output, '你好，世界');

    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0xff]));
    const binary = await runTool(root, 'read_file', { path: 'blob.bin' });
    assert.equal(binary.ok, false);
    assert.match(binary.output, /二进制/);

    const missing = await runTool(root, 'read_file', { path: 'nope.txt' });
    assert.equal(missing.ok, false);

    const escaped = await runTool(root, 'read_file', { path: '../secret.txt' });
    assert.equal(escaped.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('write_file：写入并原子替换', async () => {
  const root = tempWorkspace();
  try {
    const written = await runTool(root, 'write_file', { path: 'notes/idea.md', content: '第一版' });
    assert.equal(written.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'idea.md'), 'utf8'), '第一版');
    const overwritten = await runTool(root, 'write_file', { path: 'notes/idea.md', content: '第二版' });
    assert.equal(overwritten.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'idea.md'), 'utf8'), '第二版');
    const tooBig = await runTool(root, 'write_file', { path: 'big.txt', content: 'x'.repeat(512 * 1024 + 1) });
    assert.equal(tooBig.ok, false);
    const escaped = await runTool(root, 'write_file', { path: '../../evil.txt', content: 'x' });
    assert.equal(escaped.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run_command：参数数组执行，无 shell 注入面', async () => {
  const root = tempWorkspace();
  try {
    const version = await runTool(root, 'run_command', { command: 'node', args: ['--version'] });
    assert.equal(version.ok, true);
    assert.match(version.output, /^v\d+/);

    // 若 `;` 被 shell 解释，stdout 会出现 "pwned"；execFile 参数数组化下不应出现
    const injection = await runTool(root, 'run_command', {
      command: 'node',
      args: ['-p', '"ok"', ';', 'echo', 'pwned'],
    });
    assert.equal(injection.ok, true);
    assert.equal(injection.output.includes('pwned'), false, 'shell metacharacters must not be interpreted');

    const missing = await runTool(root, 'run_command', { command: 'definitely-not-a-real-command-xyz', args: [] });
    assert.equal(missing.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_image：图片转 data URL，非图片与超限拒绝', async () => {
  const root = tempWorkspace();
  try {
    // 1x1 透明 PNG（魔数 + IHDR 最小结构）
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    fs.writeFileSync(path.join(root, 'pic.png'), png);
    const image = await runTool(root, 'read_image', { path: 'pic.png' });
    assert.equal(image.ok, true);
    assert.match(image.output, /png/);
    assert.ok(image.imageDataUrl && image.imageDataUrl.startsWith('data:image/png;base64,'), 'read_image must return a png data url');

    fs.writeFileSync(path.join(root, 'fake.jpg'), Buffer.from('not an image at all'));
    const fake = await runTool(root, 'read_image', { path: 'fake.jpg' });
    assert.equal(fake.ok, false);
    assert.match(fake.output, /不支持的文件格式/);

    const escaped = await runTool(root, 'read_image', { path: '../photo.png' });
    assert.equal(escaped.ok, false);

    const textOnly = await runTool(root, 'read_image', { path: 'pic.png', extra: 'ignored' });
    assert.equal(textOnly.ok, true, 'extra args must be ignored');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('get_workspace_info 与未知工具', async () => {
  const root = tempWorkspace();
  try {
    const info = await runTool(root, 'get_workspace_info', {});
    assert.equal(info.ok, true);
    assert.match(info.output, /workspaceRoot/);
    const unknown = await runTool(root, 'delete_everything', {});
    assert.equal(unknown.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generate_character_image：仅保存草稿，不虚报图片、任务或奖励', async () => {
  const root = tempWorkspace();
  try {
    const res = await runTool(root, 'generate_character_image', {
      character: 'natsume',
      description: '在海边喝汽水',
      outfit: 'swimsuit',
    });
    assert.equal(res.ok, true);
    assert.equal(res.character, 'natsume');
    assert.equal(res.status, 'draft');
    assert.equal(res.bonusAffection, undefined);
    assert.match(res.output, /四季夏目/);
    assert.equal(res.imageRelativePath, undefined);
    assert.equal(res.fullImagePath, undefined);
    assert.match(res.output, /尚未提交生成任务，也未生成图片/);
    const draft = JSON.parse(fs.readFileSync(path.join(root, res.draftRelativePath), 'utf8'));
    assert.equal(draft.status, 'draft');
    assert.equal(draft.outputPath, undefined);
    assert.deepEqual(fs.readdirSync(path.join(root, 'generated-images')), [path.basename(res.draftRelativePath)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generate_character_image：草稿写入失败明确返回失败', async (t) => {
  const root = tempWorkspace();
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (String(file).startsWith(path.join(root, 'generated-images'))) throw new Error('draft write failed');
    return originalWrite.call(this, file, ...args);
  });
  try {
    const result = await runTool(root, 'generate_character_image', { character: 'natsume', description: '海边' });
    assert.equal(result.ok, false);
    assert.match(result.output, /draft write failed/);
    assert.equal(result.draftRelativePath, undefined);
    assert.deepEqual(fs.readdirSync(path.join(root, 'generated-images')), []);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generate_character_image：R18 双门 fail-closed（白名单 × adultEnabled）', async () => {
  const root = tempWorkspace();
  try {
    // 1) 未授权（缺 context）：mature=true 直接拒绝，且不落任何生成元数据
    const denied = await runTool(root, 'generate_character_image', {
      character: 'natsume', description: 'x', mature: true,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'adult_not_enabled');
    assert.match(denied.error, /未获本机授权/);
    assert.equal(fs.existsSync(path.join(root, 'generated-images')), false, '拒绝时不得写入元数据');

    // 2) falsy 授权同样拒绝（fail-closed 不做 truthy 宽松转换）
    const weakConsent = await runTool(root, 'generate_character_image', {
      character: 'nene', description: 'x', outfit: 'nsfw_nude',
    }, { adultEnabled: 'yes' });
    assert.equal(weakConsent.ok, false);

    // 3) 有授权但角色不在成人白名单：按 adultEligibility 拒绝
    const ineligible = await runTool(root, 'generate_character_image', {
      character: 'raiden_shogun', description: 'x', outfit: 'nsfw_nude',
    }, { adultEnabled: true });
    assert.equal(ineligible.ok, false);
    assert.equal(ineligible.code, 'adult_character_not_eligible');
    assert.match(ineligible.output, /白名单/);

    // 4) 双门齐备 + 大小写归一：放行并注入裸露 token
    const allowed = await runTool(root, 'generate_character_image', {
      character: 'Natsume', description: 'x', outfit: 'nsfw_nude',
    }, { adultEnabled: true });
    assert.equal(allowed.ok, true);
    const metaFiles = fs.readdirSync(path.join(root, 'generated-images')).filter((f) => f.endsWith('.json'));
    assert.equal(metaFiles.length, 1);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'generated-images', metaFiles[0]), 'utf8'));
    assert.equal(meta.mature, true);
    assert.ok(meta.promptTokens.includes('completely naked'), '放行时必须注入裸露 token');

    // 5) 非 R18 请求不受门控影响：任意角色无 context 也照常组装
    const plain = await runTool(root, 'generate_character_image', {
      character: 'raiden_shogun', description: 'y', outfit: 'dress',
    });
    assert.equal(plain.ok, true);

    // 6) 错误信封对齐：runTool 失败结果带 error/msg 镜像
    assert.equal(typeof denied.msg, 'string');
    assert.equal(denied.msg, denied.error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture_screen：Windows 原生截屏', async () => {
  const root = tempWorkspace();
  try {
    const res = await runTool(root, 'capture_screen', {});
    if (process.platform === 'win32') {
      assert.equal(res.ok, true);
      assert.match(res.imageDataUrl, /^data:image\/jpeg;base64,/);
      assert.match(res.output, /捕获当前桌面屏幕画面/);
    } else {
      assert.equal(res.ok, false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP 装配：/api/desktop-tools 本机可用、代理头拒绝、缺工具名 400', async () => {
  const root = tempWorkspace();
  const previous = process.env.AI_WORKSPACE_ROOT;
  process.env.AI_WORKSPACE_ROOT = root;
  const app = express();
  app.use(createDesktopToolsRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    fs.writeFileSync(path.join(root, 'hello.txt'), 'hi');

    const ok = await fetch(`${base}/api/desktop-tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read_file', args: { path: 'hello.txt' } }),
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.output, 'hi');

    // 带代理头的请求等同非本机来源：localOnly 必须 403
    const forwarded = await fetch(`${base}/api/desktop-tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ name: 'get_workspace_info', args: {} }),
    });
    assert.equal(forwarded.status, 403);

    const noName = await fetch(`${base}/api/desktop-tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });
    assert.equal(noName.status, 400);
    const noNameBody = await noName.json();
    assert.equal(noNameBody.ok, false);
    assert.equal(noNameBody.error, '缺少工具名');
    assert.equal(noNameBody.output, '缺少工具名', 'output 镜像保留，供对话模型 tool 消息消费');

    // R18 传输层授权：顶层 adultEnabled !== true 时 mature 参数必须被拒
    const adultDenied = await fetch(`${base}/api/desktop-tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'generate_character_image', args: { character: 'nene', description: 'x', mature: true } }),
    });
    assert.equal(adultDenied.status, 200);
    const adultDeniedBody = await adultDenied.json();
    assert.equal(adultDeniedBody.ok, false);
    assert.equal(adultDeniedBody.code, 'adult_not_enabled');

    // 模型在 args 里自行声明授权无效：args.adultEnabled 不参与判定
    const selfDeclared = await fetch(`${base}/api/desktop-tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'generate_character_image', args: { character: 'nene', description: 'x', mature: true, adultEnabled: true } }),
    });
    const selfDeclaredBody = await selfDeclared.json();
    assert.equal(selfDeclaredBody.ok, false);
    assert.equal(selfDeclaredBody.code, 'adult_not_enabled');

    // 顶层显式授权 + 白名单角色：放行
    const adultAllowed = await fetch(`${base}/api/desktop-tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'generate_character_image', args: { character: 'nene', description: '海边散步' }, adultEnabled: true }),
    });
    const adultAllowedBody = await adultAllowed.json();
    assert.equal(adultAllowedBody.ok, true);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.AI_WORKSPACE_ROOT;
    else process.env.AI_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
