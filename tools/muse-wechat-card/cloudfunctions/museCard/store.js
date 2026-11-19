'use strict'

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto')
const { CardError } = require('./errors')

const COLLECTION = 'muse_cards'
const RETENTION = 24 * 60 * 60 * 1000
const LEASE = 10 * 60 * 1000
const MAX_PENDING = 64
const MAX_PER_MEMBER = 8
const PAGE_SIZE = 16

function digest(fields) {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

function validShare(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string' || !/^[a-f0-9]{32}$/.test(supplied)) {
    return false
  }
  const key = Buffer.from(expected)
  return key.length === supplied.length && timingSafeEqual(key, Buffer.from(supplied))
}

function groupState(binding, groupKey) {
  if (!binding) return 'unbound'
  return binding.groupKey === groupKey ? 'ready' : 'other'
}

function requireGroup(binding, groupKey) {
  if (groupState(binding, groupKey) !== 'ready') {
    throw new CardError(403, 'GROUP_NOT_BOUND', '请从已绑定的微信群打开群卡片。')
  }
}

function requireLive(question, now) {
  if (!question || question.expiresAt <= now) {
    throw new CardError(410, 'QUESTION_EXPIRED', '这条提问已过期，请重新提问。')
  }
}

function isDone(question) {
  return question.state === 'answered' || question.state === 'failed'
}

function forMember(id, question, now) {
  const state = question.state === 'processing' && question.leaseUntil <= now ? 'pending' : question.state
  const result = { id, state, text: question.text, expiresAt: question.expiresAt }
  if (state === 'answered') {
    result.shareKey = question.shareKey
    if (question.answerText) result.answerText = question.answerText
    if (question.answerImage) result.answerImage = question.answerImage
  } else if (state === 'failed') {
    result.error = question.error
  }
  return result
}

function questionId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
    throw new CardError(400, 'INVALID_QUESTION', '提问编号无效。')
  }
  return id
}

// Construct db with cloud.database({ throwOnNotFound: false }). The Weixin
// SDK then returns {data:null} for a missing doc, including transaction reads.
function createStore(db) {
  const collection = db.collection(COLLECTION)
  const bound = collection.doc('group')

  async function group(groupKey) {
    return groupState((await bound.get()).data, groupKey)
  }

  async function bind(groupKey) {
    return db.runTransaction(async tx => {
      const slot = tx.collection(COLLECTION).doc('group')
      const binding = (await slot.get()).data
      const state = groupState(binding, groupKey)
      if (state === 'other') throw new CardError(409, 'GROUP_ALREADY_BOUND', 'Muse 卡片已绑定到另一个微信群。')
      if (state === 'unbound') await slot.set({ data: { groupKey, queue: [] } })
      return 'ready'
    })
  }

  async function ask(groupKey, userKey, input) {
    const id = digest([groupKey, userKey, input.clientKey]).slice(0, 32)
    const text = input.text || ''
    const image = input.image
    const inputDigest = digest([text, image?.mimeType, image?.data])
    return db.runTransaction(async tx => {
      const docs = tx.collection(COLLECTION)
      const slot = docs.doc('group')
      const binding = (await slot.get()).data
      requireGroup(binding, groupKey)
      const ref = docs.doc(id)
      const prior = (await ref.get()).data
      const now = Date.now()
      if (prior) {
        requireLive(prior, now)
        if (prior.groupKey !== groupKey || prior.userKey !== userKey || prior.inputDigest !== inputDigest) {
          throw new CardError(409, 'QUESTION_CONFLICT', '该编号已提交过其他内容，请重新发起提问。')
        }
        return forMember(id, prior, now)
      }
      // A bounded roster reserves capacity in the same transaction as each
      // question. Direct document transactions don't support where/count.
      const queue = binding.queue.filter(item => item.expiresAt > now)
      if (queue.length >= MAX_PENDING || queue.filter(item => item.userKey === userKey).length >= MAX_PER_MEMBER) {
        throw new CardError(429, 'INBOX_FULL', '还有较多提问等待 Muse 回复，请稍后再提交。')
      }
      const expiresAt = now + RETENTION
      const question = { groupKey, userKey, text, state: 'pending', inputDigest, hasImage: Boolean(image), expiresAt }
      if (image) await docs.doc('in-' + id).set({ data: { image, expiresAt } })
      await ref.set({ data: question })
      queue.push({ id, userKey, expiresAt })
      await slot.update({ data: { queue } })
      return forMember(id, question, now)
    })
  }

  async function read(groupKey, userKey, id, shareKey) {
    const ref = collection.doc(questionId(id))
    const [binding, result] = await Promise.all([bound.get(), ref.get()])
    requireGroup(binding.data, groupKey)
    const question = result.data
    if (!question || question.groupKey !== groupKey || (question.userKey !== userKey &&
        !(question.state === 'answered' && validShare(question.shareKey, shareKey)))) {
      throw new CardError(404, 'QUESTION_NOT_FOUND', '找不到这条提问，或分享卡片已失效。')
    }
    const now = Date.now()
    requireLive(question, now)
    return forMember(id, question, now)
  }

  async function pending() {
    const binding = (await bound.get()).data
    if (!binding) return []
    const now = Date.now()
    const ids = binding.queue.filter(item => item.expiresAt > now).map(item => item.id)
    if (!ids.length) return []
    // Keep roster order. Project metadata only so a just-finished image
    // cannot inflate the inbox while the roster snapshot is being fetched.
    const { data } = await collection.where({ _id: db.command.in(ids) })
      .field({ _id: true, groupKey: true, state: true, leaseUntil: true, text: true, hasImage: true, expiresAt: true })
      .limit(MAX_PENDING).get()
    const byId = new Map(data.map(item => [item._id, item]))
    const items = []
    for (const id of ids) {
      const q = byId.get(id)
      if (!q || q.groupKey !== binding.groupKey || isDone(q) || q.expiresAt <= now || q.leaseUntil > now) continue
      items.push({ requestKey: id, text: q.text, hasImage: q.hasImage, expiresAt: q.expiresAt })
      if (items.length === PAGE_SIZE) break
    }
    return items
  }

  async function take(requestKey, attemptKey) {
    const id = questionId(requestKey)
    return db.runTransaction(async tx => {
      const docs = tx.collection(COLLECTION)
      const ref = docs.doc(id)
      const question = (await ref.get()).data
      const now = Date.now()
      requireLive(question, now)
      requireGroup((await docs.doc('group').get()).data, question.groupKey)
      if (isDone(question)) throw new CardError(409, 'QUESTION_FINISHED', '这条提问已处理。')
      if (question.state === 'processing' && question.leaseUntil > now && question.attemptKey !== attemptKey) {
        throw new CardError(409, 'QUESTION_CLAIMED', '这条提问正在由另一次领取处理。')
      }
      const leaseUntil = Math.min(now + LEASE, question.expiresAt)
      const result = { requestKey: id, text: question.text, expiresAt: question.expiresAt, leaseUntil }
      if (question.hasImage) {
        const attachment = (await docs.doc('in-' + id).get()).data
        if (!attachment?.image) throw new CardError(503, 'ATTACHMENT_UNAVAILABLE', '提问图片暂时无法读取。')
        result.image = attachment.image
      }
      await ref.update({ data: { state: 'processing', attemptKey, leaseUntil } })
      return result
    })
  }

  async function finish(requestKey, attemptKey, output) {
    const id = questionId(requestKey)
    const state = output.error ? 'failed' : 'answered'
    const answerText = output.text || ''
    const image = output.image
    const outputDigest = digest([state, output.error, answerText, image?.mimeType, image?.data])
    return db.runTransaction(async tx => {
      const docs = tx.collection(COLLECTION)
      const ref = docs.doc(id)
      const question = (await ref.get()).data
      const now = Date.now()
      requireLive(question, now)
      const slot = docs.doc('group')
      const binding = (await slot.get()).data
      requireGroup(binding, question.groupKey)
      const receipt = { requestKey: id, status: state }
      if (isDone(question)) {
        if (question.attemptKey === attemptKey && question.outputDigest === outputDigest) return receipt
        throw new CardError(409, 'REPLY_CONFLICT', '这条提问已有另一份处理结果。')
      }
      if (question.state !== 'processing' || question.attemptKey !== attemptKey || question.leaseUntil <= now) {
        throw new CardError(409, 'LEASE_REQUIRED', '请先领取或续领这条提问，再提交结果。')
      }
      const update = { state, outputDigest }
      if (state === 'failed') {
        update.error = output.error
      } else {
        update.shareKey = randomBytes(16).toString('hex')
        if (answerText) update.answerText = answerText
        if (image) update.answerImage = image
      }
      // Only one 512-KiB image per database document. The source attachment
      // never appears in a shared answer and is discarded once Muse is done.
      if (question.hasImage) await docs.doc('in-' + id).remove()
      await ref.update({ data: update })
      const queue = binding.queue.filter(item => item.id !== id && item.expiresAt > now)
      await slot.update({ data: { queue } })
      return receipt
    })
  }

  async function cleanup() {
    const now = Date.now()
    await db.runTransaction(async tx => {
      const slot = tx.collection(COLLECTION).doc('group')
      const binding = (await slot.get()).data
      if (!binding) return
      const queue = binding.queue.filter(item => item.expiresAt > now)
      if (queue.length !== binding.queue.length) await slot.update({ data: { queue } })
    })
    // A conditional batch delete rechecks expiresAt for concurrently renewed
    // upload slots. Where/remove itself does not accept a limit.
    let removed = 0
    for (let batch = 0; batch < 6; batch++) {
      const expired = db.command.lte(now)
      const { data } = await collection.where({ expiresAt: expired }).field({ _id: true }).limit(100).get()
      if (!data.length) break
      const ids = data.map(item => item._id)
      const result = await collection.where({ _id: db.command.in(ids), expiresAt: expired }).remove()
      removed += result.stats.removed
    }
    return { removed }
  }

  return { group, bind, ask, read, pending, take, finish, cleanup }
}

module.exports = { createStore }
