'use strict';

let assert: typeof import('assert') = require('assert');
let test: typeof import('node:test') = require('node:test');
let progress: typeof import('../../server/comfy-progress') = require('../../server/comfy-progress');

class FakeSocket {
  closed = false;
    handlers!: any;
  url!: any;
  static instances: any[] = [];
  constructor(url: any) {
    this.url = url;
    this.handlers = {};
    FakeSocket.instances.push(this);
  }
  on(name: string|number, handler: any) { this.handlers[name] = handler; }
  emit(name: string, value?: any) { if (this.handlers[name]) this.handlers[name](value); }
  close() { this.closed = true; this.emit('close'); }
}

test('ComfyUI progress monitor filters by prompt id and maps sampling steps', () => {
  FakeSocket.instances = [];
  const a: any = { status: 'running', progress: null, currentNode: null };
  const b: any = { status: 'running', progress: null, currentNode: null };
  const monitor = progress.createComfyProgressMonitor({ COMFY_HOST: 'http://127.0.0.1:8188' }, 'client-1', { WebSocket: FakeSocket });
  assert.strictEqual(FakeSocket.instances.length, 0, 'idle monitor must not connect');
  monitor.watch('prompt-a', a);
  monitor.watch('prompt-b', b);
  const socket: any = FakeSocket.instances[0];
  assert.strictEqual(FakeSocket.instances.length, 1, 'active jobs share one connection');

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

test('progress monitor reconnects only while work is subscribed and closes when idle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeSocket.instances = [];
  const job = { status: 'running', progress: null };
  const monitor = progress.createComfyProgressMonitor({ COMFY_HOST: 'http://127.0.0.1:8188' }, 'client-2', { WebSocket: FakeSocket });
  monitor.watch('prompt-a', job);
  const socket: any = FakeSocket.instances[0];
  socket.emit('message', 'not-json');
  socket.emit('message', JSON.stringify({ type: 'progress', data: { prompt_id: 'other', value: 9, max: 10 } }));
  assert.strictEqual(job.progress, null);
  socket.close();
  t.mock.timers.tick(2000);
  assert.strictEqual(FakeSocket.instances.length, 2, 'active subscription reconnects');
  monitor.unwatch('prompt-a');
  assert.strictEqual(FakeSocket.instances[1].closed, true);
  t.mock.timers.tick(4000);
  assert.strictEqual(FakeSocket.instances.length, 2, 'idle monitor must not reconnect');
  monitor.watch('prompt-b', job);
  assert.strictEqual(FakeSocket.instances.length, 3, 'new work connects on demand');
  monitor.close();
  assert.strictEqual(FakeSocket.instances[2].closed, true);
});

test('progress helpers reject invalid values and build the native websocket URL', () => {
  assert.strictEqual(progress.clampProgress(1, 0), null);
  assert.strictEqual(progress.clampProgress(4, 8), 0.5);
  assert.strictEqual(progress.clampProgress(99, 8), 1);
  assert.strictEqual(progress.websocketUrl('https://example.test:8188/', 'aics-1'), 'wss://example.test:8188/ws?clientId=aics-1');
});
