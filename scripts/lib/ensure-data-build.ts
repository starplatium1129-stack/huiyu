'use strict';

/**
 * scripts/lib/ensure-data-build.js — 数据聚合产物自愈构建
 *
 * 2026-08-28 起 data/ 下的浏览器聚合产物（scenes.json、scenes-*.json、
 * scenes-core.json、scenes-index.json、popular-characters.json）不入库：
 * Git 只版本控制语义源（data/scenes/ 组分片、data/popular/*.json、curation.json），
 * 产物由本模块按需重建。构建是确定性的（同源必同字节），因此这里不触碰
 * DATA_VERSION 口径——版本号由 Vite 的 virtual:data-version 按产物内容动态
 * 解析，自愈重建只会产出与语义源一致的字节，不需要改写任何源码。
 *
 * 调用方：
 *   - 网关启动（server.js）：陈旧即重建，自愈而非报错；
 *   - 质检套件 contract 阶段（run-quality-suite.js）：fresh clone 保底；
 *   - build-scenes/build-popular --check 的"产物缺失"分支：等价自愈。
 * 已构建但不一致的"改源忘重建"守卫不受影响（--check 仍报错）。
 *
 * 重建后刷新对应预压产物：server/precompressed.js 按文件存在即直发、
 * 无新鲜度检查，不刷新会端出陈旧 .br/.gz。
 */

const fs: typeof import('fs') = require('fs');
const {
  aggregatePath: scenesAggregatePath,
  browserShardPath,
  corePath,
  indexPath,
  loadSceneShards,
  aggregateIsCurrent: scenesIsCurrent,
  writeAggregate,
}: typeof import('./scene-store') = require('./scene-store');
const {
  aggregatePath: popularAggregatePath,
  aggregateIsCurrent: popularIsCurrent,
  writePopularAggregate,
}: typeof import('./popular-store') = require('./popular-store');
const {
  aggregatePath: blueprintsAggregatePath,
  aggregateIsCurrent: blueprintsIsCurrent,
  writeBlueprintAggregate,
  loadBlueprintShards,
}: typeof import('./blueprint-store') = require('./blueprint-store');

/** 复用 precompress.js 的压缩参数（质量 11 brotli / level 9 gzip / MIN_BYTES），
 *  单一事实源防漂移；缺失（如精简安装）时只跳过刷新，不阻塞重建。 */
function refreshPrecompressed(files: string[]) {
  let compress;
  try {
    ({ compress } = (require('../maintenance/precompress') as typeof import('../maintenance/precompress')));
  } catch (error) {
    return;
  }
  for (const file of files) {
    try {
      compress(file);
    } catch (error) {
      // 预压失败只影响传输体积，中间件会回退明文，不阻塞自愈
    }
  }
}

function ensureScenesBuilt({ onlyIfMissing = false }: any = {}) {
  if (onlyIfMissing && fs.existsSync(scenesAggregatePath)) return { rebuilt: false };
  const { scenes } = loadSceneShards();
  if (scenesIsCurrent(scenes)) return { rebuilt: false };
  writeAggregate(scenes);
  refreshPrecompressed([
    scenesAggregatePath,
    browserShardPath.nene,
    browserShardPath.natsume,
    browserShardPath.shared,
    corePath,
    indexPath,
  ]);
  return { rebuilt: true, count: scenes.length };
}

function ensurePopularBuilt({ onlyIfMissing = false }: any = {}) {
  if (onlyIfMissing && fs.existsSync(popularAggregatePath)) return { rebuilt: false };
  if (popularIsCurrent()) return { rebuilt: false };
  const count = writePopularAggregate();
  refreshPrecompressed([popularAggregatePath]);
  return { rebuilt: true, count };
}

function ensureBlueprintsBuilt({ onlyIfMissing = false }: any = {}) {
  if (onlyIfMissing && fs.existsSync(blueprintsAggregatePath)) return { rebuilt: false };
  if (blueprintsIsCurrent()) return { rebuilt: false };
  loadBlueprintShards(); // 分片损坏会在此抛出（见下方注释）；聚合由 writeBlueprintAggregate 内部自取
  const count = writeBlueprintAggregate();
  refreshPrecompressed([blueprintsAggregatePath]);
  return { rebuilt: true, count };
}

/** 场景 + 热门角色 + 蓝图三个产物面一起自愈；任一面源分片损坏会抛出，由调用方决定降级策略。
 *
 *  - 默认（网关启动）：陈旧即重建——运行时必须拿到与语义源一致的数据；
 *  - onlyIfMissing（门禁/测试套件）：产物缺失（fresh clone）才构建，
 *    已构建但陈旧时不动手——"改源忘重建"必须继续由 --check 门禁报红，
 *    自愈不能把守卫静默抹掉。 */
function ensureAll({ onlyIfMissing = false }: any = {}) {
  const scenes = ensureScenesBuilt({ onlyIfMissing });
  const popular = ensurePopularBuilt({ onlyIfMissing });
  const blueprints = ensureBlueprintsBuilt({ onlyIfMissing });
  return { scenes, popular, blueprints };
}

export = { ensureAll, ensurePopularBuilt, ensureScenesBuilt, ensureBlueprintsBuilt };
