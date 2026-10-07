'use strict';

const test: typeof import('node:test')['test'] = require('node:test').test;
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
const { planRelease, applyRelease }: typeof import('../lib/offline-release') = require('../lib/offline-release');
const { digest }: typeof import('../lib/resource-install-fs') = require('../lib/resource-install-fs');

function fixture(t: import('node:test').TestContext) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const base = fs.mkdtempSync(path.join(temporary, 'huiyu-offline-release-test-中文 空格-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(base)), temporary);
    assert.ok(path.basename(base).startsWith('huiyu-offline-release-test-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'project'), showcaseRoot = path.join(base, 'published'), destination = path.join(base, 'output/release');
  const write = (file: string, value: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  write(path.join(root, 'package.json'), JSON.stringify({ version: '1.7.2' }));
  write(path.join(root, 'assets/characters/popular-test.png'), 'portrait');
  write(path.join(root, 'assets/characters/thumbs/popular-test.webp'), 'portrait-thumb');
  write(path.join(root, 'assets/live2d/fixture/model.moc3'), 'model');
  write(path.join(root, 'assets/live2d/fixture/model.model3.json'), '{}');
  write(path.join(root, 'assets/character-references/private.png'), 'private-reference');
  write(path.join(root, 'assets/live2d-candidates/private.png'), 'private-model');
  write(path.join(root, 'assets/theme-bootstrap.js'), 'executable');
  write(path.join(root, 'assets/theme-bootstrap.ts'), 'source');
  write(path.join(showcaseRoot, 'images/sc1000.jpg'), 'sample');
  write(path.join(showcaseRoot, 'thumbs/sc1000.jpg'), 'sample-thumb');
  write(path.join(showcaseRoot, 'images/sc999.jpg'), 'unreferenced-history');
  write(path.join(showcaseRoot, 'home/nene.jpg'), 'personal-upload');
  write(path.join(showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc1000', title: 'test', rating: 'R18', type: 'scene', provenance: { batch: 'original' } }] }));
  return { base, root, showcaseRoot, destination, releaseId: 'fixture-r1', write };
}
test('planning is zero-write, preserves showcase bytes and excludes private/code/history files', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.showcaseRoot, 'manifest.json'));
  const plan = planRelease(f);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(plan.summary.resourceFiles, 4); assert.equal(plan.summary.showcaseEntries, 1);
  assert.deepEqual(plan.summary.showcaseRatings, { R18: 1 });
  const paths = plan.inputs.map(input => input.path);
  assert.ok(paths.includes('showcase/images/sc1000.jpg'));
  assert.ok(paths.every(name => !/private|sc999|home\/|theme-bootstrap/.test(name)));
  assert.equal(plan.summary.expectedReleaseSha256, digest(plan.releaseBytes));
  assert.deepEqual(fs.readFileSync(path.join(f.showcaseRoot, 'manifest.json')), before);
  assert.deepEqual(plan.releaseBytes, planRelease(f).releaseBytes);
});
test('incremental releases carry only changed bytes, retain complete target metadata and can be chained', async t => {
  const f = fixture(t), baseline = planRelease(f);
  await applyRelease(baseline);
  const oldRelease = path.join(f.destination, 'release.json');
  f.write(path.join(f.root, 'assets/characters/popular-test.png'), 'updated-portrait');
  f.write(path.join(f.showcaseRoot, 'images/artist_rella.jpg'), 'new-artist');
  f.write(path.join(f.showcaseRoot, 'thumbs/artist_rella.jpg'), 'new-artist-thumb');
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [
    { id: 'sc1000', title: 'test', rating: 'R18', type: 'scene', provenance: { batch: 'original' } },
    { id: 'artist_rella', title: 'Rella', char: 'rella', type: 'artist', rating: 'All' },
  ] }));
  // Previous media need not remain on the publishing machine; only release.json is consulted.
  fs.unlinkSync(path.join(f.destination, 'showcase/images/sc1000.jpg'));
  const plan = planRelease({ ...f, releaseId: 'fixture-r2', destination: path.join(f.base, 'output/r2'), baseRelease: oldRelease });
  const names = plan.inputs.map(input => input.path);
  assert.deepEqual(names.filter(name => !name.endsWith('manifest.json') && !name.endsWith('delta.json')).sort(), [
    'pack/assets/characters/popular-test.png', 'showcase/images/artist_rella.jpg', 'showcase/thumbs/artist_rella.jpg',
  ]);
  const metadata = JSON.parse(plan.releaseBytes.toString('utf8'));
  assert.equal(metadata.baseRelease.releaseSha256, digest(baseline.releaseBytes));
  assert.equal(metadata.showcase.entries.length, 5);
  assert.equal(metadata.showcase.payloadEntries.length, 3);
  assert.equal(metadata.resourcePack.entries.length, 4);
  await applyRelease(plan);
  const chained = planRelease({ ...f, releaseId: 'fixture-r3', destination: path.join(f.base, 'output/r3'), baseRelease: path.join(plan.options.destination, 'release.json') });
  assert.deepEqual(chained.inputs.map(input => input.path).sort(), ['pack/delta.json', 'pack/manifest.json', 'showcase/manifest.json']);
  assert.equal(chained.summary.reusedFiles, 8);
});
test('unsafe/missing/duplicate showcase metadata and overlapping output fail before publication', t => {
  const f = fixture(t);
  assert.throws(() => planRelease({ ...f, destination: f.showcaseRoot }), /separate/);
  assert.throws(() => planRelease({ ...f, releaseId: '../unsafe' }), /safe ASCII/);
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc001', rating: 'All', image: '../private.jpg' }] }));
  assert.throws(() => planRelease(f), /Unsafe/);
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc1000', rating: 'unknown' }] }));
  assert.throws(() => planRelease(f), /Invalid/);
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc1000', rating: 'All' }, { id: 'SC1000', rating: 'All' }] }));
  assert.throws(() => planRelease(f), /duplicate/);
  fs.unlinkSync(path.join(f.showcaseRoot, 'thumbs/sc1000.jpg'));
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc1000', rating: 'All' }] }));
  assert.throws(() => planRelease(f)); assert.equal(fs.existsSync(f.destination), false);
});
test('a source containing only excluded or executable assets cannot produce an unimportable pack', t => {
  const f = fixture(t);
  for (const rel of ['characters/popular-test.png', 'characters/thumbs/popular-test.webp', 'live2d/fixture/model.moc3', 'live2d/fixture/model.model3.json']) {
    fs.unlinkSync(path.join(f.root, 'assets', rel));
  }
  assert.throws(() => planRelease(f), /serviceable public resource/);
  assert.equal(fs.existsSync(f.destination), false);
});
test('export rechecks planned bytes and refuses changed sources or existing releases', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), plan = planRelease(f);
  const result = await applyRelease(plan);
  assert.equal(result.applied, true);
  for (const input of plan.inputs) assert.equal(digest(fs.readFileSync(path.join(f.destination, input.path))), input.entry.sha256);
  assert.equal(digest(fs.readFileSync(path.join(f.destination, 'release.json'))), plan.summary.expectedReleaseSha256);
  assert.throws(() => planRelease(f), /already exists/);
  await assert.rejects(applyRelease(plan), /already exists/);
  const next = planRelease({ ...f, destination: path.join(f.base, 'output/release2') });
  f.write(path.join(f.root, 'assets/characters/popular-test.png'), 'modified');
  await assert.rejects(applyRelease(next), /incomplete/);
  assert.equal(fs.existsSync(next.options.destination), false);
});
test('cancelled export leaves no usable release', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(applyRelease(planRelease(f), controller.signal), /incomplete/);
  assert.equal(fs.existsSync(f.destination), false);
});
test('Windows importer preview authenticates external release hash and rejects unlisted ZIP entries without writing', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), plan = planRelease(f); await applyRelease(plan);
  const repo = path.resolve(__dirname, '../..'), archive = path.join(f.base, 'release.zip');
  const install = path.join(f.base, 'installed'), runtime = path.join(f.base, 'userdata/gateway');
  f.write(path.join(install, 'gateway/huiyu-runtime.exe'), 'not-executed-in-preview');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'scripts/maintenance/archive-offline-release.ps1'), '-Source', f.destination, '-Archive', archive], { windowsHide: true });
  const args = ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'tools/install-offline-resources.ps1'), '-Archive', archive,
    '-ExpectedReleaseSha256', plan.summary.expectedReleaseSha256, '-InstallDir', install, '-RuntimeRoot', runtime];
  const run = (argv: string[]) => execFileSync('powershell.exe', argv, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
  const output = JSON.parse(run(args)); assert.equal(output.mode, 'preview'); assert.equal(output.files, plan.summary.files);
  const verified = JSON.parse(run([...args, '-Verify'])); assert.equal(verified.verified, true);
  const untrusted = [...args]; untrusted.splice(untrusted.indexOf('-ExpectedReleaseSha256'), 2);
  assert.throws(() => run([...untrusted, '-TrustedRelease', '-Verify']), /UNTRUSTED_RELEASE/);
  assert.equal(fs.existsSync(runtime), false);
  const wrong = [...args]; wrong[wrong.indexOf('-ExpectedReleaseSha256') + 1] = '0'.repeat(64);
  assert.throws(() => run(wrong), /hash mismatch/);
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const damaged = path.join(f.base, 'damaged.zip'); fs.copyFileSync(archive, damaged);
  run(['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${quote(damaged)},'Update'); try { $entry=$zip.GetEntry('showcase/images/sc1000.jpg'); $entry.Delete(); $entry=$zip.CreateEntry('showcase/images/sc1000.jpg'); $stream=$entry.Open(); $bytes=[Text.Encoding]::ASCII.GetBytes('broken'); $stream.Write($bytes,0,$bytes.Length); $stream.Dispose() } finally { $zip.Dispose() }`]);
  const damagedArgs = [...args, '-Verify']; damagedArgs[damagedArgs.indexOf('-Archive') + 1] = damaged;
  assert.throws(() => run(damagedArgs), /hash mismatch/);
  assert.equal(fs.existsSync(runtime), false);
  run(['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${quote(archive)},'Update'); try { $entry=$zip.CreateEntry('unlisted.exe'); $stream=$entry.Open(); $stream.Dispose() } finally { $zip.Dispose() }`]);
  assert.throws(() => run(args), /inventory differs/);
  assert.equal(fs.existsSync(runtime), false);
});
test('attachment failure publishes no output and the same publisher command can be retried', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), repo = path.resolve(__dirname, '../..'), out = path.join(f.base, 'distribution');
  const args = [path.join(repo, 'scripts/maintenance/stage-offline-release.js'), '--root', f.root,
    '--showcase-root', f.showcaseRoot, '--release', f.releaseId, '--out', out, '--apply'];
  assert.throws(() => execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true }), /Incomplete distribution/);
  assert.equal(fs.existsSync(out), false);
  assert.ok(fs.readdirSync(f.base).some(name => name.startsWith('distribution.staging-')));
  f.write(path.join(f.root, 'tools/install-offline-resources.ps1'), fs.readFileSync(path.join(repo, 'tools/install-offline-resources.ps1')));
  for (const name of ['offline-resource-assistant.ps1', 'Install-OfflineResources.cmd']) {
    f.write(path.join(f.root, 'tools', name), fs.readFileSync(path.join(repo, 'tools', name)));
  }
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true }));
  assert.equal(result.applied, true);
  for (const rel of [f.releaseId + '.zip', f.releaseId + '.zip.sha256', f.releaseId + '.release.sha256', 'Install-OfflineResources.ps1', 'offline-resource-assistant.ps1', 'Install-OfflineResources.cmd']) {
    assert.ok(fs.statSync(path.join(out, rel)).isFile());
  }
  assert.equal(result.destination, path.join(out, f.releaseId));
});

test('graphical worker resumes staging across sessions with approved release and directory binding, retaining cancellation', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), plan = planRelease(f); await applyRelease(plan);
  const repo = path.resolve(__dirname, '../..'), archive = path.join(f.base, 'release.zip');
  const install = path.join(f.base, '程序 安装'), runtime = path.join(f.base, '用户 资料/gateway');
  fs.mkdirSync(path.join(install, 'gateway'), { recursive: true });
  for (const name of ['Install-OfflineResources.cmd', 'offline-resource-assistant.ps1', 'install-offline-resources.ps1']) {
    f.write(path.join(install, 'gateway/tools', name), fs.readFileSync(path.join(repo, 'tools', name)));
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const runner = path.join(f.base, 'exercise.ps1');
  const previewFile = path.join(f.base, 'preview.json'), reopened = path.join(f.base, 'reopened.ps1');
  const otherInstall = path.join(f.base, 'other-program'), otherRuntime = path.join(f.base, 'other-user/gateway');
  f.write(path.join(otherInstall, 'gateway/directory-marker'), 'fixture');
  f.write(reopened, `\uFEFF
param([string]$ExpectedStaging)
$ErrorActionPreference='Stop'
. ${quote(path.join(repo, 'tools/offline-resource-assistant.ps1'))}
$preview=Get-Content -LiteralPath ${quote(previewFile)} -Raw | ConvertFrom-Json
if ($ExpectedStaging -notin @(Get-OfflineResumeRecords).staging) { throw 'Reopened helper did not discover retained staging' }
$matched=@(Get-OfflineResumeRecords $preview)
if ($matched.Count -ne 1 -or $matched[0].staging -ne $ExpectedStaging) { throw 'Reopened helper did not bind preview to staging' }
$preview.runtimeRoot=${quote(otherRuntime)}
if (@(Get-OfflineResumeRecords $preview).Count) { throw 'Changed runtime selected old staging' }
$preview.runtimeRoot=${quote(runtime + path.sep)}; $preview.installDir=${quote(otherInstall)}
if (@(Get-OfflineResumeRecords $preview).Count) { throw 'Changed installation selected old staging' }
$window=New-OfflineWindow
if ($window.FindName('Install').IsEnabled -or $window.FindName('Archive').Text) { throw 'Recovery discovery authorized installation' }
$window.Close()
Write-Output 'REOPEN_DISCOVERY_BINDING_WITHOUT_AUTHORIZATION_OK'
`);
  f.write(runner, `\uFEFF
$ErrorActionPreference='Stop'
& ${quote(path.join(repo, 'scripts/maintenance/archive-offline-release.ps1'))} -Source ${quote(f.destination)} -Archive ${quote(archive)}
Add-Type -OutputAssembly ${quote(path.join(install, 'gateway/huiyu-runtime.exe'))} -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
public class NativeFixture {
  public static int Main(string[] args) {
    if (Array.IndexOf(args, "--help") >= 0) {
      bool old = File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "old-runtime"));
      Console.WriteLine(old ? "{\\\"ok\\\":true,\\\"usage\\\":\\\"old runtime\\\"}" : "{\\\"ok\\\":true,\\\"usage\\\":\\\"--cancel-stdin\\\"}"); return 0;
    }
    string package = args[Array.IndexOf(args, "--package-root") + 1];
    string app = args[Array.IndexOf(args, "--app-root") + 1];
    string runtime = args[Array.IndexOf(args, "--runtime-root") + 1];
    if (Path.GetFullPath(app) != AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\\\') || !runtime.EndsWith("gateway\\\\")) return 43;
    if (Array.IndexOf(args, "--cancel-stdin") < 0 || !File.Exists(Path.Combine(package, "release.json"))) return 42;
    File.AppendAllText(Path.Combine(app, "calls.txt"), package + "\\n");
    if (File.Exists(Path.Combine(app, "wait"))) { Console.In.Read(); Console.Error.WriteLine("CANCELLED cooperatively"); return 7; }
    if (File.Exists(Path.Combine(app, "succeed"))) { Console.WriteLine("{\\\"ok\\\":true,\\\"kind\\\":\\\"huiyu-offline-import-result\\\",\\\"releaseId\\\":\\\"fixture-r1\\\"}"); return 0; }
    Console.Error.WriteLine("LOCKED fixture"); return 9;
  }
}
'@
$state=[hashtable]::Synchronized(@{Cancel=$false; CanResume=$false; Staging=$null})
$options=@{Archive=${quote(archive)}; ExpectedReleaseSha256=${quote(plan.summary.expectedReleaseSha256)}; RuntimeRoot=${quote(runtime + path.sep)}; Apply=$true; ProgressState=$state}
$worker=${quote(path.join(install, 'gateway/tools/install-offline-resources.ps1'))}
# Verification detects an incompatible binary without touching any user directory.
[IO.File]::WriteAllText(${quote(path.join(install, 'gateway/old-runtime'))}, 'old')
$options.Apply=$false; $options.Verify=$true
try { & $worker @options; throw 'Expected incompatible native runtime' } catch { if ($_.Exception.Message -notmatch 'USAGE:') { throw } }
Remove-Item -LiteralPath ${quote(path.join(install, 'gateway/old-runtime'))}
$preview=(& $worker @options) | ConvertFrom-Json
if ($preview.installDir -ne ${quote(install)} -or -not $preview.verified -or $state.Staging) { throw 'Bundled preview path/capability check failed' }
$preview | ConvertTo-Json | Set-Content -LiteralPath ${quote(previewFile)} -Encoding UTF8
$options.Apply=$true
try { & $worker @options; throw 'Expected native failure' } catch { if ($_.Exception.Message -notmatch 'LOCKED fixture') { throw } }
if (-not $state.CanResume -or -not (Test-Path -LiteralPath $state.Staging)) { throw 'Missing recovery staging' }
$retained=$state.Staging
try {
  $recordPath=$retained+'.resume.json'
  $recordBytes=[IO.File]::ReadAllText($recordPath)
  $record=$recordBytes | ConvertFrom-Json
  if ($record.releaseSha256 -ne $preview.releaseSha256 -or $record.releaseId -ne $preview.releaseId -or $record.installDir -ne $preview.installDir -or $record.runtimeRoot -ne $preview.runtimeRoot) { throw 'Incorrect persisted recovery binding' }
  $reopenOutput=& powershell.exe -NoProfile -NonInteractive -STA -File ${quote(reopened)} -ExpectedStaging $retained
  if ($LASTEXITCODE -ne 0 -or $reopenOutput -notmatch 'REOPEN_DISCOVERY_BINDING_WITHOUT_AUTHORIZATION_OK') { throw 'Reopened helper failed' }
  . ${quote(path.join(repo, 'tools/offline-resource-assistant.ps1'))}
  $options.ResumeStaging=$retained
  $changed=$options.Clone(); $changed.RuntimeRoot=${quote(otherRuntime)}
  try { & $worker @changed; throw 'Expected runtime binding rejection' } catch { if ($_.Exception.Message -notmatch 'Recovery record does not match') { throw } }
  Copy-Item -LiteralPath ${quote(path.join(install, 'gateway/huiyu-runtime.exe'))} -Destination ${quote(path.join(otherInstall, 'gateway/huiyu-runtime.exe'))}
  $changed=$options.Clone(); $changed.InstallDir=${quote(otherInstall)}
  try { & $worker @changed; throw 'Expected install binding rejection' } catch { if ($_.Exception.Message -notmatch 'Recovery record does not match') { throw } }
  $record.releaseSha256='0'*64
  [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json))
  if (@(Get-OfflineResumeRecords $preview).Count) { throw 'Wrong approval selected old staging' }
  try { & $worker @options; throw 'Expected approval binding rejection' } catch { if ($_.Exception.Message -notmatch 'Recovery record does not match') { throw } }
  $record.releaseSha256=$preview.releaseSha256; $record.releaseId='fixture-r2'
  [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json))
  if (@(Get-OfflineResumeRecords $preview).Count) { throw 'Wrong release selected old staging' }
  try { & $worker @options; throw 'Expected release binding rejection' } catch { if ($_.Exception.Message -notmatch 'Recovery record does not match') { throw } }
  [IO.File]::WriteAllText($recordPath, '{broken')
  if (@(Get-OfflineResumeRecords $preview).Count) { throw 'Damaged recovery record selected staging' }
  [IO.File]::Delete($recordPath)
  if (@(Get-OfflineResumeRecords $preview).Count) { throw 'Missing recovery record selected staging' }
  try { & $worker @options; throw 'Expected missing record rejection' } catch { if ($_.Exception.Message -notmatch 'Missing path') { throw } }
  [IO.File]::WriteAllText($recordPath, $recordBytes)
  $absent=Join-Path (Split-Path $retained -Parent) ('huiyu-offline-import-'+[Guid]::NewGuid().ToString())
  [IO.File]::WriteAllText(($absent+'.resume.json'), $recordBytes)
  try {
    if ($absent -in @(Get-OfflineResumeRecords $preview).staging) { throw 'Missing staging selected for recovery' }
    $changed=$options.Clone(); $changed.ResumeStaging=$absent
    try { & $worker @changed; throw 'Expected missing staging rejection' } catch { if ($_.Exception.Message -notmatch 'Missing path') { throw } }
  } finally { [IO.File]::Delete($absent+'.resume.json') }
  if ((Get-Content -LiteralPath ${quote(path.join(install, 'gateway/calls.txt'))}).Count -ne 1) { throw 'Mismatched recovery invoked native install' }
  [IO.File]::WriteAllText(${quote(path.join(install, 'gateway/wait'))}, 'wait')
  $options.ResumeStaging=$retained
  $shell=[PowerShell]::Create()
  $shell.AddScript({param($worker,$options,$state) try { & $worker @options } catch { $state.Failure=$_.Exception.Message }}).AddArgument($worker).AddArgument($options).AddArgument($state) | Out-Null
  $state.Phase='starting'
  $handle=$shell.BeginInvoke()
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while ($state.Phase -ne 'installing' -and -not $handle.IsCompleted) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Worker did not start' }; Start-Sleep -Milliseconds 20 }
  $state.Cancel=$true
  if (-not $handle.AsyncWaitHandle.WaitOne(10000)) { throw 'Cancellation did not settle' }
  $shell.EndInvoke($handle) | Out-Null; $shell.Dispose()
  if ($state.Failure -notmatch 'CANCELLED cooperatively') { throw ('Unexpected cancellation: '+$state.Failure) }
  if ((Get-Content -LiteralPath ${quote(path.join(install, 'gateway/calls.txt'))}).Count -ne 2) { throw 'Retry did not invoke native importer' }
  if (-not (Test-Path -LiteralPath $retained)) { throw 'Recovery input was removed' }
  Remove-Item -LiteralPath ${quote(path.join(install, 'gateway/wait'))}
  [IO.File]::WriteAllText(${quote(path.join(install, 'gateway/succeed'))}, 'succeed')
  $state.Cancel=$false
  $result=(& $worker @options) | ConvertFrom-Json
  if (-not $result.ok -or (Test-Path -LiteralPath $retained) -or (Test-Path -LiteralPath $recordPath) -or $state.CanResume -or $state.Staging) { throw 'Retry after cancel did not confirm and clean staging' }
  if (Test-Path -LiteralPath ${quote(runtime)}) { throw 'Fixture touched target user runtime' }
  Write-Output 'BUNDLED_UNICODE_PREVIEW_FAILURE_RESUME_CANCEL_RETRY_OK'
} finally {
  $tempRoot=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'))+'\\'
  $resolved=[IO.Path]::GetFullPath($retained)
  if (-not $resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^huiyu-offline-import-[a-f0-9-]{36}$') { throw 'Unsafe fixture cleanup' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  if (Test-Path -LiteralPath ($resolved+'.resume.json')) { Remove-Item -LiteralPath ($resolved+'.resume.json') -Force }
}
`);
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', runner], { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 45000 });
  assert.match(output, /BUNDLED_UNICODE_PREVIEW_FAILURE_RESUME_CANCEL_RETRY_OK/);
});
