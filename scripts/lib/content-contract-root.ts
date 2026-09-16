'use strict';

let path: typeof import('path') = require('path');

let REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * G11：内容契约校验统一数据根。
 *
 * 维护保存与 scene-store/popular-store 等库已采用 AICS_DATA_ROOT || AICS_APP_ROOT
 * || 仓库根；validate-content-contracts 此前固定仓库根，隔离夹具与替代部署形态
 * 无法校验自己的数据。该根表示完整项目布局根（含 data/assets/src/stores）：
 * 调用方必须自备全套布局文件，缺文件按缺失报错，不允许回退读取生产数据。
 * 校验规则代码（src/utils、src/config 的 TS 模块）仍按代码仓库解析，与此根无关。
 */
function resolveContentRoot(env?: NodeJS.ProcessEnv) {
  env = env || process.env;
  return path.resolve(env.AICS_DATA_ROOT || env.AICS_APP_ROOT || REPO_ROOT);
}

export = { REPO_ROOT: REPO_ROOT, resolveContentRoot: resolveContentRoot };
