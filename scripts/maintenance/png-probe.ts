'use strict';

const zlib: typeof import('zlib') = require('zlib');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paethPredictor(left: number, up: number, upperLeft: number) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodePng8(buffer: unknown[]) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33
    || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idatChunks: any[] = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) return null;

    const type = buffer.toString('ascii', typeStart, dataStart);
    if (type === 'IHDR') {
      if (length !== 13) return null;
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      const colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] || 0;
      if (!width || !height || bitDepth !== 8 || !channels
        || compression !== 0 || filter !== 0 || interlace !== 0) {
        return null;
      }
    } else if (type === 'IDAT') {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = chunkEnd;
  }

  if (!width || !height || !channels || !idatChunks.length) return null;

  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  } catch (error) {
    return null;
  }

  const stride = width * channels;
  if (inflated.length !== height * (stride + 1)) return null;
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const inputRow = y * (stride + 1);
    const outputRow = y * stride;
    const filterType = inflated[inputRow];
    if (filterType > 4) return null;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputRow + 1 + x];
      const left = x >= channels ? pixels[outputRow + x - channels] : 0;
      const up = y > 0 ? pixels[outputRow - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels
        ? pixels[outputRow - stride + x - channels]
        : 0;
      let value = raw;
      if (filterType === 1) value += left;
      else if (filterType === 2) value += up;
      else if (filterType === 3) value += Math.floor((left + up) / 2);
      else if (filterType === 4) value += paethPredictor(left, up, upperLeft);
      pixels[outputRow + x] = value & 0xff;
    }
  }

  function rgbAt(x: number, y: number) {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const index = (y * width + x) * channels;
    if (channels === 1 || channels === 2) {
      const gray = pixels[index];
      return [gray, gray, gray];
    }
    return [pixels[index], pixels[index + 1], pixels[index + 2]];
  }

  return { width, height, rgbAt };
}

function luminance(rgb: number[]) {
  return Math.round(rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114);
}

export = { decodePng8, luminance };
