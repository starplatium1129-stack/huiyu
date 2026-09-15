'use strict';

import { PathLike } from 'node:fs';

const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { fork }: typeof import('node:child_process') = require('node:child_process');
const { once }: typeof import('node:events') = require('node:events');
const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');

const names = ['data/scenes/group.json', 'data/scenes/new.1.json', 'data/blueprints/old.json',
  'data/blueprints/manifest.json', 'data/scenes.json', 'data/scenes.json.gz', 'data/scenes.json.br', 'src/stores/sceneStore.ts'];
function createFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-recovery-'));
  const rootDir = path.join(base, 'project');
  fs.mkdirSync(rootDir);
  for (const [index, name] of names.entries()) {
    const file = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (name !== 'data/scenes/new.1.json') fs.writeFileSync(file, Buffer.from('neutral-original-' + index + '\n'));
  }
  fs.writeFileSync(path.join(rootDir, 'data', 'unrelated.json'), 'unrelated bytes\r\n');
  const options = { rootDir, runtimeRoot: path.join(rootDir, 'runtime') };
  return { base, options, files: names.map(name => path.join(rootDir, name)), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function tree(directory: PathLike, excludeRuntime = false, output: any = {}, prefix = '') {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excludeRuntime && entry.name === 'runtime') continue;
    const name = prefix + entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) output[name] = 'link';
    else if (entry.isDirectory()) { output[name + '/'] = 'directory'; tree(file, false, output, name + '/'); }
    else output[name] = io.digest(fs.readFileSync(file));
  }
  return output;
}
async function spawnWorker(fixture: any, mode = 'hold') {
  const child = fork(path.join(__dirname, 'maintenance-recovery-worker.js'), [mode, JSON.stringify(fixture.options)], { silent: true, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'exit');
  const message = await Promise.race([
    once(child, 'message').then(([value]) => value),
    closed.then(([code]) => { throw new Error('fixture exited before ready: ' + code + ' ' + stderr); }),
  ]);
  return { child, message, closed, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; } };
}
export = { createFixture, names, tree, spawnWorker };
