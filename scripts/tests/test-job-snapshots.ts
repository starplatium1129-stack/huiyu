'use strict';

const assert: typeof import('assert') = require('assert');
const test: typeof import('node:test') = require('node:test');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { createJobSnapshotStore, toSnapshot, safeId }: typeof import('../../server/job-snapshot') = require('../../server/job-snapshot');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aics-job-snap-'));
}

function sampleJob(overrides: any = {}) {
  return Object.assign({
    id: 'v-1730000000-ab12',
    owner: 'local',
    createdAt: 1730000000000,
    estimatedSeconds: 180,
    input: { modelId: 'h3-native', width: 832, height: 480, duration: 5 },
  }, overrides);
}

test('save 写入快照且不落提示词/Token', () => {
  const dir = tempDir();
  try {
    const store = createJobSnapshotStore(dir);
    store.save(sampleJob({ prompt: '应当被剔除的原文' }));
    const files = fs.readdirSync(dir);
    assert.strictEqual(files.length, 1);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.strictEqual(parsed.id, 'v-1730000000-ab12');
    assert.strictEqual(parsed.status, 'running');
    assert.deepStrictEqual(Object.keys(parsed.input), ['modelId', 'width', 'height', 'duration']);
    assert.ok(!JSON.stringify(parsed).includes('prompt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('drain 读走遗留快照并清空目录（读后即删）', () => {
  const dir = tempDir();
  try {
    const store = createJobSnapshotStore(dir);
    store.save(sampleJob());
    store.save(sampleJob({ id: 'v-second' }));
    const restored = store.drain();
    assert.strictEqual(restored.length, 2);
    assert.ok(restored.some((s) => s.id === 'v-second'));
    assert.strictEqual(fs.readdirSync(dir).length, 0);
    // 二次 drain 无残留
    assert.strictEqual(store.drain().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove 精确删除对应快照；优雅关停路径全清后 drain 为空', () => {
  const dir = tempDir();
  try {
    const store = createJobSnapshotStore(dir);
    store.save(sampleJob());
    store.save(sampleJob({ id: 'v-other' }));
    store.remove('v-other');
    assert.deepStrictEqual(store.drain().map((s) => s.id), ['v-1730000000-ab12']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏快照被跳过并清除，不污染重启恢复', () => {
  const dir = tempDir();
  try {
    const store = createJobSnapshotStore(dir);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not-json', 'utf8');
    store.save(sampleJob());
    const restored = store.drain();
    assert.strictEqual(restored.length, 1);
    assert.strictEqual(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('无 id/owner 的畸形快照不入 tombstone 名单', () => {
  const dir = tempDir();
  try {
    const store = createJobSnapshotStore(dir);
    fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ foo: 1 }), 'utf8');
    assert.strictEqual(store.drain().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeId 消毒路径拼接字符', () => {
  assert.strictEqual(safeId('../../etc/passwd'), '....etcpasswd');
  assert.strictEqual(safeId('v-1_2.3-x'), 'v-1_2.3-x');
  assert.ok(!/[/\\]/.test(safeId('..\\..\\win')));
  assert.strictEqual(safeId(null), '');
});

test('toSnapshot 输出公开字段白名单', () => {
  const snap = toSnapshot(sampleJob());
  assert.deepStrictEqual(Object.keys(snap), ['id', 'owner', 'status', 'createdAt', 'estimatedSeconds', 'input']);
  assert.strictEqual(snap.owner, 'local');
});

test('未配置目录时退化为无操作存根', () => {
  const store = createJobSnapshotStore(undefined);
  store.save(sampleJob());
  store.remove('any');
  assert.deepStrictEqual(store.drain(), []);
});
