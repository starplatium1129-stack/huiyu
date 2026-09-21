import { errorMessage as runtimeErrorMessage } from '../../scripts/lib/runtime-errors';
'use strict';

/**
 * routes/video/batch.js —— 分镜批量服务（P5 批量生成 / P6 尾帧衔接 / P8 拼接）。
 *
 * 一次提交一组镜头：服务端逐镜排队生成（尊重 MAX_PENDING 与 16GB 显存，绝不
 * 并行多任务抢显存），单镜失败不打断整批，可在批内单独重抽；linkLastFrame 时
 * 用上一镜结果尾帧衔接下一镜（有首帧 → FL2VA 尾帧；无首帧 → 续接为 I2VA 首帧），
 * 全批成功后可用 ffmpeg 拼接成片（P8）。
 */

let childProcess: typeof import('child_process') = require('child_process');
let crypto: typeof import('crypto') = require('crypto');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let errors: typeof import('./errors') = require('./errors');
let constants: typeof import('./constants') = require('./constants');
let media: typeof import('./media') = require('./media');
let validation: typeof import('./validation') = require('./validation');

let serviceError = errors.serviceError;
let MODEL_BY_ID = constants.MODEL_BY_ID;
let IMAGE_INPUT_PREFIX = constants.IMAGE_INPUT_PREFIX;
let BATCH_TTL_MS = constants.BATCH_TTL_MS;
let BATCH_JOB_TTL_MS = constants.BATCH_JOB_TTL_MS;

function createBatchService(config: any, videoService: any, dependencies: any) {
  dependencies = dependencies || {};
  let batches = new Map();
  let closed = false;
  let pollIntervalMs = dependencies.batchPollIntervalMs || 2000;
  // ffmpeg 命令可注入（测试替身）；缺省走 child_process.execFile。
  let runFfmpeg = dependencies.runFfmpeg || function (args: readonly string[]|null|undefined) {
    return new Promise(function (resolve, reject) {
      childProcess.execFile('ffmpeg', args, { maxBuffer:8 * 1024 * 1024 }, function (error, stdout, stderr) {
        if (error) reject(new Error('ffmpeg 执行失败: ' + String(stderr || error.message).slice(0, 300)));
        else resolve(stdout);
      });
    });
  };

  function publicShot(shot: any) {
    return {
      index:shot.index,
      status:shot.status,
      prompt:shot.input.originalPrompt,
      dialogue:shot.input.dialogue || null,
      shotSize:shot.input.shotSize || null,
      camera:shot.input.camera,
      motion:shot.input.motion,
      duration:shot.input.duration,
      seed:shot.input.seed,
      attempts:shot.attempts,
      error:shot.error || null,
      code:shot.errorCode || null,
      resultAvailable:Boolean(shot.job && shot.job.result),
      resultUrl:shot.job && shot.job.result
        ? '/api/video/jobs/' + encodeURIComponent(shot.job.id) + '/result'
        : null,
    };
  }

  function publicBatch(batch: any) {
    let total = batch.shots.length;
    let succeeded = batch.shots.filter(function (s: { status: string; }) { return s.status === 'succeeded'; }).length;
    let failed = batch.shots.filter(function (s: { status: string; }) { return s.status === 'failed'; }).length;
    return {
      id:batch.id,
      status:batch.status,
      modelId:batch.modelId,
      aspectRatio:batch.aspectRatio,
      quality:batch.quality,
      steps:batch.steps,
      linkLastFrame:batch.linkLastFrame,
      progress:{ total:total, succeeded:succeeded, failed:failed },
      createdAt:batch.createdAt,
      shots:batch.shots.map(publicShot),
      concatAvailable:Boolean(batch.concat),
      concatUrl:batch.concat ? '/api/video/batches/' + encodeURIComponent(batch.id) + '/result' : null,
    };
  }

  function get(id: any, owner: any) {
    let batch = batches.get(String(id || ''));
    return batch && batch.owner === owner ? batch : null;
  }

  // 从上一镜结果 MP4 抽取尾帧 → 受控输入文件（供下一镜 FL2VA 尾帧 / I2VA 首帧）。
  async function extractLastFrame(shot: any) {
    if (!shot.job || !shot.job.result || !shot.job.result.path) return null;
    let name = IMAGE_INPUT_PREFIX + crypto.randomBytes(8).toString('hex') + '.png';
    let root = media.imageInputRoot(config);
    let target = path.resolve(root, name);
    if (target.indexOf(path.resolve(root) + path.sep) !== 0) return null;
    try {
      await runFfmpeg(['-y', '-sseof', '-0.1', '-i', shot.job.result.path, '-frames:v', '1', '-update', '1', target]);
    } catch (error) {
      console.warn('[video] 尾帧抽取失败（镜头 ' + shot.index + '）：' + runtimeErrorMessage(error));
      return null;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).size) return null;
    return name;
  }

  // 批状态收敛：无待处理/运行中镜头时定终态；否则继续推进下一镜。
  function finalizeStatus(batch: { shots: any[]; status: string; }) {
    let pending = batch.shots.some(function (s: { status: string; }) { return s.status === 'pending'; });
    let active = batch.shots.some(function (s: { status: string; }) { return s.status === 'queued' || s.status === 'running'; });
    if (!pending && !active) {
      let allSucceeded = batch.shots.every(function (s: { status: string; }) { return s.status === 'succeeded'; });
      let allTerminal = batch.shots.every(function (s: { status: string; }) {
        return s.status === 'succeeded' || s.status === 'cancelled';
      });
      batch.status = allSucceeded ? 'done' : (allTerminal ? 'cancelled' : 'paused');
      return;
    }
    void kick(batch);
  }

  // linkLastFrame 衔接可能在提交前改写了 image/lastFrame（上一镜尾帧）：
  // 提示词必须按当前输入模式重新组装（官方参考图指令随 I2VA/FL2VA/L2VA 变化），
  // seed 显式传回保证确定性（重抽/重试不换随机种子）。
  function recomposeInput(input: any, batch: any, config: any) {
    let body: any = {
      prompt:input.originalPrompt,
      modelId:batch.modelId,
      aspectRatio:batch.aspectRatio,
      duration:input.duration,
      camera:input.camera,
      motion:input.motion,
      seed:input.seed,
      quality:input.quality,
      image:input.image || undefined,
      lastFrame:input.lastFrame || undefined,
      references:input.references || undefined,
      dialogue:input.dialogue || undefined,
      dialogueLang:input.dialogueLang || undefined,
      shotSize:input.shotSize || undefined,
    };
    if (input.negative) body.negative = input.negative;
    if (batch.modelId === 'minimax-h3' && input.steps) body.steps = input.steps;
    if (batch.adultEnabled === true) body.adultEnabled = true;
    return Object.assign({}, validation.validateInput(body, config, batch.accessContext || { isLocal:false }));
  }

  function scheduleWatch(batch: any) {
    if (closed || batch.status === 'cancelled' || batch.watchTimer) return;
    let tick = async function () {
      batch.watchTimer = null;
      if (closed || batch.status === 'cancelled') return;
      let shot = batch.shots.find(function (s: any) {
        return s.job && (s.status === 'queued' || s.status === 'running');
      });
      if (!shot) return;
      let job = videoService.get(shot.job.id, batch.owner);
      if (!job) {
        shot.status = 'failed';
        shot.error = '任务记录已过期';
        shot.errorCode = 'JOB_EXPIRED';
        finalizeStatus(batch);
        return;
      }
      if (job.status === 'succeeded') {
        shot.status = 'succeeded';
        let next = batch.shots[shot.index]; // index 从 1 开始 → 数组下一项
        if (batch.linkLastFrame && next && next.status === 'pending') {
          // 带参考图（Ref2VA 角色卡）的镜头不做尾帧衔接：上一镜末帧作为 Hybrid
          // 首帧会以像素锚定覆盖 <Picture N> 参考，导致角色切换镜头被前一角色
          // 污染（2026-08-17 实锤：宁宁末帧喂给夏目读信镜头，夏目被画成白发）。
          // 参考卡镜头保持纯 Ref2VA，身份由 <Picture N> 专属锚定。
          if (next.input && next.input.references && next.input.references.length) {
            finalizeStatus(batch);
            return;
          }
          let name = await extractLastFrame(shot);
          if (name) {
            if (next.input.image) next.input.lastFrame = name;
            else next.input.image = name;
          }
        }
        finalizeStatus(batch);
        return;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        shot.status = job.status;
        shot.error = job.error;
        shot.errorCode = job.errorCode;
        finalizeStatus(batch);
        return;
      }
      batch.watchTimer = setTimeout(tick, pollIntervalMs);
      if (batch.watchTimer.unref) batch.watchTimer.unref();
    };
    batch.watchTimer = setTimeout(tick, pollIntervalMs);
    if (batch.watchTimer.unref) batch.watchTimer.unref();
  }

  async function kick(batch: any) {
    if (closed || batch.status === 'cancelled' || batch.kicking) return;
    let shot = batch.shots.find(function (s: { status: string; }) { return s.status === 'pending'; });
    if (!shot) {
      finalizeStatus(batch);
      return;
    }
    batch.kicking = true;
    try {
      shot.input = recomposeInput(shot.input, batch, config);
      let job = videoService.create(shot.input, batch.owner, { ttlMs:BATCH_JOB_TTL_MS });
      shot.job = job;
      shot.attempts += 1;
      shot.status = 'queued';
      await videoService.submit(job);
      scheduleWatch(batch);
    } catch (error: any) {
      shot.status = 'failed';
      shot.error = error && error.message || '分镜提交失败';
      shot.errorCode = error && error.code || 'BATCH_SUBMIT_FAILED';
      if (shot.job) {
        try { await videoService.cancel(shot.job); } catch (cancelError) {}
        shot.job = null;
      }
      finalizeStatus(batch);
    } finally {
      batch.kicking = false;
    }
  }

  function removeBatch(batch: any) {
    if (batch.watchTimer) clearTimeout(batch.watchTimer);
    if (batch.gcTimer) clearTimeout(batch.gcTimer);
    if (batch.concat && batch.concat.path) {
      try { fs.unlinkSync(batch.concat.path); } catch (error) {}
    }
    batches.delete(batch.id);
  }

  async function create(owner: any, batchInput: any) {
    let availability = media.modelAvailability(config, MODEL_BY_ID[batchInput.modelId]);
    if (!availability.available) {
      throw serviceError(503, 'VIDEO_MODEL_UNAVAILABLE', '视频模型文件尚未安装', {
        missing:availability.missing,
      });
    }
    let id = crypto.randomBytes(18).toString('hex');
    let batch: any = {
      id:id,
      owner:owner,
      status:'running',
      modelId:batchInput.modelId,
      aspectRatio:batchInput.aspectRatio,
      quality:batchInput.quality,
      steps:batchInput.steps,
      linkLastFrame:batchInput.linkLastFrame,
      adultEnabled:batchInput.adultEnabled === true,
      accessContext:batchInput.accessContext || Object.freeze({ isLocal:false }),
      shots:batchInput.shots.map(function (entry: any, index: number) {
        return {
          index:index + 1,
          input:entry.input,
          status:'pending',
          attempts:0,
          error:null,
          errorCode:null,
          job:null,
        };
      }),
      createdAt:Date.now(),
      concat:null,
      watchTimer:null,
      gcTimer:null,
      kicking:false,
    };
    batches.set(id, batch);
    batch.gcTimer = setTimeout(function () { removeBatch(batch); }, BATCH_TTL_MS);
    if (batch.gcTimer.unref) batch.gcTimer.unref();
    void kick(batch);
    return batch;
  }

  async function cancel(batch: { status: string; watchTimer: string|number|NodeJS.Timeout|null|undefined; shots: string|any[]; }) {
    if (batch.status === 'done') return batch;
    batch.status = 'cancelled';
    if (batch.watchTimer) { clearTimeout(batch.watchTimer); batch.watchTimer = null; }
    for (let i = 0; i < batch.shots.length; i += 1) {
      let shot: any = batch.shots[i];
      if (shot.status === 'pending') shot.status = 'cancelled';
      else if (shot.status === 'queued' || shot.status === 'running') {
        if (shot.job) {
          try { await videoService.cancel(shot.job); } catch (error) {}
        }
        if (shot.status !== 'cancelled') {
          shot.status = 'cancelled';
          shot.error = '任务已取消';
          shot.errorCode = 'VIDEO_CANCELLED';
        }
      }
    }
    return batch;
  }

  async function retryShot(batch: { shots: { [x: string]: any; }; status: string; }, index: string|number) {
    let shot: any = batch.shots[index];
    if (!shot) throw serviceError(404, 'SHOT_NOT_FOUND', '分镜不存在');
    if (shot.status !== 'failed' && shot.status !== 'cancelled') {
      throw serviceError(409, 'BATCH_SHOT_NOT_RETRYABLE', '只有失败或取消的分镜可以重抽');
    }
    shot.status = 'pending';
    shot.error = null;
    shot.errorCode = null;
    shot.job = null;
    batch.status = 'running';
    void kick(batch);
    return batch;
  }

  async function concat(batch: any) {
    if (batch.concat) return batch.concat;
    let succeeded = batch.shots.filter(function (s: { status: string; }) { return s.status === 'succeeded'; });
    if (succeeded.length < 2) {
      throw serviceError(409, 'BATCH_CONCAT_NEEDS_SHOTS', '至少需要两个成功分镜才能拼接');
    }
    let root = media.ensureMediaRoot(config);
    let listPath = path.join(root, 'batch_' + batch.id + '.txt');
    let lines = succeeded.map(function (shot: any) {
      return "file '" + String(shot.job.result.path).replace(/'/g, "'\\''") + "'";
    });
    fs.writeFileSync(listPath, lines.join('\n') + '\n');
    let target = path.join(root, 'batch_' + batch.id + '.mp4');
    // 2026-08-16 真机实测：H3 输出画布可能与请求画布有 ±几像素漂移（如 832×480 →
    // 832×509），逐镜拼接必须 scale+pad 归一化到批量画布，否则成片分辨率逐段漂移。
    let canvas = batch.shots[0].input;
    let args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', 'scale=' + canvas.width + ':' + canvas.height + ':force_original_aspect_ratio=decrease,pad=' + canvas.width + ':' + canvas.height + ':(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', target];
    try {
      await runFfmpeg(args);
    } catch (error) {
      // 部分镜头可能无音轨导致音频编码失败：去掉音频轨重试（纯视频拼接）。
      console.warn('[video] 带音轨拼接失败，回退纯视频拼接：' + runtimeErrorMessage(error));
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf', 'scale=' + canvas.width + ':' + canvas.height + ':force_original_aspect_ratio=decrease,pad=' + canvas.width + ':' + canvas.height + ':(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
        '-an', target]);
    } finally {
      try { fs.unlinkSync(listPath); } catch (error) {}
    }
    if (!fs.existsSync(target) || !fs.statSync(target).size) {
      throw serviceError(500, 'BATCH_CONCAT_FAILED', '视频拼接失败');
    }
    batch.concat = { path:target, mime:'video/mp4' };
    return batch.concat;
  }

  function close() {
    closed = true;
    batches.forEach(removeBatch);
  }

  return {
    create:create,
    get:get,
    cancel:cancel,
    retryShot:retryShot,
    concat:concat,
    publicBatch:publicBatch,
    close:close,
  };
}

export = { createBatchService:createBatchService };
