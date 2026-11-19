'use strict'

const { createHash } = require('node:crypto')
const { imageSize } = require('image-size')
const { CardError } = require('./errors')

// A Mini Program callFunction payload is limited to 100 KiB, including its JSON.
const PART_CHARS = 64 * 1024
const IMAGE_BYTES = 512 * 1024
const MAX_CHARS = Math.ceil(IMAGE_BYTES / 3) * 4
const MAX_PARTS = Math.ceil(MAX_CHARS / PART_CHARS)
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function invalidImage() {
  return new CardError(400, 'INVALID_IMAGE', '请选择 512 KiB 以内的 JPEG 或 PNG 图片。')
}

function descriptor(image) {
  if (!image || !['image/jpeg', 'image/png'].includes(image.mimeType)
      || !Number.isInteger(image.parts) || image.parts < 1 || image.parts > MAX_PARTS) throw invalidImage()
  return { mimeType: image.mimeType, parts: image.parts }
}

function validatedImage(image) {
  const data = image?.data
  if (typeof data !== 'string' || !data.length || data.length > MAX_CHARS || !BASE64.test(data)) throw invalidImage()
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > IMAGE_BYTES || bytes.toString('base64') !== data) throw invalidImage()
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (!(png && image.mimeType === 'image/png' || jpeg && image.mimeType === 'image/jpeg')) throw invalidImage()
  let size
  try { size = imageSize(bytes) } catch { throw invalidImage() }
  if (!size.width || !size.height || size.width > 8192 || size.height > 8192 || size.width * size.height > 32000000) throw invalidImage()
  return { mimeType: image.mimeType, data }
}

// One bounded set of upload slots per member. An abandoned upload cannot grow
// storage indefinitely. The clientKey prevents chunks from two drafts mixing.
function slot(collectionOwner, groupKey, userKey, part) {
  const hash = createHash('sha256').update(JSON.stringify([groupKey, userKey, part])).digest('hex')
  return collectionOwner.collection('muse_cards').doc('u-' + hash.slice(0, 30))
}

async function stage(db, groupKey, userKey, clientKey, input) {
  const { mimeType, parts } = descriptor(input)
  const { part, data } = input
  if (!Number.isInteger(part) || part < 0 || part >= parts || typeof data !== 'string'
      || !data.length || data.length % 4 || data.length > PART_CHARS
      || !BASE64.test(data) || (part < parts - 1 && (data.length !== PART_CHARS || data.includes('=')))
      || part * PART_CHARS + data.length > MAX_CHARS) throw invalidImage()
  await db.runTransaction(async tx => {
    const ref = slot(tx, groupKey, userKey, part)
    const { data: previous } = await ref.get()
    if (previous?.clientKey === clientKey && previous.expiresAt > Date.now()) {
      if (previous.parts !== parts || previous.mimeType !== mimeType || previous.data !== data) {
        throw new CardError(409, 'UPLOAD_CONFLICT', '这个提问编号已用于另一份图片，请新建提问。')
      }
      return
    }
    await ref.set({ data: { kind: 'uploadPart', clientKey, parts, mimeType, data, expiresAt: Date.now() + 30 * 60 * 1000 } })
  })
}

async function assembledImage(db, groupKey, userKey, clientKey, image) {
  const { parts, mimeType } = descriptor(image)
  const now = Date.now()
  const chunks = await Promise.all(Array.from({ length: parts }, async (_, part) => {
    const { data: row } = await slot(db, groupKey, userKey, part).get()
    if (row?.clientKey !== clientKey || row.parts !== parts || row.mimeType !== mimeType || row.expiresAt <= now) {
      throw new CardError(409, 'UPLOAD_INCOMPLETE', '图片上传还未完成，请重试发送原图。')
    }
    return row.data
  }))
  return validatedImage({ mimeType, data: chunks.join('') })
}

function questionView(question) {
  if (!question.answerImage) return question
  const { mimeType, data } = question.answerImage
  return { ...question, answerImage: { mimeType, parts: Math.ceil(data.length / PART_CHARS) } }
}

function answerPart(question, part) {
  const image = question.answerImage
  if (!image || !Number.isInteger(part) || part < 0 || part >= Math.ceil(image.data.length / PART_CHARS)) {
    throw new CardError(404, 'IMAGE_PART_MISSING', '这张回答图片或图片分块不存在。')
  }
  return image.data.slice(part * PART_CHARS, (part + 1) * PART_CHARS)
}

module.exports = { stage, assembledImage, validatedImage, questionView, answerPart, IMAGE_BYTES }
