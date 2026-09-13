'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateRun, PASSIVE_EFFECTS } = require('../lib/workflow-runner');

function reportConditions({ root = path.resolve(__dirname, '../..'), domain, registry = require('../workflow').WORKFLOWS } = {}) {
  const base = fs.realpathSync(root);
  const exists = (file) => {
    try {
      const target = fs.realpathSync(path.resolve(base, file.split('#')[0].replace(/:\d+$/, '')));
      const rel = path.relative(base, target);
      return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) && fs.statSync(target).isFile();
    } catch { return false; }
  };
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).scripts || {}; } catch { /* npm entries remain missing */ }
  const names = Object.keys(registry).filter(name => !domain || name.split(':')[0] === domain);
  if (!names.length) throw new Error('Unknown domain: ' + domain);
  function effects(name, parents = []) {
    if (parents.includes(name)) throw new Error('Composite cycle: ' + name);
    const def = registry[name];
    if (!def) throw new Error('Missing step: ' + name);
    return [...(Array.isArray(def.run?.nature) ? def.run.nature : []), ...(def.steps || []).flatMap(step => effects(step, [...parents, name]))];
  }
  const commands = names.map(name => {
    const def = registry[name] || {}, errors = validateRun(name, def);
    const cmd = Array.isArray(def.cmd) ? def.cmd : [];
    let entryExists = Boolean(def.builtin === 'audit' || Array.isArray(def.steps) && def.steps.length);
    if (cmd.length) {
      const files = cmd.filter(arg => typeof arg === 'string' && /^(scripts\/|deploy-desktop\.bat)/.test(arg));
      entryExists = cmd[0] === 'npm' ? typeof scripts[cmd[1] === 'run' ? cmd[2] : cmd[1]] === 'string' : files.length > 0 && files.every(exists);
    }
    if (!entryExists) errors.push('Missing entry');
    const docsExist = typeof def.docs === 'string' && exists(def.docs);
    if (!docsExist) errors.push('Missing documentation');
    let childEffects = [], missingEffects = [];
    try {
      childEffects = [...new Set((def.steps || []).flatMap(step => effects(step, [name])))];
      missingEffects = childEffects.filter(effect => !PASSIVE_EFFECTS.includes(effect) && !(Array.isArray(def.run?.nature) && def.run.nature.includes(effect)));
      if (missingEffects.length) errors.push('Composite omitted effects: ' + missingEffects.join(', '));
    } catch (error) { errors.push(error.message); }
    return { name, nature: def.run?.nature ?? null, machine: def.run?.machine ?? null, resume: def.run?.resume ?? null,
      evidence: def.run?.evidence ?? null, unknown: def.run?.unknown ?? ['未声明'], entry: cmd, entryExists, docs: def.docs ?? null, docsExist,
      composite: { steps: def.steps || [], childEffects, missingEffects }, errors, executionStatus: 'not-run' };
  });
  return { schemaVersion: 1, ok: commands.every(row => !row.errors.length), commands, executionStatus: 'not-run' };
}
function main(argv = process.argv.slice(2)) {
  const options = {}; let json = false, preview = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--help', '-h', '--plan'].includes(arg)) preview = true;
    else if (arg === '--json') json = true;
    else if (['--root', '--domain'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[arg.slice(2)] = argv[++i];
    else throw new Error('Invalid argument: ' + arg);
  }
  if (preview) { console.log('audit:workflow-conditions [--json] [--root <directory>] [--domain <workflow group>]：只读注册条件；不执行命令。'); return 0; }
  const result = reportConditions(options);
  console.log(json ? JSON.stringify(result, null, 2) : result.commands.map(row => `${row.name}: ${row.errors.length ? row.errors.join('; ') : 'metadata valid'}; not-run`).join('\n'));
  return result.ok ? 0 : 1;
}
module.exports = { reportConditions, main };
if (require.main === module) { try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
