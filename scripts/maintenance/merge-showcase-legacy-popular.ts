'use strict';
/**
 * 2026-08-18 发布后合并：把旧版 showcase 的全部 popular 条目（pc_*）并入新版 manifest。
 *
 * 背景：publish-popular-showcase.js 的 buildManifest 会丢弃 source 目录所有旧 popular 条目
 * （只保留 scene/artist/lora + 新生成的 popular），因此本次只发布 9 位新角色缺失样张时，
 * 必须把线上 394 个旧 pc_* 条目合并回来，并复制对应图片/缩略图，避免旧角色样张丢失。
 *
 * Usage:
 *   node scripts/maintenance/merge-showcase-legacy-popular.js \
 *       --legacy <旧版目录 manifest.json> --target <新版目录> [--apply]
 */
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOWCASE_ROOT = path.resolve(ROOT, '..', 'AI', 'SceneShowcase');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

const legacyManifestFile = path.resolve(argument('--legacy', path.join(SHOWCASE_ROOT, '2026-08-15_v23', 'manifest.json')));
const targetDir = path.resolve(argument('--target', ''));
const apply = process.argv.includes('--apply');

if (!targetDir) throw new Error('--target <新版目录> 必填');
const targetManifestFile = path.join(targetDir, 'manifest.json');
if (!fs.existsSync(targetManifestFile)) throw new Error(`target has no manifest.json: ${targetManifestFile}`);

const legacy = readJson(legacyManifestFile);
const target = readJson(targetManifestFile);

const legacyPopular = (legacy.entries || []).filter(e => isRecord(e) && e.type === 'popular');
const targetPopularIds = new Set((target.entries || []).filter(e => isRecord(e) && e.type === 'popular').map(e => e.id));

// 旧条目中尚未出现在新版的 popular 条目（按 id 去重）
const merged = legacyPopular.filter(e => !targetPopularIds.has(e.id));
console.log(`legacy popular: ${legacyPopular.length} | already in target: ${legacyPopular.length - merged.length} | to merge: ${merged.length}`);

if (apply) {
  // 复制旧条目的 image/thumb 到新版目录
  const legacyDir = path.dirname(legacyManifestFile);
  let copied = 0;
  for (const e of merged) {
    for (const rel of [e.image, e.thumb]) {
      if (!rel) continue;
      const src = path.join(legacyDir, rel.split('/').join(path.sep));
      const dst = path.join(targetDir, rel.split('/').join(path.sep));
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied++;
      }
    }
  }
  console.log(`copied legacy assets: ${copied}`);

  // 合并 manifest 条目并重算统计
  const entries = [...(target.entries || []), ...merged];
  const typeCounts = { scene: 0, artist: 0, popular: 0, lora: 0 };
  for (const e of entries) if (isRecord(e) && typeCounts[e.type] !== undefined) typeCounts[e.type] += 1;
  const counts = { All: 0, R15: 0, R18: 0 };
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const rating = e.rating === 'R15' || e.rating === 'R18' ? e.rating : 'All';
    counts[rating] += 1;
  }
  target.entries = entries;
  target.entryCount = entries.length;
  target.sceneCount = typeCounts.scene;
  target.typeCounts = typeCounts;
  target.counts = counts;
  target.updatedAt = new Date().toISOString();
  writeJsonAtomic(targetManifestFile, target);
  console.log('merged manifest written:', targetManifestFile);
  console.log('final entries:', entries.length, '| typeCounts:', JSON.stringify(typeCounts));
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
