'use strict';

import type { SnapshotJob, JobSnapshot, JobSnapshotStore } from './job-types';

/**
 * server/job-snapshot.js —— 长任务快照存根（2026-08-27 P1 审计项）。
 *
 * 视频等任务的注册表均为内存 Map（server/job-runner.js）。网关被强杀或崩溃时，
 * 进行中的任务 id 全部失联：前端轮询只能拿到 404 JOB_NOT_FOUND，十几分钟的
 * 视频批任务对用户是断崖。本模块把「任务存在过」这一最小事实落盘：
 *
 * - save/remove 挂在任务创建与 removeJob（TTL 清理 / 显式删除 / graceful 关停）
 *   两端 —— 优雅关停会逐一 removeJob，天然清空快照；只有崩溃/强杀才会留痕。
 * - 启动时 drain() 一次性读走遗留快照并删除文件，进程内保留 tombstone；
 *   路由层据此把「未知任务 id」升级为 410 JOB_LOST 的明确提示，而非 404 冒充不存在。
 *
 * 快照只记录展示所需的最小字段（id/owner 哈希/时间/输入摘要），
 * 不写 token、不写提示词原文。文件名对 id 做白名单消毒防路径拼接意外。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

function safeId(id: unknown) {
  return String(id || '').replace(/[^\w.-]/g, '').slice(0, 80);
}

/** 公开字段白名单：与 routes/video.js publicJob 对齐的最小子集 */
function toSnapshot(job: SnapshotJob): JobSnapshot {
  const input = job.input || {};
  return {
    id: job.id,
    owner: job.owner,
    status: 'running',
    createdAt: job.createdAt,
    estimatedSeconds: job.estimatedSeconds || null,
    input: {
      modelId: input.modelId || null,
      width: input.width || null,
      height: input.height || null,
      duration: input.duration || null,
    },
  };
}

function createJobSnapshotStore(dir?: string | null): JobSnapshotStore {
  // dir 缺省（测试夹具/未配置 runtime 的调用方）时退化为无操作存根
  if (!dir) {
    return { save() {}, remove() {}, drain() { return []; } };
  }
  const directory = dir;

  function ensureDir() {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  }

  function fileOf(id: unknown) {
    return path.join(directory, safeId(id) + '.json');
  }

  function save(job: SnapshotJob) {
    try {
      ensureDir();
      const target = fileOf(job.id);
      const tmp = target + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(toSnapshot(job), null, 1), 'utf8');
      fs.renameSync(tmp, target);
    } catch (error) {
      // 落盘失败不允许阻断提交链路（主事实仍在内存注册表）
    }
  }

  function remove(id: unknown) {
    try {
      fs.unlinkSync(fileOf(id));
    } catch (error) {
      // 文件不存在或目录未建都视为已清理
    }
  }

  /** 启动时一次性读走全部遗留快照（读后即删），损坏条目跳过并清除 */
  function drain() {
    let names: string[] = [];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json') && !name.includes('.tmp-'));
    } catch (error) {
      return [];
    }
    const restored: JobSnapshot[] = [];
    for (const name of names) {
      const full = path.join(directory, name);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const parsed: JobSnapshot | null = JSON.parse(raw);
        if (parsed && parsed.id && parsed.owner) restored.push(parsed);
      } catch (error) {
        // 损坏快照同样清走，避免永久残留
      }
      try { fs.unlinkSync(full); } catch (error) {}
    }
    return restored;
  }

  return { save, remove, drain };
}

export = { createJobSnapshotStore, toSnapshot, safeId };
