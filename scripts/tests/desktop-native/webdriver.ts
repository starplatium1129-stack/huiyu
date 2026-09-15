import { errorMessage as runtimeErrorMessage } from '../../lib/runtime-errors';
'use strict'

const fs: typeof import('node:fs') = require('node:fs')
const http: typeof import('node:http') = require('node:http')
const net: typeof import('node:net') = require('node:net')
const path: typeof import('node:path') = require('node:path')
const { spawn }: typeof import('node:child_process') = require('node:child_process')
const { terminateTree }: typeof import('./command') = require('./command')

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

function delay(ms: any) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function requestJson(port: any, method: any, pathname: any, body: any, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body))
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, response => {
      const chunks: any = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch {}
        if ((response.statusCode || 0) >= 400) {
          const message = parsed?.value?.message || parsed?.message || text || `HTTP ${response.statusCode}`
          const error = new Error(`WebDriver ${method} ${pathname}: ${message}`)
          error.statusCode = response.statusCode
          error.response = parsed || text
          reject(error)
          return
        }
        resolve(parsed)
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`WebDriver request timed out: ${method} ${pathname}`)))
    request.on('error', reject)
    request.end(payload || undefined)
  })
}

class WebDriverSession {
  constructor(options: any) {
    this.port = options.port
    this.sessionId = options.sessionId
    this.capabilities = options.capabilities || {}
  }

  endpoint(suffix = '') {
    return `/session/${encodeURIComponent(this.sessionId)}${suffix}`
  }

  async command(method: any, suffix: any, body?: any, timeoutMs?: any) {
    const response = await requestJson(this.port, method, this.endpoint(suffix), body, timeoutMs)
    return response?.value
  }

  execute(script: any, args = []) {
    return this.command('POST', '/execute/sync', { script, args })
  }

  async executeAsync(body: any, args = [], timeoutMs = 30_000) {
    await this.command('POST', '/timeouts', { script: timeoutMs })
    const script = `
const done = arguments[arguments.length - 1]
Promise.resolve().then(async () => {
${body}
}).then(value => done({ ok: true, value }), error => done({ ok: false, error: String(error && (error.stack || error.message) || error) }))
`
    const result = await this.command('POST', '/execute/async', { script, args }, timeoutMs + 5_000)
    if (!result?.ok) throw new Error(result?.error || 'WebDriver async script failed')
    return result.value
  }

  invoke(command: any, payload = {}, timeoutMs = 30_000) {
    return this.executeAsync(`
const command = arguments[0]
const payload = arguments[1]
if (!window.__TAURI__?.core?.invoke) throw new Error('Tauri invoke bridge is unavailable')
return await window.__TAURI__.core.invoke(command, payload)
`, [command, payload], timeoutMs)
  }

  async find(selector: any) {
    const value = await this.command('POST', '/element', { using: 'css selector', value: selector })
    const id = value?.[ELEMENT_KEY]
    if (!id) throw new Error(`WebDriver element did not return an id: ${selector}`)
    return id
  }

  async click(selector: any) {
    const id = await this.find(selector)
    await this.command('POST', `/element/${encodeURIComponent(id)}/click`, {})
  }

  async fill(selector: any, text: any) {
    const id = await this.find(selector)
    await this.command('POST', `/element/${encodeURIComponent(id)}/clear`, {})
    await this.command('POST', `/element/${encodeURIComponent(id)}/value`, { text: String(text), value: [...String(text)] })
  }

  async screenshot(filePath: any) {
    const value = await this.command('GET', '/screenshot')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(String(value || ''), 'base64'))
    return filePath
  }

  async waitFor(description: any, predicateBody: any, args = [], options = {}) {
    const timeoutMs = options.timeoutMs || 30_000
    const intervalMs = options.intervalMs || 100
    const started = Date.now()
    let last = null
    while (Date.now() - started < timeoutMs) {
      try {
        last = await this.execute(`return (() => { ${predicateBody} })()`, args)
        if (last) return { elapsedMs: Date.now() - started, value: last }
      } catch (error) {
        last = runtimeErrorMessage(error)
      }
      await delay(intervalMs)
    }
    throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms; last=${JSON.stringify(last)}`)
  }

  async close() {
    try { await this.command('DELETE', '', null, 15_000) } catch {}
  }
}

class TauriDriver {
  constructor(options: any) {
    this.executable = options.executable
    this.nativeDriver = options.nativeDriver
    this.environment = options.environment
    this.evidence = options.evidence
    this.process = null
    this.port = 0
    this.nativePort = 0
    this.closed = false
  }

  async start() {
    this.port = await freePort()
    this.nativePort = await freePort()
    const args = [
      '--port', String(this.port),
      '--native-port', String(this.nativePort),
      '--native-driver', this.nativeDriver,
    ]
    this.evidence?.commandStart(`${this.executable} ${args.join(' ')}`)
    const started = Date.now()
    this.process = spawn(this.executable, args, {
      env: this.environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.process.stdout.on('data', (chunk: any) => this.evidence?.commandOutput('tauri-driver', String(chunk)))
    this.process.stderr.on('data', (chunk: any) => this.evidence?.commandOutput('tauri-driver', String(chunk)))
    this.process.on('error', (error: any) => this.evidence?.commandOutput('tauri-driver-error', error.message))
    const deadline = Date.now() + 20_000
    let lastError = ''
    while (Date.now() < deadline) {
      if (this.process.exitCode != null) throw new Error(`tauri-driver exited early with code ${this.process.exitCode}`)
      try {
        await requestJson(this.port, 'GET', '/status', null, 2_000)
        this.evidence?.commandEnd(`${this.executable} ${args.join(' ')}`, 0, Date.now() - started)
        return
      } catch (error) {
        lastError = runtimeErrorMessage(error)
        await delay(150)
      }
    }
    this.close()
    throw new Error(`tauri-driver did not become ready: ${lastError}`)
  }

  async createSession(options: any) {
    const tauriOptions = {
      application: options.application,
      args: options.args || [],
      webviewOptions: {
        userDataFolder: options.userDataFolder,
        additionalBrowserArguments: ['--autoplay-policy=no-user-gesture-required'],
      },
    }
    const response = await requestJson(this.port, 'POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'wry',
          'tauri:options': tauriOptions,
        },
        firstMatch: [{}],
      },
    }, options.timeoutMs || 90_000)
    const value = response?.value || {}
    const sessionId = value.sessionId || response?.sessionId
    if (!sessionId) throw new Error(`tauri-driver did not return a session id: ${JSON.stringify(response)}`)
    return new WebDriverSession({ port: this.port, sessionId, capabilities: value.capabilities })
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.process?.pid) terminateTree(this.process.pid)
    this.process = null
  }
}

export = {
  TauriDriver,
  WebDriverSession,
  delay,
  freePort,
  requestJson,
}
