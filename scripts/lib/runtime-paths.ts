const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

function ensureDirectory(directory: string) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

function createRuntimePaths(projectRoot: string, configuredRoot?: string) {
  const root = configuredRoot ? path.resolve(configuredRoot) : path.join(projectRoot, 'runtime');
  const state = path.join(root, 'state');
  const logs = path.join(root, 'logs');
  const outputs = path.join(root, 'outputs');
  [root, state, logs, outputs].forEach(ensureDirectory);
  return {
    root,
    state,
    logs,
    outputs,
    config: path.join(root, 'config.json'),
    gatewayToken: path.join(state, 'gateway_token'),
    gatewayPid: path.join(state, 'gateway_pid'),
    gatewayPort: path.join(state, 'gateway_port'),
    tunnelPid: path.join(state, 'tunnel_pid'),
    tunnelLog: path.join(logs, 'tunnel.log'),
    gatewayLog: path.join(logs, 'gateway.log'),
    controlLog: path.join(logs, 'control.log')
  };
}

function availableTarget(target: string) {
  if (!fs.existsSync(target)) return target;
  const parsed = path.parse(target);
  return path.join(parsed.dir, parsed.name + '.legacy-' + Date.now() + parsed.ext);
}

function moveLegacyFile(source: string, target: string) {
  if (!fs.existsSync(source)) return;
  const destination = availableTarget(target);
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    try {
      fs.copyFileSync(source, destination);
      fs.unlinkSync(source);
    } catch (copyError) {
      console.warn('Unable to migrate runtime file:', path.basename(source), copyError instanceof Error ? copyError.message : String(copyError));
    }
  }
}

function moveLegacyOutputs(source: string, destination: string) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return;
  ensureDirectory(destination);
  for (const name of fs.readdirSync(source)) {
    const item = path.join(source, name);
    if (!fs.statSync(item).isFile()) continue;
    moveLegacyFile(item, path.join(destination, name));
  }
  try {
    if (fs.readdirSync(source).length === 0) fs.rmdirSync(source);
  } catch (error) {}
}

function migrateLegacyRuntime(projectRoot: string, paths: ReturnType<typeof createRuntimePaths>) {
  const fileMap = [
    ['.gateway_config.json', paths.config],
    ['.gateway_token', paths.gatewayToken],
    ['.gateway_pid', paths.gatewayPid],
    ['.gateway_port', paths.gatewayPort],
    ['.tunnel_pid', paths.tunnelPid],
    ['tunnel.log', paths.tunnelLog]
  ];
  fileMap.forEach(([legacyName, target]) => moveLegacyFile(path.join(projectRoot, legacyName), target));
  moveLegacyOutputs(path.join(projectRoot, 'friend_outputs'), paths.outputs);
}

function rotateLog(file: string, maxBytes: number) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= maxBytes) return;
    const parsed = path.parse(file);
    const previous = path.join(parsed.dir, parsed.name + '.previous' + parsed.ext);
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    fs.renameSync(file, previous);
  } catch (error) {
    console.warn('Unable to rotate log:', path.basename(file), error instanceof Error ? error.message : String(error));
  }
}

export = { createRuntimePaths, migrateLegacyRuntime, rotateLog };
