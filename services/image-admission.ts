import fs = require('fs');
import path = require('path');
import crypto = require('crypto');
import sharp from 'sharp';
import SerialQueue = require('./serial-queue');

const queue = new SerialQueue('image-admission', 2);
const owned = /^aics_(?:video_(?:ref|input)|anima_input)_[a-f0-9]+\.(?:png|jpe?g|webp)$/i;
interface Limits { bytes?: number; files?: number }
function failure(code: string, message: string, status = 400) { return Object.assign(new Error(message), { code, status }); }

export async function validateImage(buffer: Buffer): Promise<void> {
  const options = { limitInputPixels: 32 * 1024 * 1024, failOn: 'warning' as const, animated: true };
  try {
    if (buffer.subarray(1, 4).toString() === 'PNG') {
      for (let at = 8; at + 12 <= buffer.length;) {
        const length = buffer.readUInt32BE(at);
        if (at + 12 + length > buffer.length || buffer.toString('ascii', at + 4, at + 8) === 'acTL') throw Error('invalid or animated PNG');
        at += 12 + length;
      }
    }
    const metadata = await sharp(buffer, options).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format || '') || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || (metadata.pages || 1) !== 1) throw Error('dimensions');
    // Fully validate compressed data under the pixel and time budget, without a raw output allocation.
    await sharp(buffer, options).timeout({ seconds: 5 }).stats();
  } catch { throw failure('INVALID_IMAGE', '图片损坏、动画或超出解码预算（8192 边长、32M 像素、单帧）'); }
}

/** Shared directory mutex reserves the entire scan/write interval across processes.
 * Crashed owners fail closed; never steal a lock or delete unknown user files. */
export async function storeAdmittedImage(root: string, buffer: Buffer, prefix: string, extension: string, owner: string, limits: Limits = {}, signal?: AbortSignal): Promise<string> {
  return queue.run(async () => {
    signal?.throwIfAborted();
    if (buffer.length > 20 * 1024 * 1024) throw failure('INVALID_IMAGE', '图片超过 20 MiB');
    await fs.promises.mkdir(root, { recursive: true });
    const lock = path.join(root, '.aics-image-admission.lock');
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      signal?.throwIfAborted();
      try { await fs.promises.mkdir(lock); acquired = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!acquired) throw failure('IMAGE_STORAGE_BUSY', '素材写入繁忙；若网关曾异常退出，请检查素材锁后重试。', 503);
    const temporary = path.join(lock, prefix + crypto.randomUUID() + '.tmp');
    try {
      const saltFile = path.join(root, '.aics-image-owner-salt');
      let salt: Buffer;
      try { salt = await fs.promises.readFile(saltFile); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        salt = crypto.randomBytes(32);
        await fs.promises.writeFile(saltFile, salt, { flag:'wx', mode:0o600 });
      }
      if (salt.length !== 32) throw failure('IMAGE_STORAGE_INVALID', '素材身份文件损坏，请检查后重试。', 409);
      const name = prefix + crypto.createHmac('sha256', salt).update(owner).update('\0').update(buffer).digest('hex').slice(0, 40) + '.' + extension;
      const target = path.join(root, name);
      // Verify exact bytes, not only the truncated filename hash.
      try { if ((await fs.promises.readFile(target)).equals(buffer)) return name; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let bytes = 0, files = 0;
      for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
        if (!owned.test(entry.name)) continue;
        if (!entry.isFile()) throw failure('IMAGE_STORAGE_INVALID', '素材库存在异常文件，请先检查。', 409);
        bytes += (await fs.promises.stat(path.join(root, entry.name))).size; files++;
      }
      const maxBytes = limits.bytes ?? 512 * 1024 * 1024, maxFiles = limits.files ?? 1024;
      if (bytes + buffer.length > maxBytes || files + 1 > maxFiles) throw failure('IMAGE_QUOTA', `素材额度不足（${files}/${maxFiles} 文件，${bytes}/${maxBytes} 字节）；请先检查并整理未引用素材。`, 413);
      await validateImage(buffer);
      signal?.throwIfAborted();
      await fs.promises.writeFile(temporary, buffer, { flag: 'wx' });
      signal?.throwIfAborted();
      // A hard-link publishes atomically without overwriting any existing original.
      await fs.promises.link(temporary, target);
      return name;
    } finally {
      await fs.promises.rm(temporary, { force: true });
      await fs.promises.rmdir(lock);
    }
  }, { signal });
}
