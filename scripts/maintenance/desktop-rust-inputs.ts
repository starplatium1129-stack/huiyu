import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import identity = require('../lib/delivery-identity');
import safe = require('../lib/delivery-paths');
import { loadNativeLicenseMaterials, readNativeMaterialFromWorktree, verifyNativeLicenseMaterial } from '../lib/native-license-materials';

const SOURCES = [{ kind: 'tree', path: 'runtime-rs/src' }, { kind: 'file', path: 'runtime-rs/Cargo.toml' }, { kind: 'file', path: 'runtime-rs/Cargo.lock' }];
const NATIVE_MANIFEST = 'runtime-rs/native-dependencies.windows-x64.json';
const EXECUTABLE = 'runtime-rs/target/release/huiyu-runtime.exe';
function digest(bytes: Buffer) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function nativeManifest(bytes: Buffer) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32-x64' || !Array.isArray(manifest.files)
    || manifest.files.length !== 2 || [...manifest.files.map((f: any) => f.name)].sort().join(',') !== 'libvips-42.dll,onnxruntime.dll') throw Error('Invalid Windows native manifest');
  return manifest;
}
function nativeReleaseState(manifest: any) {
  const pending = Array.isArray(manifest.redistribution?.pending) ? manifest.redistribution.pending : ['Native redistribution review missing'];
  return { pending, releaseReady: manifest.status === 'redistribution-verified' && pending.length === 0
    && manifest.licenseEvidence?.publicRedistributionApproved === true && manifest.licenseEvidence?.completeLinkedLicenseClosure === true };
}
function checkedBytes(root: string, file: string, expected: { bytes: number; sha256: string }): Buffer {
  const input = safe.resolveSafe(root, file);
  if (!fs.statSync(input).isFile()) throw Error(`Expected native file: ${file}`);
  const bytes = fs.readFileSync(input);
  if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw Error(`Native/build bytes mismatch: ${file}`);
  return bytes;
}
function runtimeBuild(root: string) {
  const receipt = JSON.parse(fs.readFileSync(safe.resolveSafe(root, 'runtime/rust-evidence/build.json'), 'utf8'));
  if (receipt.formatVersion !== 1 || receipt.binary?.path !== EXECUTABLE) throw Error('Missing Windows release Rust build binding');
  identity.validateSnapshot(receipt.source);
  const current = identity.snapshot(root, SOURCES);
  if (current.status !== 'complete' || current.sha256 !== receipt.source.sha256) throw Error('Rust source/build binding is stale; run rust:build');
  const bytes = checkedBytes(root, EXECUTABLE, receipt.binary);
  return { receipt, bytes };
}
function developmentNativeEnvironment(root:string, supplied:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const env={...supplied};
  if(process.platform!=='win32')return env;
  const selected=[['libvips-42.dll','AICS_VIPS_DYLIB_PATH'],['onnxruntime.dll','AICS_ORT_DYLIB_PATH']];
  if(selected.every(([,key])=>env[key]!==undefined))return env;
  const manifest=JSON.parse(fs.readFileSync(safe.resolveSafe(root,NATIVE_MANIFEST),'utf8'));
  for(const [name,key] of selected){if(env[key]!==undefined)continue;
    const entry=manifest.files?.find((file:any)=>file.name===name);if(!entry)throw Error(`Native manifest lacks ${name}`);
    checkedBytes(root,entry.source,entry);env[key]=safe.resolveSafe(root,entry.source);
  }
  return env;
}
function copyRustPayload(root: string, gateway: string) {
  const { receipt, bytes } = runtimeBuild(root);
  fs.writeFileSync(path.join(gateway, 'huiyu-runtime.exe'), bytes);
  const manifestBytes=fs.readFileSync(safe.resolveSafe(root,NATIVE_MANIFEST));
  const manifest = nativeManifest(manifestBytes);
  fs.mkdirSync(path.join(gateway, 'native'), { recursive: true });
  for (const file of manifest.files) fs.writeFileSync(path.join(gateway, 'native', file.name), checkedBytes(root, file.source, file));
  const readMaterial = readNativeMaterialFromWorktree(root);
  const materials = loadNativeLicenseMaterials(file => file === NATIVE_MANIFEST ? manifestBytes : readMaterial(file));
  for (const [file] of materials) {
    const content = readMaterial(file);
    verifyNativeLicenseMaterial(materials, file, content);
    const destination = safe.resolveSafe(gateway, file.slice('runtime-rs/'.length), true);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content!);
  }
  fs.writeFileSync(path.join(gateway, 'native-dependencies.windows-x64.json'),manifestBytes);
  const report = { schemaVersion: 1, runtime: receipt.binary, source: receipt.source.sha256,
    nativeManifestSha256: digest(manifestBytes), nativeMaterialCount: materials.size,
    ...nativeReleaseState(manifest) };
  fs.writeFileSync(path.join(gateway, 'rust-runtime-build.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
/** The caller first verifies the desktop build/distribution binding. Only the
 * staged bytes bound to that candidate may authorize a public release. */
function assertNativeReleaseReady(gateway: string): void {
  const read = readNativeMaterialFromWorktree(gateway);
  const manifestBytes = read('native-dependencies.windows-x64.json'), reportBytes = read('rust-runtime-build.json');
  if (!manifestBytes || !reportBytes) throw Error('Native release manifest/build report is missing');
  const manifest = nativeManifest(manifestBytes), report = JSON.parse(reportBytes.toString('utf8'));
  if (report.schemaVersion !== 1 || report.nativeManifestSha256 !== digest(manifestBytes)) throw Error('Native release manifest differs from build binding');
  const materials = loadNativeLicenseMaterials(file => file === NATIVE_MANIFEST ? manifestBytes : read(file.slice('runtime-rs/'.length)));
  if (materials.size !== report.nativeMaterialCount) throw Error('Native release material inventory differs from build binding');
  checkedBytes(gateway, 'huiyu-runtime.exe', report.runtime);
  for (const file of manifest.files) checkedBytes(gateway, `native/${file.name}`, file);
  if (!nativeReleaseState(manifest).releaseReady || report.releaseReady !== true || !Array.isArray(report.pending) || report.pending.length) {
    throw Error('Native public release is not approved: releaseReady=false; complete bound redistribution materials and explicit approvals first');
  }
}
export = { SOURCES, EXECUTABLE, NATIVE_MANIFEST, checkedBytes, runtimeBuild, copyRustPayload, developmentNativeEnvironment, assertNativeReleaseReady };
