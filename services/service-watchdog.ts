'use strict';

/**
 * 服务自愈看门狗。
 *
 * 规则：
 * - 只有"曾经健康且当前处于受管状态"的服务才自动重启，避免上游本来就没
 *   启动时无限拉起（例如用户从未点过"启动语音"）。
 * - 掉线后按指数退避重试（intervalMs → 2x → 4x → …，封顶 maxBackoffMs）；
 *   恢复健康后重置退避。
 * - 重启动作互斥（同一服务不会并发重启）；stop() 会清掉全部定时器。
 */

interface WatchdogService {
  name: string;
  /** 探测当前健康状态（true = 在线）。 */
  probe: () => Promise<boolean>;
  /** 执行重启；返回 ok:true 表示已恢复或已开始恢复。 */
  restart: () => Promise<{ ok: boolean; error?: string }>;
  /** 是否允许自动重启（受管状态）。 */
  shouldManage: () => boolean;
  /** 网关重启后，已有 desired-managed latch 的服务仍可恢复；未登记服务不适用。 */
  recoverOnStart?: () => boolean;
}

interface WatchdogOptions {
  services: WatchdogService[];
  intervalMs?: number;
  maxBackoffMs?: number;
  onEvent?: (event: {
    service: string;
    kind: 'down' | 'restarted' | 'restart-failed';
    attempt?: number;
    error?: string;
  }) => void;
}

interface ServiceEntry {
  healthy: boolean;
  wasHealthy: boolean;
  managed: boolean;
  restarting: boolean;
  restartInFlight: boolean;
  attempt: number;
  lastError: string;
  lastRestartAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface WatchdogStatus {
  running: boolean;
  services: Record<string, {
    healthy: boolean;
    managed: boolean;
    restarting: boolean;
    attempt: number;
    lastError: string;
    lastRestartAt: number;
  }>;
}

function createServiceWatchdog(options: WatchdogOptions) {
  const intervalMs = Math.max(50, Number(options.intervalMs) || 5000);
  const maxBackoffMs = Math.max(intervalMs, Number(options.maxBackoffMs) || 30000);
  const services = Array.isArray(options.services) ? options.services : [];
  const entries = new Map<string, ServiceEntry>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let checking = false;
  let generation = 0;

  function entry(service: WatchdogService): ServiceEntry {
    let current = entries.get(service.name);
    if (!current) {
      current = {
        healthy: false,
        wasHealthy: false,
        managed: false,
        restarting: false,
        restartInFlight: false,
        attempt: 0,
        lastError: '',
        lastRestartAt: 0,
        timer: null
      };
      entries.set(service.name, current);
    }
    return current;
  }

  function clearRestartTimer(current: ServiceEntry) {
    if (current.timer) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    current.restarting = running && current.restartInFlight;
  }

  function scheduleRestart(service: WatchdogService, current: ServiceEntry) {
    if (!running || current.restarting || current.restartInFlight) return;
    const scheduledGeneration = generation;
    const delay = Math.min(maxBackoffMs, intervalMs * Math.pow(2, current.attempt));
    current.restarting = true;
    current.timer = setTimeout(function () {
      current.timer = null;
      void (async function () {
        if (!running || scheduledGeneration !== generation) return;
        current.managed = service.shouldManage();
        if (!current.managed) { clearRestartTimer(current); return; }
        current.restartInFlight = true;
        let result: { ok: boolean; error?: string };
        try {
          result = await service.restart();
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        current.restartInFlight = false;
        current.restarting = false;
        if (!running || scheduledGeneration !== generation || !service.shouldManage()) return;
        if (result && result.ok) {
          current.attempt = 0;
          current.lastError = '';
          current.lastRestartAt = Date.now();
          if (options.onEvent) options.onEvent({ service: service.name, kind: 'restarted' });
        } else {
          current.attempt += 1;
          current.lastError = (result && result.error) || '重启失败';
          if (options.onEvent) {
            options.onEvent({
              service: service.name,
              kind: 'restart-failed',
              attempt: current.attempt,
              error: current.lastError
            });
          }
          scheduleRestart(service, current);
        }
      })();
    }, delay);
    if (typeof current.timer.unref === 'function') current.timer.unref();
  }

  async function check(): Promise<void> {
    if (checking || !running) return;
    checking = true;
    const checkedGeneration = generation;
    try {
      for (const service of services) {
        const current = entry(service);
        let healthy = false;
        try {
          healthy = await service.probe();
        } catch {
          healthy = false;
        }
        if (!running || checkedGeneration !== generation) return;
        current.healthy = healthy;
        current.managed = service.shouldManage();
        if (!current.managed) {
          current.wasHealthy = healthy;
          clearRestartTimer(current);
          continue;
        }
        if (healthy) {
          if (!current.wasHealthy && current.attempt > 0 && options.onEvent) {
            options.onEvent({ service: service.name, kind: 'restarted' });
          }
          current.wasHealthy = true;
          current.attempt = 0;
          current.lastError = '';
          clearRestartTimer(current);
          continue;
        }
        // 曾经健康 → 现在掉线：触发自愈；从未健康则不动（等待手动启动）。
        if ((current.wasHealthy || (current.attempt === 0 && service.recoverOnStart && service.recoverOnStart())) && !current.restarting && !current.restartInFlight) {
          if (options.onEvent) options.onEvent({ service: service.name, kind: 'down' });
          scheduleRestart(service, current);
        }
      }
    } finally {
      checking = false;
    }
  }

  function start(): void {
    if (running) return;
    generation++;
    running = true;
    timer = setInterval(function () { void check(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void check();
  }

  function stop(): void {
    running = false;
    generation++;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const current of entries.values()) clearRestartTimer(current);
  }

  function status(): WatchdogStatus {
    const servicesView: WatchdogStatus['services'] = {};
    for (const service of services) {
      const current = entry(service);
      servicesView[service.name] = {
        healthy: current.healthy,
        managed: current.managed,
        restarting: current.restarting,
        attempt: current.attempt,
        lastError: current.lastError,
        lastRestartAt: current.lastRestartAt
      };
    }
    return { running: running, services: servicesView };
  }

  return { start: start, stop: stop, check: check, status: status };
}

export = { createServiceWatchdog: createServiceWatchdog };
