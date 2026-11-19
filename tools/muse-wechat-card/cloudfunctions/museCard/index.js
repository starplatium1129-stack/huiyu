'use strict'

const cloud = require('wx-server-sdk')
const { createHash, createHmac, timingSafeEqual } = require('node:crypto')
const { CardError } = require('./errors')
const { createStore } = require('./store')
const media = require('./media')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })
const store = createStore(db)

const guide = {
  name: '绘遇 · Muse 微信群卡片',
  version: 1,
  authentication: '所有 POST 请求在 X-Token 请求头中携带群卡片专用密钥。',
  usage: '在同一 HTTPS 地址发送 UTF-8 JSON。只处理群友在小程序内提交的问题。读到提问后可用公开网页搜索和绘图工具回答，结果写回卡片，由群友在微信里决定是否分享。',
  actions: {
    pair: '首次设置时 POST {"action":"pair"}。只在机主的 Muse 私聊中展示返回的绑定码，15 分钟内由机主在目标微信群的卡片里输入。',
    pending: 'POST {"action":"pending"}。items 中每项含 requestKey、text、hasImage、expiresAt；没有新问题时返回空数组。',
    take: 'POST {"action":"take","requestKey":"收件编号","attemptKey":"为本次处理生成的 UUID"}。取得问题和可选原图。重试沿用 attemptKey；较长任务可在 leaseUntil 前用同一请求续期。',
    reply: 'POST {"action":"reply","requestKey":"收件编号","attemptKey":"领取时的 UUID","text":"回答","image":{"mimeType":"image/jpeg","data":"原图的标准 Base64"}}。text 和 image 至少选一项。status=answered 表示结果已存入卡片。',
    fail: '无法完成时 POST {"action":"fail","requestKey":"收件编号","attemptKey":"领取时的 UUID","error":"给提问者看的简短说明"}。',
  },
  limits: { questionChars: 1600, answerChars: 4000, imageBytes: media.IMAGE_BYTES, imageTypes: ['image/jpeg', 'image/png'], retentionHours: 24 },
  permissions: 'pending 和 take 只向连接器提供本群卡片里的提问及附件，take 同时登记领取；reply 和 fail 写入这条卡片。群友的提问不授予访问机主私人资料、账户或其他聊天的权限。',
}

function token() {
  const value = process.env.MUSE_CARD_TOKEN
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(value)) {
    throw new CardError(503, 'CONNECTOR_NOT_CONFIGURED', '请先在云函数环境变量配置群卡片专用的 MUSE_CARD_TOKEN。')
  }
  return value
}

function sameSecret(left, right) {
  if (typeof left !== 'string' || left.length > 256) return false
  const digest = value => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(left), digest(right))
}

function bindingCode(expiry) {
  const signature = createHmac('sha256', token()).update('muse-card/bind/' + expiry).digest('hex').slice(0, 16)
  return expiry + '-' + signature
}

function checkBindingCode(value) {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const match = /^([a-z0-9]{5,10})-[a-f0-9]{16}$/.exec(code)
  const expiresAt = match ? Number.parseInt(match[1], 36) * 1000 : 0
  if (expiresAt <= Date.now() || expiresAt > Date.now() + 15 * 60_000 + 1000 || !sameSecret(code, bindingCode(match[1]))) {
    throw new CardError(403, 'BIND_CODE_INVALID', '绑定码已失效或输入有误，请在你自己的 Muse 对话里重新获取。')
  }
}

function identity(kind, appId, id) {
  return createHash('sha256').update(JSON.stringify([kind, appId, id])).digest('hex')
}

async function verifiedGroup(groupCloudId, context) {
  const denied = () => new CardError(403, 'GROUP_PROOF_INVALID', '请从普通微信群里的卡片打开，或重新选择该群。')
  if (typeof groupCloudId !== 'string' || !groupCloudId || groupCloudId.length > 512) throw denied()
  let response
  try {
    response = await cloud.getOpenData({ list: [groupCloudId] })
  } catch {
    throw denied()
  }
  const group = response.list?.find(item => item.cloudID === groupCloudId)?.data
  if (!group || Number(group.chat_type) !== 3 || typeof group.opengid !== 'string' || !group.opengid
      || group.opengid.length > 256 || (group.watermark?.appid && group.watermark.appid !== context.APPID)) throw denied()
  return identity('group', context.APPID, group.opengid)
}

function key(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) {
    throw new CardError(400, 'INVALID_KEY', '请求编号无效，请从原群卡片重新打开。')
  }
  return value
}

function boundedText(value, limit) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > 2 * limit || [...value.trim()].length > limit) {
    throw new CardError(400, 'TEXT_LIMIT', '文字最多 ' + limit + ' 字。')
  }
  return value.trim()
}

async function mini(event, context) {
  const groupKey = await verifiedGroup(event.groupCloudId, context)
  const userKey = identity('member', context.APPID, context.OPENID)
  const groupState = await store.group(groupKey)
  if (event.action === 'open') return { groupState, groupKey }
  if (event.action === 'bind' && groupState === 'unbound') {
    checkBindingCode(event.bindCode)
    return { groupState: await store.bind(groupKey), groupKey }
  }
  if (groupState !== 'ready') throw new CardError(403, 'GROUP_NOT_BOUND', '请在已绑定的微信群里使用这张卡片。')
  if (event.action === 'bind') return { groupState, groupKey }
  if (event.action === 'stage') {
    await media.stage(db, groupKey, userKey, key(event.clientKey), event)
    return {}
  }
  if (event.action === 'ask') {
    const clientKey = key(event.clientKey)
    const text = boundedText(event.text, guide.limits.questionChars)
    const image = event.image ? await media.assembledImage(db, groupKey, userKey, clientKey, event.image) : undefined
    if (!text && !image) throw new CardError(400, 'EMPTY_QUESTION', '请写下问题或选择一张图片。')
    const question = await store.ask(groupKey, userKey, { clientKey, text, image })
    return { question: media.questionView(question) }
  }
  if (event.action === 'read' || event.action === 'imagePart') {
    const shareKey = event.shareKey ? key(event.shareKey) : undefined
    const question = await store.read(groupKey, userKey, key(event.id), shareKey)
    if (event.action === 'imagePart') return { data: media.answerPart(question, event.part) }
    return { question: media.questionView(question) }
  }
  throw new CardError(400, 'UNKNOWN_ACTION', '未知的小程序操作。')
}

async function agent(body) {
  switch (body.action) {
    case 'guide': return guide
    case 'pair': {
      if (await store.group('') !== 'unbound') throw new CardError(409, 'ALREADY_BOUND', '此连接已经绑定到一个微信群。')
      const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60
      return { bindCode: bindingCode(expiresAt.toString(36)), expiresAt: expiresAt * 1000 }
    }
    case 'pending': return { items: await store.pending() }
    case 'take': return store.take(key(body.requestKey), key(body.attemptKey))
    case 'reply': {
      const text = boundedText(body.text, guide.limits.answerChars)
      const image = body.image ? media.validatedImage(body.image) : undefined
      if (!text && !image) throw new CardError(400, 'EMPTY_ANSWER', '请提交文字或一张图片。')
      return store.finish(key(body.requestKey), key(body.attemptKey), { text, image })
    }
    case 'fail': {
      const error = boundedText(body.error, 300)
      if (!error) throw new CardError(400, 'EMPTY_REASON', '请说明未能完成的原因。')
      return store.finish(key(body.requestKey), key(body.attemptKey), { error })
    }
    default: throw new CardError(400, 'UNKNOWN_ACTION', '请 GET 当前地址查看 Muse 接口。')
  }
}

function publicError(error) {
  if (error instanceof CardError) return error
  // The platform error can include request parameters. Keep only a numeric SDK code.
  console.warn('museCard cloud operation failed', Number(error?.errCode) || 0)
  return new CardError(503, 'CLOUD_UNAVAILABLE', '云服务暂时不可用，请稍后重试。首次部署请检查 muse_cards 集合。')
}

function httpResponse(statusCode, value) {
  return {
    statusCode,
    isBase64Encoded: false,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(value),
  }
}

async function http(event) {
  try {
    if (event.httpMethod === 'GET') return httpResponse(200, { ok: true, ...guide })
    if (event.httpMethod !== 'POST') throw new CardError(405, 'METHOD_NOT_ALLOWED', '请使用 GET 或 POST。')
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([name, value]) => [name.toLowerCase(), value]))
    if (!sameSecret(headers['x-token'], token())) throw new CardError(401, 'UNAUTHORIZED', '请检查连接器的群卡片专用密钥。')
    if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > 1024 * 1024) {
      throw new CardError(413, 'BODY_TOO_LARGE', '请求体过大或格式错误。')
    }
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
    let body
    try { body = JSON.parse(raw) } catch { throw new CardError(400, 'INVALID_JSON', '请求需要 UTF-8 JSON。') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CardError(400, 'INVALID_JSON', '请求需要 JSON 对象。')
    return httpResponse(200, { ok: true, ...await agent(body) })
  } catch (error) {
    const failure = publicError(error)
    return httpResponse(failure.status, { ok: false, code: failure.code, error: failure.message })
  }
}

exports.main = async function main(event) {
  const context = cloud.getWXContext()
  try {
    // Identity comes from the trusted invocation, never from fields in the request.
    if (context.OPENID && context.APPID) return { ok: true, ...await mini(event, context) }
    if (context.SOURCE === 'wx_trigger' && event?.TriggerName === 'museCardCleanup') {
      return { ok: true, ...await store.cleanup() }
    }
    if (typeof event?.httpMethod === 'string') return await http(event)
    throw new CardError(403, 'WECHAT_LOGIN_REQUIRED', '请在微信小程序内打开群卡片。')
  } catch (error) {
    const failure = publicError(error)
    return { ok: false, code: failure.code, error: failure.message }
  }
}
