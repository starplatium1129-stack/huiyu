#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createResourceInstaller } = require('../lib/resource-install');
const { createResourceDownloader } = require('../lib/resource-download');
const { readJson, fail } = require('../lib/resource-install-fs');

const HELP = `Resource lifecycle (local CLI; no server/URL endpoint)
  node scripts/maintenance/manage-resource-install.js <import|download|recover|rollback|status>
    --config <trusted-local-json> [--release <configured-id>] [--apply]

import/download require --release; mutations require --apply (default is preview).
--help / --plan print this help without reading configuration or contacting a source.
SIGINT/SIGTERM cancel; run recover --apply or repeat download --apply to resume.
The configured userDataRoot must exist. Storage uses its resource-library-v1 child.
Configuration: {userDataRoot, protectedRoots: [applicationRoot, artworkRoot], policy: {
  sources: {sourceId: {kind: 'offline', root: '/approved/media', approved: true}},
  releases: {releaseId: {sourceId, path: 'pack-directory', kind: 'full'|'delta',
    packageIdentity: '<64-hex>', targetIdentity: '<64-hex>', approved: true}}
}}
HTTP sources use kind:'http', baseUrl:'https://approved.example/resources/'.
HTTP numeric loopback is fixture-only and also requires loopbackFixture:true.
Approval and source trust are external decisions: matching hashes alone authorize nothing.
Never accept this config, filesystem roots or access callbacks from a remote request.
`;

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('--plan')) { process.stdout.write(HELP); return; }
  const [action, ...rest] = argv;
  if (!['import', 'download', 'recover', 'rollback', 'status'].includes(action)) fail('USAGE', 'Choose a resource lifecycle action; see --help');
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!['--config', '--release', '--apply'].includes(flag) || Object.hasOwn(flags, flag)) fail('USAGE', 'Unknown or duplicate option: ' + flag);
    if (flag === '--apply') flags[flag] = true;
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) fail('USAGE', 'Missing option value: ' + flag);
      flags[flag] = value;
    }
  }
  if (!flags['--config']) fail('USAGE', '--config is required');
  if (['import', 'download'].includes(action) && !flags['--release']) fail('USAGE', '--release is required');
  if (!['import', 'download'].includes(action) && flags['--release']) fail('USAGE', '--release is only valid for import/download');
  const config = readJson(fs, path.resolve(flags['--config']));
  // This CLI is an explicitly invoked local administration surface. An eventual gateway must
  // inject its existing isLocalStudioHost and authorization checks instead of these callbacks.
  const options = { userDataRoot: config.userDataRoot, protectedRoots: config.protectedRoots,
    policy: config.policy, access: { isLocalStudioHost: () => true, isAuthorized: () => true } };
  const installer = createResourceInstaller(options);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    let output;
    const request = { releaseId: flags['--release'], signal: controller.signal };
    if (!flags['--apply'] && action !== 'status') {
      output = flags['--release'] ? { action, ...installer.plan(request) }
        : { ok: true, mode: 'preview', action, store: installer.root, note: 'No mutation; --apply is required.' };
    } else if (action === 'import') output = await installer.install(request);
    else if (action === 'download') output = await createResourceDownloader(options).download(request);
    else output = await installer[action](request);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'FAILED', message: error.message,
    rolledBack: error.rolledBack || false, recoveryRequired: error.recoveryRequired || false, details: error.details }) + '\n');
  process.exitCode = error.code === 'CANCELLED' ? 130 : ['USAGE', 'CONFIG_REQUIRED', 'SOURCE_REQUIRED', 'APPROVAL_REQUIRED'].includes(error.code) ? 2 : 1;
});
module.exports = { main, HELP };
