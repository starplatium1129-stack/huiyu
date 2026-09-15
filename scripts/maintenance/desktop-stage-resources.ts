'use strict';

/**
 * 桌面端打包资源暂存：把网关运行所需文件复制到 desktop-tauri/resources/，
 * 供 tauri.conf.json 的 bundle.resources 引用（tauri 资源路径以 src-tauri
 * 为基准，跨目录相对路径在 build script 的 cwd 下不可靠）。
 *
 * 运行时依赖锁从根 package-lock.json 的非 dev 闭包派生，随后只用 npm ci
 * 安装，避免打包依赖本机当时解析到的版本。
 *
 * 用法：node scripts/maintenance/desktop-stage-resources.js
 */

const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const { execFileSync } = (require('node:child_process') as typeof import('node:child_process'));
const { withDesktopBuildLock } = (require('./desktop-build-lock') as typeof import('./desktop-build-lock'));
const { getRuntimeGeneratedInventory } = (require('./runtime-generated-files') as typeof import('./runtime-generated-files'));

type Logger = (message: string) => void;
interface LockEntry {
  version?: string;
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [field: string]: unknown;
}
interface RootPackage { version: string; dependencies?: Record<string, string> }
interface RootLock { packages: Record<string, LockEntry> }
interface StageOptions {
  root?: string;
  stage?: string;
  resourceProfile?: string;
  logger?: Logger;
  installDependencies?: (gatewayDir: string) => void;
}

const ROOT = path.resolve(__dirname, '../..');
const STAGE = path.join(ROOT, 'desktop-tauri', 'src-tauri', 'resources');

const ENTRIES = [
  ['server.js', 'gateway/server.js'],
  ['server', 'gateway/server'],
  ['routes', 'gateway/routes'],
  ['services', 'gateway/services'],
  ['scripts/lib', 'gateway/scripts/lib'],
  ['docs', 'gateway/docs'],
  ['data', 'gateway/data'],
  ['dist', 'gateway/dist'],
  ['assets', 'gateway/assets'],
  ['tools', 'gateway/tools'],
];
// 桌面端 gateway 的 npm 依赖白名单：打包时只把这里列出的包写进 gateway/package.json，
// 由 npm ci 安装。凡是运行时 require 的新依赖都必须加进来，否则网页版正常、桌面端静默降级
// （2026-08-29 教训：onnxruntime-node + sharp 漏登记，真实反推在桌面端一直走启发式兜底）。
// 要求：该包须同时存在于根 package.json 的 dependencies 与 package-lock.json，否则派生时抛错。
const RUNTIME_DEPENDENCIES = [
  'compression',
  'express',
  'http-proxy-middleware',
  // 本地真实反推（WD14 ONNX，server/interrogate-engine.js）
  'onnxruntime-node',
  'sharp',
  // ComfyUI 出图进度 WebSocket 客户端（server/comfy-progress.js）。
  // 2026-09-06 教训：ws 原先靠前端依赖搭车进包，闭包派生后缺失，
  // 出图进度接口 500 → 桌面端主页面打不开、桌宠不显示。
  'ws',
];

function copyDir(src: string, dest: string, includeFile: (file: string) => boolean = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, includeFile);
    } else if (includeFile(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function isRuntimeServiceFile(filePath: string) {
  return path.extname(filePath).toLowerCase() === '.js';
}

function copySelectedFiles(src: string, dest: string, relativeFiles: readonly string[]) {
  for (const relativePath of relativeFiles) {
    const from = path.join(src, relativePath);
    const to = path.join(dest, relativePath);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
      throw new Error(`required runtime output is missing: services/${relativePath}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

/**
 * 从根 lock 派生运行时依赖闭包：从 RUNTIME_DEPENDENCIES 出发沿 dependencies /
 * optionalDependencies / peerDependencies 走传递闭包（npm ≥7 默认安装 peers，
 * sharp 的平台二进制在 optionalDependencies 里，漏走都会导致桌面端缺包）。
 *
 * 条目按根 lock 原始路径（含 node_modules/<parent>/node_modules/<name> 嵌套）
 * 原样保留，不可拍平——npm ci 会校验树结构一致性，把嵌套版本写到顶层会报
 * Missing/<pkg> from lock file。查找顺序模拟 Node 解析：沿父包祖先链逐级
 * 向上找同名包，最后落到根提升版本。
 */
function collectRuntimeClosure(rootLock: RootLock, logger?: Logger) {
  const packages = rootLock.packages;
  const resolve = (name: string, parentPath: string) => {
    let prefix = parentPath;
    for (;;) {
      const candidate = prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`;
      const entry = packages[candidate];
      if (entry && typeof entry.version === 'string') return { entry, lockPath: candidate };
      const cut = prefix ? prefix.lastIndexOf('/node_modules/') : -1;
      if (cut === -1) {
        if (!prefix) break;
        prefix = '';
        continue;
      }
      prefix = prefix.slice(0, cut);
    }
    return null;
  };

  const closure: Record<string, LockEntry> = {};
  // field 记录来源：常规 dependencies 缺失是硬错误（运行时必崩）；
  // optional/peer 缺失跳过（如 ws 的 bufferutil 可选加速层，有纯 JS 回退）。
  const queue = RUNTIME_DEPENDENCIES.map((name: any) => ({ name, parentPath: '', field: 'root' }));
  while (queue.length) {
    const { name, parentPath, field } = queue.shift()!;
    const found = resolve(name, parentPath);
    if (!found) {
      if (field === 'dependencies' || field === 'root') {
        throw new Error(`runtime dependency is missing from package-lock.json: ${name}`);
      }
      if (logger) logger(`[stage] 跳过未入锁的可选依赖 ${name}（来源 ${field}）`);
      continue;
    }
    const { entry, lockPath } = found;
    if (closure[lockPath]) continue;
    closure[lockPath] = entry;
    for (const depField of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const depName of Object.keys(entry[depField] || {})) {
        queue.push({ name: depName, parentPath: lockPath, field: depField });
      }
    }
  }
  return closure;
}

function buildGatewayPackage(rootPkg: RootPackage, rootLock: RootLock, logger?: Logger) {
  const closure = collectRuntimeClosure(rootLock, logger);
  const dependencies = Object.fromEntries(RUNTIME_DEPENDENCIES.map((name: any) => {
    const entry = closure[`node_modules/${name}`];
    if (!entry || typeof entry.version !== 'string') {
      throw new Error(`runtime dependency is missing from package-lock.json: ${name}`);
    }
    return [name, entry.version];
  }));

  const packages: Record<string, LockEntry> = {
    '': {
      name: 'aics-gateway',
      version: rootPkg.version,
      dependencies,
    },
  };
  for (const [lockPath, entry] of Object.entries(closure)) {
    packages[lockPath] = entry;
  }

  return {
    manifest: {
      name: 'aics-gateway',
      private: true,
      version: rootPkg.version,
      dependencies,
    },
    lock: {
      name: 'aics-gateway',
      version: rootPkg.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    },
  };
}

function resolveNpmInvocation() {
  const npmCli = process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)
    ? process.env.npm_execpath
    : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCli)) return { command: process.execPath, args: [npmCli] };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] };
}

function installGatewayDependencies(gatewayDir: string) {
  const npm = resolveNpmInvocation();
  execFileSync(npm.command, [
    ...npm.args,
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], {
    cwd: gatewayDir,
    stdio: 'inherit',
  });
}

function directorySize(directory: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? directorySize(fullPath) : fs.statSync(fullPath).size;
  }
  return bytes;
}

function removeTree(target: string, logger: Logger) {
  let size = 0;
  try {
    size = directorySize(target);
  } catch (error) {
    return 0;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    logger(`[stage] warning: 未能删除 ${path.basename(target)}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
  return size;
}

/**
 * 精简原生二进制：onnxruntime-node 一个包里塞了 win/linux/darwin + arm64 的全平台预编译
 * 产物（283 MB），而桌面端只分发 win32-x64。装完依赖后删掉其余平台，283 MB -> 64 MB，
 * 安装包相应少膨胀约 200 MB。删除失败只告警不中断（受限环境下 rmSync 可能被拦截，
 * 此时由调用方用其他方式补删，功能不受影响，只是包会偏大）。
 */
function pruneNativeBinaries(tempStage: string, logger: Logger) {
  const ortBin = path.join(tempStage, 'gateway', 'node_modules', 'onnxruntime-node', 'bin');
  if (!fs.existsSync(ortBin)) return 0;

  let freed = 0;
  for (const apiDir of fs.readdirSync(ortBin)) {
    const apiPath = path.join(ortBin, apiDir);
    if (!fs.statSync(apiPath).isDirectory()) continue;
    for (const platform of fs.readdirSync(apiPath)) {
      const platformPath = path.join(apiPath, platform);
      if (platform === 'win32') {
        for (const arch of fs.readdirSync(platformPath)) {
          if (arch === 'x64') continue;
          freed += removeTree(path.join(platformPath, arch), logger);
        }
        continue;
      }
      freed += removeTree(platformPath, logger);
    }
  }
  if (freed > 0) {
    logger(`[stage] 裁剪非 win32-x64 的 onnxruntime 二进制，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`);
  }
  return freed;
}

function publishStage(tempStage: string, stage: string, logger: Logger) {
  const backupStage = `${stage}.previous-${process.pid}-${crypto.randomUUID()}`;
  let oldMoved = false;
  try {
    if (fs.existsSync(stage)) {
      fs.renameSync(stage, backupStage);
      oldMoved = true;
    }
    fs.renameSync(tempStage, stage);
  } catch (error) {
    if (oldMoved && !fs.existsSync(stage) && fs.existsSync(backupStage)) {
      try {
        fs.renameSync(backupStage, stage);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'desktop stage publish and rollback both failed');
      }
    }
    throw error;
  }

  if (oldMoved) {
    try {
      fs.rmSync(backupStage, { recursive: true, force: true });
    } catch (error) {
      logger(`[stage] warning: could not remove previous stage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function stageResources(options: StageOptions = {}) {
  const root = options.root || ROOT;
  const resourceProfile = options.resourceProfile || process.env.AICS_DESKTOP_RESOURCE_PROFILE || 'full';
  if (!['full', 'base'].includes(resourceProfile)) throw new Error('Resource profile must be full or base');
  const stage = options.stage || STAGE;
  const logger = options.logger || console.log;
  const installDependencies = options.installDependencies || installGatewayDependencies;
  const runtimeFiles = getRuntimeGeneratedInventory(root);
  const stageParent = path.dirname(stage);
  fs.mkdirSync(stageParent, { recursive: true });
  const tempStage = fs.mkdtempSync(path.join(stageParent, `${path.basename(stage)}.tmp-${process.pid}-`));

  try {
    for (const [source, target] of ENTRIES) {
      const from = path.join(root, source);
      const to = path.join(tempStage, target);
      if (!fs.existsSync(from)) {
        throw new Error(`required staging input is missing: ${source}`);
      }
      if (source === 'services') {
        copySelectedFiles(from, to, runtimeFiles.javascriptFiles);
      } else if (fs.statSync(from).isDirectory()) {
        if (source === 'assets') {
          // 2026-08-29：character-references（~1GB 媒体图）已迁出项目 → AI 工作区，
          // 由网关 /character-references 外部目录服务；此处排除防误回放入包。
          copyDir(from, to, (filePath: any) => {
            const rel = path.relative(from, filePath);
            return rel.split(path.sep)[0] !== 'character-references' && !/\.(?:[cm]?ts|map)$/.test(filePath);
          });
        } else {
          copyDir(from, to, (filePath: any) => !/\.(?:[cm]?ts|map)$/.test(filePath));
        }
      } else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
      logger(`[stage] ${source} -> resources/${target}`);
    }

    execFileSync(process.execPath, [path.join(__dirname, 'desktop-resource-profile.js'), root,
      path.join(tempStage, 'gateway'), resourceProfile], { windowsHide: true, stdio: 'pipe' });
    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const rootLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const gateway = buildGatewayPackage(rootPkg, rootLock, logger);
    const gatewayDir = path.join(tempStage, 'gateway');
    fs.writeFileSync(path.join(gatewayDir, 'package.json'), JSON.stringify(gateway.manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(gatewayDir, 'package-lock.json'), JSON.stringify(gateway.lock, null, 2) + '\n');

    logger('[stage] npm ci (production deps, locked)...');
    installDependencies(gatewayDir);
    logger('[stage] node_modules installed');
    pruneNativeBinaries(tempStage, logger);

    const sizeMb = directorySize(tempStage) / 1024 / 1024;
    publishStage(tempStage, stage, logger);
    logger(`[stage] staged resources: ${sizeMb.toFixed(1)} MB`);
    return { stage, runtimeJavaScriptFiles: runtimeFiles.javascriptFiles };
  } catch (error) {
    fs.rmSync(tempStage, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  await withDesktopBuildLock({ workspaceRoot: ROOT }, () => stageResources());
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(`[stage] FAIL ${error.message}`);
    process.exitCode = 1;
  });
}

export = {
  buildGatewayPackage,
  copyDir,
  isRuntimeServiceFile,
  publishStage,
  resolveNpmInvocation,
  stageResources,
};
