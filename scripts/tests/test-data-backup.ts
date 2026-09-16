const assert: typeof import('assert') = require('assert');
const backup: typeof import('../../src/utils/backupCore.ts') = require('../../src/utils/backupCore.ts');

const { test }: typeof import('node:test') = require('node:test');

test("Local data backup tests passed against the production TypeScript core", () => {
const created = backup.createBackup({
  appVersion:'1.5.0',
  history:[{ id:1, timestamp:10, prompt:'old' }],
  projects:[{ id:'p1', updatedAt:20, title:'project' }],
  settings:{ aics_theme:'dark' },
  images:[{ id:'img_1', dataUrl:'data:image/png;base64,YQ==', size:1 }]
});

assert.equal(created.app, backup.BACKUP_APP);
assert.equal(created.schemaVersion, backup.BACKUP_SCHEMA_VERSION);
assert.deepEqual(backup.summarizeBackup(created), { history:1, projects:1, settings:1, images:1 });

const drawEngineBackup = backup.createBackup({
  appVersion:'1.5.0',
  settings:{ aics_draw_engine:'anima' },
});
assert.strictEqual(drawEngineBackup.data.settings.aics_draw_engine, 'anima');
assert.strictEqual(
  backup.normalizeBackup(drawEngineBackup).data.settings.aics_draw_engine,
  'anima',
  'draw engine setting must survive backup round-trip',
);

const migrated = backup.normalizeBackup({
  history:[{ id:2, prompt:'legacy' }],
  projects:[],
  settings:{ aics_theme:'light' },
  images:[]
});
assert.equal(migrated.schemaVersion, backup.BACKUP_SCHEMA_VERSION);
assert.equal(migrated.data.history[0].prompt, 'legacy');

const merged = backup.mergeBackupRecords(
  [{ id:1, timestamp:10, prompt:'local' }, { id:2, timestamp:20 }],
  [{ id:1, timestamp:30, prompt:'imported' }, { id:3, timestamp:40 }]
);
assert.deepEqual(merged.map(item => item.id), [3, 1, 2]);
assert.equal(merged.find(item => item.id === 1)!.prompt, 'imported');

const legacyMerged = backup.mergeBackupRecords(
  [{ timestamp:50, prompt:'legacy local' }],
  [{ timestamp:50, prompt:'legacy imported' }, { prompt:'id-less record' }]
);
assert.equal(legacyMerged.length, 2);
assert.equal(legacyMerged[0].prompt, 'legacy imported');

assert.throws(() => backup.normalizeBackup({ schemaVersion:99 }), /更新版本/);
assert.throws(() => backup.normalizeBackup({ schemaVersion:1, type:'other-backup', data:{} }), /不是绘遇备份/);
assert.throws(() => backup.normalizeBackup({ schemaVersion:2, app:'other-app', data:{ settings:{ key:'value' } } }), /不是绘遇备份/);
assert.throws(() => backup.normalizeBackup({ foo:'bar' }), /不包含可恢复/);
assert.throws(() => backup.normalizeBackup(null), /有效对象/);
assert.throws(() => backup.normalizeBackup({
  schemaVersion:2,
  data:{ history:[], projects:[], settings:{} },
  images:[{ id:'bad', dataUrl:'data:text/html;base64,YQ==' }],
}), /没有可恢复/);

});

test('Backup storage-key inventory: live keys collected, dead keys cleaned, restore allowlist', () => {
  const keys: typeof import('../../src/utils/storageKeys.ts') = require('../../src/utils/storageKeys.ts');
  const live = [
    'aics_theme', 'aics_interface_sound_v1', 'aics_sd_last_success_v1',
    'aics_pb_last_draft', 'aics_pb_director_mode', 'aics_scene_favorites',
    'aics_recent_scenes', 'aics_hidden_scenes', 'aics_scene_usage_v1',
    'aics_show_mature', 'aics_tunnel_off', 'aics_chat_v1', 'aics_chat_model',
    'aics_chat_api_drafts', 'aics_chat_archive_v1', 'aics_chat_thinking_v1',
    'aics_guest_guide_dismissed', 'aics_companion_live2d_v1', 'aics_draw_engine',
  ];
  live.forEach(key => {
    assert.strictEqual(keys.isLiveLocalKey(key), true, key + ' must be a live backup key');
  });
  assert.strictEqual(keys.isLiveLocalKey('aics_sd_settings_v1'), false);
  assert.strictEqual(keys.isLiveLocalKey('aics_projects'), false);
  assert.strictEqual(keys.isLiveLocalKey('random_unknown_key'), false);

  const dead = ['aics_sd_settings_v1', 'aics_projects', 'aics_pending_scene'];
  dead.forEach(key => assert.strictEqual(keys.isDeadLocalKey(key), true, key + ' must be a dead key'));

  const stored = new Map([
    ['aics_theme', 'dark'],
    ['aics_chat_v1', '{"version":3}'],
    ['aics_chat_archive_v1', '{"version":1}'],
    ['aics_chat_thinking_v1', 'medium'],
    ['aics_companion_live2d_v1', 'true'],
    ['aics_draw_engine', 'anima'],
    ['aics_scene_usage_v1', '{"nene-cafe":3}'],
    ['aics_sd_settings_v1', 'stale'],
    ['aics_projects', 'stale'],
    ['aics_pending_scene', 'stale'],
    ['random_unknown_key', 'must not leak'],
  ]);
  const fakeStorage = {
    length: stored.size,
    key: (index: string|number) => [...stored.keys()][Number(index)] ?? null,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
    removeItem: (key: string) => { stored.delete(key) },
  };

  const collected = keys.collectLiveLocalSettings(fakeStorage);
  assert.deepStrictEqual(Object.keys(collected).sort(), [
    'aics_chat_archive_v1', 'aics_chat_thinking_v1', 'aics_chat_v1', 'aics_companion_live2d_v1', 'aics_draw_engine', 'aics_scene_usage_v1', 'aics_theme',
  ]);
  assert.strictEqual(collected.random_unknown_key, undefined);

  const removed = keys.cleanDeadLocalKeys(fakeStorage);
  assert.strictEqual(removed, 3, 'all three dead keys must be removed');
  assert.strictEqual(stored.has('aics_sd_settings_v1'), false);
  assert.strictEqual(stored.has('aics_projects'), false);
  assert.strictEqual(stored.has('aics_pending_scene'), false);
  assert.strictEqual(stored.has('aics_theme'), true);
  assert.strictEqual(stored.has('random_unknown_key'), true, 'unknown keys must not be touched');

  assert.strictEqual(keys.isRestorableLocalKey('aics_chat_v1'), true);
  assert.strictEqual(keys.isRestorableLocalKey('aics_draw_engine'), true);
  assert.strictEqual(keys.isRestorableLocalKey('aics_sd_settings_v1'), false);
  assert.strictEqual(keys.isRestorableLocalKey('random_unknown_key'), false);
});
