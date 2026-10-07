#!/usr/bin/env node
'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { execFile }: typeof import('node:child_process') = require('node:child_process');
const { promisify }: typeof import('node:util') = require('node:util');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { planRelease, applyRelease }: typeof import('../lib/offline-release') = require('../lib/offline-release');
const { noLinks, readBytes, writeAtomic, mkdir }: typeof import('../lib/resource-install-fs') = require('../lib/resource-install-fs');

const HELP = `offline:pack --showcase-root <published-directory> --release <safe-id> --out <new-output-parent> [--root <project>] [--base-release <previous release.json>] [--apply]
Default: read-only plan and source hashing. --help/--plan do not read target files.
--apply: Windows-only verified export, ZIP and companion installer. Never overwrites releases.
Exports only serviceable assets and the current showcase manifest's original/thumbnail files.
--base-release: incremental ZIP; unchanged bytes are reused from that installed release. No previous asset reads.
No model calls, downloads, content rewrites, public upload, private references or local model candidates.
New-machine installer uses Windows PowerShell/.NET and the installed Rust executable, not Node.
The graphical helper pins independently published release.json approvals; unknown editions fail closed.
`;
function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--root', '--showcase-root', '--release', '--out', '--base-release', '--apply'].includes(flag) || Object.hasOwn(flags, flag)) throw new Error('Unknown or duplicate option: ' + flag);
    if (flag === '--apply') flags[flag] = true;
    else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('Missing value: ' + flag); flags[flag] = value; }
  }
  for (const flag of ['--showcase-root', '--release', '--out']) if (!flags[flag]) throw new Error('Required: ' + flag);
  return flags;
}
async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('--plan')) { console.log(HELP); return; }
  const flags = parse(argv);
  const root = path.resolve(String(flags['--root'] || path.resolve(__dirname, '../..')));
  const destination = path.join(path.resolve(String(flags['--out'])), String(flags['--release']));
  const plan = planRelease({ root, showcaseRoot: path.resolve(String(flags['--showcase-root'])), releaseId: String(flags['--release']), destination,
    ...(flags['--base-release'] ? { baseRelease: path.resolve(String(flags['--base-release'])) } : {}) });
  if (!flags['--apply']) { console.log(JSON.stringify({ ...plan.summary, applied: false, archive: destination + '.zip' }, null, 2)); return; }
  if (process.platform !== 'win32') throw new Error('Offline ZIP publication is currently Windows only');
  const output = path.dirname(destination);
  if (noLinks(fs, output, { missing: true })) throw new Error('Output parent must be new: ' + output);
  mkdir(fs, path.dirname(output));
  const staging = fs.mkdtempSync(output + '.staging-');
  const candidate = path.join(staging, String(flags['--release']));
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await applyRelease({ ...plan, options: { ...plan.options, destination: candidate } }, abort.signal);
    const archive = candidate + '.zip';
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'archive-offline-release.ps1'), '-Source', candidate, '-Archive', archive],
    { windowsHide: true, timeout: 900_000, signal: abort.signal });
    const stat = noLinks(fs, archive)!;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(archive, { signal: abort.signal })) hash.update(chunk);
    if (noLinks(fs, archive)!.size !== stat.size) throw new Error('ZIP changed during verification');
    const archiveHash = hash.digest('hex');
    writeAtomic(fs, archive + '.sha256', Buffer.from(archiveHash + '  ' + path.basename(archive) + '\n'));
    writeAtomic(fs, candidate + '.release.sha256', Buffer.from(result.expectedReleaseSha256 + '  release.json\n'));
    const installer = readBytes(fs, path.join(root, 'tools/install-offline-resources.ps1'));
    writeAtomic(fs, path.join(staging, 'Install-OfflineResources.ps1'), installer);
    for (const name of ['offline-resource-assistant.ps1', 'Install-OfflineResources.cmd']) {
      writeAtomic(fs, path.join(staging, name), readBytes(fs, path.join(root, 'tools', name)));
    }
    abort.signal.throwIfAborted();
    if (noLinks(fs, output, { missing: true })) throw new Error('Output appeared during staging');
    // Publish the ZIP, checksums, installer and unpacked edition together. A
    // failed compression leaves only staging and can be retried at the same --out.
    fs.renameSync(staging, output);
    console.log(JSON.stringify({ ...result, destination, archive: destination + '.zip', archiveBytes: stat.size, archiveSha256: archiveHash,
      installer: path.join(output, 'Install-OfflineResources.ps1'),
      assistant: path.join(output, 'Install-OfflineResources.cmd'),
      note: 'Candidate ZIP created and byte-verified. Public source approval, installed version and visual/device acceptance are separate.' }, null, 2));
  } catch (error) {
    throw new Error('Incomplete distribution retained in staging: ' + staging, { cause: error });
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
export = { main, parse, HELP };
