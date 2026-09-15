#!/usr/bin/env node
import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

const path: typeof import('node:path') = require('node:path');
const { readJson }: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
const { previewMaintenanceRecovery, applyMaintenanceRecovery }: typeof import('../lib/maintenance-recovery') = require('../lib/maintenance-recovery');

function main(argv: any = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('--plan')) {
    process.stdout.write('Usage: node scripts/maintenance/recover-maintenance.js --root <root> [--runtime-root <runtime>] [--showcase-root <trusted-root>] [--backup <id>]\n'
      + 'Default: read-only JSON recovery plan on stdout; no files or directories are created.\n'
      + 'Apply only with the same roots plus --apply --recovery-plan <saved-preview.json>.\n'
      + '--help / --plan: description only; no target, backup, journal or recovery-plan is read, and no operation is executed.\n'
      + 'Exit: 0 success/executable preview, 1 blocked/conflict/failure, 2 invalid arguments.\n');
    return 0;
  }
  const values: Record<string, any> = {};
  try {
    for (let index = 0; index < argv.length; index++) {
      const key = argv[index];
      if (!['--root', '--runtime-root', '--showcase-root', '--backup', '--recovery-plan', '--apply'].includes(key) || Object.hasOwn(values, key)) throw new Error('Unknown or duplicate argument: ' + key);
      if (key === '--apply') values[key] = true;
      else {
        if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Missing value: ' + key);
        values[key] = argv[++index];
      }
    }
    if (!values['--root'] || Boolean(values['--apply']) !== Boolean(values['--recovery-plan'])) throw new Error('--root is required; --apply and --recovery-plan must be supplied together');
  } catch (error) { process.stderr.write(runtimeErrorMessage(error) + '\n'); return 2; }
  try {
    const options = { rootDir: path.resolve(values['--root']), runtimeRoot: values['--runtime-root'] && path.resolve(values['--runtime-root']),
      showcaseRoot: values['--showcase-root'] && path.resolve(values['--showcase-root']), backupId: values['--backup'] };
    const result = values['--apply'] ? applyMaintenanceRecovery(options, readJson(path.resolve(values['--recovery-plan']))) : previewMaintenanceRecovery(options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return (values['--apply'] ? result.ok : result.executable) ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: runtimeErrorCode(error), error: runtimeErrorMessage(error), recoveryRequired: true }) + '\n');
    return 1;
  }
}
if (require.main === module) process.exitCode = main();
export = { main };
