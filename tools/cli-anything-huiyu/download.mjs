import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { bytes, connection, exchange, requestKey } from './muse.mjs'
import { isTerminalItem } from './wait.mjs'

const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex')
const MAX_PNG = 32 * 1024 * 1024
const RANGE_MIN = 1024 * 1024
const RANGE_CONNECTIONS = 4
const PART_BYTES = 128 * 1024
const SHA256 = /^[0-9a-f]{64}$/
const RESULT_PATH = /^\/api\/(?:anima|moss|creative|qwen|keyframe|manga)\/jobs\/[0-9a-f]{32}\/(?:result|lineart)$/
const CACHED_PART = /^\d+\.([0-9a-f]{64})$/
const RETRY_HTTP = new Set([408, 429, 500, 502, 503, 504])
const LINK_UNSUPPORTED = new Set(['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])
const executeFile = promisify(execFile)
const digest = data => createHash('sha256').update(data).digest('hex')

function problem(code, message, fields) {
  return Object.assign(new Error(message), { code }, fields)
}

function invalidOriginal() {
  return problem('RESULT_INTEGRITY_MISMATCH', '原图与回执不一致，请重新查询任务后取图。')
}

function validOriginal(data, metadata) {
  return data.length === metadata.size && data.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)
    && digest(data) === metadata.sha256
}

function verifyOriginal(data, metadata) {
  if (!validOriginal(data, metadata)) throw invalidOriginal()
  return data
}

function readMetadata(item) {
  const { resultUrl: url, resultBytes: size, resultSha256: sha256 } = item
  if (typeof url !== 'string' || !RESULT_PATH.test(url) || !Number.isSafeInteger(size)
      || size < PNG_HEADER.length || size > MAX_PNG || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw problem('RESULT_RECEIPT_INVALID', '原图回执的地址、大小或 SHA-256 无效。')
  }
  return { url, size, sha256 }
}

async function readResponse(res, status, mime, length, expected = {}) {
  const declaredLength = res.headers['content-length']
  if (res.statusCode !== status || res.headers['content-type']?.split(';', 1)[0]?.trim() !== mime
      || ((mime !== 'image/png' || status === 206 || declaredLength !== undefined) && declaredLength !== String(length))
      || Object.entries(expected).some(([key, value]) => res.headers[key] !== value)) {
    res.destroy()
    throw problem('RESULT_RESPONSE_INVALID', '绘遇返回的原图响应与回执不符。')
  }
  const data = await bytes(res, length)
  if (data.length !== length) throw invalidOriginal()
  return data
}

async function whole(metadata, signal) {
  const response = await exchange('GET', metadata.url, undefined, { signal })
  if (response.headers['x-result-sha256'] !== undefined && response.headers['x-result-sha256'] !== metadata.sha256) {
    response.destroy()
    throw invalidOriginal()
  }
  return verifyOriginal(await readResponse(response, 200, 'image/png', metadata.size), metadata)
}

async function parallelRanges(metadata, signal) {
  const controller = new AbortController()
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const etag = `"${metadata.sha256}"`
  const chunkSize = Math.ceil(metadata.size / RANGE_CONNECTIONS)
  const requests = Array.from({ length: RANGE_CONNECTIONS }, async (_, index) => {
    const start = index * chunkSize
    const end = Math.min(metadata.size, start + chunkSize) - 1
    const response = await exchange('GET', metadata.url, undefined, {
      headers: { Range: `bytes=${start}-${end}`, 'If-Range': etag }, signal: requestSignal,
    })
    return readResponse(response, 206, 'image/png', end - start + 1, {
      'content-range': `bytes ${start}-${end}/${metadata.size}`, etag,
    })
  })
  try {
    return verifyOriginal(Buffer.concat(await Promise.all(requests), metadata.size), metadata)
  } finally {
    controller.abort()
    await Promise.allSettled(requests)
  }
}

async function statIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function readBoundedFile(path, size) {
  const info = await statIfPresent(path)
  if (!info) return undefined
  if (!info.isFile() || info.size !== size) return null
  let file
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await file.stat()
    if (!opened.isFile() || opened.size !== size || opened.dev !== info.dev || opened.ino !== info.ino) return null
    const data = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await file.read(data, offset, size - offset, offset)
      if (!bytesRead) return null
      offset += bytesRead
    }
    const after = await statIfPresent(path)
    if (!after?.isFile() || after.size !== size || after.dev !== opened.dev || after.ino !== opened.ino) return null
    return data
  } catch (error) {
    if (error.code === 'ELOOP') return null
    if (error.code !== 'ENOENT') throw error
  } finally {
    await file?.close()
  }
}

async function existingOriginal(path, metadata) {
  const data = await readBoundedFile(path, metadata.size)
  if (data === undefined) return false
  if (data && validOriginal(data, metadata)) return true
  throw problem('OUTPUT_EXISTS', `目标文件已存在且内容不同：${path}`)
}

async function removeFile(path) {
  await unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}

async function withTemporaryFile(directory, data, publish) {
  const temporary = join(directory, `.huiyu-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(data)
    } finally {
      await file.close()
    }
    await publish(temporary)
  } finally {
    await removeFile(temporary)
  }
}

async function moveWithoutReplacing(source, target) {
  if (process.platform !== 'win32') {
    throw problem('ATOMIC_SAVE_UNAVAILABLE', '目标文件系统不支持原子保存，请选择支持硬链接的目录。')
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // Windows File.Move uses the native no-replace move. Both files share a
  // parent, and paths are data supplied through the environment.
  await executeFile(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'try { [IO.File]::Move($env:HUIYU_SAVE_SOURCE, $env:HUIYU_SAVE_TARGET) } catch { exit 1 }',
  ], {
    env: { SystemRoot: systemRoot, HUIYU_SAVE_SOURCE: source, HUIYU_SAVE_TARGET: target },
    windowsHide: true, timeout: 15_000,
  })
}

async function publishOriginal(path, data, metadata) {
  await withTemporaryFile(dirname(path), data, async temporary => {
    try {
      await link(temporary, path)
    } catch (error) {
      if (await existingOriginal(path, metadata)) return
      if (!LINK_UNSUPPORTED.has(error.code)) throw error
      try {
        await moveWithoutReplacing(temporary, path)
      } catch (moveError) {
        if (await existingOriginal(path, metadata)) return
        if (moveError.code === 'ATOMIC_SAVE_UNAVAILABLE') throw moveError
        throw problem('ATOMIC_SAVE_UNAVAILABLE', '无法将原图原子保存到目标目录，请检查文件系统和写入权限。')
      }
    }
  })
}

function partCache(path, metadata) {
  const identity = digest(basename(path) + '\n' + metadata.sha256)
  return join(dirname(path), `.huiyu-parts-${identity}`)
}

async function cacheAvailable(cache) {
  const info = await statIfPresent(cache)
  if (info && !info.isDirectory()) {
    throw problem('RESULT_CACHE_INVALID', '原图分片缓存路径不是普通目录。')
  }
  return Boolean(info)
}

async function ensureCache(cache) {
  await mkdir(cache, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  if (!await cacheAvailable(cache)) throw problem('RESULT_CACHE_INVALID', '原图分片缓存目录已消失，请重试。')
}

async function readCachedPart(cache, names, index, length) {
  for (const name of names) {
    if (!name.startsWith(`${index}.`)) continue
    const hash = CACHED_PART.exec(name)?.[1]
    if (!hash) continue
    const data = await readBoundedFile(join(cache, name), length)
    if (data && digest(data) === hash) return data
  }
}

async function writeCachedPart(cache, index, sha256, data) {
  try {
    await withTemporaryFile(cache, data, temporary => rename(temporary, join(cache, `${index}.${sha256}`)))
  } catch (error) {
    // A concurrent download may have completed and removed its cache.
    if (error.code !== 'ENOENT') throw error
  }
}

async function removeCompletedCache(cache) {
  if (!await cacheAvailable(cache)) return
  const names = await readdir(cache).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  for (const name of names) {
    if (CACHED_PART.test(name)) await removeFile(join(cache, name))
  }
  await rmdir(cache).catch(error => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  })
}

async function readPart(metadata, index, length, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await exchange('GET', `${metadata.url}?part=${index}`, undefined, { signal })
      const sha256 = response.headers['x-part-sha256']
      if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
        response.destroy()
        throw invalidOriginal()
      }
      const data = await readResponse(response, 200, 'application/octet-stream', length, {
        'x-result-offset': String(index * PART_BYTES), 'x-result-bytes': String(metadata.size),
        'x-result-sha256': metadata.sha256,
      })
      if (digest(data) !== sha256) throw invalidOriginal()
      return { data, sha256 }
    } catch (error) {
      const retryable = !error.httpStatus || RETRY_HTTP.has(error.httpStatus) || error.code === 'MUSE_RESULT_TRANSFERRING'
      const delaySeconds = error.retryAfterSeconds ?? 2
      if (signal?.aborted || attempt >= 2 || !retryable || delaySeconds > 60) throw error
      await delay(Math.max(1, delaySeconds) * 1_000, undefined, { signal })
    }
  }
}

async function receiveParts(metadata, cache, signal) {
  await ensureCache(cache)
  const names = await readdir(cache).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  const image = Buffer.alloc(metadata.size)
  for (let offset = 0, index = 0; offset < metadata.size; offset += PART_BYTES, index++) {
    signal?.throwIfAborted()
    const length = Math.min(PART_BYTES, metadata.size - offset)
    let data = await readCachedPart(cache, names, index, length)
    if (!data) {
      const part = await readPart(metadata, index, length, signal)
      data = part.data
      await writeCachedPart(cache, index, part.sha256, data)
    }
    data.copy(image, offset)
  }
  if (!validOriginal(image, metadata)) {
    await removeCompletedCache(cache)
    throw invalidOriginal()
  }
  return image
}

async function receiveOriginal(metadata, cache, { singleConnection, signal }) {
  const useRanges = !singleConnection && metadata.size >= RANGE_MIN
  if (!await cacheAvailable(cache)) {
    try {
      return await (useRanges ? parallelRanges(metadata, signal) : whole(metadata, signal))
    } catch (error) {
      if (signal?.aborted || [401, 403, 404, 410].includes(error.httpStatus)) throw error
    }
  }
  try {
    return await receiveParts(metadata, cache, signal)
  } catch (error) {
    // Older endpoints or an intermediary may offer only whole-file GET.
    if (!useRanges || ![400, 404, 405, 416, 501].includes(error.httpStatus)) throw error
    return whole(metadata, signal)
  }
}

export async function saveOriginal(receipt, itemNumber, filename, options = {}) {
  const item = receipt.items?.[itemNumber - 1]
  if (!item) throw new Error('批次中没有这一张图，请用 job 查看各项。')
  if (item.resultAvailable !== true) {
    throw problem(item.code || 'RESULT_UNAVAILABLE', item.error || `原图还不可用，任务状态为 ${item.status}。`, {
      deliveryStatus: item.deliveryStatus,
    })
  }
  const metadata = readMetadata(item)
  const path = resolve(filename)
  await mkdir(dirname(path), { recursive: true })
  const cache = partCache(path, metadata)
  if (!await existingOriginal(path, metadata)) {
    const data = await receiveOriginal(metadata, cache, options)
    options.signal?.throwIfAborted()
    await publishOriginal(path, data, metadata)
  }
  // Cache cleanup is best effort after the complete file has been published.
  await removeCompletedCache(cache).catch(() => {})
  return { path, bytes: metadata.size, sha256: metadata.sha256, batchKey: receipt.batchKey, item: itemNumber }
}

export async function saveAll(receipt, directory, options = {}) {
  if (!Array.isArray(receipt.items)) throw problem('CLI_RESPONSE_INVALID', '回执缺少任务列表。')
  const batchKey = requestKey(receipt.batchKey)
  const result = { batchKey, saved: [], pending: [], failed: [] }
  for (const [index, item] of receipt.items.entries()) {
    const number = index + 1
    const row = { item: number, status: item.status, deliveryStatus: item.deliveryStatus }
    if (item.resultAvailable === true) {
      try {
        result.saved.push(await saveOriginal(receipt, number, join(directory, `huiyu-${batchKey}-${number}.png`), options))
      } catch (error) {
        result.failed.push({ ...row, code: error.code ?? 'OUTPUT_FAILED', error: error.message })
      }
    } else if (isTerminalItem(item)) {
      result.failed.push({ ...row, code: item.code || 'RESULT_UNAVAILABLE', error: item.error })
    } else {
      result.pending.push(row)
    }
  }
  return result
}

const MEDIA_PATH = /^\/api\/muse\/(?:video\/(?:jobs|batches)\/[A-Za-z0-9_-]{1,160}\/result|gallery\/[^/?#\\]{1,512}\/file(?:\?idType=(?:string|number))?)$/
const MEDIA_RANGE_CHUNK = 4 * 1024 * 1024
const MEDIA_RELAY_PARTS = 8

async function existingMediaMatches(path, expectedBytes, expectedSha256) {
  const info = await statIfPresent(path)
  if (!info) return false
  if (!info.isFile() || info.size !== expectedBytes) {
    throw problem('OUTPUT_EXISTS', `目标文件已存在且内容不同：${path}`)
  }
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== expectedBytes || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw problem('OUTPUT_EXISTS', `目标文件已存在且内容不同：${path}`)
    }
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(256 * 1024)
    let readTotal = 0
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length)
      if (!bytesRead) break
      readTotal += bytesRead
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead))
    }
    if (readTotal === expectedBytes && hash.digest('hex') === expectedSha256) return true
    throw problem('OUTPUT_EXISTS', `目标文件已存在且内容不同：${path}`)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    if (error.code === 'ELOOP') throw problem('OUTPUT_EXISTS', `目标路径不是普通文件：${path}`)
    throw error
  } finally {
    await handle?.close()
  }
}

async function publishTempFile(temporary, targetPath, expectedBytes, expectedSha256) {
  try {
    await link(temporary, targetPath)
  } catch (error) {
    if (await existingMediaMatches(targetPath, expectedBytes, expectedSha256)) return
    if (!LINK_UNSUPPORTED.has(error.code)) throw error
    try {
      await moveWithoutReplacing(temporary, targetPath)
    } catch (moveError) {
      if (await existingMediaMatches(targetPath, expectedBytes, expectedSha256)) return
      if (moveError.code === 'ATOMIC_SAVE_UNAVAILABLE') throw moveError
      throw problem('ATOMIC_SAVE_UNAVAILABLE', '无法将媒体文件原子保存到目标目录，请检查文件系统和写入权限。')
    }
  }
}

async function resolveMediaMetadata(url, expectedBytes, expectedSha256, mimeType, signal) {
  if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0
      && typeof expectedSha256 === 'string' && SHA256.test(expectedSha256)) {
    return { size: expectedBytes, sha256: expectedSha256, mimeType: mimeType || null }
  }
  const head = await exchange('HEAD', url, undefined, { signal, timeoutMs: 30_000 })
  head.resume()
  const size = Number(head.headers['x-result-bytes'] ?? head.headers['content-length'])
  const sha256 = head.headers['x-result-sha256']
  const mime = mimeType || head.headers['content-type']?.split(';', 1)[0]?.trim() || null
  if (!Number.isSafeInteger(size) || size < 1 || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw problem('RESULT_RECEIPT_INVALID', '媒体回执缺少有效的大小或 SHA-256。')
  }
  return { size, sha256, mimeType: mime }
}

function appendPartQuery(url, partIndex, count) {
  const sep = url.includes('?') ? '&' : '?'
  return count > 1 ? `${url}${sep}part=${partIndex}&count=${count}` : `${url}${sep}part=${partIndex}`
}

async function streamMediaDirect(url, meta, file, { singleConnection, signal }) {
  const hash = createHash('sha256')
  if (singleConnection || meta.size < RANGE_MIN) {
    const res = await exchange('GET', url, undefined, { signal, timeoutMs: 180_000 })
    if (res.statusCode !== 200) {
      res.destroy()
      throw problem('RESULT_RESPONSE_INVALID', '媒体下载响应状态异常。')
    }
    if (res.headers['x-result-sha256'] !== undefined && res.headers['x-result-sha256'] !== meta.sha256) {
      res.destroy()
      throw invalidOriginal()
    }
    let written = 0
    for await (const chunk of res) {
      written += chunk.length
      if (written > meta.size) {
        res.destroy()
        throw invalidOriginal()
      }
      hash.update(chunk)
      await file.writeFile(chunk)
    }
    if (written !== meta.size || hash.digest('hex') !== meta.sha256) throw invalidOriginal()
    return { method: 'whole', mimeType: meta.mimeType || res.headers['content-type']?.split(';', 1)[0]?.trim() || null }
  }

  const etag = `"${meta.sha256}"`
  let offset = 0
  let detectedMime = meta.mimeType
  while (offset < meta.size) {
    signal?.throwIfAborted()
    const end = Math.min(meta.size, offset + MEDIA_RANGE_CHUNK) - 1
    const expectedLen = end - offset + 1
    const res = await exchange('GET', url, undefined, {
      headers: { Range: `bytes=${offset}-${end}`, 'If-Range': etag },
      signal,
      timeoutMs: 120_000,
    })
    const expectedRange = `bytes ${offset}-${end}/${meta.size}`
    if (res.statusCode !== 206
        || res.headers['content-range'] !== expectedRange
        || (res.headers['etag'] !== undefined && res.headers['etag'] !== etag)
        || (res.headers['x-result-sha256'] !== undefined && res.headers['x-result-sha256'] !== meta.sha256)) {
      res.destroy()
      throw problem('RESULT_RESPONSE_INVALID', '分范围下载响应头与回执不符。')
    }
    detectedMime ??= res.headers['content-type']?.split(';', 1)[0]?.trim() || null
    const chunk = await bytes(res, expectedLen)
    if (chunk.length !== expectedLen) throw invalidOriginal()
    hash.update(chunk)
    await file.writeFile(chunk)
    offset += chunk.length
  }
  if (hash.digest('hex') !== meta.sha256) throw invalidOriginal()
  return { method: 'range', mimeType: detectedMime }
}

async function streamMediaParts(url, meta, file, { partBytes = PART_BYTES, maxPartCount = 16, signal }) {
  const hash = createHash('sha256')
  const totalParts = Math.ceil(meta.size / partBytes)
  let partIndex = 0
  let batchSize = Math.max(1, Math.min(MEDIA_RELAY_PARTS, maxPartCount))
  let detectedMime = meta.mimeType

  while (partIndex < totalParts) {
    signal?.throwIfAborted()
    const count = Math.min(batchSize, totalParts - partIndex)
    const offset = partIndex * partBytes
    const expectedLen = Math.min(count * partBytes, meta.size - offset)
    let chunk
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await exchange('GET', appendPartQuery(url, partIndex, count), undefined, {
          signal,
          timeoutMs: 90_000,
        })
        const partSha = res.headers['x-part-sha256']
        if (res.statusCode !== 200
            || res.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/octet-stream'
            || res.headers['x-result-offset'] !== String(offset)
            || res.headers['x-result-bytes'] !== String(meta.size)
            || res.headers['x-result-sha256'] !== meta.sha256
            || typeof partSha !== 'string' || !SHA256.test(partSha)) {
          res.destroy()
          throw invalidOriginal()
        }
        detectedMime ??= res.headers['x-result-mime']?.split(';', 1)[0]?.trim() || null
        const data = await bytes(res, expectedLen)
        if (data.length !== expectedLen || digest(data) !== partSha) throw invalidOriginal()
        chunk = data
        break
      } catch (error) {
        if ((error.httpStatus === 413 || error.httpStatus === 400) && batchSize > 1) {
          batchSize = 1
          break
        }
        const retryable = !error.httpStatus || RETRY_HTTP.has(error.httpStatus)
        const delaySeconds = error.retryAfterSeconds ?? 2
        if (signal?.aborted || attempt >= 2 || !retryable || delaySeconds > 60) throw error
        await delay(Math.max(1, delaySeconds) * 1_000, undefined, { signal })
      }
    }
    if (!chunk) continue
    hash.update(chunk)
    await file.writeFile(chunk)
    partIndex += count
  }

  if (hash.digest('hex') !== meta.sha256) throw invalidOriginal()
  return { method: 'parts', mimeType: detectedMime }
}

export async function saveVerifiedMedia({
  url,
  bytes: expectedBytes,
  sha256: expectedSha256,
  mimeType,
  partBytes = PART_BYTES,
  maxPartCount = 16,
  outputPath,
  singleConnection = false,
  signal,
}) {
  if (typeof url !== 'string' || !MEDIA_PATH.test(url)) {
    throw problem('RESULT_RECEIPT_INVALID', '媒体下载地址无效。')
  }
  if (typeof outputPath !== 'string' || !outputPath.trim()) {
    throw new Error('输出文件路径不能为空。')
  }
  const meta = await resolveMediaMetadata(url, expectedBytes, expectedSha256, mimeType, signal)
  const targetPath = resolve(outputPath)
  await mkdir(dirname(targetPath), { recursive: true })
  if (await existingMediaMatches(targetPath, meta.size, meta.sha256)) {
    return { path: targetPath, bytes: meta.size, sha256: meta.sha256, mimeType: meta.mimeType, reused: true }
  }

  const { mode } = connection()
  const writeAttempt = async downloader => {
    const temporary = join(dirname(targetPath), `.huiyu-media-${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      let info
      try {
        info = await downloader(file)
      } finally {
        await file.close()
      }
      signal?.throwIfAborted()
      await publishTempFile(temporary, targetPath, meta.size, meta.sha256)
      return info
    } finally {
      await removeFile(temporary)
    }
  }

  let info
  if (mode === 'relay') {
    info = await writeAttempt(file => streamMediaParts(url, meta, file, { partBytes, maxPartCount, signal }))
  } else {
    try {
      info = await writeAttempt(file => streamMediaDirect(url, meta, file, { singleConnection, signal }))
    } catch (error) {
      if (signal?.aborted || [401, 403, 404, 410].includes(error.httpStatus) || error.code === 'OUTPUT_EXISTS') {
        throw error
      }
      info = await writeAttempt(file => streamMediaParts(url, meta, file, { partBytes, maxPartCount, signal }))
    }
  }

  return {
    path: targetPath,
    bytes: meta.size,
    sha256: meta.sha256,
    mimeType: info.mimeType ?? meta.mimeType,
    transport: info.method,
    reused: false,
  }
}
