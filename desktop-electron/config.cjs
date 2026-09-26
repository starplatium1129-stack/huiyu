'use strict';
const fs = require('node:fs');
const path = require('node:path');

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function resolved(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('PoC paths must be absolute');
  let ancestor = path.resolve(file);
  const missing = [];
  while (!fs.existsSync(ancestor)) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(fs.realpathSync(ancestor), ...missing);
}
function loadConfig(argv) {
  const index = argv.indexOf('--config');
  if (index < 0 || !argv[index + 1]) throw Error('usage: electron desktop-electron/main.cjs --config <isolated JSON>');
  const input = JSON.parse(fs.readFileSync(argv[index + 1], 'utf8'));
  const config = { ...input, pocRoot: resolved(input.pocRoot) };
  if (config.pocRoot === path.parse(config.pocRoot).root) throw Error('PoC root cannot be a drive root');
  const marker = path.join(config.pocRoot, '.huiyu-electron-poc');
  if (fs.existsSync(config.pocRoot) && fs.readdirSync(config.pocRoot).length && !fs.existsSync(marker)) {
    throw Error('PoC root must be new/empty or carry its own .huiyu-electron-poc marker');
  }
  for (const field of ['userData', 'configRoot', 'aiRoot']) {
    config[field] = resolved(input[field]);
    if (!within(config.pocRoot, config[field])) throw Error(`${field} must stay inside independent pocRoot`);
  }
  const writable = [config.userData, config.configRoot, config.aiRoot];
  for (let i = 0; i < writable.length; i++) for (let j = i + 1; j < writable.length; j++) {
    if (writable[i].toLowerCase() === writable[j].toLowerCase() || within(writable[i], writable[j]) || within(writable[j], writable[i])) throw Error('PoC writable roots must be separate');
  }
  for (const field of ['webRoot', 'gatewayRoot', 'nodeExe', 'nativeExe', 'assetsRoot']) {
    config[field] = fs.realpathSync(resolved(input[field]));
    if (within(config.pocRoot, config[field])) throw Error(`${field} must be an existing read-only build/resource input outside pocRoot`);
  }
  if (!Number.isInteger(config.gatewayPort) || config.gatewayPort < 1024 || config.gatewayPort > 65535) throw Error('Invalid gatewayPort');
  if (config.debugPort !== undefined && (!Number.isInteger(config.debugPort) || config.debugPort < 1024 || config.debugPort > 65535 || config.debugPort === config.gatewayPort)) throw Error('Invalid debugPort');
  if (config.runtimeStartDelayMs !== undefined && (!Number.isInteger(config.runtimeStartDelayMs) || config.runtimeStartDelayMs < 0 || config.runtimeStartDelayMs > 60_000)) throw Error('Invalid runtimeStartDelayMs');
  fs.mkdirSync(config.pocRoot, { recursive: true });
  fs.writeFileSync(marker, 'Independent Electron comparison data only.\n', { flag: 'a' });
  for (const dir of writable) fs.mkdirSync(dir, { recursive: true });
  return Object.freeze(config);
}
module.exports = { loadConfig, within };
