'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const SDK_PARTS = ['Core/include/Live2DCubismCore.h', 'Core/lib/windows/x86_64/143/Live2DCubismCore_MD.lib', 'Framework/src/CubismFramework.cpp'];

type EnvironmentOptions = {
  root?: string;
  env?: NodeJS.ProcessEnv;
};

type BuildCheck = { name: string; ready: boolean; detail: string; help?: string };

function resolveSdkRoot(root = ROOT, env: NodeJS.ProcessEnv = process.env, exists = fs.existsSync): string {
  // An explicitly configured path is authoritative: do not silently build against a different SDK.
  if (env.LIVE2D_CUBISM_SDK_DIR) return path.resolve(env.LIVE2D_CUBISM_SDK_DIR);
  return [
    path.join(root, 'runtime/desktop-build-sdk/CubismSdkForNative-5-r.5'),
    'E:/code/CubismSdkForNative-5-r.5/CubismSdkForNative-5-r.5',
  ].find(candidate => SDK_PARTS.every(part => exists(path.join(candidate, part)))) || '';
}

function desktopBuildEnvironment(root = ROOT, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const home = source.USERPROFILE || os.homedir();
  const candidates = [path.join(source.CARGO_HOME || path.join(home, '.cargo'), 'bin'), path.join(home, '.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin')];
  const rustBin = candidates.find(candidate => fs.existsSync(path.join(candidate, 'cargo.exe')));
  if (rustBin) env[pathKey] = [rustBin, env[pathKey] || ''].join(path.delimiter);
  const sdk = resolveSdkRoot(root, source);
  if (sdk) env.LIVE2D_CUBISM_SDK_DIR = sdk;
  return env;
}

function inspectDesktopBuildEnvironment(options: EnvironmentOptions = {}) {
  const root = options.root || ROOT;
  const env = desktopBuildEnvironment(root, options.env || process.env);
  const checks: BuildCheck[] = [];
  const add = (name: string, ready: unknown, detail: string, help?: string) => checks.push({ name, ready: Boolean(ready), detail, ...(help ? { help } : {}) });
  add('Windows', process.platform === 'win32' && process.arch === 'x64', `${process.platform} ${process.arch}`, '安装包需要 Windows x64 构建主机');
  const node = process.versions.node.split('.').map(Number);
  add('Node.js', node[0] > 22 || (node[0] === 22 && node[1] >= 18), process.versions.node, '需要 Node.js >=22.18');
  const cargo = spawnSync('cargo', ['--version'], { env, encoding: 'utf8', windowsHide: true });
  const rustc = spawnSync('rustc', ['-vV'], { env, encoding: 'utf8', windowsHide: true });
  add('Rust MSVC', cargo.status === 0 && /host: x86_64-pc-windows-msvc/.test(rustc.stdout || ''), String(cargo.stdout || cargo.error?.message || '').trim(), '从 https://rust-lang.org/tools/install/ 安装 x64 MSVC stable 工具链');
  const programFiles = env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe');
  const studio = fs.existsSync(vswhere) ? spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }) : null;
  add('Visual C++', studio?.status === 0 && studio.stdout.trim(), studio?.stdout.trim() || '', '在 Visual Studio Installer 安装“使用 C++ 的桌面开发”');
  const sdkLib = path.join(programFiles, 'Windows Kits/10/Lib');
  const windowsSdk = fs.existsSync(sdkLib) ? fs.readdirSync(sdkLib).find(version => fs.existsSync(path.join(sdkLib, version, 'um/x64/kernel32.lib'))) : '';
  add('Windows SDK', windowsSdk, windowsSdk || '', '通过 Visual Studio Installer 安装 Windows 10/11 SDK');
  const sdkRoot = env.LIVE2D_CUBISM_SDK_DIR || '';
  add('Cubism Native R5', sdkRoot && SDK_PARTS.every(part => fs.existsSync(path.join(sdkRoot, part))), sdkRoot,
    '将官方 CubismSdkForNative-5-r.5 放在 runtime/desktop-build-sdk/，或设置 LIVE2D_CUBISM_SDK_DIR');
  return { ready: checks.every(check => check.ready), checks, sdkRoot };
}

function assertDesktopBuildEnvironment(root = ROOT) {
  const report = inspectDesktopBuildEnvironment({ root });
  if (!report.ready) throw new Error('桌面构建环境未就绪：\n' + report.checks.filter(check => !check.ready).map(check => `${check.name}: ${check.help}`).join('\n'));
  return report;
}

if (require.main === module) {
  const report = inspectDesktopBuildEnvironment();
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : report.checks.map(check => `${check.ready ? 'OK' : 'MISSING'} ${check.name}: ${check.detail || check.help}`).join('\n'));
  process.exitCode = report.ready ? 0 : 1;
}
export = { resolveSdkRoot, desktopBuildEnvironment, inspectDesktopBuildEnvironment, assertDesktopBuildEnvironment };
