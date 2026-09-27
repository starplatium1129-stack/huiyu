// Test-only original TypeScript execution. Data IO is an in-memory fixture;
// only source modules are read from this repository, with no real data access.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let scenes = input.scenes;
const errors = [];
const cache = new Map();
const fixtureFs = { readFileSync(file) {
  if (path.basename(file) === 'manual-scene-ratings.js') return fs.readFileSync(path.join(root, 'scripts/lib/manual-scene-ratings.js'), 'utf8');
  const key = path.basename(file);
  if (!Object.hasOwn(input.files, key)) throw new Error('Missing fixture: ' + key);
  return JSON.stringify(input.files[key]);
}};
const store = { loadSceneShards: () => ({ scenes: structuredClone(scenes) }), writeAggregate: next => { scenes = next; } };
const processFixture = { argv: ['node', 'fixture', '--write'], env: { AICS_DATA_ROOT: '/fixture' }, exit() { throw 'EXIT'; } };
function load(relative) {
  let file = path.resolve(root, relative.replace(/\.(?:js|ts)$/, '') + '.ts');
  if (!fs.existsSync(file)) file = file.replace(/\.ts$/, '.js');
  if (!['scripts/lib/', 'scripts/maintenance/', 'src/utils/'].some(prefix => file.startsWith(path.resolve(root, prefix) + path.sep))) throw new Error('Import outside source closure: ' + file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = name => {
    if (['fs', 'node:fs'].includes(name)) return fixtureFs;
    if (['path', 'node:path'].includes(name)) return path;
    if (name.endsWith('/scene-store')) return store;
    if (name.endsWith('/scene-write')) return { applySceneChanges() {}, readRetiredSceneIds() { return new Set(); } };
    if (!name.startsWith('.')) throw new Error('Unsupported source dependency: ' + name);
    return load(path.relative(root, path.resolve(path.dirname(file), name)));
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, process: processFixture, __dirname: path.dirname(file), console: { log() {}, error: text => errors.push(String(text)) }, structuredClone, Buffer, URL }, { filename: file });
  return module.exports;
}
const { renderedScene } = load('scripts/lib/scene-render-contract');
const policy = load('scripts/lib/prompt-policy');
const effective = scenes.map(renderedScene);
const rating = scenes.map(policy.ratingFor);
load('scripts/maintenance/classify-scene-ratings').main(['--write']);
const classified = structuredClone(scenes);
load('scripts/maintenance/optimize-scenes');
const optimized = structuredClone(scenes);
const optimizerErrors = errors.splice(0);
scenes = input.scenes;
try { load('scripts/maintenance/validate-scenes'); } catch (error) { if (error !== 'EXIT') throw error; }
process.stdout.write(JSON.stringify({ effective, rating, classified, optimized, optimizerErrors, validation: errors.filter(text => text.startsWith('  - ')).map(text => text.slice(4)) }));
