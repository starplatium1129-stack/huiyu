'use strict';
/**
 * server/job-runner.js — 长任务注册表公共原语（2026-08-21 收口）。
 *
 * 三条生成链路（routes/anima.js、routes/generation.js、routes/video.js）各自拥有
 * 引擎专属的 poll/cancel 状态机——ComfyUI 历史解释、定向取消确认（anima 的
 * cancelChecks 双路串行锁）、SD WebUI 轮询语义都是刻意不同的，不在这里强行统一。
 * 真正逐字重复的是骨架：「Map 任务存储 + pendingCount + unref 定时器（pollTimer/
 * gcTimer）+ closed 标志」。2026-08-16 的幽灵槽/取消复活类修复曾需要三处同步，
 * 本模块把这部分收口为单一实现。
 *
 * 迁移约定：引擎代码继续直接读写 registry.jobs 这个 Map（jobs.set/get/delete/
 * forEach 原样保留），因此注册表替换是零行为差异的。
 */
let TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled']);
function isTerminalStatus(status) {
    return TERMINAL_STATUSES.indexOf(status) !== -1;
}
function createJobRegistry() {
    let jobs = new Map();
    let closed = false;
    return {
        jobs: jobs,
        isClosed: function () { return closed; },
        close: function () { closed = true; },
        /** queued/running/cancelling 视为占用并发额度（anima 与 video 判定口径一致） */
        pendingCount: function () {
            let count = 0;
            jobs.forEach(function (job) {
                if (job.status === 'queued' || job.status === 'running' || job.status === 'cancelling')
                    count += 1;
            });
            return count;
        },
        /**
         * 挂定时器并记录句柄到 job[slot]；同槽位重挂自动清旧（schedulePoll 重排语义），
         * 回调触发前先置空句柄。unref 语义必须显式声明：gc/孤儿清理用 unref:true，
         * 而轮询定时器保持默认（不 unref，与迁移前行为一致）。
         */
        armTimer: function (job, slot, delayMs, fn, options) {
            this.clearTimer(job, slot);
            const timer = setTimeout(function () {
                job[slot] = null;
                fn();
            }, delayMs);
            job[slot] = timer;
            if (options && options.unref && typeof timer.unref === 'function')
                timer.unref();
            return timer;
        },
        clearTimer: function (job, slot) {
            if (job[slot]) {
                clearTimeout(job[slot]);
                job[slot] = null;
            }
        }
    };
}
module.exports = {
    createJobRegistry: createJobRegistry,
    isTerminalStatus: isTerminalStatus,
    TERMINAL_STATUSES: TERMINAL_STATUSES
};
