'use strict';

// Only test-owned configuration is passed by the fixture parent; not a test entry or service.
const fs: typeof import('node:fs') = require('node:fs');
const { createResourceInstaller }: typeof import('../lib/resource-install') = require('../lib/resource-install');
const { createResourceDownloader }: typeof import('../lib/resource-download') = require('../lib/resource-download');

async function main() {
  const [configFile, phase, action = 'install', releaseId = 'delta'] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const options = { ...config, access: { isLocalStudioHost: () => true, isAuthorized: () => true },
    onEvent: async (e: { phase: string; bytes: unknown; }) => {
      if (e.phase !== phase) return;
      process.send({ phase: e.phase, bytes: e.bytes });
      const interval = setInterval(() => {}, 1000);
      try { await new Promise(() => {}); } finally { clearInterval(interval); }
    } };
  const resource = action === 'download' ? createResourceDownloader(options) : createResourceInstaller(options);
  await resource[action]({ releaseId });
}
if (require.main === module && process.argv[2]) main().catch(error => {
  if (process.send) process.send({ error: error.code, message: error.message });
  process.exitCode = 1;
});
