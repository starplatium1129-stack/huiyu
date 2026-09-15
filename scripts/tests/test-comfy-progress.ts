'use strict';

var assert: typeof import('assert') = require('assert');
var test: typeof import('node:test') = require('node:test');
var progress: typeof import('../../server/comfy-progress') = require('../../server/comfy-progress');

class FakeSocket {
    handlers!: any;
  url!: any;
static instances = [];
  constructor(url: any) {
    this.url = url;
    this.handlers = {};
    FakeSocket.instances.push(this);
  }
  on(name: string|number, handler: any) { this.handlers[name] = handler; }
  emit(name: string, value?: any) { if (this.handlers[name]) this.handlers[name](value); }
  close() { this.emit('close'); }
}

test('ComfyUI progress monitor filters by prompt id and maps sampling steps', () => {
  FakeSocket.instances = [];
  const a = { status: 'running', progress: null, currentNode: null };
  const b = { status: 'running', progress: null, currentNode: null };
  const monitor = progress.createComfyProgressMonitor({ COMFY_HOST: 'http://127.0.0.1:8188' }, 'client-1', { WebSocket: FakeSocket });
  const socket: any = FakeSocket.instances[0];
  monitor.watch('prompt-a', a);
  monitor.watch('prompt-b', b);

  socket.emit('message', JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-b', value: 4, max: 20, node: '7' } }));
  assert.strictEqual(a.progress, null);
  assert.strictEqual(b.progress, 0.2);
  assert.strictEqual(b.currentNode, '7');
  assert.match(b.progressText, /4 \/ 20/);

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'executing', data: { prompt_id: 'prompt-a', node: '4' } })));
  assert.strictEqual(a.currentNode, '4');
  assert.strictEqual(b.currentNode, '7');
  monitor.close();
});

test('progress monitor ignores malformed and unrelated events and closes cleanly', () => {
  FakeSocket.instances = [];
  const job = { status: 'running', progress: null };
  const monitor = progress.createComfyProgressMonitor({ COMFY_HOST: 'http://127.0.0.1:8188' }, 'client-2', { WebSocket: FakeSocket });
  const socket: any = FakeSocket.instances[0];
  monitor.watch('prompt-a', job);
  socket.emit('message', 'not-json');
  socket.emit('message', JSON.stringify({ type: 'progress', data: { prompt_id: 'other', value: 9, max: 10 } }));
  assert.strictEqual(job.progress, null);
  monitor.close();
  assert.strictEqual(FakeSocket.instances.length, 1);
});

test('progress helpers reject invalid values and build the native websocket URL', () => {
  assert.strictEqual(progress.clampProgress(1, 0), null);
  assert.strictEqual(progress.clampProgress(4, 8), 0.5);
  assert.strictEqual(progress.clampProgress(99, 8), 1);
  assert.strictEqual(progress.websocketUrl('https://example.test:8188/', 'aics-1'), 'wss://example.test:8188/ws?clientId=aics-1');
});
