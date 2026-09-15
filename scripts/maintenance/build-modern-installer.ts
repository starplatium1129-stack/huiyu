import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { WithImplicitCoercion } from 'node:buffer';
import { PathOrFileDescriptor } from 'node:fs';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const BASE = path.join(ROOT, 'desktop-tauri/src-tauri/installer');
const SOURCE = path.join(BASE, 'modern');
const GENERATED = path.join(BASE, 'generated/modern');

function run(command: string, args: readonly string[], options: any = {}) {
  const result = spawnSync(command, args, { cwd: GENERATED, encoding: 'utf8', windowsHide: true, timeout: 180_000, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`Modern installer command failed: ${result.error?.message || result.status}`);
}

function buildModernInstaller({ payload, output, preview = false, capture = false, theme = 'dark', state = 'ready', dpi = 96 }: any = {}) {
  if (!preview && (!payload || !fs.existsSync(payload))) throw new Error('A verified NSIS payload is required');
  if (!['dark', 'light'].includes(theme) || !['ready', 'installing', 'done', 'error'].includes(state)) throw new Error('Unknown preview theme or state');
  fs.mkdirSync(GENERATED, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Installer version must be a stable semantic version');
  const payloadHash = preview ? '' : crypto.createHash('sha256').update(fs.readFileSync(payload)).digest('hex');
  const payloadLength = preview ? 0 : fs.statSync(payload).size;
  const nsisFile = path.join(ROOT, 'desktop-tauri/src-tauri/target/release/nsis/x64/installer.nsi');
  const estimated = fs.existsSync(nsisFile) ? /!define ESTIMATEDSIZE "(\d+)"/.exec(fs.readFileSync(nsisFile, 'utf8')) : null;
  const required = Number(estimated?.[1] || 520000) * 1024;
  const metadata = `using System.Reflection;
[assembly: AssemblyTitle("绘遇安装器")]
[assembly: AssemblyProduct("绘遇 · HUIYU")]
[assembly: AssemblyVersion("${version}.0")]
[assembly: AssemblyFileVersion("${version}.0")]
namespace Ayaki.Installer { internal static class PayloadInfo {
  public const string Version = "${version}";
  public const string Sha256 = "${payloadHash}";
  public const long Length = ${payloadLength}L;
  public const long RequiredBytes = ${required}L;
  public static readonly bool PreviewBuild = ${preview ? 'true' : 'false'};
} }
`;
  const metaFile = path.join(GENERATED, 'PayloadInfo.cs');
  fs.writeFileSync(metaFile, metadata, 'utf8');
  const icons = fs.readFileSync(path.join(SOURCE, 'controls.svg'), 'utf8');
  const xaml = fs.readFileSync(path.join(SOURCE, 'Installer.xaml'), 'utf8').replace(/@ICON_([A-Z]+)@/g, (_: any, key: any) => {
    const match = new RegExp(`<path id="${key.toLowerCase()}" d="([^"]+)"`).exec(icons);
    if (!match) throw new Error(`Missing hand-drawn icon: ${key}`);
    return match[1];
  });
  const xamlFile = path.join(GENERATED, 'Installer.xaml');
  fs.writeFileSync(xamlFile, xaml);
  const framework = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('Windows .NET Framework compiler is unavailable');
  const executable = path.join(GENERATED, preview ? 'AyakiInstaller-Preview.exe' : 'AyakiInstaller.exe');
  const references = ['System.dll', 'System.Core.dll', 'System.Xaml.dll', 'System.Windows.Forms.dll'].map((file: any) => path.join(framework, file));
  references.push(...['WindowsBase.dll', 'PresentationCore.dll', 'PresentationFramework.dll', 'UIAutomationTypes.dll'].map((file: any) => path.join(framework, 'WPF', file)));
  const args = ['/nologo', '/utf8output', '/codepage:65001', '/target:winexe', '/platform:x64', '/optimize+', `/out:${executable}`, `/win32manifest:${path.join(SOURCE, 'app.manifest')}`, `/win32icon:${path.join(BASE, '../icons/icon.ico')}`,
    ...references.map((file: any) => `/reference:${file}`), `/resource:${xamlFile},Installer.xaml`, `/resource:${path.join(BASE, 'atelier-keyart.png')},Keyart.png`, metaFile,
    ...['Program.cs', 'InstallEngine.cs', 'FolderPicker.cs', 'InstallerWindow.cs'].map((file: any) => path.join(SOURCE, file))];
  if (!preview) args.push(`/resource:${path.resolve(payload)},Payload.exe`);
  run(compiler, args);
  run(executable, ['--self-test']);
  if (capture) {
    const captureFile = path.join(ROOT, 'runtime', `installer-modern-${theme}-${state}-${dpi}.png`);
    run(executable, ['--preview', `--theme=${theme}`, `--state=${state}`, `--dpi=${dpi}`, `--capture=${captureFile}`]);
    console.log(`Native preview: ${captureFile}`);
  }
  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(executable, output); }
  console.log(`Modern installer: ${output || executable}`);
  return { executable: output || executable, payloadHash, payloadLength, version };
}


function verifyUpdaterSignature(executable: PathOrFileDescriptor, signature: WithImplicitCoercion<string>, publicKey: WithImplicitCoercion<string>) {
  const key = Buffer.from(Buffer.from(publicKey, 'base64').toString('utf8').trim().split(/\r?\n/)[1] || '', 'base64');
  const lines = Buffer.from(signature, 'base64').toString('utf8').trim().split(/\r?\n/);
  const packet = Buffer.from(lines[1] || '', 'base64');
  if (key.length !== 42 || packet.length !== 74 || !key.subarray(2, 10).equals(packet.subarray(2, 10))) throw new Error('Updater signing key mismatch');
  const algorithm = packet.subarray(0, 2).toString();
  if (!['ED', 'Ed'].includes(algorithm)) throw new Error('Unsupported updater signature algorithm');
  const verifier = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const data = fs.readFileSync(executable);
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  if (!crypto.verify(null, message, verifier, packet.subarray(10))) throw new Error('Distributed installer signature verification failed');
  if (!lines[2]?.startsWith('trusted comment: ') || !crypto.verify(null, Buffer.concat([packet.subarray(10), Buffer.from(lines[2].slice(17))]), verifier, Buffer.from(lines[3] || '', 'base64'))) throw new Error('Updater trusted comment verification failed');
  return true;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (key: string|unknown[], fallback: string|undefined) => args.find((arg: any) => arg.startsWith(`--${key}=`))?.slice(key.length + 3) || fallback;
  if (args.includes('--help')) console.log('Build modern installer: --preview [--capture --theme=dark|light --state=ready|installing|done|error --dpi=96|120|144] or --payload=<NSIS exe> --output=<wrapper exe>');
  else try { buildModernInstaller({ preview: args.includes('--preview'), capture: args.includes('--capture'), theme: value('theme', 'dark'), state: value('state', 'ready'), dpi: Number(value('dpi', '96')), payload: value('payload', undefined), output: value('output', undefined) }); }
  catch (error) { console.error(runtimeErrorMessage(error)); process.exitCode = 1; }
}
export = { buildModernInstaller, verifyUpdaterSignature };
