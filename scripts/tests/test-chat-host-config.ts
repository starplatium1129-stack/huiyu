'use strict';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { readHostConfig }: typeof import('../../routes/video-ai-config') = require('../../routes/video-ai-config');

test('host configuration cache isolates equally sized files with identical timestamps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-config-audit-'));
  try {
    const configs = ['first', 'other'].map(name => {
      const state = path.join(root, name); fs.mkdirSync(state);
      const file = path.join(state, 'chat_api_config.json');
      fs.writeFileSync(file, JSON.stringify({ baseUrl: 'https://example.invalid/v1', model: name, apiKey: 'fixture' }));
      fs.utimesSync(file, new Date(0), new Date(0));
      return { RUNTIME: { state } };
    });
    assert.equal(readHostConfig(configs[0]).model, 'first');
    assert.equal(readHostConfig(configs[1]).model, 'other');
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aics-config-audit-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed atomic replacement preserves the previous configuration and cleans temporary files', () => {
  const { createHostConfigStore }: typeof import('../../server/chat-host-config') = require('../../server/chat-host-config');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-config-audit-'));
  const config = { RUNTIME: { state: root } };
  const original = { baseUrl: 'https://example.invalid/v1', model: 'old', apiKey: 'fixture' };
  const store = createHostConfigStore();
  try {
    store.writeHostConfig(config, original);
    const fault = createHostConfigStore({ ...fs, renameSync() { throw new Error('replacement denied'); } });
    assert.throws(() => fault.writeHostConfig(config, { ...original, model: 'new' }), /replacement denied/);
    assert.equal(store.readHostConfig(config).model, 'old');
    assert.deepEqual(fs.readdirSync(root), ['chat_api_config.json']);
    store.writeHostConfig(config, { ...original, model: 'new' });
    assert.equal(store.readHostConfig(config).model, 'new');
    store.deleteHostConfig(config);
    assert.equal(store.readHostConfig(config), null);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aics-config-audit-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('permission failure while deleting a configuration is not reported as success', () => {
  const { createHostConfigStore }: typeof import('../../server/chat-host-config') = require('../../server/chat-host-config');
  const store = createHostConfigStore({ unlinkSync() { const error = new Error('denied'); error.code = 'EACCES'; throw error; } });
  assert.throws(() => store.deleteHostConfig({ RUNTIME: { state: os.tmpdir() } }), /denied/);
});
