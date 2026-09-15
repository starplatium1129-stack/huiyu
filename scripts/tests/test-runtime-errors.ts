import assert = require('node:assert/strict');
import { test } from 'node:test';
import { errorMessage, errorCode, errorStatus, errorStack, errorOutput } from '../lib/runtime-errors';

test('caught-value helpers preserve standard Error and process failure details', () => {
  const error = Object.assign(new Error('fixture failure'), {
    code: 'ENOENT', status: 503, statusCode: 504, stdout: 'output', stderr: Buffer.from('failure'),
  });
  assert.equal(errorMessage(error), 'fixture failure');
  assert.equal(errorCode(error), 'ENOENT');
  assert.equal(errorStatus(error), 503);
  assert.equal(errorStatus(error, 'statusCode'), 504);
  assert.equal(errorStack(error), error.stack);
  assert.equal(errorOutput(error, 'stdout'), 'output');
  assert.deepEqual(errorOutput(error, 'stderr'), Buffer.from('failure'));
});

test('plain fixture errors are supported and malformed fields never become trusted status or code values', () => {
  assert.equal(errorCode({ code: 'EACCES' }), 'EACCES');
  assert.equal(errorCode({ code: 7 }), 7);
  assert.equal(errorMessage({ message: 'plain failure' }), 'plain failure');
  assert.equal(errorMessage('thrown string'), 'thrown string');
  for (const value of [undefined, null, false, 3, 'error', { code: {}, status: '503', stack: 42, stdout: {} }]) {
    assert.equal(errorCode(value), undefined);
    assert.equal(errorStatus(value), undefined);
    assert.equal(errorStack(value), undefined);
    assert.equal(errorOutput(value, 'stdout'), undefined);
  }
  assert.equal(errorStatus({ status: NaN }), undefined);
  assert.equal(errorStatus({ status: Infinity }), undefined);
});
