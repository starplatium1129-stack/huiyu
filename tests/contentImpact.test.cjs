const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { collectGitChanges, collectGitHistory } = require('../scripts/maintenance/content-impact-git.js')

const root = path.resolve(__dirname, '..')
const fixtureRoot = path.join(root, 'runtime', 'audit-fixtures')

function fixture(t) {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(fixtureRoot, 'content-impact-'))
  t.after(() => {
    const relative = path.relative(fixtureRoot, fs.realpathSync(directory))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function git(directory, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
    cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
}

function repository(t) {
  const directory = fixture(t)
  git(directory, 'init', '--quiet')
  fs.writeFileSync(path.join(directory, '.gitattributes'), 'subject.txt filter=audit\n')
  fs.writeFileSync(path.join(directory, 'subject.txt'), 'before\n')
  git(directory, 'add', '--', '.gitattributes', 'subject.txt')
  git(directory, '-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', '-c', 'core.hooksPath=disabled-hooks',
    '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'audit fixture')
  fs.writeFileSync(path.join(directory, 'subject.txt'), 'after, a different length\n')
  return directory
}

for (const collector of [
  { name: 'working-tree', collect: collectGitChanges, status: 'collected' },
  { name: 'historical', collect: directory => collectGitHistory(directory, 'HEAD').result, status: 'compared' },
]) {
  for (const filter of ['clean', 'process']) {
    test(`${collector.name} impact collection does not run ${filter} filters`, t => {
      const directory = repository(t)
      fs.writeFileSync(path.join(directory, 'filter.cjs'),
        "require('node:fs').writeFileSync('filter-ran', 'yes'); process.stdin.pipe(process.stdout)\n")
      git(directory, 'config', '--local', `filter.audit.${filter}`, 'node filter.cjs')
      git(directory, 'config', '--local', 'filter.audit.required', 'true')
      const result = collector.collect(directory)
      assert.equal(result.status, collector.status, result.reason)
      assert.ok(result.paths.includes('subject.txt'))
      assert.equal(fs.existsSync(path.join(directory, 'filter-ran')), false)
    })
  }

  test(`${collector.name} impact collection does not run fsmonitor hooks`, t => {
    const directory = repository(t)
    fs.writeFileSync(path.join(directory, 'monitor.cjs'),
      "require('node:fs').writeFileSync('monitor-ran', 'yes'); process.stdout.write('audit-token\\0')\n")
    git(directory, 'config', '--local', 'core.fsmonitor', 'node monitor.cjs')
    const result = collector.collect(directory)
    assert.equal(result.status, collector.status, result.reason)
    assert.ok(result.paths.includes('subject.txt'))
    assert.equal(fs.existsSync(path.join(directory, 'monitor-ran')), false)
  })
}

test('working-tree impact collection includes staged, unstaged and untracked paths', t => {
  const directory = repository(t)
  fs.writeFileSync(path.join(directory, 'staged.txt'), 'staged\n')
  git(directory, 'add', '--', 'staged.txt')
  fs.writeFileSync(path.join(directory, 'untracked.txt'), 'untracked\n')
  const result = collectGitChanges(directory)
  assert.equal(result.status, 'collected', result.reason)
  assert.deepEqual(result.paths.sort(), ['staged.txt', 'subject.txt', 'untracked.txt'])
})

test('working-tree impact collection refuses repositories without HEAD', t => {
  const directory = fixture(t)
  git(directory, 'init', '--quiet')
  const result = collectGitChanges(directory)
  assert.equal(result.status, 'error')
  assert.deepEqual(result.paths, [])
})

test('workflow source changes require workflow revalidation', t => {
  const directory = fixture(t)
  for (const [domain, key, aggregate, version] of [
    ['popular', 'characters', 'popular-characters.json', 1],
    ['blueprints', 'blueprints', 'scene-blueprints.json', 2],
  ]) {
    const target = path.join(directory, 'data', domain)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ files: [{ file: 'empty.json', count: 0 }] }))
    fs.writeFileSync(path.join(target, 'empty.json'), JSON.stringify({ [key]: [] }))
    fs.writeFileSync(path.join(directory, 'data', aggregate), JSON.stringify({ version, [key]: [] }))
  }
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/maintenance/report-content-impact.js'),
    '--root', directory, '--path', 'scripts/workflow.ts', '--json'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  const output = JSON.parse(result.stdout)
  assert.ok(output.revalidate.some(item => item.domain === 'workflow' && item.object === 'scripts/workflow.ts'))
  assert.ok(output.recommendations.some(item => item.name === 'data:validate' && item.executed === false))
})
