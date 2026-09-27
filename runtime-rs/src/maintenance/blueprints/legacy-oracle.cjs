// Only pure Node planners run here. This process never loads a data store or
// consults the production data root, environment configuration or model service.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative.endsWith('.ts') ? relative : relative + '.ts');
  if (!file.startsWith(path.join(root, 'scripts/lib') + path.sep)) throw new Error('Pure oracle import escaped scripts/lib');
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = name => {
    if (name === './runtime-errors') return { errorMessage: error => error?.message || String(error) };
    if (!name.startsWith('.')) throw new Error('Unsupported pure oracle dependency: ' + name);
    return load(path.relative(root, path.resolve(path.dirname(file), name)));
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, structuredClone, console }, { filename: file });
  return module.exports;
}
const { planBlueprintChanges } = load('scripts/lib/blueprint-change-plan');
const { resolveSceneChangeSet } = load('scripts/lib/scene-change-set');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({ plans: input.plans.map(plan => {
  try { return { plan: planBlueprintChanges(plan) }; }
  catch (error) { return { problems: error.problems }; }
}), delta: resolveSceneChangeSet({ scenes: [{ id: 'sc001' }], blueprints: input.current }, { version: 1, scenes: { upsert: [], remove: [] }, blueprints: input.change }).blueprints }));
