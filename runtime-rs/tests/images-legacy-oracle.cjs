// Read only the existing pure TypeScript validators/catalog/workflow. No service,
// gateway, runtime configuration, model directory or model process is loaded.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const cache = new Map();
function load(relative) {
  const filename = path.resolve(root, relative.endsWith('.ts') ? relative : relative + '.ts');
  if (!filename.startsWith(root + path.sep)) throw new Error('Oracle import escaped repository');
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = name => {
    if (name === 'crypto' || name === 'node:crypto') return require('node:crypto');
    if (name === 'path' || name === 'node:path') return require('node:path');
    if (name.endsWith('/security')) return { isDirectLocalRequest: request => request?.local === true, adultRemoteEnabled: () => false };
    if (!name.startsWith('.')) throw new Error('Unsupported oracle dependency: ' + name);
    return load(path.relative(root, path.resolve(path.dirname(filename), name)));
  };
  vm.runInNewContext(source, { module, exports: module.exports, require: localRequire, console, Buffer }, { filename });
  return module.exports;
}
const catalog = load('server/anima-model-catalog');
const contract = load('server/anima-generation-contract');
if (process.argv.includes('--catalog')) {
  process.stdout.write(JSON.stringify({ ...catalog, contract }, null, 2));
} else {
  const { validateInput } = load('routes/anima/validation');
  const { buildWorkflow } = load('routes/anima/workflows');
  const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify({ catalog: { ...catalog, contract }, cases: cases.map(test => {
    try {
      const input = validateInput({ local: test.local !== false, socket: {}, headers: {} }, test.input, test.family);
      if (test.superResModel) input.superResModel = test.superResModel;
      return { input, workflow: buildWorkflow(input) };
    } catch (error) { return { code: error.code, status: error.status }; }
  }) }));
}
