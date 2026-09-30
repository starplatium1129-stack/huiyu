'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

// Windows rmSync leaves dangling junctions when it removes their targets first.
// Fixtures remove their own links before recursive cleanup. This is deliberately
// limited to a named direct child of TEMP; it is not a user-directory cleanup API.
function cleanupResourceFixture(base: string, prefix: string) {
  const info = fs.lstatSync(base);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'fixture root must remain its own directory');
  const root = fs.realpathSync.native(base);
  const relative = path.relative(fs.realpathSync.native(os.tmpdir()), root);
  assert.ok(path.isAbsolute(root) && relative === path.basename(base) && relative.startsWith(prefix),
    'refusing cleanup outside this temporary fixture root');
  const unlinkFixtureLinks = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fs.unlinkSync(file);
      else if (entry.isDirectory()) unlinkFixtureLinks(file);
    }
  };
  unlinkFixtureLinks(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
export = { cleanupResourceFixture };
