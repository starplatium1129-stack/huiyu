'use strict';

// The outline master supplies wordmarks; the mascot master supplies app icons.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const sharp: typeof import('sharp') = require('sharp');
const ROOT = path.resolve(__dirname, '../..');

async function buildBrandAssets() {
  const master = fs.readFileSync(path.join(ROOT, 'assets/brand-mark.svg'), 'utf8');
  const outline = /<path d="([^"]+)"/.exec(master)?.[1];
  if (!outline) throw new Error('Brand outline missing');
  const mark = `<path d="${outline}" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>`;
  const svg = (viewBox: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-labelledby="title"><title id="title">绘遇 · HUIYU</title>${body}</svg>\n`;
  for (const [name, ink, accent] of [['logo', '#FFF8F4', '#F2A8BE'], ['logo-light', '#211C30', '#92365F']]) {
    const body = `<g color="${accent}" transform="translate(0 0) scale(2)">${mark}</g><g fill="${ink}"><text x="58" y="30" font-family="'Noto Serif SC','SimSun',serif" font-size="29" font-weight="700" letter-spacing="3">绘遇</text><text x="60" y="44" font-family="'Segoe UI',sans-serif" font-size="9" font-weight="600" letter-spacing="4">HUIYU</text></g>`;
    fs.writeFileSync(path.join(ROOT, `assets/${name}.svg`), svg('0 0 132 48', body));
  }
  const appIcon = path.join(ROOT, 'assets/app-icon.png');
  const faviconPng = await sharp(appIcon).resize(256, 256).png().toBuffer();
  const icon = svg('0 0 256 256', `<image width="256" height="256" href="data:image/png;base64,${faviconPng.toString('base64')}"/>`);
  fs.writeFileSync(path.join(ROOT, 'assets/favicon.svg'), icon);
  const directory = path.join(ROOT, 'desktop-tauri/src-tauri/icons');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries: any[] = [];
  for (const size of sizes) {
    const png = await sharp(appIcon).resize(size, size).png().toBuffer();
    if ([32, 64, 128, 256].includes(size)) fs.writeFileSync(path.join(directory, `icon-${size}.png`), png);
    entries.push(png);
  }
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((png: any, index: any) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([header, ...entries]));
  const controls = path.join(ROOT, 'desktop-tauri/src-tauri/installer/modern/controls.svg');
  const source = fs.readFileSync(controls, 'utf8');
  if (!/<path id="atelier" d="[^"]+"/.test(source)) throw new Error('Installer brand anchor missing');
  fs.writeFileSync(controls, source.replace(/<path id="atelier" d="[^"]+"/, `<path id="atelier" d="${outline}"`));
  console.log('HUIYU: outline wordmarks and installer mark, mascot favicon and seven-size Windows ICO generated.');
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Build HUIYU wordmarks from assets/brand-mark.svg and app icons from assets/app-icon.png. No arguments.');
  else buildBrandAssets().catch((error: any) => { console.error(error); process.exitCode = 1; });
}
export = { buildBrandAssets };
