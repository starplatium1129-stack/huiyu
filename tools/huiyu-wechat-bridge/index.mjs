import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { saveMediaBuffer } from 'openclaw/plugin-sdk/media-store'

const channel = 'openclaw-weixin'
const maxImageBytes = 3 * 1024 * 1024

function readConfig(raw) {
  const origin = new URL(raw.origin)
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('绘遇微信桥接只接受本机绘遇地址')
  }
  const accountId = String(raw.accountId ?? '').trim()
  const token = String(raw.token ?? '')
  if (!accountId || !/^[a-f0-9]{64}$/.test(token)) throw new Error('请配置微信账号 ID 和绘遇连接密钥')
  return { url: new URL('/api/companion-channels/wechat/message', origin), accountId, token }
}

export default definePluginEntry({
  id: 'huiyu-wechat-bridge',
  name: '绘遇微信桥接',
  description: '通过腾讯的微信通道使用本机绘遇。',
  register(api) {
    const config = readConfig(api.pluginConfig ?? {})
    api.on('reply_dispatch', async (event, context) => {
      const message = event.ctx
      if ((event.originatingChannel ?? message.OriginatingChannel) !== channel
        || (event.originatingAccountId ?? message.AccountId) !== config.accountId
        || (event.originatingChatType ?? message.ChatType) !== 'direct' || event.suppressUserDelivery || event.isTailDispatch) return
      const peer = event.originatingTo || message.OriginatingTo
      const id = message.MessageSidFull || message.MessageSid
      const text = (message.BodyForCommands || message.RawBody || message.BodyForAgent || message.Body || '').trim()
      if (!peer || !id || !text) return

      let reply
      try {
        await context.turnAdoption?.adopt()
        context.turnAdoption?.assertCurrent()
        const deadline = AbortSignal.timeout(185_000)
        const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, deadline]) : deadline
        const response = await fetch(config.url, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
          body: JSON.stringify({ account: config.accountId, peer, id, text: [...text].slice(0, 2000).join('') }),
        })
        if (!response.ok) throw new Error('绘遇未接受消息')
        const result = await response.json()
        if (typeof result.text !== 'string' || !Array.isArray(result.images) || result.images.length > 3) {
          throw new Error('绘遇回复格式无效')
        }
        const mediaUrls = []
        for (const image of result.images) {
          if (!['huiyu.png', 'huiyu.jpg'].includes(image.name) || typeof image.data !== 'string'
            || image.data.length > 4 * 1024 * 1024) throw new Error('绘遇图片格式无效')
          const saved = await saveMediaBuffer(Buffer.from(image.data, 'base64'), image.name.endsWith('.png') ? 'image/png' : 'image/jpeg', 'outbound', maxImageBytes, image.name)
          mediaUrls.push(saved.path)
        }
        reply = { text: result.text, ...(mediaUrls.length ? { mediaUrls } : {}) }
        context.turnAdoption?.assertCurrent()
      } catch {
        if (!context.abortSignal?.aborted) reply = { text: '绘遇暂时无法回复。请确认电脑上的绘遇正在运行，微信桥接地址和密钥正确。' }
      }
      const queuedFinal = Boolean(reply && (reply.text || reply.mediaUrls?.length) && context.dispatcher.sendFinalReply(reply))
      context.recordProcessed(queuedFinal ? 'completed' : 'skipped')
      context.markIdle('huiyu-wechat-bridge')
      return { handled: true, queuedFinal, counts: context.dispatcher.getQueuedCounts() }
    }, { eligibleDispatchKinds: ['agent'], timeoutMs: 190_000 })
  },
})
