#!/usr/bin/env node
'use strict';

import fs = require('node:fs');
import path = require('node:path');
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';

const RELEASE_REPOSITORY = 'starplatium1129-stack/huiyu';
const DEFAULT_TAG = 'media-packs-latest';
const PORTRAIT_FILE = /^popular-[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)$/i;
const SHOWCASE_SAMPLE = /^(?:images|thumbs)\/(?:sc\d{3,}|artist_[a-zA-Z0-9_-]+|pc_[a-zA-Z0-9_-]+|lora_[a-zA-Z0-9_-]+)\.(?:jpg|png|webp)$/i;

const HELP = `media:pack --out <输出目录> [--portraits] [--showcase-root <已发布样张目录>] [--version <版本号>] [--tag <GitHubRelease标签>] [--apply] [--publish]
默认只读预览打包清单；加 --apply 生成免重压缩 STORE ZIP、SHA-256 与 media-packs.json 索引。
  --portraits               打包 assets/characters/popular-* 高清立绘为独立立绘资源包
  --showcase-root <目录>    打包已发布的场景样张（manifest.json、images/、thumbs/）为独立样张资源包
  --out <目录>              输出目录（已存在时自动合并更新 media-packs.json 中对应包信息）
  --version <版本>          资源包版本标识（默认当日 YYYYMMDD）
  --tag <标签>              GitHub Release 标签（默认 ${DEFAULT_TAG}）
  --apply                   实际写出 ZIP 与 media-packs.json
  --publish                 通过 gh CLI 上传到 GitHub Release（需先 --apply 或目录中已有构建产物）
`;

interface PackEntry {
  source: string;
  archivePath: string;
  bytes: number;
}

interface PackRecord {
  id: 'portraits' | 'showcase';
  version: string;
  label: string;
  description: string;
  bytes: number;
  fileCount: number;
  archive: {
    fileName: string;
    url: string;
    sha256: string;
    bytes: number;
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, chunk: Buffer): number {
  let c = crc >>> 0;
  for (let i = 0; i < chunk.length; i++) {
    c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

function writeU64LE(buf: Buffer, offset: number, value: bigint) {
  buf.writeBigUInt64LE(value, offset);
}

async function writeChunk(stream: fs.WriteStream, chunk: Buffer) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

/** Stream-writes a standard ZIP (ZIP64-capable) using STORE (method 0) for already-compressed images. */
async function writeStoreZip(entries: PackEntry[], destination: string): Promise<{ bytes: number; sha256: string }> {
  const temp = `${destination}.tmp-${process.pid}`;
  const out = fs.createWriteStream(temp);
  const archiveHash = createHash('sha256');
  let offset = 0n;
  const write = async (buf: Buffer) => {
    archiveHash.update(buf);
    offset += BigInt(buf.length);
    await writeChunk(out, buf);
  };
  const centralRecords: Array<{
    nameBuf: Buffer;
    crc: number;
    size: bigint;
    localOffset: bigint;
  }> = [];

  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.archivePath, 'utf8');
      const stat = fs.lstatSync(entry.source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`拒绝打包非常规文件: ${entry.source}`);
      const size = BigInt(stat.size);
      // Pre-compute CRC32 by streaming once, then write local header + raw bytes without data descriptor.
      let crc = 0xffffffff;
      let checkedBytes = 0n;
      for await (const chunk of fs.createReadStream(entry.source, { highWaterMark: 1024 * 1024 })) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = crc32Update(crc, buf);
        checkedBytes += BigInt(buf.length);
      }
      if (checkedBytes !== size) throw new Error(`文件打包期间发生变化: ${entry.source}`);
      crc = (crc ^ 0xffffffff) >>> 0;

      const localOffset = offset;
      const needsZip64Local = size >= 0xffffffffn;
      const extra = needsZip64Local ? Buffer.alloc(20) : Buffer.alloc(0);
      if (needsZip64Local) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(16, 2);
        writeU64LE(extra, 4, size);
        writeU64LE(extra, 12, size);
      }
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(needsZip64Local ? 45 : 20, 4);
      localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
      localHeader.writeUInt16LE(0, 8); // STORE
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt16LE(0x5421, 12); // Fixed DOS date for deterministic archives
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(needsZip64Local ? 0xffffffff : Number(size), 18);
      localHeader.writeUInt32LE(needsZip64Local ? 0xffffffff : Number(size), 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(extra.length, 28);

      await write(localHeader);
      await write(nameBuf);
      if (extra.length) await write(extra);
      for await (const chunk of fs.createReadStream(entry.source, { highWaterMark: 1024 * 1024 })) {
        await write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      centralRecords.push({ nameBuf, crc, size, localOffset });
    }

    const centralStart = offset;
    for (const rec of centralRecords) {
      const needsSize64 = rec.size >= 0xffffffffn;
      const needsOffset64 = rec.localOffset >= 0xffffffffn;
      const extraFields: bigint[] = [];
      if (needsSize64) { extraFields.push(rec.size, rec.size); }
      if (needsOffset64) { extraFields.push(rec.localOffset); }
      const extra = extraFields.length ? Buffer.alloc(4 + extraFields.length * 8) : Buffer.alloc(0);
      if (extra.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(extraFields.length * 8, 2);
        extraFields.forEach((value, idx) => writeU64LE(extra, 4 + idx * 8, value));
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(extra.length ? 45 : 20, 4);
      header.writeUInt16LE(extra.length ? 45 : 20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt16LE(0x5421, 14);
      header.writeUInt32LE(rec.crc, 16);
      header.writeUInt32LE(needsSize64 ? 0xffffffff : Number(rec.size), 20);
      header.writeUInt32LE(needsSize64 ? 0xffffffff : Number(rec.size), 24);
      header.writeUInt16LE(rec.nameBuf.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(needsOffset64 ? 0xffffffff : Number(rec.localOffset), 42);
      await write(header);
      await write(rec.nameBuf);
      if (extra.length) await write(extra);
    }

    const centralSize = offset - centralStart;
    const count = BigInt(centralRecords.length);
    const needsZip64Eocd = count >= 0xffffn || centralSize >= 0xffffffffn || centralStart >= 0xffffffffn;
    if (needsZip64Eocd) {
      const zip64EocdOffset = offset;
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(0x06064b50, 0);
      writeU64LE(z64, 4, 44n);
      z64.writeUInt16LE(45, 12);
      z64.writeUInt16LE(45, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      writeU64LE(z64, 24, count);
      writeU64LE(z64, 32, count);
      writeU64LE(z64, 40, centralSize);
      writeU64LE(z64, 48, centralStart);
      await write(z64);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      writeU64LE(locator, 8, zip64EocdOffset);
      locator.writeUInt32LE(1, 16);
      await write(locator);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(count >= 0xffffn ? 0xffff : Number(count), 8);
    eocd.writeUInt16LE(count >= 0xffffn ? 0xffff : Number(count), 10);
    eocd.writeUInt32LE(centralSize >= 0xffffffffn ? 0xffffffff : Number(centralSize), 12);
    eocd.writeUInt32LE(centralStart >= 0xffffffffn ? 0xffffffff : Number(centralStart), 16);
    eocd.writeUInt16LE(0, 20);
    await write(eocd);

    out.end();
    await once(out, 'finish');
    fs.renameSync(temp, destination);
    return { bytes: Number(offset), sha256: archiveHash.digest('hex') };
  } catch (error) {
    out.destroy();
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function collectPortraits(root: string): PackEntry[] {
  const dir = path.join(root, 'assets', 'characters');
  if (!fs.existsSync(dir)) throw new Error(`找不到角色立绘目录: ${dir}`);
  const out: PackEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!PORTRAIT_FILE.test(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    out.push({ source: full, archivePath: `assets/characters/${name}`, bytes: stat.size });
  }
  if (!out.length) throw new Error('未找到可打包的 popular-* 高清立绘文件');
  return out;
}

function collectShowcase(showcaseRoot: string): PackEntry[] {
  const manifestPath = path.join(showcaseRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`样张目录缺少 manifest.json: ${showcaseRoot}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('样张 manifest.json 缺少有效的 entries 列表');
  const seen = new Set<string>();
  const out: PackEntry[] = [{ source: manifestPath, archivePath: 'manifest.json', bytes: fs.lstatSync(manifestPath).size }];
  for (const item of manifest.entries) {
    if (!item || typeof item.id !== 'string' || !item.id) {
      throw new Error('样张 manifest.json 含缺少 ID 的条目');
    }
    for (const [field, folder] of [['image', 'images'], ['thumb', 'thumbs']] as const) {
      const rel = String(item[field] || `${folder}/${item.id}.jpg`);
      if (!SHOWCASE_SAMPLE.test(rel) || !rel.startsWith(`${folder}/`)) {
        throw new Error(`样张 ${item.id} 的 ${field} 路径无效：${rel}`);
      }
      const key = rel.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const full = path.join(showcaseRoot, rel);
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`样张文件缺失或非法: ${full}`);
      out.push({ source: full, archivePath: rel, bytes: stat.size });
    }
  }
  out.sort((a, b) => a.archivePath.localeCompare(b.archivePath, 'en'));
  return out;
}

function defaultVersion(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function ghCommand(root: string): string {
  const portable = path.join(root, 'runtime/github-cli/bin/gh.exe');
  return process.env.GH_EXECUTABLE || (fs.existsSync(portable) ? portable : 'gh');
}

function publishFiles(root: string, tag: string, files: string[]) {
  const cli = ghCommand(root);
  let exists = true;
  try {
    execFileSync(cli, ['release', 'view', tag, '--repo', RELEASE_REPOSITORY, '--json', 'tagName'], { cwd: root, stdio: 'pipe', windowsHide: true });
  } catch {
    exists = false;
  }
  if (!exists) {
    execFileSync(cli, [
      'release', 'create', tag, ...files,
      '--repo', RELEASE_REPOSITORY,
      '--title', '绘遇 HUIYU · 在线资源包（立绘与样张）',
      '--notes', '供绘遇桌面端首次启动引导与控制室「资源与素材」按需下载的人像立绘包与场景样张资源库。',
      '--latest=false',
    ], { cwd: root, stdio: 'inherit', windowsHide: true });
  } else {
    execFileSync(cli, ['release', 'upload', tag, ...files, '--repo', RELEASE_REPOSITORY, '--clobber'], { cwd: root, stdio: 'inherit', windowsHide: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h') || argv.includes('--plan')) {
    console.log(HELP);
    return;
  }
  let outDir = '';
  let showcaseRoot = '';
  let includePortraits = false;
  let version = defaultVersion();
  let tag = DEFAULT_TAG;
  let apply = false;
  let publish = false;
  let root = path.resolve(__dirname, '../..');

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--portraits') includePortraits = true;
    else if (flag === '--apply') apply = true;
    else if (flag === '--publish') publish = true;
    else if (flag === '--out') outDir = argv[++i] || '';
    else if (flag === '--showcase-root') showcaseRoot = argv[++i] || '';
    else if (flag === '--version') version = argv[++i] || '';
    else if (flag === '--tag') tag = argv[++i] || '';
    else if (flag === '--root') root = path.resolve(argv[++i] || '');
    else throw new Error(`未知参数: ${flag}`);
  }
  if (!outDir) throw new Error('必须指定 --out <输出目录>');
  if (!includePortraits && !showcaseRoot) throw new Error('至少指定 --portraits 或 --showcase-root <目录> 之一');
  if (!/^[a-zA-Z0-9._-]{1,48}$/.test(version)) throw new Error(`无效版本号: ${version}`);
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(tag)) throw new Error(`无效标签名: ${tag}`);

  const resolvedOut = path.resolve(outDir);
  const plans: Array<{
    id: 'portraits' | 'showcase';
    label: string;
    description: string;
    entries: PackEntry[];
    fileName: string;
    totalBytes: number;
  }> = [];

  if (includePortraits) {
    const entries = collectPortraits(root);
    plans.push({
      id: 'portraits',
      label: '人物高清立绘包',
      description: '全部热门角色高清原画立绘，用于角色档案原画欣赏、聊天室大立绘与创作项目导入。',
      entries,
      fileName: `huiyu-pack-portraits-${version}.zip`,
      totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    });
  }
  if (showcaseRoot) {
    const entries = collectShowcase(path.resolve(showcaseRoot));
    plans.push({
      id: 'showcase',
      label: '场景样张资源库',
      description: '画册与场景浏览的高清成品样张与缩略图，离线秒看所有推荐场景成图。',
      entries,
      fileName: `huiyu-pack-showcase-${version}.zip`,
      totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    });
  }

  if (!apply) {
    console.log(JSON.stringify({
      applied: false,
      outDir: resolvedOut,
      version,
      tag,
      packs: plans.map(p => ({ id: p.id, fileName: p.fileName, fileCount: p.entries.length, rawBytes: p.totalBytes })),
    }, null, 2));
    return;
  }

  fs.mkdirSync(resolvedOut, { recursive: true });
  const indexPath = path.join(resolvedOut, 'media-packs.json');
  const existingPacks: Record<string, PackRecord> = fs.existsSync(indexPath)
    ? (JSON.parse(fs.readFileSync(indexPath, 'utf8')).packs || {})
    : {};
  const uploadList: string[] = [];

  for (const plan of plans) {
    const archivePath = path.join(resolvedOut, plan.fileName);
    console.log(`[media:pack] 正在打包 ${plan.label}（${plan.entries.length} 个文件，${(plan.totalBytes / 1024 / 1024).toFixed(1)} MiB）...`);
    const written = await writeStoreZip(plan.entries, archivePath);
    const shaPath = `${archivePath}.sha256`;
    fs.writeFileSync(shaPath, `${written.sha256}  ${plan.fileName}\n`, 'utf8');
    existingPacks[plan.id] = {
      id: plan.id,
      version,
      label: plan.label,
      description: plan.description,
      bytes: plan.totalBytes,
      fileCount: plan.entries.length,
      archive: {
        fileName: plan.fileName,
        url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(plan.fileName)}`,
        sha256: written.sha256,
        bytes: written.bytes,
      },
    };
    uploadList.push(archivePath, shaPath);
    console.log(`[media:pack] 已生成 ${plan.fileName}（${(written.bytes / 1024 / 1024).toFixed(1)} MiB，SHA256=${written.sha256.slice(0, 12)}…）`);
  }

  const indexPayload = {
    schemaVersion: 1,
    kind: 'huiyu-media-packs-index',
    updatedAt: new Date().toISOString(),
    releaseTag: tag,
    packs: existingPacks,
  };
  fs.writeFileSync(indexPath, JSON.stringify(indexPayload, null, 2) + '\n', 'utf8');
  uploadList.push(indexPath);

  if (publish) {
    console.log(`[media:pack] 正在发布到 GitHub Release ${RELEASE_REPOSITORY}@${tag} ...`);
    publishFiles(root, tag, uploadList);
    console.log('[media:pack] 发布完成。');
  }
  console.log(JSON.stringify({ applied: true, published: publish, indexPath, packs: existingPacks }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
export = { collectPortraits, collectShowcase, writeStoreZip };
