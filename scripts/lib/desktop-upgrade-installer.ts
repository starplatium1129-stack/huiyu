import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import { spawnSync } from 'node:child_process';
import binding = require('./desktop-build-binding');
import safe = require('./delivery-paths');
import lock = require('../maintenance/desktop-build-lock');

type Asset = { path: string; bytes: number; sha256: string };
const RETAIN = /^gateway\/assets\/(?:characters|live2d|chibi|dual-poses|particles)\//;
function once(source: string, from: string, to: string) {
  if (source.split(from).length !== 2) throw Error(`Upgrade template anchor drift: ${from.slice(0, 70)}`);
  return source.replace(from, to);
}
function nsisPath(value: string) {
  // File/OutFile take compiler paths, not runtime variable strings. Doubling $
  // here changes the actual filename; reject preprocessor expressions instead.
  if (/["\r\n\0]/.test(value) || value.includes('${')) throw Error('Unsupported NSIS compiler path');
  return value;
}

export function upgradeScript(source: string, assets: Asset[], verifier: string, host: string, output: string) {
  if (!assets.length) throw Error('Upgrade requires a nonempty retained asset inventory');
  let text = source.replace(/\r\n/g, '\n');
  const required = new Set(assets.map(file => file.path));
  const omitted = new Set<string>();
  text = text.split('\n').filter(line => {
    const match = /^\s*File \/a "\/oname=([^"]+)" "([^"]+)"\s*$/.exec(line);
    const relative = match?.[1].replace(/\\+/g, '/').replaceAll('$$', '$');
    if (!relative || !required.has(relative)) return true;
    if (omitted.has(relative)) throw Error('Duplicate retained File instruction');
    omitted.add(relative); return false;
  }).join('\n');
  if (omitted.size !== required.size) throw Error('Retained assets do not match rendered installer File instructions');
  for (const name of omitted) {
    const deletes = [...text.matchAll(/^\s*Delete "\$INSTDIR([^"\n]+)"/gm)].map(match => match[1].replace(/\\+/g, '/').replace(/^\//, '').replaceAll('$$', '$'));
    if (!deletes.includes(name)) throw Error('Upgrade must retain the complete uninstaller resource inventory');
  }
  const webview = text.match(/^!define INSTALLWEBVIEW2MODE "([^"]+)"$/m);
  if (!webview) throw Error('Missing WebView2 installer mode');
  text = once(text, webview[0], '!define INSTALLWEBVIEW2MODE "skip"');
  const binary = text.match(/^!define MAINBINARYSRCPATH "[^"]+"$/m);
  const destination = text.match(/^OutFile "[^"]+"$/m);
  if (!binary || !destination) throw Error('Missing installer host/output declarations');
  text = once(text, binary[0], `!define MAINBINARYSRCPATH "${nsisPath(host)}"`);
  text = once(text, destination[0], `OutFile "${nsisPath(output)}"`);
  const check = `Function GameCheckUpgradeResources
  InitPluginsDir
  File "/oname=$PLUGINSDIR\\HuiyuUpgradeCheck.exe" "${nsisPath(verifier)}"
  nsExec::ExecToStack /TIMEOUT=60000 '"$PLUGINSDIR\\HuiyuUpgradeCheck.exe" "$INSTDIR"'
  Pop $0
  Pop $1
  \${If} $0 != 0
    DetailPrint "Upgrade requirements failed: $1"
    \${IfNot} \${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "此升级包需要完整的旧版绘遇和相同版本的基础素材。请下载本版本的完整安装包进行安装或修复。"
    \${EndIf}
    SetErrorLevel 1603
    Quit
  \${EndIf}
  StrCpy $UpdateMode 1
FunctionEnd

`;
  // /UPDATE already bypasses the old uninstaller in pinned Tauri. Guard before
  // the reinstall page can run it, and again after directory selection.
  text = once(text, 'Function PageLeaveReinstall\n', 'Function PageLeaveReinstall\n  Call GameCheckUpgradeResources\n  StrCpy $WixMode 0\n  Goto reinst_done\n');
  text = once(text, 'Section EarlyChecks\n', `${check}Section EarlyChecks\n  Call GameCheckUpgradeResources\n`);
  return text;
}

// Tauri 2.12 restores the bound host to UNK after packaging. A derived NSIS must
// embed its single NSS stamp with every other byte preserved. Use an official
// packaged-host receipt when upstream exposes one; marker drift must fail closed.
export function nsisHost(bytes: Buffer) {
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const offset = bytes.indexOf(marker);
  if (offset < 0 || bytes.indexOf(marker, offset + marker.length) >= 0) throw Error('Expected one bound Tauri NSIS host marker');
  const result = Buffer.from(bytes);
  result.write('__TAURI_BUNDLE_TYPE_VAR_NSS', offset, 'ascii');
  return result;
}

function command(executable: string, args: string[], cwd: string) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (result.error || result.status !== 0) throw Error(`Upgrade package build failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
}

export async function buildUpgradeInstaller(root: string) {
  return lock.withDesktopBuildLock({ workspaceRoot: root }, () => {
    const receipt = binding.verifyBuild(root);
    const renderedPath = 'desktop-tauri/src-tauri/target/release/nsis/x64/installer.nsi';
    if (!receipt.build.entries.some((entry: { path: string; status: string }) => entry.path === renderedPath && entry.status === 'file'))
      throw Error('Rendered NSIS inputs are not bound; perform a fresh desktop build');
    const assets: Asset[] = receipt.build.entries.filter((entry: { path: string; status: string }) => entry.status === 'file' &&
      RETAIN.test(entry.path.replace(/^desktop-tauri\/src-tauri\/resources\//, '')))
      .map((entry: Asset) => ({ path: entry.path.replace(/^desktop-tauri\/src-tauri\/resources\//, ''), bytes: entry.bytes, sha256: entry.sha256 }));
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const directory = safe.resolveSafe(root, `runtime/desktop-updates/payloads/${version}`, true);
    fs.mkdirSync(directory, { recursive: true });
    const manifest = path.join(directory, 'UpgradeRequirements.json');
    fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, version, assets }));
    const verifier = path.join(directory, 'HuiyuUpgradeCheck.exe');
    const framework = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
    command(path.join(framework, 'csc.exe'), ['/nologo', '/utf8output', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+',
      `/out:${verifier}`, `/reference:${path.join(framework, 'System.Runtime.Serialization.dll')}`,
      `/win32manifest:${path.join(root, 'desktop-tauri/src-tauri/installer/modern/app.manifest')}`,
      `/resource:${manifest},UpgradeRequirements.json`, path.join(root, 'desktop-tauri/src-tauri/installer/modern/UpgradeCheck.cs')], directory);
    const host = path.join(directory, 'nsis-host.exe');
    fs.writeFileSync(host, nsisHost(fs.readFileSync(path.join(root, 'desktop-tauri/src-tauri/target/release/ai-cg-studio-desktop.exe'))));
    const output = path.join(directory, `AI-CG-Studio_${version}_x64-upgrade.exe`);
    const script = path.join(directory, 'upgrade.nsi');
    fs.writeFileSync(script, upgradeScript(fs.readFileSync(path.join(root, renderedPath), 'utf8'), assets, verifier, host, output));
    command(path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe'), ['/NOCD', '/INPUTCHARSET', 'UTF8', '/V2', script], path.dirname(path.join(root, renderedPath)));
    binding.bindDerivedPayload(root, output);
    binding.bindDerivedPayload(root, verifier);
    return { payload: output, verifier, retainedFiles: assets.length, retainedBytes: assets.reduce((sum, file) => sum + file.bytes, 0),
      requirementsSha256: crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') };
  });
}
