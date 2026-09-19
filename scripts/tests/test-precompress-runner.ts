import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import zlib = require('node:zlib');
import { test } from 'node:test';
import precompress = require('../maintenance/precompress');
const { compress, compressAsync, main } = precompress;

test('async precompression preserves exact Brotli 11/gzip 9 bytes and rejects stale/corrupt artifacts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-precompress-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.mkdirSync(path.join(root, 'data'));
    const file = path.join(root, 'data', 'fixture.json');
    const raw = Buffer.from(JSON.stringify({ text: 'neutral compression fixture '.repeat(2000) }));
    fs.writeFileSync(file, raw);
    const expected = compress(file);
    const br = fs.readFileSync(file + '.br'), gz = fs.readFileSync(file + '.gz');
    assert.deepEqual(await compressAsync(file), expected);
    assert.deepEqual(fs.readFileSync(file + '.br'), br);
    assert.deepEqual(fs.readFileSync(file + '.gz'), gz);
    assert.deepEqual(zlib.brotliDecompressSync(br), raw);
    assert.equal(await main(root, ['--check']), 0);
    fs.writeFileSync(file + '.br', 'corrupt');
    assert.equal(await main(root, ['--check']), 1);
    assert.equal(fs.readFileSync(file + '.br', 'utf8'), 'corrupt', '--check never repairs');
    fs.writeFileSync(file + '.gz', zlib.gzipSync('stale'));
    const orphan = path.join(root, 'data', 'orphan.json.br');
    fs.writeFileSync(orphan, 'orphan');
    const font = path.join(root, 'dist', 'font.woff');
    fs.writeFileSync(font, 'redundant');
    fs.writeFileSync(path.join(root, 'dist', 'font.woff2'), 'preserved');
    fs.writeFileSync(path.join(root, 'dist', 'fonts.css'), 'src:url(font.woff2) format("woff2"),url(font.woff) format("woff")');
    assert.equal(await main(root, []), 0);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(font), false);
    assert.ok(fs.existsSync(path.join(root, 'dist', 'font.woff2')));
    assert.equal(await main(root, ['--check']), 0);
    assert.deepEqual(fs.readFileSync(file + '.br'), br);
    assert.deepEqual(fs.readFileSync(file + '.gz'), gz);
    await assert.rejects(() => compressAsync(path.join(root, 'missing')), /ENOENT/);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
