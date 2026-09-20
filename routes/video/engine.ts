import type { VideoConfig } from './types';
import comfy = require('./comfy');
import workflows = require('./workflows');

// T8 双时钟采样路径可用性（2026-08-16）：MiniMaxH3DualClockSamplerT8 +
// MiniMaxH3AudioConditioningT8 + MiniMaxH3AVDecodeT8 + 4 步加速 LoRA。
// 真机基准（4070 Ti SUPER）：standard 5s 228s → 4 步 90s / 8 步 110s（≈2.5×），
// 画质抽查可接受；无 T8 节点时回退原生采样器路径（8 步 LoRA）。
// 模块默认 false：单元/网关测试（mock 无 T8）走原生路径不受影响；
// 生产由 createVideoRouter 启动时探测真实 ComfyUI 后置 true。
// 2026-08-17 修复：探测结果此前「启动时一次性、永不刷新」——3123 启动时
// ComfyUI 未就绪/被卡死任务占满会导致探测失败并永久缓存 false，此后所有
// 视频任务错走原生慢路径（15s 503s vs T8 272s）。现在提交任务前带 TTL 重探。
let t8Available = false;
let t8ProbeAt = 0;
let T8_PROBE_TTL_MS = 60 * 1000;
function setT8Available(value: boolean) {
  t8Available = Boolean(value);
}
async function probeT8Nodes(config: VideoConfig) {
  try {
    // object_info 返回 { <nodeName>: {...} }；必须确认节点键真实存在
    // （mock 对任意路径返回 200 {} 时不得误判为可用）。
    let data: unknown = await comfy.requestComfyJson(config, 'GET', '/object_info/MiniMaxH3DualClockSamplerT8', null, 10000);
    setT8Available(Boolean(data && typeof data === 'object' && 'MiniMaxH3DualClockSamplerT8' in data && data.MiniMaxH3DualClockSamplerT8));
    if (t8Available) {
      console.log('[video] T8 双时钟采样路径可用（4 步加速 LoRA + DualClock）');
    } else {
      console.warn('[video] T8 双时钟节点不可用，回退原生采样路径');
    }
  } catch (error) {
    setT8Available(false);
    console.warn('[video] T8 双时钟节点不可用，回退原生采样路径');
  }
}
// 提交前确保探测是最新的：T8 未启用且超过 TTL 时重探一次（ComfyUI 恢复或
// 节点就绪后，第一次提交自动重新发现 T8，不再需要重启网关）。
async function ensureT8Probe(config: VideoConfig) {
  if (t8Available) return;
  if (Date.now() - t8ProbeAt < T8_PROBE_TTL_MS) return;
  t8ProbeAt = Date.now();
  await probeT8Nodes(config);
}

// 视频任务预估时长（秒）：帧数 × 步数 × 每帧每步耗时 + 加载/编码余量。
// 真机校准（4070 Ti SUPER）：T8 双时钟 ≈ 0.125s/帧/步（15s 4 步实测 272s），
// 原生采样 ≈ 0.25s/帧/步（15s 4 步实测 489s，含模型换入）；余量 90s 覆盖
// 模型加载与首帧编码。用于：真实进度外推（替代固定 0.12）、卡死预警
// （elapsed > 预估 × 1.5 提示异常）、动态超时（deadline = 预估 × 3）。
// 依赖本文件的 T8 探测状态，故留在编排层而非 workflows 纯函数模块。
let H3_PER_FRAME_STEP_SECONDS = { t8:0.125, native:0.25 };
let H3_ESTIMATE_MARGIN_SECONDS = 90;
function estimateH3Seconds(input: { frames: number; steps: number; }) {
  let rate = t8Available
    ? H3_PER_FRAME_STEP_SECONDS.t8
    : H3_PER_FRAME_STEP_SECONDS.native;
  return Math.round(input.frames * input.steps * rate) + H3_ESTIMATE_MARGIN_SECONDS;
}

// 工作流分派包装：把当前 T8 探测状态注入纯函数构建器（workflows 模块无状态）。
// 导出同名函数保持测试面不变（setT8Available → buildWorkflow 即时生效）。
function buildWorkflow(input: { modelId: string|number; }) {
  return workflows.buildWorkflow(input, { t8Available:t8Available });
}


export = { setT8Available, probeT8Nodes, ensureT8Probe, estimateH3Seconds, buildWorkflow, isT8Available: () => t8Available };
