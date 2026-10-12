/** Optional product-benchmark sidecar. Never imported for its side effects. */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { killProcessTree } from './process-tree';

export type SamplingOptions = { gpuUuid: string; executable: string };
type Sample = { receivedMs: number; queryTimestamp: string; usedMiB: number; totalMiB: number };
type Window = { label: string; startMs: number; endMs: number | null; sampleCount: number;
  sampledMaximumMiB: number | null; maxObservedGapMs: number | null; lastSampleMs: number | null;
  preSubmission: Sample | null; postDelivery: Sample | null };
const INTERVAL = 1000, MAX_GAP = 3500, START_TIMEOUT = 10000, CLOSE_TIMEOUT = 5000;
export const LIMITATIONS = 'Monitoring-enabled wall times include unmeasured sampling overhead; compare only equally monitored suites. '
  + 'The maximum of 1-second device memory.used samples can miss peaks and includes desktop, driver, other processes and resident models. '
  + 'It is neither a true peak nor job/process-attributed memory; do not subtract baselines or compare it to allocator peaks. '
  + 'Host full-line receipt timestamps define windows; pipe buffering and scheduling can misassign boundary samples. '
  + 'The selected physical UUID does not prove which device an already-running backend uses (CUDA_VISIBLE_DEVICES can remap logical indices). '
  + 'Backend device binding and GPU exclusivity require operator verification; MIG/vGPU and multi-GPU jobs are outside this mode. '
  + 'SIGINT stops local waiting only; server jobs may still be running. Hard termination/crashes cannot guarantee sidecar cleanup. Real-device behavior and overhead are untested.';

export function command(config: SamplingOptions) {
  return [config.executable, '--id=' + config.gpuUuid,
    '--query-gpu=uuid,pci.bus_id,driver_version,memory.total,memory.used,timestamp', '--format=csv,noheader', '--loop-ms=1000'];
}

export class DeviceMemorySampler {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private child?: cp.ChildProcess;
  private closed: Promise<void>;
  private resolveClosed!: () => void;
  private closeObserved = false;
  private exitObserved = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private stopPromise?: Promise<void>;
  private stopping = false;
  private firstTimer?: ReturnType<typeof setTimeout>;
  private gapTimer?: ReturnType<typeof setTimeout>;
  private buffer = '';
  private rawBytes = 0;
  private stderrBytes = 0;
  private rawWriteFailed = false;
  private issues: string[] = [];
  private windows: Window[] = [];
  private last: Sample | null = null;
  private device: { gpuUuid: string; pciBusId: string; driverVersion: string; totalMiB: number } | null = null;
  private suite = { sampleCount: 0, sampledMaximumMiB: null as number | null, maxObservedGapMs: null as number | null };

  constructor(private config: SamplingOptions, private output: string) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    // The runner's --run gate is the only caller. No probe or process is used in plan mode.
    try {
      if (!fs.statSync(config.executable).isFile()) throw Error('nvidia-smi path is not a file');
      fs.writeFileSync(path.join(output, 'device-memory-samples.jsonl'), '', { flag: 'wx' });
      fs.writeFileSync(path.join(output, 'device-memory-stderr.log'), '', { flag: 'wx' });
      const [exe, ...args] = command(config);
      this.child = cp.spawn(exe, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child.once('close', (code, signal) => {
        this.closeObserved = true; this.exitCode = code; this.exitSignal = signal; this.clearTimers();
        if (!this.stopping) this.fail(`Sampler closed unexpectedly (${code ?? signal ?? 'unknown'})`);
        this.resolveClosed();
      });
      this.child.once('exit', () => { this.exitObserved = true; });
      this.child.on('error', error => this.fail('Sampler process error: ' + error.message));
      this.child.stdout!.setEncoding('utf8');
      this.child.stdout!.on('error', error => this.fail('Sampler stdout error: ' + error.message));
      this.child.stdout!.on('data', (chunk: string) => this.receive(chunk));
      this.child.stderr!.on('error', error => this.fail('Sampler stderr error: ' + error.message));
      this.child.stderr!.on('data', (chunk: Buffer) => {
        try {
          const retained = chunk.subarray(0, Math.max(0, 16384 - this.stderrBytes));
          fs.appendFileSync(path.join(output, 'device-memory-stderr.log'), retained); this.stderrBytes += chunk.length;
          this.fail('Sampler wrote stderr; inspect device-memory-stderr.log');
        } catch (error) { this.fail('Cannot save sampler stderr: ' + String(error)); }
      });
      this.firstTimer = setTimeout(() => this.fail('No trustworthy first sample within 10 seconds; no job may be submitted'), START_TIMEOUT);
    } catch (error) { this.fail('Cannot start sampler: ' + String(error)); }
  }

  fail(reason: string) {
    if (!this.issues.includes(reason) && this.issues.length < 16) this.issues.push(reason);
    this.clearTimers();
    if (!this.last) this.rejectReady(Error(reason));
    else if (!this.stopping) void this.stop().catch(error => {
      if (this.issues.length < 16) this.issues.push('Cannot persist cleanup evidence: ' + String(error));
    }); // Stop the failed sidecar promptly, without aborting the in-flight server job.
  }
  private clearTimers() { clearTimeout(this.firstTimer); clearTimeout(this.gapTimer); }
  assertHealthy() {
    if (this.last && performance.now() - this.last.receivedMs > MAX_GAP) this.fail('Sampling gap exceeded 3500 ms');
    if (this.issues.length || !this.last || this.stopping) throw Error(this.issues[0] ?? 'Sampler is not ready');
  }
  private raw(value: object) {
    if (this.rawWriteFailed) return;
    const text = JSON.stringify(value) + '\n';
    this.rawBytes += Buffer.byteLength(text);
    if (this.rawBytes > 64 * 1024 * 1024) throw Error('Sampler evidence exceeds 64 MiB');
    try { fs.appendFileSync(path.join(this.output, 'device-memory-samples.jsonl'), text); }
    catch (error) { this.rawWriteFailed = true; throw error; }
  }
  private receive(chunk: string) {
    if (this.issues.length || this.stopping) return;
    this.buffer += chunk;
    if (this.buffer.length > 8192) { this.fail('Sampler stdout buffer exceeds 8192 characters'); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
      const receivedMs = performance.now();
      try {
        const fields = raw.split(',').map(value => value.trim());
        if (fields.length !== 6 || fields.some(value => !value || value === 'N/A')
          || fields[0].toLowerCase() !== this.config.gpuUuid.toLowerCase()) throw Error('Unexpected sampler row or physical UUID');
        const mib = (value: string) => /^\d+(?:\.\d+)? MiB$/.test(value) ? Number(value.slice(0, -4)) : NaN;
        const totalMiB = mib(fields[3]), usedMiB = mib(fields[4]);
        if (!Number.isFinite(totalMiB) || !Number.isFinite(usedMiB) || totalMiB <= 0 || usedMiB > totalMiB) throw Error('Unavailable/invalid MiB reading (never treated as zero)');
        const device = { gpuUuid: fields[0], pciBusId: fields[1], driverVersion: fields[2], totalMiB };
        if (this.device && JSON.stringify(device) !== JSON.stringify(this.device)) throw Error('Sampler device identity/configuration changed');
        const sample = { receivedMs, queryTimestamp: fields[5], usedMiB, totalMiB };
        this.raw({ raw, ...device, ...sample }); this.device = device;
        if (this.last) this.suite.maxObservedGapMs = Math.max(this.suite.maxObservedGapMs ?? 0, receivedMs - this.last.receivedMs);
        this.suite.sampleCount++; this.suite.sampledMaximumMiB = Math.max(this.suite.sampledMaximumMiB ?? 0, usedMiB);
        for (const window of this.windows) {
          if (window.endMs !== null) { if (!window.postDelivery) window.postDelivery = sample; continue; }
          if (window.lastSampleMs !== null) window.maxObservedGapMs = Math.max(window.maxObservedGapMs ?? 0, receivedMs - window.lastSampleMs);
          window.sampleCount++; window.lastSampleMs = receivedMs;
          window.sampledMaximumMiB = Math.max(window.sampledMaximumMiB ?? 0, usedMiB);
        }
        const gap = this.last ? receivedMs - this.last.receivedMs : 0;
        this.last = sample; clearTimeout(this.firstTimer); clearTimeout(this.gapTimer); this.resolveReady();
        if (gap > MAX_GAP) { this.fail('Sampling gap exceeded 3500 ms'); return; }
        this.gapTimer = setTimeout(() => this.fail('Sampling gap exceeded 3500 ms'), MAX_GAP);
      } catch (error) {
        try { this.raw({ raw: raw.slice(0, 4096), receivedMs, invalid: String(error) }); } catch { /* already reported below */ }
        this.fail('Sampler row/evidence error: ' + String(error)); return;
      }
    }
  }

  beginWindow(label: string, startMs: number) {
    this.assertHealthy();
    this.windows.push({ label, startMs, endMs: null, sampleCount: 0, sampledMaximumMiB: null,
      maxObservedGapMs: null, lastSampleMs: null, preSubmission: this.last, postDelivery: null });
  }
  endWindow(label: string, endMs: number) {
    const window = this.windows.find(value => value.label === label);
    if (window) window.endMs = endMs;
  }
  window(label: string) {
    const window = this.windows.find(value => value.label === label);
    return window ? { ...window, status: !window.sampleCount ? 'unverified' : this.issues.length ? 'partial' : 'sampled',
      issue: window.sampleCount ? null : 'No valid in-window sample; sub-second work can be missed', unit: 'MiB' } : null;
  }
  snapshot() {
    return { status: this.issues.length ? this.suite.sampleCount ? 'partial' : 'unverified' : 'sampled',
      metric: 'nvidia-smi-device-memory.used', unit: 'MiB', requestedGpuUuid: this.config.gpuUuid, device: this.device,
      command: command(this.config), requestedIntervalMs: INTERVAL, maximumAllowedGapMs: MAX_GAP,
      windowClock: 'host-monotonic-full-line-receipt', ...this.suite,
      scope: 'whole-suite-including-warmups-and-gaps; use separate job windows for measured work',
      executionDeviceBinding: 'operator-declared-unverified', processAttribution: 'unverified', truePeak: 'unverified',
      samplingOverhead: 'unmeasured', rawSamples: 'device-memory-samples.jsonl', issues: [...this.issues],
      cleanup: { pid: this.child?.pid ?? null, closeObserved: this.closeObserved, exitCode: this.exitCode, signal: this.exitSignal,
        status: !this.child ? 'not-started' : this.closeObserved ? 'closed' : 'unverified' }, limitations: LIMITATIONS };
  }
  stop(): Promise<void> { return this.stopPromise ??= this.close(); }
  private async close() {
    this.stopping = true; this.clearTimers();
    if (!this.last) this.rejectReady(Error(this.issues[0] ?? 'Sampler stopped before first sample'));
    if (this.child && !this.closeObserved) {
      // taskkill's return only confirms the cleanup command ended. close confirms this child's streams ended.
      if (!this.exitObserved && this.child.exitCode === null && this.child.signalCode === null) killProcessTree(this.child, { force: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_TIMEOUT); })]);
      clearTimeout(timer);
      if (!this.closeObserved) {
        this.fail('Cleanup unverified: own child close was not observed within 5 seconds');
        this.child.stdout?.destroy(); this.child.stderr?.destroy(); this.child.unref();
      }
    }
    // Preserve the early stop outcome; a late close may arrive while the server job finishes.
    fs.writeFileSync(path.join(this.output, 'device-memory-stop-checkpoint.json'),
      JSON.stringify({ evidenceStage: 'sidecar-stop-checkpoint', ...this.snapshot() }, null, 2) + '\n');
  }
}
