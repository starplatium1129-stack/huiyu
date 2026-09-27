'use strict';

// Both showcase publishers use the same image sizing and isolated Python conversion.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');

const IMAGE_BOX = '1800x2400';

const IMAGE_QUALITY = 94;

const THUMB_BOX = '480x640';

const THUMB_QUALITY = 85;

function convertImages(python: any, sourceFile: any, imageOut: any, thumbOut: any) {
  const result = spawnSync(python, [
    path.join(ROOT, 'scripts', 'maintenance', 'convert-showcase-image.py'),
    sourceFile,
    imageOut,
    thumbOut,
    '--image-box', IMAGE_BOX,
    '--image-quality', String(IMAGE_QUALITY),
    '--thumb-box', THUMB_BOX,
    '--thumb-quality', String(THUMB_QUALITY),
  ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (result.error) throw new Error(`image conversion could not run (${python}): ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`image conversion failed for ${sourceFile}:\n${result.stderr || result.stdout || 'unknown error'}`);
  }
  for (const out of [imageOut, thumbOut]) {
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      throw new Error(`image conversion produced no output: ${out}`);
    }
  }
}

export = { IMAGE_BOX, IMAGE_QUALITY, THUMB_BOX, THUMB_QUALITY, convertImages };
