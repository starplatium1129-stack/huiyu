const { invoke } = require('./cloud')

const MAX_BYTES = 512 * 1024
const PART_LENGTH = 65536
const fs = () => wx.getFileSystemManager()
const prefix = 'huiyu-muse-card-'
let fileNumber = 0
let cacheChecked = false

function mimeOf(data) {
  if (typeof data !== 'string' || !data.length || data.length % 4 !== 0) return ''
  const length = data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  if (length > MAX_BYTES) return ''
  if (data.startsWith('iVBORw0KGgo')) return 'image/png'
  if (data.startsWith('/9j/')) return 'image/jpeg'
  return ''
}

async function smallFile(filePath) {
  const { stats } = await invoke(options => fs().stat(options), { path: filePath })
  if (stats.size > MAX_BYTES) return null
  const { data } = await invoke(options => fs().readFile(options), { filePath, encoding: 'base64' })
  const mimeType = mimeOf(data)
  return mimeType ? { mimeType, data } : null
}

async function choosePhoto() {
  if (wx.chooseMedia) {
    const selection = await invoke(wx.chooseMedia, { count: 1, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'] })
    return selection.tempFiles[0].tempFilePath
  }
  const selection = await invoke(wx.chooseImage, { count: 1, sizeType: ['compressed'] })
  return selection.tempFilePaths[0]
}

function imageCanvas(page) {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery().in(page).select('#encoder').fields({ node: true }).exec(items => {
      const node = items && items[0] && items[0].node
      if (node) resolve(node)
      else reject(new Error('当前微信无法压缩这张图片，请选择 512 KiB 以内的 JPEG 或 PNG。'))
    })
  })
}

async function preparePhoto(path, page) {
  const info = await invoke(wx.getImageInfo, { src: path })
  const original = await smallFile(path)
  if (original) return original

  if (wx.compressImage && /^(jpe?g)$/i.test(info.type || '')) {
    const scale = Math.min(1, 1440 / Math.max(info.width, info.height))
    try {
      const result = await invoke(wx.compressImage, { src: path, quality: 76, compressedWidth: Math.max(1, Math.round(info.width * scale)) })
      const image = await smallFile(result.tempFilePath)
      if (image) return image
    } catch { /* Older clients can still use their 2D canvas below. */ }
  }

  // iOS only supports JPEG in compressImage; flatten larger PNGs onto a white canvas.
  const canvas = await imageCanvas(page)
  const picture = canvas.createImage()
  await new Promise((resolve, reject) => {
    picture.onload = resolve
    picture.onerror = () => reject(new Error('微信无法读取这张图片，请改选 JPEG 或 PNG。'))
    picture.src = path
  })
  try {
    for (const edge of [1440, 1000, 640]) {
      const scale = Math.min(1, edge / Math.max(picture.width, picture.height))
      canvas.width = Math.max(1, Math.round(picture.width * scale))
      canvas.height = Math.max(1, Math.round(picture.height * scale))
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(picture, 0, 0, canvas.width, canvas.height)
      const file = await invoke(wx.canvasToTempFilePath, {
        canvas, fileType: 'jpg', quality: 0.76, destWidth: canvas.width, destHeight: canvas.height,
      })
      const image = await smallFile(file.tempFilePath)
      if (image) return image
    }
  } finally {
    canvas.width = 1
    canvas.height = 1
  }
  throw new Error('压缩后图片仍超过 512 KiB，请先裁小一点。')
}

function dropFile(path) {
  if (path && path.startsWith(wx.env.USER_DATA_PATH + '/' + prefix)) fs().unlink({ filePath: path, fail() {} })
}

async function localImage(image) {
  if (mimeOf(image.data) !== image.mimeType) throw new Error('图片数据不完整，请重新读取。')
  if (!cacheChecked) {
    cacheChecked = true
    try {
      for (const name of fs().readdirSync(wx.env.USER_DATA_PATH)) {
        const match = /^huiyu-muse-card-(\d+)-\d+\.(png|jpg)$/.exec(name)
        if (match && Date.now() - Number(match[1]) > 86400000) dropFile(wx.env.USER_DATA_PATH + '/' + name)
      }
    } catch { /* The directory may be empty on first use. */ }
  }
  const path = wx.env.USER_DATA_PATH + '/' + prefix + Date.now() + '-' + (++fileNumber) + (image.mimeType === 'image/png' ? '.png' : '.jpg')
  try {
    await invoke(options => fs().writeFile(options), { filePath: path, data: image.data, encoding: 'base64' })
    await invoke(wx.getImageInfo, { src: path })
  } catch {
    dropFile(path)
    throw new Error('微信未能读取图片，请检查手机剩余空间并重新加载。')
  }
  return path
}

async function stagePhoto(image, clientKey, request) {
  const parts = Math.ceil(image.data.length / PART_LENGTH)
  for (let part = 0; part < parts; part++) {
    await request('stage', {
      clientKey, mimeType: image.mimeType, part, parts,
      data: image.data.slice(part * PART_LENGTH, (part + 1) * PART_LENGTH),
    })
  }
  return { mimeType: image.mimeType, parts }
}

async function readAnswerImage(image, ref, request) {
  const limit = Math.ceil(Math.ceil(MAX_BYTES / 3) * 4 / PART_LENGTH)
  if (!['image/png', 'image/jpeg'].includes(image.mimeType) || !Number.isInteger(image.parts) || image.parts < 1 || image.parts > limit) {
    throw new Error('回答图片格式有误。')
  }
  const chunks = []
  for (let part = 0; part < image.parts; part++) {
    const { data } = await request('imagePart', { ...ref, part })
    if (typeof data !== 'string' || !data.length || data.length > PART_LENGTH) throw new Error('回答图片分片不完整，请重新读取。')
    chunks.push(data)
  }
  return localImage({ mimeType: image.mimeType, data: chunks.join('') })
}

module.exports = { choosePhoto, preparePhoto, stagePhoto, readAnswerImage, localImage, dropFile, mimeOf }
