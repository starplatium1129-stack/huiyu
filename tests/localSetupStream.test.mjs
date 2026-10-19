import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readLocalSetupStream } from '../src/api/localSetupStream.ts'

const encoder = new TextEncoder()
const result = { type: 'result', state: 'downloaded', message: '完成' }
const progress = { type: 'progress', bytesRead: 1, expectedBytes: 2 }
const record = value => JSON.stringify(value) + '\n'

function response(chunks, hooks = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      if (!hooks.open) controller.close()
    },
    cancel() { hooks.cancelled = true },
  }), { headers: { 'content-type': 'application/x-ndjson' } })
}

function consume(event) { return event.type === 'result' ? event : undefined }
function read(stream, signal = new AbortController().signal, onEvent = consume) {
  return readLocalSetupStream(stream, signal, onEvent)
}

test('accepts coalesced progress records larger than 64 KiB in total', async () => {
  const events = 2_000
  let count = 0
  const chunk = record(progress).repeat(events) + record(result)
  assert.ok(chunk.length > 64 * 1024)
  assert.deepEqual(await read(response([chunk]), undefined, event => {
    if (event.type === 'progress') count++
    return consume(event)
  }), result)
  assert.equal(count, events)
})

test('accepts split UTF-8, CRLF and a final result without a newline', async () => {
  const bytes = encoder.encode(record(progress).replace('\n', '\r\n') + JSON.stringify(result))
  assert.deepEqual(await read(response(Array.from(bytes, byte => Uint8Array.of(byte)))), result)
})

test('accepts a record exactly at the 64 KiB limit', async () => {
  const event = { type: 'result', message: '' }
  event.message = 'x'.repeat(64 * 1024 - JSON.stringify(event).length)
  assert.deepEqual(await read(response([record(event)])), event)
})

test('rejects an oversized complete record', async () => {
  const oversized = record({ type: 'progress', message: 'x'.repeat(64 * 1024) })
  await assert.rejects(read(response([oversized + record(result)])), /模型操作响应过大/)
})

test('rejects an oversized record accumulated across reads', async () => {
  await assert.rejects(read(response([' '.repeat(32 * 1024), ' '.repeat(32 * 1024 + 1)])), /模型操作响应过大/)
})

test('requires a terminal result even after valid progress', async () => {
  await assert.rejects(read(response([record(progress)])), /未收到完整结果/)
})

test('preserves JSON parsing and consumer validation failures', async () => {
  await assert.rejects(read(response(['{broken}\n'])), SyntaxError)
  const failure = new Error('模型下载返回了不匹配的数据')
  await assert.rejects(read(response([record(progress)]), undefined, () => { throw failure }), error => error === failure)
})

test('stops after the terminal result and cancels an open stream', async () => {
  const hooks = { open: true, cancelled: false }
  const stream = response([record(result) + '{ignored}\n'], hooks)
  assert.deepEqual(await read(stream), result)
  assert.equal(hooks.cancelled, true)
  assert.equal(stream.body.locked, false)
})

test('aborting a pending read cancels and releases the reader', async () => {
  const hooks = { open: true, cancelled: false }
  const stream = response([], hooks), controller = new AbortController()
  const reading = read(stream, controller.signal)
  controller.abort()
  await assert.rejects(reading, error => error.name === 'AbortError')
  assert.equal(hooks.cancelled, true)
  assert.equal(stream.body.locked, false)
})

test('preserves HTTP and content type failures', async () => {
  await assert.rejects(read(new Response(JSON.stringify({ error: '下载失败' }), { status: 409 })), /下载失败/)
  await assert.rejects(read(new Response('{}')), /无效响应/)
})
