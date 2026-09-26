import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from '@playwright/test'

export async function port() {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = (server.address() as net.AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return value
}
export const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
export async function until<T>(work: () => T | Promise<T>, ready: (value: T) => boolean, label: string, timeout = 30_000) {
  const end = performance.now() + timeout
  let last: unknown
  do { try { const value = await work(); if (ready(value)) return value } catch (error) { last = error }; await delay(60) } while (performance.now() < end)
  throw Error(`Timeout: ${label}${last ? ` (${String(last)})` : ''}`)
}
export async function gone(pid: number) { await until(() => alive(pid), value => !value, `owned process ${pid} exit`, 15_000) }

export function prepareWorkspace(node: string, gateway: string, configRoot: string, userData: string) {
  for (const directory of [configRoot, userData]) fs.mkdirSync(directory, { recursive: true })
  const profile = `profile-${crypto.randomBytes(32).toString('hex')}`
  fs.writeFileSync(path.join(userData, '.huiyu-source-profile'), profile)
  const source = String.raw`
    const path = require('node:path'); const crypto = require('node:crypto');
    const fixture = JSON.parse(process.env.AICS_ELECTRON_FIXTURE);
    const {createDesktopWorkspaceHost} = require(path.join(fixture.gateway, 'server/workspace/host.js'));
    const {fingerprint} = require(path.join(fixture.gateway, 'server/workspace/records.js'));
    (async () => {
      const host = await createDesktopWorkspaceHost({configRoot:fixture.configRoot,sourceProfileId:fixture.profile,
        secret:crypto.randomBytes(32).toString('hex'),gatewayOrigin:'http://127.0.0.1:19999'});
      try {
        await host.prepareCandidate(); const service=host.service;
        const owner={workspaceId:service.workspaceId,principalId:'desktop:'+fixture.profile,protocolVersion:1};
        const envelope={format:'huiyu-migration',version:1,migrationId:crypto.randomUUID(),
          source:{sourceProfileId:fixture.profile,origin:'https://huiyu.localhost',windowIds:['atelier']},
          createdAt:Date.now(),records:[],media:[],blockers:[],credentials:{references:[],verified:true}};
        await service.request({kind:'migration.begin',operationId:crypto.randomUUID(),envelope:{...envelope,fingerprint:fingerprint(envelope)}},owner);
        const verified=await service.request({kind:'migration.verify',operationId:crypto.randomUUID(),migrationId:envelope.migrationId},owner);
        if(verified.blockers.length) throw Error('Empty fixture migration blocked');
        await host.activate(envelope.migrationId,true);
        console.log(JSON.stringify({workspaceId:service.workspaceId,migrationId:envelope.migrationId,domains:verified.domains}));
      } finally { await host.close(); }
    })().catch(error=>{console.error(error);process.exitCode=1});
  `
  const result = spawnSync(node, ['-e', source], { windowsHide: true, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, AICS_ELECTRON_FIXTURE: JSON.stringify({ gateway, configRoot, profile }) } })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { workspaceId: string; migrationId: string; domains: string[] }
}

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }
export class Shell {
  process: ChildProcessWithoutNullStreams
  pending = new Map<number, Pending>()
  nextId = 0
  closed: Promise<void>
  socket?: net.Socket
  pipeReady: Promise<net.Socket>
  constructor(executable: string, entry: string, config: string, logDir: string) {
    this.process = spawn(executable, [entry, '--config', config], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env, ELECTRON_RUN_AS_NODE: undefined, SD_HOST: 'http://127.0.0.1:9', COMFY_HOST: 'http://127.0.0.1:9',
      TTS_HOST: 'http://127.0.0.1:9', OLLAMA_HOST: 'http://127.0.0.1:9', SD_API_AUTH: '',
    } })
    let resolvePipe!: (socket: net.Socket) => void, rejectPipe!: (error: Error) => void
    this.pipeReady = new Promise((resolve, reject) => { resolvePipe = resolve; rejectPipe = reject })
    void this.pipeReady.catch(() => {})
    const buffers = new Map<string, string>()
    const consume = (channel: string, chunk: string) => {
      fs.appendFileSync(path.join(logDir, `${channel}.log`), chunk)
      let buffer = (buffers.get(channel) || '') + chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
        if (channel === 'stdout' && line.startsWith('HUIYU_PROBE_PIPE ')) {
          const name = line.slice('HUIYU_PROBE_PIPE '.length)
          assert.match(name, /^\\\\\.\\pipe\\huiyu-electron-[a-f0-9]{32}$/)
          assert.equal(this.socket, undefined, 'Only one diagnostic owner connection')
          this.socket = net.createConnection(name)
          this.socket.setEncoding('utf8')
          this.socket.once('connect', () => resolvePipe(this.socket!))
          this.socket.on('data', chunk => consume('probe', String(chunk)))
          this.socket.on('error', error => { rejectPipe(error); this.fail(error) })
          continue
        }
        if (!line.startsWith('HUIYU_PROBE ')) continue
        try {
          const message = JSON.parse(line.slice('HUIYU_PROBE '.length))
          const pending = this.pending.get(message.id)
          if (!pending) continue
          clearTimeout(pending.timer); this.pending.delete(message.id)
          if (message.error) pending.reject(Error(message.error)); else pending.resolve(message.result)
        } catch (error) { this.fail(error as Error) }
      }
      buffers.set(channel, buffer)
    }
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk: string) => consume('stdout', chunk))
    this.process.stderr.on('data', chunk => fs.appendFileSync(path.join(logDir, 'stderr.log'), chunk))
    this.process.on('error', error => this.fail(error))
    this.closed = new Promise(resolve => this.process.once('close', (code, signal) => {
      const error = Error(`Electron closed: ${code ?? signal}`)
      rejectPipe(error); this.socket?.destroy(); this.fail(error); resolve()
    }))
  }
  fail(error: Error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }; this.pending.clear() }
  async request(op: string, extra: Record<string, unknown> = {}, timeout = 45_000): Promise<any> {
    const socket = await Promise.race([this.pipeReady, delay(timeout, undefined, { ref: false }).then(() => { throw Error('Electron probe pipe unavailable') })])
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Electron probe timeout: ${op}`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ id, op, ...extra }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }
}

export async function bootstrap(page: Page) {
  return page.evaluate(async () => {
    const bridge = Reflect.get(window, '__HUIYU_ELECTRON__') || Reflect.get(window, '__TAURI__')
    return bridge.commands ? bridge.commands.desktop_bootstrap({}) : bridge.core.invoke('desktop_bootstrap')
  }) as Promise<any>
}
export async function invoke(page: Page, command: string, args: Record<string, unknown> = {}) {
  return page.evaluate(async ({ command, args }) => {
    const bridge = Reflect.get(window, '__HUIYU_ELECTRON__') || Reflect.get(window, '__TAURI__')
    return bridge.commands ? bridge.commands[command](args) : bridge.core.invoke(command, args)
  }, { command, args })
}
export async function workspace(page: Page, endpoint: string, body?: Record<string, unknown>, token?: string) {
  return page.evaluate(async ({ endpoint, body, token }) => {
    const host = Reflect.get(window, '__HUIYU_ELECTRON__')
    const descriptor = await host.commands.desktop_bootstrap({})
    const session = descriptor.runtime.workspace
    const response = await fetch(descriptor.runtime.origin + '/api/workspace' + endpoint, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-aics-workspace-session': token || session.token },
      ...(body ? { body: JSON.stringify({ ...body, protocolVersion: 1, workspaceId: session.workspaceId }) } : {}),
    })
    return { status: response.status, body: await response.json() }
  }, { endpoint, body, token })
}
