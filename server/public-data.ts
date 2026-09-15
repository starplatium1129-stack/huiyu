'use strict';

/**
 * server/public-data.js — /data 路由公开白名单的唯一来源（2026-08-21 收口）。
 *
 * 此前 server.js 与 server/precompressed.js 各持一份拷贝，新增公开数据文件时
 * 极易漏改其一：漏掉 server.js 侧则明文 404，漏掉 precompressed 侧则预压产物
 * 静默不生效——而 precompressed 在 /data 白名单路由之前执行，两份不一致时
 * 以更严格者为准不会泄露，但优化会静默失效。收口为单一模块后两侧必然同步。
 */

let PUBLIC_DATA_FILES = [
  'scenes.json', 'scenes-index.json', 'scenes-core.json',
  'scenes-nene.json', 'scenes-natsume.json', 'scenes-shared.json',
  'curation.json', 'characters.json',
  'loras.json', 'tags.json', 'presets.json',
  'popular-characters.json', 'scene-blueprints.json',
  // 角色参考标准（前端 characterReferenceData.ts 运行时加载，2026-08-21 起
  // 从内嵌 TS 字面量外移至此；45 角色 / 900+ 参考项，~342KB 不进 JS bundle）
  'character-reference-view.json'
];

export = Object.freeze(PUBLIC_DATA_FILES.slice());
