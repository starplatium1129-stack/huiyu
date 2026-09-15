'use strict';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http: typeof import('node:http') = require('node:http');
const comfy: typeof import('../../server/comfy-client') = require('../../server/comfy-client');

test('orphan sweep recognizes native queue metadata and excludes this process new prompts', async () => {
  let submitted: { extra_data: { custom: unknown; }; };
  const cancelled: unknown = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/prompt') {
      submitted = JSON.parse(raw);
      res.end(JSON.stringify({ prompt_id: 'fresh' }));
    } else if (req.url === '/queue') {
      res.end(JSON.stringify({ queue_running: [[1, 'old', {}, { client_id: 'owner' }, []]], queue_pending: [
        [2, 'fresh', {}, { ...submitted.extra_data, client_id: 'owner' }, []],
        [3, 'other', {}, { client_id: 'other' }, []],
      ] }));
    } else {
      cancelled.push(req.url);
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { COMFY_HOST: `http://127.0.0.1:${server.address().port}` };
  try {
    const body = { prompt: {}, client_id: 'owner', extra_data: { custom: 'kept' } };
    await comfy.requestComfyJson(config, 'POST', '/prompt', body);
    assert.equal(submitted.extra_data.custom, 'kept');
    assert.equal(body.extra_data.aics_session_id, undefined, 'do not mutate caller payload');
    assert.deepEqual(await comfy.cancelOrphanPrompts(config, 'owner'), ['old']);
    assert.deepEqual(cancelled, ['/api/jobs/old/cancel']);
    assert.deepEqual(comfy.ownedPromptIds([null, [0, 'x', {}, null]], 'owner'), []);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('non-JSON cancellation response preserves HTTP status for fallback', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('Not Found'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(comfy.requestComfyJson({ COMFY_HOST: `http://127.0.0.1:${server.address().port}` }, 'POST', '/cancel'),
      error => error.detail.upstreamStatus === 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
