import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type FailureKind = 'assertion' | 'typecheck' | 'build' | 'timeout' | 'environment' | 'signal' | 'process';
export type QualityResult = {
  name: string; status: 'passed' | 'failed' | 'not-run'; duration: number;
  failureKind?: FailureKind; reason?: string; output?: string; timeoutMs?: number; metadata?: unknown;
};

export function classifyFailure(result: { error?: { code?: string }; signal?: string | null; status: number | null }, output: string): FailureKind | undefined {
  if (result.error?.code === 'ETIMEDOUT') return 'timeout';
  if (result.error?.code === 'ENOENT' || /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Executable doesn't exist/.test(output)) return 'environment';
  if (result.signal) return 'signal';
  if (!result.error && result.status === 0) return undefined;
  if (/error TS\d+:/.test(output)) return 'typecheck';
  if (/AssertionError|ERR_ASSERTION|failureType: ['"]testCodeFailure/.test(output)) return 'assertion';
  if (/error during build|Build failed/i.test(output)) return 'build';
  return 'process';
}

/** Per-run diagnostics, suitable as logs for capture:delivery; never a replacement evidence ledger. */
export function writeQualityReport(label: string, results: QualityResult[], duration: number, directory = process.env.AICS_TEST_REPORT_DIR) {
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  const name = label.replace(/[^a-z0-9-]/gi, '-');
  const stem = name + '-' + Date.now() + '-' + randomUUID();
  const logFile = path.join(directory, stem + '.log');
  fs.writeFileSync(logFile, results.map(result => '=== ' + result.name + ' (' + result.status + ') ===\n' + (result.output || result.reason || '')).join('\n'));
  const report = {
    schema: 'aics.quality-suite.v1', label, timestamp: new Date().toISOString(),
    node: process.version, platform: process.platform, durationMs: duration,
    status: results.every(result => result.status === 'passed') ? 'passed' : 'failed',
    logFile: path.basename(logFile),
    results: results.map(({ output, ...result }) => ({ ...result, counts: Object.fromEntries([...String(output || '').matchAll(/[ℹ#] (tests|pass|fail|cancelled|skipped) (\d+)/g)].map(match => [match[1], Number(match[2])])) })),
  };
  const reportFile = path.join(directory, stem + '.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  return reportFile;
}

