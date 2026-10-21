import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import { spawnSync } from 'node:child_process';
import binding = require('./desktop-build-binding');
import safe = require('./delivery-paths');
import lock = require('./workspace-lock');
import { timeDesktopBuild } from './desktop-build-timing';
import { desktopBuildProfile, desktopHostExecutable } from './desktop-build-profile';

type Asset = { path: string; bytes: number; sha256: string };
// Character pictures and particle grids change with content updates and ship in the upgrade.
const RETAIN = /^gateway\/assets\/(?:live2d|chibi|dual-poses)\//;
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

function upgradeScript(source: string, assets: Asset[], verifier: string, host: string, output: string) {
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
  // The derived host has a temporary basename; install it under the product name.
  text = once(text, '  File "${MAINBINARYSRCPATH}"', '  File "/oname=${MAINBINARYNAME}.exe" "${MAINBINARYSRCPATH}"');
  text = once(text, destination[0], `OutFile "${nsisPath(output)}"`);
  return upgradeChecks(text, verifier);
}

function upgradeChecks(text: string, verifier: string) {
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
function nsisHost(bytes: Buffer) {
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const offset = bytes.indexOf(marker);
  if (offset < 0 || bytes.indexOf(marker, offset + marker.length) >= 0) throw Error('Expected one bound Tauri NSIS host marker');
  const result = Buffer.from(bytes);
  result.write('__TAURI_BUNDLE_TYPE_VAR_NSS', offset, 'ascii');
  return result;
}

function command(executable: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (result.error || result.status !== 0) throw Error(`Upgrade package build failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
}

// Tauri still renders the complete uninstaller inventory. Only the install File
// loop is reduced, so a later uninstall also removes the retained old resources.
function localUpgradeTemplate(root: string, receipt: ReturnType<typeof binding.verifyBuild>, assets: Asset[], verifier: string) {
  const base = 'desktop-tauri/src-tauri';
  const config = JSON.parse(fs.readFileSync(path.join(root, base, 'tauri.conf.json'), 'utf8'));
  const retained = new Set(assets.map(asset => asset.path));
  const omitted = new Set<string>();
  const files: string[] = [];
  for (const [source, destination] of Object.entries(config.bundle.resources as Record<string, string>)) {
    const relative = safe.relative(`${base}/${source}`);
    const sourcePath = safe.resolveSafe(root, relative);
    const directory = fs.statSync(sourcePath).isDirectory();
    const inputs: string[] = directory
      ? receipt.build.entries.filter((entry: { status: string; path: string }) => entry.status === 'file' && entry.path.startsWith(`${relative}/`)).map((entry: Asset) => entry.path)
      : [relative];
    if (!inputs.length) throw Error(`No bound local upgrade resources: ${source}`);
    for (const input of inputs) {
      const target = safe.relative(directory ? `${destination}/${input.slice(relative.length + 1)}` : destination);
      if (retained.has(target)) { omitted.add(target); continue; }
      const name = target.replaceAll('$', () => '$$').replaceAll('/', '\\');
      files.push(`    File /a "/oname=${name}" "${nsisPath(safe.resolveSafe(root, input))}"`);
    }
  }
  if (omitted.size !== retained.size) throw Error('Retained assets differ from the Tauri resource mapping');
  const template = fs.readFileSync(path.join(root, base, 'installer/generated/installer.nsi'), 'utf8').replace(/\r\n/g, '\n');
  return upgradeChecks(once(template, '  {{#each resources}}\n    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"\n  {{/each}}', files.join('\n')), verifier);
}

export async function buildUpgradeInstaller(root: string, options: { installDir?: string; local?: boolean } = {}) {
  return lock.withWorkspaceLock({ workspaceRoot: root }, async () => {
    if (options.local && !options.installDir) throw Error('Local upgrades require an existing installation directory');
    const receipt = await timeDesktopBuild('upgrade source verification', () => binding.verifyBuild(root, undefined, options.local ? undefined : 'release'));
    const profile = desktopBuildProfile(receipt.buildProfile);
    const hostExecutable = path.join(root, desktopHostExecutable(profile));
    const renderedPath = 'desktop-tauri/src-tauri/target/release/nsis/x64/installer.nsi';
    if (!options.local && !receipt.build.entries.some((entry: { path: string; status: string }) => entry.path === renderedPath && entry.status === 'file'))
      throw Error('Rendered NSIS inputs are not bound; perform a fresh desktop build');
    const assets: Asset[] = receipt.build.entries.filter((entry: { path: string; status: string }) => entry.status === 'file' &&
      RETAIN.test(entry.path.replace(/^desktop-tauri\/src-tauri\/resources\//, '')))
      .map((entry: Asset) => ({ path: entry.path.replace(/^desktop-tauri\/src-tauri\/resources\//, ''), bytes: entry.bytes, sha256: entry.sha256 }));
    if (!assets.length) throw Error('Upgrade requires a nonempty retained asset inventory');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const directory = safe.resolveSafe(root, `runtime/desktop-updates/payloads/${version}${options.local ? '/local' : ''}`, true);
    fs.mkdirSync(directory, { recursive: true });
    const manifest = path.join(directory, 'UpgradeRequirements.json');
    fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, version, assets }));
    const verifier = path.join(directory, 'HuiyuUpgradeCheck.exe');
    const framework = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
    command(path.join(framework, 'csc.exe'), ['/nologo', '/utf8output', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+',
      `/out:${verifier}`, `/reference:${path.join(framework, 'System.Runtime.Serialization.dll')}`,
      `/win32manifest:${path.join(root, 'desktop-tauri/src-tauri/installer/modern/app.manifest')}`,
      `/resource:${manifest},UpgradeRequirements.json`, path.join(root, 'desktop-tauri/src-tauri/installer/modern/UpgradeCheck.cs')], directory);
    // The same read-only verifier runs again inside the installer before writes.
    // A local mismatch must stop before NSIS compression or wrapper generation.
    if (options.installDir) {
      await timeDesktopBuild('installed upgrade prerequisites', () => command(verifier, [path.resolve(options.installDir!)], directory));
    }
    const output = path.join(directory, `AI-CG-Studio_${version}_x64-upgrade.exe`);
    const script = path.join(directory, 'upgrade.nsi');
    let nsisFile = path.join(root, renderedPath);
    if (options.local) {
      fs.writeFileSync(script, localUpgradeTemplate(root, receipt, assets, verifier));
      // Bundle a copy in an isolated Cargo target directory. Neither an existing
      // full installer nor the bound host/NSIS inputs are overwritten.
      const target = path.join(directory, 'target');
      fs.mkdirSync(path.join(target, 'release'), { recursive: true });
      fs.copyFileSync(hostExecutable, path.join(target, 'release/ai-cg-studio-desktop.exe'));
      const env: NodeJS.ProcessEnv = { ...(require('./desktop-build-environment') as typeof import('./desktop-build-environment')).desktopBuildEnvironment(root), CARGO_TARGET_DIR: target };
      delete env.TAURI_SIGNING_PRIVATE_KEY; delete env.TAURI_SIGNING_PRIVATE_KEY_PATH; delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
      await timeDesktopBuild('local upgrade NSIS bundle', () => command(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'bundle', '--bundles', 'nsis', '--ci', '--no-sign',
        '--config', path.join(root, 'desktop-tauri/tauri.local.json'), '--config', JSON.stringify({ bundle: { windows: { nsis: { template: script } } } })], path.join(root, 'desktop-tauri'), env));
      const config = JSON.parse(fs.readFileSync(path.join(root, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'));
      fs.renameSync(path.join(target, 'release/bundle/nsis', `${config.productName}_${version}_x64-setup.exe`), output);
      nsisFile = path.join(target, 'release/nsis/x64/installer.nsi');
    } else {
      const host = path.join(directory, 'nsis-host.exe');
      fs.writeFileSync(host, nsisHost(fs.readFileSync(hostExecutable)));
      fs.writeFileSync(script, upgradeScript(fs.readFileSync(nsisFile, 'utf8'), assets, verifier, host, output));
      await timeDesktopBuild('upgrade NSIS compression', () => command(path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe'), ['/NOCD', '/INPUTCHARSET', 'UTF8', '/V2', script], path.dirname(nsisFile)));
    }
    await timeDesktopBuild('upgrade payload binding', () => binding.bindDerivedPayloads(root, [output, verifier]));
    return { payload: output, verifier, nsisFile, retainedFiles: assets.length, retainedBytes: assets.reduce((sum, file) => sum + file.bytes, 0),
      requirementsSha256: crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') };
  });
}
