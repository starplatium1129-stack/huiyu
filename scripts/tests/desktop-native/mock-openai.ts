import { errorMessage as runtimeErrorMessage } from '../../lib/runtime-errors';
'use strict'

const http: typeof import('node:http') = require('node:http')
const { freePort }: typeof import('./webdriver') = require('./webdriver')

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}

function responseFor(messages) {
  const latest = [...(Array.isArray(messages) ? messages : [])].reverse()
    .find(message => message?.role === 'user')
  const text = typeof latest?.content === 'string' ? latest.content : ''
  if (text.includes('d10-no-voice-happy')) {
    return '[mood=happy]今天也能见到你，我真的很开心。'
  }
  if (text.includes('d10-tts-happy')) {
    return '[mood=happy]（开心）今天也辛苦了，能陪着你我很高兴。'
  }
  if (text.includes('d10-tts-neutral')) {
    return '[mood=neutral]今天也辛苦了，要不要在这里稍微休息一下？'
  }
  return '[mood=neutral]我在这里，慢慢说就好。'
}

async function startMockOpenAi() {
  const port = await freePort()
  const requests = []
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'd10-deterministic' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    try {
      const body = await readBody(request)
      const content = responseFor(body.messages)
      requests.push({ at: new Date().toISOString(), body, content })
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      const chunks = [content.slice(0, 12), content.slice(12)]
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      await new Promise(resolve => setTimeout(resolve, 1_200))
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: runtimeErrorMessage(error) }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

export = { startMockOpenAi }
