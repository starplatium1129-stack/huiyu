import fs = require('node:fs');
import zlib = require('node:zlib');
import { promisify } from 'node:util';

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);
export const COMPRESSIBLE = /\.(?:js|css|html|json|svg|txt|map)$/i;
/** Small files rarely benefit from separate compressed artifacts. */
export const MIN_BYTES = 1024;

function brotliOptions(size: number): zlib.BrotliOptions {
  return { params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
  } };
}
const GZIP_OPTIONS: zlib.ZlibOptions = { level: 9 };

export function compress(file: string) {
  const raw = fs.readFileSync(file);
  if (raw.length < MIN_BYTES) return null;

  const brotli = zlib.brotliCompressSync(raw, brotliOptions(raw.length));
  const gzip = zlib.gzipSync(raw, GZIP_OPTIONS);

  return writeArtifacts(file, raw, brotli, gzip);
}

function writeArtifacts(file: string, raw: Buffer, brotli: Buffer, gzip: Buffer) {
  // 压不小就别留，免得服务端发出比原文更大的响应
  if (brotli.length < raw.length) fs.writeFileSync(file + '.br', brotli);
  else if (fs.existsSync(file + '.br')) fs.unlinkSync(file + '.br');
  if (gzip.length < raw.length) fs.writeFileSync(file + '.gz', gzip);
  else if (fs.existsSync(file + '.gz')) fs.unlinkSync(file + '.gz');

  return { raw: raw.length, brotli: brotli.length, gzip: gzip.length };
}

/** The async path uses the same quality/options and bytes as the synchronous API. */
export async function compressAsync(file: string) {
  const raw = fs.readFileSync(file);
  if (raw.length < MIN_BYTES) return null;
  const [brotli, gzip] = await Promise.all([
    brotliCompress(raw, brotliOptions(raw.length)),
    gzipCompress(raw, GZIP_OPTIONS),
  ]);
  return writeArtifacts(file, raw, brotli, gzip);
}
