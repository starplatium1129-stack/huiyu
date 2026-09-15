'use strict';

/**
 * 维护写盘路径测试 — 已迁移到 node:test。
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const helpers = (require('../../routes/maintenance') as typeof import('../../routes/maintenance'))._test;

function expectThrow(action: { (): void; (): void; (): any; }, message: string|Error|undefined) {
  assert.throws(action, message);
}

test('写盘回滚：原子写 + 快照恢复 + 备份清单', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-maintenance-'));
  try {
    const original = path.join(temp, 'content.json');
    const created = path.join(temp, 'created.json');
    fs.writeFileSync(original, '{"version":1}\n');
    const snapshot = helpers.snapshotFiles([original, created]);
    helpers.writeFileAtomic(original, '{"version":2}\n');
    helpers.writeFileAtomic(created, '{}\n');
    const backup = helpers.saveSnapshotBackup(snapshot, path.join(temp, 'backups'), 'test');
    helpers.restoreSnapshot(snapshot);
    assert.equal(fs.readFileSync(original, 'utf8'), '{"version":1}\n', 'rollback must restore the previous file bytes');
    assert.equal(fs.existsSync(created), false, 'rollback must remove files created after the snapshot');
    assert.equal(fs.existsSync(path.join(backup, 'manifest.json')), true, 'every transaction must create a recoverable backup manifest');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('标签校验：重复英文名必须拒绝', () => {
  helpers.validateTags([{ id: 'tag_001', cat: 'Scene', en: 'library', cn: '图书馆', weight: 0.8, related: [] }]);
  expectThrow(() => {
    helpers.validateTags([
      { id: 'tag_001', en: 'library' },
      { id: 'tag_002', en: 'LIBRARY' },
    ]);
  }, 'duplicate prompt tag names must be rejected');
});

test('策展清洗：招牌自动入精选、互斥与失效引用清理', () => {
  const curation = helpers.sanitizeCuration({
    curatedSceneIds: ['sc001', 'missing'],
    signatureSceneIds: ['sc002'],
    reviewSceneIds: ['sc001', 'sc003'],
    recommendationReasons: { sc002: '招牌理由', missing: 'stale' },
  }, new Set(['sc001', 'sc002', 'sc003']));
  assert.equal(curation.curatedSceneIds.includes('sc002'), true, 'signature scenes must automatically belong to curated scenes');
  assert.equal(curation.reviewSceneIds.includes('sc001'), false, 'a scene cannot be both curated and pending review');
  assert.equal(curation.recommendationReasons.missing, undefined, 'references to deleted scenes must be cleaned');
});

test('策展清洗：personaCoreSceneIds 稳定去重、剔除非活跃引用，其他策展字段不受影响', () => {
  const activeIds = new Set(['sc001', 'sc002', 'sc003']);
  const input = {
    curatedSceneIds: ['sc001'],
    signatureSceneIds: ['sc002'],
    reviewSceneIds: ['sc003'],
    recommendationReasons: { sc002: '招牌理由' },
    personaCoreSceneIds: ['sc003', 'sc148', 'sc001', 'sc003', 42, ''],
    personaCoreReasons: { sc003: '开场画面' },
    searchAliases: { cozy: ['壁炉'] },
    moodRails: [{ id: 'rail_01', title: '温柔夜', query: '夜' }],
  };
  const before = JSON.stringify(input);
  const curation = helpers.sanitizeCuration(input, activeIds);
  assert.equal(JSON.stringify(input), before, '输入对象不得被原地修改');
  assert.deepEqual(curation.personaCoreSceneIds, ['sc003', 'sc001'],
    '必须保持首次出现顺序去重，并剔除非活跃引用与非字符串项');
  assert.deepEqual(curation.personaCoreReasons, { sc003: '开场画面' }, 'personaCoreReasons 语义不得被改动');
  assert.deepEqual(curation.searchAliases, { cozy: ['壁炉'] }, 'searchAliases 必须原样透传');
  assert.deepEqual(curation.moodRails, [{ id: 'rail_01', title: '温柔夜', query: '夜' }], 'moodRails 必须原样透传');
});

test('策展清洗：personaCoreSceneIds 显式非数组必须报错并指出字段', () => {
  const activeIds = new Set(['sc001']);
  for (const bad of ['sc001', 42, null, { id: 'sc001' }]) {
    assert.throws(() => helpers.sanitizeCuration({ personaCoreSceneIds: bad }, activeIds),
      /personaCoreSceneIds/, '显式非数组输入必须报出 personaCoreSceneIds 字段名：' + JSON.stringify(bad));
  }
});

test('策展清洗：personaCoreSceneIds 缺省保持缺省，空数组保留为空', () => {
  const absent = helpers.sanitizeCuration({ curatedSceneIds: ['sc001'] }, new Set(['sc001']));
  assert.equal('personaCoreSceneIds' in absent, false, '缺省不得被解释为清空并注入空数组');
  const emptied = helpers.sanitizeCuration({ personaCoreSceneIds: [] }, new Set(['sc001']));
  assert.deepEqual(emptied.personaCoreSceneIds, [], '显式空数组是明确的清空意图，必须保留');
});

test('策展清洗：仅继承旧核心精选，显式清空优先且不修改旧对象', () => {
  const previous = { personaCoreSceneIds: ['sc002', 'retired', 'sc001'], personaCoreReasons: { sc002: '旧理由' } };
  const before = JSON.stringify(previous);
  const active = new Set(['sc001', 'sc002']);
  const inherited = helpers.sanitizeCuration({}, active, previous);
  assert.deepEqual(inherited.personaCoreSceneIds, ['sc002', 'sc001']);
  assert.equal(inherited.personaCoreReasons, undefined, '不得顺带合并其他字段');
  assert.deepEqual(helpers.sanitizeCuration({ personaCoreSceneIds: [] }, active, previous).personaCoreSceneIds, []);
  assert.equal(JSON.stringify(previous), before);
});

test('JPEG 上传：规范魔数接受、非规范格式拒绝', () => {
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  assert.equal(helpers.decodeJpegDataUrl(jpeg, 'test').length, 4, 'canonical JPEG uploads must be accepted');
  expectThrow(() => { helpers.decodeJpegDataUrl('data:image/png;base64,AAAA', 'test'); }, 'non-canonical image formats must be rejected by the server');
});
