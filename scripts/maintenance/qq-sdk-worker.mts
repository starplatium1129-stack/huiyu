import { createInterface } from 'node:readline'
import { ApiClient, GatewayConnection, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol'
import type { PersistedSession } from '@tencent-connect/qqbot-nodejs/protocol'

const maxFrameBytes = 1024 * 1024
const allowedHosts = new Set(['api.bot.qq.com', 'api.sgroup.qq.com'])
const messageKinds = new Set(['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE'])
const api = new ApiClient({ baseUrl: 'https://api.bot.qq.com', defaultTimeoutMs: 12_000 })
const tokens = new TokenManager()
const cancel = new AbortController()
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

interface Start {
  appId: string
  appSecret: string
  session?: PersistedSession
}

interface SocketLike {
  readyState?: number
  terminate?: () => void
}

interface GatewayInternals {
  handleHello?: (ws: SocketLike, data: { heartbeat_interval?: unknown }, accessToken: string) => void
  handlePayload?: (ws: SocketLike, payload: { op?: unknown }, accessToken: string) => void
  cleanup?: () => void
}

function logDiagnostic(message: string) {
  const clean = message.replace(/[\r\n]+/g, ' ').slice(0, 240)
  if (clean) process.stderr.write(`${clean}\n`)
}

function emit(event: object) {
  if (cancel.signal.aborted) return
  const line = `${JSON.stringify(event)}\n`
  const bytes = Buffer.byteLength(line)
  if (bytes > maxFrameBytes || process.stdout.writableLength + bytes > 2 * maxFrameBytes) {
    // Restart from the last event acknowledged by the parent if the pipe backs up.
    process.exitCode = 1
    cancel.abort()
    return
  }
  process.stdout.write(line)
}

/**
 * The upstream QQ SDK sends HEARTBEAT frames on an interval but ignores
 * HEARTBEAT_ACK responses, so half-open sockets stay stuck in OPEN forever.
 * Monitor inbound gateway frames and terminate zombie sockets after two
 * missed heartbeat windows, while emitting liveness ticks to the parent.
 */
function attachHeartbeatWatchdog(connection: GatewayConnection) {
  const target = connection as unknown as GatewayInternals
  if (typeof target.handleHello !== 'function' || typeof target.handlePayload !== 'function' || typeof target.cleanup !== 'function') {
    return
  }
  const origHello = target.handleHello.bind(connection)
  const origPayload = target.handlePayload.bind(connection)
  const origCleanup = target.cleanup.bind(connection)
  let watchdog: ReturnType<typeof setInterval> | null = null
  let lastInboundAt = Date.now()
  let lastEmittedHeartbeatAt = 0

  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearInterval(watchdog)
      watchdog = null
    }
  }

  target.cleanup = () => {
    clearWatchdog()
    origCleanup()
  }

  target.handleHello = (ws, data, accessToken) => {
    origHello(ws, data, accessToken)
    clearWatchdog()
    const rawInterval = Number(data?.heartbeat_interval)
    const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 10_000 && rawInterval <= 120_000 ? rawInterval : 41_250
    const timeoutMs = Math.max(intervalMs * 2 + 15_000, 95_000)
    const checkMs = Math.max(5_000, Math.min(15_000, Math.floor(intervalMs / 2)))
    lastInboundAt = Date.now()
    lastEmittedHeartbeatAt = lastInboundAt
    emit({ type: 'heartbeat' })
    watchdog = setInterval(() => {
      if (cancel.signal.aborted) {
        clearWatchdog()
        return
      }
      if (Date.now() - lastInboundAt > timeoutMs) {
        clearWatchdog()
        logDiagnostic(`heartbeat watchdog triggered after ${Math.round((Date.now() - lastInboundAt) / 1000)}s silence; terminating socket`)
        try { ws.terminate?.() } catch { /* socket already closing */ }
      }
    }, checkMs)
    watchdog.unref?.()
  }

  target.handlePayload = (ws, payload, accessToken) => {
    const now = Date.now()
    lastInboundAt = now
    if (payload?.op === 11 || now - lastEmittedHeartbeatAt >= 20_000) {
      lastEmittedHeartbeatAt = now
      emit({ type: 'heartbeat' })
    }
    origPayload(ws, payload, accessToken)
  }
}

async function start(line: string) {
  const config: Start = JSON.parse(line)
  const { appId, appSecret } = config
  if (!/^\d{1,24}$/.test(appId) || typeof appSecret !== 'string' || !appSecret || appSecret.length > 512) {
    throw new Error('Invalid start request')
  }
  let session = config.session ?? null
  const connection = new GatewayConnection({
    account: { accountId: appId, appId, clientSecret: appSecret },
    abortSignal: cancel.signal,
    intents: 1 << 25,
    reconnect: { maxAttempts: 5 },
    getAccessToken: () => tokens.getAccessToken(appId, appSecret),
    clearTokenCache: () => tokens.clearCache(appId),
    async getGatewayUrl(accessToken) {
      const { url } = await api.request<{ url: string }>(accessToken, 'GET', '/gateway')
      const address = new URL(url)
      if (address.protocol !== 'wss:' || !allowedHosts.has(address.hostname) || address.port || address.username || address.password) {
        throw new Error('Invalid QQ gateway address')
      }
      return address.href
    },
    session: {
      load: () => session,
      save: value => { session = value },
      clear() {
        session = null
        emit({ type: 'reset' })
      },
    },
    onReady: data => emit({ type: 'ready', session, botId: (data as { user?: { id?: string } })?.user?.id }),
    onResumed: () => emit({ type: 'resumed' }),
    onDisconnected: ({ code }) => emit({ type: 'disconnected', code }),
    onError: error => logDiagnostic(`gateway error: ${error?.message || String(error)}`),
    onMessage(message) {
      if (!messageKinds.has(message.rawEventType)) return
      emit({ type: 'message', kind: message.rawEventType, sequence: session?.lastSeq, data: message.raw })
    },
  })
  attachHeartbeatWatchdog(connection)
  await connection.start()
}

process.stdout.on('error', () => cancel.abort())
input.once('close', () => cancel.abort())
input.once('line', line => {
  void start(line).catch((error: unknown) => {
    const closeCode = error && typeof error === 'object' && 'closeCode' in error ? error.closeCode : undefined
    logDiagnostic(`worker exited: ${error instanceof Error ? error.message : String(error)}`)
    emit({ type: 'failed', code: typeof closeCode === 'number' ? closeCode : 0 })
    process.exitCode = 1
  }).finally(() => {
    input.close()
    process.stdin.destroy()
  })
})
