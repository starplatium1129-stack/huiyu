'use strict';


/**
 * 维护工具实际依赖的 ZIP 解压边界；运行时鉴权由 Rust security/remote_content 行为测试负责。
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

for (const method of ['all', 'async', 'entry']) {
  test('archive dependency: normal extraction and destination link rejection (' + method + ')', async (t) => {
    const fs: typeof import('node:fs') = require('node:fs');
    const os: typeof import('node:os') = require('node:os');
    const path: typeof import('node:path') = require('node:path');
    const AdmZip: typeof import('adm-zip') = require('adm-zip');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-zip-regression-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const zip = new AdmZip();
    zip.addFile('linked/fixture.txt', Buffer.from('archive fixture'));
    const extract = async (target: string) => {
      if (method === 'async') await new Promise<void>((resolve, reject) => zip.extractAllToAsync(target, true, false, error => error ? reject(error) : resolve()));
      else if (method === 'entry') zip.extractEntryTo('linked/fixture.txt', target, true, true);
      else zip.extractAllTo(target, true);
    };
    const normal = path.join(root, 'normal');
    await extract(normal);
    assert.equal(fs.readFileSync(path.join(normal, 'linked/fixture.txt'), 'utf8'), 'archive fixture');
    const target = path.join(root, 'destination');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(target); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'fixture.txt'), 'unchanged sentinel');
    fs.symlinkSync(outside, path.join(target, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(extract(target), /ADM-ZIP: (?:There is a file in the way|Unable to create folder)/);
    assert.equal(fs.readFileSync(path.join(outside, 'fixture.txt'), 'utf8'), 'unchanged sentinel');
  });
}
