'use strict';

/**
 * routes/video/constants.js —— 视频链路纯数据表：请求上限、受控前缀、TTL、
 * 输出节点契约、负面清单与画质/时长目录。零副作用，供各子模块共享。
 *
 * 模型目录：2026-08-21 起由 server/video-model-catalog.js 承载，此处转出口。
 */

let modelCatalog: typeof import('../../server/video-model-catalog') = require('../../server/video-model-catalog');

// ── 请求与资源上限 ──────────────────────────────────────────────
let MAX_BODY = '32kb';
let MAX_PENDING = 2;
let MAX_PROMPT_LENGTH = 4000;
let MAX_NEGATIVE_LENGTH = 2000;
let MAX_VIDEO_BYTES = 256 * 1024 * 1024;
let MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// 首帧图片写入 ComfyUI/input 的受控前缀；任务结束/网关启动时清理。
let IMAGE_INPUT_PREFIX = 'aics_video_input_';
// 参考图（Ref2VA 角色卡）独立前缀：网关启动清理只删首帧孤儿（aics_video_input_），
// 参考图是跨任务长期资产，不能被启动清理误删（2026-08-17 短片流水线实锤）。
let IMAGE_REF_PREFIX = 'aics_video_ref_';

// （原 JOB_TIMEOUT_MS 已废弃：2026-08-17 起动态超时 = 预估时长 × 3、下限 10 分钟，
// 见 createVideoService/create() 内 deadline 注释）
let JOB_TTL_MS = 2 * 60 * 60 * 1000;
// 分镜批量（P5）：单批镜头数、请求体上限、批量记录 TTL。
let MAX_BATCH_SHOTS = 30;
let MAX_BATCH_BODY = '1mb';
let BATCH_TTL_MS = 24 * 60 * 60 * 1000;
let BATCH_JOB_TTL_MS = 24 * 60 * 60 * 1000;
let POLL_INTERVAL_MS = 1000;

// 输出契约：SaveVideo 节点固定在 '11'，文件名前缀固定 aics_video。
let OUTPUT_NODE_ID = '11';
let OUTPUT_FILENAME_PREFIX = 'aics_video';

// ── 目录数据 ────────────────────────────────────────────────────
let MODEL_CATALOG = modelCatalog.MODEL_CATALOG;
let MODEL_BY_ID = modelCatalog.MODEL_BY_ID;

let WAN_NEGATIVE = [
  '色调艳丽', '过曝', '静态', '细节模糊不清', '字幕', '水印',
  '整体发灰', '最差质量', '低质量', 'JPEG压缩残留',
  '肢体畸形', '多余的手指', '画得不好的手部', '画得不好的脸部',
  '静止不动的画面', '杂乱的背景',
].join('，');

let ASPECTS = Object.freeze({
  landscape:{ width:832, height:480, label:'横屏 16:9' },
  portrait:{ width:480, height:832, label:'竖屏 9:16' },
  square:{ width:640, height:640, label:'方形 1:1' },
});

// 画质档位（16GB 显存实测区间 0.2—0.5MP；h3lite 部署矩阵与官方 ResolutionSelector
// 对齐：0.4MP 是官方常规画布，0.5MP 是 16GB 探索上限，720p(≈0.9MP) 需大显存或超分）。
// 所有尺寸均为 32 倍数、短边 ≤768、面积 ≤768×1344。
let QUALITIES = Object.freeze({
  fast:Object.freeze({
    label:'快速',
    summary:'约 1—2 分钟/条 · 试镜与找方向',
    sizes:Object.freeze({
      landscape:Object.freeze({ width:608, height:352 }),
      portrait:Object.freeze({ width:352, height:608 }),
      square:Object.freeze({ width:448, height:448 }),
    }),
  }),
  standard:Object.freeze({
    label:'标准',
    summary:'约 2.5—4.5 分钟/条 · 日常主力（官方常规画布）',
    sizes:Object.freeze({
      landscape:Object.freeze({ width:832, height:480 }),
      portrait:Object.freeze({ width:480, height:832 }),
      square:Object.freeze({ width:640, height:640 }),
    }),
  }),
  fine:Object.freeze({
    label:'精细',
    summary:'约 3.5—6 分钟/条 · 16GB 上限档',
    sizes:Object.freeze({
      landscape:Object.freeze({ width:960, height:544 }),
      portrait:Object.freeze({ width:544, height:960 }),
      square:Object.freeze({ width:768, height:768 }),
    }),
  }),
});

let DURATIONS = Object.freeze({
  3:{ seconds:3, frames:73 },
  5:{ seconds:5, frames:121 },
});

// H3 长镜档：10s/15s 在模型训练区间（124–362 帧）内；16GB 显存可行性
// 2026-08-16 真机实测确认（std10 ≈ 7 分钟，std15 ≈ 11 分钟，见 roadmap）。
// Wan 5B 仍只支持 3/5。
let H3_EXTRA_DURATIONS = new Set([10, 15]);

export = {
  MAX_BODY:MAX_BODY,
  MAX_PENDING:MAX_PENDING,
  MAX_PROMPT_LENGTH:MAX_PROMPT_LENGTH,
  MAX_NEGATIVE_LENGTH:MAX_NEGATIVE_LENGTH,
  MAX_VIDEO_BYTES:MAX_VIDEO_BYTES,
  MAX_IMAGE_BYTES:MAX_IMAGE_BYTES,
  IMAGE_INPUT_PREFIX:IMAGE_INPUT_PREFIX,
  IMAGE_REF_PREFIX:IMAGE_REF_PREFIX,
  JOB_TTL_MS:JOB_TTL_MS,
  MAX_BATCH_SHOTS:MAX_BATCH_SHOTS,
  MAX_BATCH_BODY:MAX_BATCH_BODY,
  BATCH_TTL_MS:BATCH_TTL_MS,
  BATCH_JOB_TTL_MS:BATCH_JOB_TTL_MS,
  POLL_INTERVAL_MS:POLL_INTERVAL_MS,
  OUTPUT_NODE_ID:OUTPUT_NODE_ID,
  OUTPUT_FILENAME_PREFIX:OUTPUT_FILENAME_PREFIX,
  MODEL_CATALOG:MODEL_CATALOG,
  MODEL_BY_ID:MODEL_BY_ID,
  WAN_NEGATIVE:WAN_NEGATIVE,
  ASPECTS:ASPECTS,
  QUALITIES:QUALITIES,
  DURATIONS:DURATIONS,
  H3_EXTRA_DURATIONS:H3_EXTRA_DURATIONS,
};
