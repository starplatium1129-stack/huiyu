// Independent wire fixture for old task records. Only Node filesystem/JSON/crypto
// primitives are used; no current Rust codec or retired backend is imported.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fixture = require('../fixtures/legacy-provider-identities.json');
function fingerprint({ comfy, identity, webui }) {
  // These ASCII field names have a fixed order in the historical provider shape.
  const { created, inode, root } = identity;
  return createHash('sha256').update(JSON.stringify({ comfy, identity: { created, inode, root }, webui })).digest('hex');
}
for (const { value, sha256 } of fixture.cases) assert.equal(fingerprint(value), sha256);
const root = path.join(process.argv[2], 'ComfyUI');
const stat = fs.statSync(root);
process.stdout.write(fingerprint({ comfy: process.argv[3], webui: process.argv[3],
  identity: { root: fs.realpathSync(root), created: stat.birthtimeMs, inode: stat.ino } }));
