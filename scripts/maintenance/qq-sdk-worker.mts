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
    onMessage(message) {
      if (!messageKinds.has(message.rawEventType)) return
      emit({ type: 'message', kind: message.rawEventType, sequence: session?.lastSeq, data: message.raw })
    },
  })
  await connection.start()
}

process.stdout.on('error', () => cancel.abort())
input.once('close', () => cancel.abort())
input.once('line', line => {
  void start(line).catch((error: unknown) => {
    const closeCode = error && typeof error === 'object' && 'closeCode' in error ? error.closeCode : undefined
    emit({ type: 'failed', code: typeof closeCode === 'number' ? closeCode : 0 })
    process.exitCode = 1
  }).finally(() => {
    input.close()
    process.stdin.destroy()
  })
})
