'use strict';

/** 定稿场景提示词基线门禁：受保护场景（定点手工修/官方CG/实拍定稿）的渲染字段
 *  必须与 data/prompt-pinned-scenes.json 逐字节一致。字段有意的更新流程：
 *  真实出图自测 -> node scripts/maintenance/pin-scene-prompts.js --capture。 */
const assert: typeof import('assert') = require('assert');
const { execFileSync }: typeof import('child_process') = require('child_process');
const path: typeof import('path') = require('path');
const test: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const vm: typeof import('node:vm') = require('node:vm');

const tool = path.resolve(__dirname, '..', 'maintenance', 'pin-scene-prompts.js');

test('pinned scenes: all protected prompts byte-match the baseline', () => {
  execFileSync(process.execPath, [tool, '--check'], { stdio: 'pipe' });
});

test('pinned scenes: baseline exists and is non-trivial', () => {
  const baseline = require(path.resolve(__dirname, '..', '..', 'data', 'prompt-pinned-scenes.json'));
  const ids = Object.keys(baseline.scenes || {});
  assert.ok(ids.length >= 95, `expected >=95 pinned scenes, got ${ids.length}`);
  for (const id of ['sc033', 'sc234']) {
    assert.ok(baseline.scenes[id], `${id} must stay pinned`);
    assert.deepStrictEqual(baseline.scenes[id].pinSource, ['png-reference']);
  }
});

function withShallowFixture(run: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-pinned-shallow-'));
  const shard = path.join(root, 'data/scenes/fixture.json');
  const baseline = path.join(root, 'data/prompt-pinned-scenes.json');
  const fields = { prompt: 'reviewed prompt', negative: 'reviewed negative', animaCaption: 'reviewed caption', recommendedSize: '832x1216', rating: 'sfw', mature: false };
  fs.mkdirSync(path.dirname(shard), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/scenes/manifest.json'), JSON.stringify({ files: [{ file: 'fixture.json' }] }));
  fs.writeFileSync(shard, JSON.stringify([{ id: 'sc033', ...fields, story: 'keep story' }]));
  fs.writeFileSync(baseline, JSON.stringify({ scenes: { sc033: { ...fields, pinSource: ['png-reference'] } } }));
  function invoke(args: any) {
    const output: any = [];
    const state = { argv: ['node', tool, ...args], exitCode: 0 };
    vm.runInNewContext(fs.readFileSync(tool, 'utf8'), {
      __dirname: path.join(root, 'scripts/maintenance'), __filename: tool, process: state,
      exports: {}, module: { exports: {} },
      require(name: any) {
        if (name === 'child_process') return { execFileSync() { throw new Error('missing historical commit'); } };
        if (name === '../lib/scene-store') return { expandShardFiles: (entry: any) => [entry.file] };
        return require(name);
      },
      console: { log: (...args: any[]) => output.push(args.join(' ')), warn: (...args: any[]) => output.push(args.join(' ')), error: (...args: any[]) => output.push(args.join(' ')) },
    }, { filename: tool });
    return { code: state.exitCode, output: output.join('\n') };
  }
  try { run({ invoke, shard, baseline, fields }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('pinned report explains shallow-history fallback without modifying data', () => withShallowFixture(({ invoke, shard, baseline }: any) => {
  const before = [fs.readFileSync(shard, 'utf8'), fs.readFileSync(baseline, 'utf8')];
  const report = invoke(['--report']);
  assert.equal(report.code, 0);
  assert.match(report.output, /降级.*baseline/);
  assert.deepEqual([fs.readFileSync(shard, 'utf8'), fs.readFileSync(baseline, 'utf8')], before);
  assert.equal(invoke(['--report', '--source=history']).code, 1);
}));

test('pinned shallow apply requires an explicit baseline target and preserves metadata', () => withShallowFixture(({ invoke, shard, baseline, fields }: any) => {
  fs.writeFileSync(shard, JSON.stringify([{ id: 'sc033', ...fields, prompt: 'drift', mature: true, story: 'keep story' }]));
  const before = fs.readFileSync(shard, 'utf8');
  const baselineBefore = fs.readFileSync(baseline, 'utf8');
  assert.equal(invoke(['--apply']).code, 1);
  assert.equal(fs.readFileSync(shard, 'utf8'), before);
  assert.equal(invoke(['--apply', '--source=baseline']).code, 0);
  const entry = JSON.parse(fs.readFileSync(shard, 'utf8'))[0];
  assert.equal(entry.prompt, fields.prompt);
  assert.equal(entry.mature, false);
  assert.equal(entry.story, 'keep story');
  assert.equal(fs.readFileSync(baseline, 'utf8'), baselineBefore);
  assert.equal(invoke(['--check']).code, 0);
}));

test('pinned capture in shallow checkout preserves membership and provenance', () => withShallowFixture(({ invoke, shard, baseline, fields }: any) => {
  fs.writeFileSync(shard, JSON.stringify([{ id: 'sc033', ...fields, prompt: 'new reviewed fixture' }]));
  assert.equal(invoke(['--capture']).code, 0);
  const saved = JSON.parse(fs.readFileSync(baseline, 'utf8')).scenes;
  assert.deepEqual(Object.keys(saved), ['sc033']);
  assert.deepEqual(saved.sc033.pinSource, ['png-reference']);
  assert.equal(saved.sc033.prompt, 'new reviewed fixture');
}));

test('pinned mutations fail before writing when a protected entry is missing or duplicated', () => withShallowFixture(({ invoke, shard, baseline, fields }: any) => {
  const originalBaseline = fs.readFileSync(baseline, 'utf8');
  fs.writeFileSync(shard, '[]');
  assert.equal(invoke(['--capture']).code, 1);
  assert.equal(invoke(['--apply', '--source=baseline']).code, 1);
  assert.equal(fs.readFileSync(baseline, 'utf8'), originalBaseline);
  fs.writeFileSync(shard, JSON.stringify([{ id: 'sc033', ...fields }, { id: 'sc033', ...fields }]));
  assert.equal(invoke(['--check']).code, 1);
}));

test('pinned empty baseline is rejected instead of passing an empty check', () => withShallowFixture(({ invoke, baseline }: any) => {
  fs.writeFileSync(baseline, '{"scenes":{}}');
  assert.equal(invoke(['--check']).code, 1);
  assert.equal(invoke(['--capture']).code, 1);
  assert.equal(fs.readFileSync(baseline, 'utf8'), '{"scenes":{}}');
}));
