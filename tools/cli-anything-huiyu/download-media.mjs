import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { bytes, connection, exchange } from './muse.mjs'

export const RANGE_MIN = 1024 * 1024
export const PART_BYTES = 128 * 1024
export const SHA256 = /^[0-9a-f]{64}$/
export const RETRY_HTTP = new Set([408, 429, 500, 502, 503, 504])
export const LINK_UNSUPPORTED = new Set(['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])
const MEDIA_PATH = /^\/api\/muse\/(?:video\/(?:jobs|batches)\/[A-Za-z0-9_-]{1,160}\/result|gallery\/[^/?#\\]{1,512}\/file(?:\?idType=(?:string|number))?)$/
const MEDIA_RANGE_CHUNK = 4 * 1024 * 1024
const MEDIA_RELAY_PARTS = 8
const executeFile = promisify(execFile)

export const digest = data => createHash('sha256').update(data).digest('hex')

export function problem(code, message, fields) {
  return Object.assign(new Error(message), { code }, fields)
}

export function invalidOriginal() {
  return problem('RESULT_INTEGRITY_MISMATCH', '原图与回执不一致，请重新查询任务后取图。')
}

export async function statIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export async function removeFile(path) {
  await unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}

export async function withTemporaryFile(directory, data, publish) {
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

export async function moveWithoutReplacing(source, target) {
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
