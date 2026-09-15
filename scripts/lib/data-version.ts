/**
 * scripts/lib/data-version.js — DATA_VERSION 单一事实源
 *
 * 浏览器读取 data/*.json 时带 ?v=DATA_VERSION，服务端按 immutable 缓存；
 * 此处用数据内容的稳定哈希锁定版本号。任何改动 data 产物而忘了同步
 * DATA_VERSION，客户端都会命中 immutable 旧缓存。
 *
 * 调用方：
 *   - scripts/maintenance/build-scenes.js  （构建后同步）
 *   - scripts/maintenance/build-popular.js （构建后同步）
 *   - scripts/maintenance/validate-content-contracts.js （校验一致性）
 */
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

/** 哈希域 = 浏览器直接读取的 13 个 data 产物（与 validate-content-contracts.js 口径一致）。 */
const VERSIONED_FILES = [
  'scenes.json', 'scenes-index.json', 'scenes-core.json',
  'scenes-nene.json', 'scenes-natsume.json', 'scenes-shared.json',
  'curation.json', 'characters.json', 'loras.json', 'tags.json', 'presets.json',
  'popular-characters.json', 'scene-blueprints.json'
];

/** 依据当前 data 产物内容计算期望的 DATA_VERSION。 */
function expectedDataVersion(root: string) {
  const hash = crypto.createHash('sha1');
  for (const name of VERSIONED_FILES) {
    const file = path.join(root, 'data', name);
    hash.update(name + '=' + fs.readFileSync(file, 'utf8').length + ';');
    hash.update(fs.readFileSync(file));
  }
  return Number.parseInt(hash.digest('hex').slice(0, 8), 16);
}

/** 幂等同步 src/stores/sceneStore.ts 的 DATA_VERSION。返回 { wrote, version }。 */
function syncDataVersion(root: string) {
  const version = expectedDataVersion(root);
  const storeFile = path.join(root, 'src', 'stores', 'sceneStore.ts');
  const src = fs.readFileSync(storeFile, 'utf8');
  const match = /DATA_VERSION\s*=\s*(\d+)/.exec(src);
  if (match && Number(match[1]) !== version) {
    const next = src.replace(/DATA_VERSION\s*=\s*\d+/, `DATA_VERSION = ${version}`);
    fs.writeFileSync(storeFile, next, 'utf8');
    return { wrote: true, version };
  }
  return { wrote: false, version };
}

export = { VERSIONED_FILES, expectedDataVersion, syncDataVersion };
