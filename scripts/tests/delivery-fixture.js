'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { capture } = require('../lib/delivery-handoff');
const { EVIDENCE_DIR, saveJson, sha256 } = require('../lib/delivery-paths');
const { report } = require('../maintenance/audit-delivery');

function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aics-delivery-tracking-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t, gitEnabled = true) {
  const root = temp(t);
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  write('src/main.js', 'module.exports = 1;\n'); write('src/remove.js', 'module.exports = 2;\n');
  write('dist/index.html', '<html>fixture</html>'); write('.gitignore', '/runtime/\n/src/ignored*\n');
  if (gitEnabled) {
    git('init', '--template='); git('add', '--', 'src/main.js', 'src/remove.js', 'dist/index.html', '.gitignore');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'isolated fixture');
  }
  const initial = { scope: 'isolated fixture only', source: [{ path: 'src', kind: 'tree' }], build: [{ path: 'dist', kind: 'tree' }],
    gates: { 'checks.source': ['source'], 'checks.bundle': ['build'], 'checks.office': ['source', 'build'] } };
  const baselinePath = `${EVIDENCE_DIR}/baseline.json`, officePath = `${EVIDENCE_DIR}/office.json`, resultPath = `${EVIDENCE_DIR}/results.json`;
  function office(extra = {}) {
    const baseline = capture(root, { ...initial, ...extra }); saveJson(root, baselinePath, baseline);
    const checks = {};
    for (const key of ['source', 'bundle', 'office']) {
      const log = `${EVIDENCE_DIR}/${key}.log`; write(log, 'isolated fixture result; no real gate or device was run');
      checks[key] = { status: 'passed', report: log };
    }
    write(resultPath, { schemaVersion: 1, baselineSha256: sha256(fs.readFileSync(path.join(root, baselinePath))), checks });
    const document = capture(root, { baseline: baselinePath, record: resultPath }); saveJson(root, officePath, document);
    return document;
  }
  return { root, write, git, initial, baselinePath, officePath, resultPath, office,
    audit: (evidence = officePath, extra = {}) => report({ root, evidence, require: [], builds: [], ...extra }) };
}
function tree(root) {
  const output = {};
  function visit(dir) {
    for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
      const rel = dir ? `${dir}/${name}` : name, full = path.join(root, rel), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) output[rel] = `link:${fs.readlinkSync(full)}`;
      else if (stat.isDirectory()) { output[rel] = 'directory'; visit(rel); }
      else output[rel] = sha256(fs.readFileSync(full));
    }
  }
  visit(''); return output;
}
module.exports = { fixture, temp, tree, EVIDENCE_DIR };
