import assert = require('node:assert/strict');
import { test, type TestContext } from 'node:test';
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import loggerModule = require('../../server/logger');
const { createLogger } = loggerModule;

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-logger-safety-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return { dir };
}
function captureTerminal(action: () => void): string[] {
  const stdout = process.stdout.write, stderr = process.stderr.write, output: string[] = [];
  const capture = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof stdout;
  process.stdout.write = capture; process.stderr.write = capture;
  try { action(); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  return output;
}
function day() {
  const d = new Date();
  return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
async function appends(action: () => void): Promise<number> {
  const original = fs.appendFile, pending: Promise<void>[] = [];
  fs.appendFile = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, options: fs.WriteFileOptions, callback: fs.NoParamCallback) => {
    pending.push(new Promise<void>((resolve, reject) => {
      original(file, data, options, cause => { callback(cause); if (cause) reject(cause); else resolve(); });
    }));
  }) as typeof fs.appendFile;
  try { action(); } finally { fs.appendFile = original; }
  await Promise.all(pending);
  return pending.length;
}
function read(dir: string) { return fs.readFileSync(path.join(dir, `gateway-${day()}.log`), 'utf8'); }

test('redacts common credentials and prevents injected file/terminal log lines', async t => {
  const { dir } = fixture(t), logger = createLogger({ dir });
  let terminal: string[] = [];
  await appends(() => { terminal = captureTerminal(() => logger.error('GET /?token=querySecret&ok=1\r\n[INFO] forged ' +
    'Cookie: aics_token=cookieSecret; Authorization: Bearer bearerSecret ' +
    'https://user:password@example.test/a', new Error('Basic YmFzaWM6c2VjcmV0 /?api_key=detailSecret'))); });
  const content = read(dir), output = terminal.join('');
  for (const secret of ['querySecret', 'cookieSecret', 'bearerSecret', 'user:password', 'YmFzaWM6c2VjcmV0', 'detailSecret'])
    assert.ok(!content.includes(secret) && !output.includes(secret), secret);
  assert.ok(content.includes('[REDACTED]'));
  assert.equal(content.trimEnd().split('\n').length, 1);
  assert.ok(content.includes('\\r\\n[INFO] forged'));
});

test('reserves pending append bytes, even for a burst smaller than 500 writes', async t => {
  const { dir } = fixture(t), logger = createLogger({ dir, dailyBytesLimit:1024 });
  const count = await appends(() => { captureTerminal(() => { for (let i = 0; i < 100; i++) logger.info('中'.repeat(50)); }); });
  assert.ok(count > 0 && count < 100);
  assert.ok(Buffer.byteLength(read(dir)) <= 1024);
});

test('first write counts an existing daily file before appending', async t => {
  const { dir } = fixture(t);
  const file = path.join(dir, `gateway-${day()}.log`);
  fs.writeFileSync(file, 'x'.repeat(512));
  const logger = createLogger({ dir, dailyBytesLimit:512 });
  assert.equal(await appends(() => logger.info('do not append')), 0);
  assert.equal(fs.statSync(file).size, 512);
});

test('oversized individual messages and details are bounded; unprintable details are safe', async t => {
  const { dir } = fixture(t), logger = createLogger({ dir });
  await appends(() => { captureTerminal(() => {
    logger.error('x'.repeat(200000), 'y'.repeat(200000));
    logger.error('safe', { toString() { throw new Error('bad formatter'); } });
  }); });
  const content = read(dir);
  assert.ok(Buffer.byteLength(content) < 9000);
  assert.ok(content.includes('[unprintable detail]'));
});

test('repeated same-day rotations preserve earlier archives', t => {
  const { dir } = fixture(t);
  const earlier = path.join(dir, `control-${day()}.log`), current = path.join(dir, 'control.log');
  fs.writeFileSync(earlier, 'original archive'); fs.writeFileSync(current, 'b'.repeat(32));
  createLogger({ dir, maxBytes:8 });
  assert.equal(fs.readFileSync(earlier, 'utf8'), 'original archive');
  assert.equal(fs.readFileSync(path.join(dir, `control.1-${day()}.log`), 'utf8'), 'b'.repeat(32));
  assert.equal(fs.existsSync(current), false);
});

test('rotation failure does not truncate the live log', t => {
  const { dir } = fixture(t), file = path.join(dir, 'control.log');
  fs.writeFileSync(file, 'keep these bytes');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('busy'), { code:'EBUSY' }); });
  createLogger({ dir, maxBytes:4 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep these bytes');
});

test('malformed prefix cannot write outside the logging directory', async t => {
  const { dir } = fixture(t), logger = createLogger({ dir, prefix:'../escape' });
  await appends(() => logger.info('inside'));
  assert.deepEqual(fs.readdirSync(dir), [`gateway-${day()}.log`]);
});

test('log cleanup does not follow links or remove directories', { skip:process.platform === 'win32' }, t => {
  const { dir } = fixture(t), target = path.join(dir, 'important.txt');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, path.join(dir, 'old-20200101.log'));
  fs.mkdirSync(path.join(dir, 'folder-20200101.log'));
  createLogger({ dir, maxBytes:1 });
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.ok(fs.lstatSync(path.join(dir, 'old-20200101.log')).isSymbolicLink());
  assert.ok(fs.statSync(path.join(dir, 'folder-20200101.log')).isDirectory());
});

test('disabled debug stays silent and unavailable output sinks do not throw', async t => {
  const { dir } = fixture(t), previous = process.env.DEBUG;
  process.env.DEBUG = '0';
  let logger: ReturnType<typeof createLogger>;
  try { logger = createLogger({ dir, debug:false }); }
  finally { if (previous === undefined) delete process.env.DEBUG; else process.env.DEBUG = previous; }
  let terminal: string[] = [];
  assert.equal(await appends(() => { terminal = captureTerminal(() => logger.debug('hidden')); }), 0);
  assert.equal(terminal.length, 0);
  await appends(() => {
    const original = process.stdout.write;
    process.stdout.write = () => { throw new Error('closed pipe'); };
    try { assert.doesNotThrow(() => logger.info('still persisted')); }
    finally { process.stdout.write = original; }
  });
  assert.ok(read(dir).includes('still persisted'));
});
