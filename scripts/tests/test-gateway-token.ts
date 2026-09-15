'use strict';

/**
 * 网关 Token 持久化测试 — 已迁移到 node:test。
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const loadGatewayConfig = (require('../../server/config') as typeof import('../../server/config')).loadGatewayConfig;

test('Token 生成、持久化、覆盖与修复', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-gateway-token-'));
  try {
    const initial = loadGatewayConfig(root, { DISABLE_TUNNEL: '1' });
    const restarted = loadGatewayConfig(root, { DISABLE_TUNNEL: '1' });
    assert.match(initial.TOKEN, /^[a-f0-9]{64}$/i, 'generated token must be 32 random bytes encoded as hex');
    assert.equal(initial.TOKEN_SOURCE, 'runtime/state');
    assert.equal(restarted.TOKEN, initial.TOKEN, 'gateway token must survive a restart');
    assert.equal(
      fs.readFileSync(initial.RUNTIME.gatewayToken, 'utf8').trim(), initial.TOKEN,
      'generated gateway token must be persisted in runtime/state',
    );

    const override = loadGatewayConfig(root, { TOKEN: 'operator-defined-token', DISABLE_TUNNEL: '1' });
    assert.equal(override.TOKEN, 'operator-defined-token', 'TOKEN environment variable must override persisted token');
    assert.equal(override.TOKEN_SOURCE, 'environment');
    assert.equal(
      loadGatewayConfig(root, { DISABLE_TUNNEL: '1' }).TOKEN, initial.TOKEN,
      'an environment override must not replace the persisted share token',
    );

    fs.writeFileSync(initial.RUNTIME.gatewayToken, 'invalid token\n', 'utf8');
    const repaired = loadGatewayConfig(root, { DISABLE_TUNNEL: '1' });
    assert.match(repaired.TOKEN, /^[a-f0-9]{64}$/i, 'invalid persisted token must be replaced safely');
    assert.notEqual(repaired.TOKEN, initial.TOKEN, 'invalid token must not be reused');
    assert.equal(fs.readFileSync(initial.RUNTIME.gatewayToken, 'utf8').trim(), repaired.TOKEN);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
