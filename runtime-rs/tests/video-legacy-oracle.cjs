// Pure legacy compiler oracle. All production filesystem/network access from
// loaded modules is disabled; dimensions come only from explicit fixture data.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const cache = new Map(); let current = {};
const forbiddenFs = new Proxy({}, { get: (_, key) => () => { throw new Error('Oracle forbids data IO: ' + key); } });
function load(relative) {
  const file = path.resolve(root, relative.endsWith('.ts') ? relative : relative + '.ts');
  if (!file.startsWith(root + path.sep)) throw new Error('Oracle import escaped root');
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  let code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  if (file.endsWith(path.join('video', 'storyboard.ts'))) code += '\nmodule.exports.BEAT_FRAMING=BEAT_FRAMING;module.exports.ADULT_CATEGORIES=ADULT_CATEGORIES;';
  const localRequire = name => {
    if (name === 'fs' || name === 'node:fs') return forbiddenFs;
    if (name === 'path' || name === 'node:path') return path;
    if (name === 'crypto' || name === 'node:crypto') return require('node:crypto');
    if (name.endsWith('/security') || name === './security') return { adultRemoteEnabled: () => false };
    if (!name.startsWith('.')) throw new Error('Unsupported oracle dependency: ' + name);
    return load(path.relative(root, path.resolve(path.dirname(file), name)));
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, Buffer, console, structuredClone }, { filename: file });
  return module.exports;
}
const constants = load('routes/video/constants'), prose = load('routes/video/prose'), storyboard = load('routes/video/storyboard');
function replacer(_, value) {
  if (Object.prototype.toString.call(value) === '[object RegExp]') return { source: value.source, flags: value.flags };
  if (Object.prototype.toString.call(value) === '[object Set]') return [...value];
  return value;
}
const catalog = { constants, prose, storyboard };
if (process.argv.includes('--catalog')) process.stdout.write(JSON.stringify(catalog, replacer, 2));
else {
  const media = load('routes/video/media');
  media.imageInputAvailable = (_, name) => current.allowImages === true || Object.hasOwn(current.imageSizes || {}, name);
  media.readImageSize = file => (current.imageSizes || {})[path.basename(file)] || null;
  const validation = load('routes/video/validation'), workflows = load('routes/video/workflows');
  const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify({ catalog, cases: cases.map(test => {
    current = test;
    try {
      if (test.blueprint) return { storyboard: storyboard.buildStoryboard(test.blueprint, test.options) };
      const config = test.allowImages || test.imageSizes ? { AI_WORKSPACE_ROOT: '/oracle-fixture' } : undefined;
      const input = test.batch ? validation.validateBatchInput(test.input, config, { isLocal: test.local !== false }) : validation.validateInput(test.input, config, { isLocal: test.local !== false });
      return { input, workflows: (test.batch ? input.shots.map(s => s.input) : [input]).map(input => workflows.buildWorkflow(input, { t8Available: test.t8 === true })) };
    } catch (error) { return { code: error.code, status: error.status }; }
  }) }, replacer));
}
