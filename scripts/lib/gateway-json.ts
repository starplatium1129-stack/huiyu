const { object }: typeof import('./content-history-reader') = require('./content-history-reader');

interface GatewayJob extends Record<string, unknown> {
  id: string;
  status: string;
  resultUrl?: string | null;
  provider?: string | null;
  error?: string | null;
  code?: string | null;
  seed?: unknown;
  metadata?: Record<string, unknown> | null;
}

/** Fields consumed by candidate polling; unconsumed metadata stays opaque. */
export function readGatewayJob(data: unknown): GatewayJob | null {
  if (!object(data) || data.ok !== true || !object(data.job)) return null;
  const job = data.job;
  if (typeof job.id !== 'string' || !job.id || typeof job.status !== 'string'
    || !['resultUrl', 'provider', 'error', 'code'].every(key => job[key] == null || typeof job[key] === 'string')
    || (job.metadata != null && !object(job.metadata))) return null;
  return job as GatewayJob;
}

/** Candidate runners inspect transport errors before deciding whether to retry their job. */
export async function gatewayJson(base: string, pathname: string, options?: RequestInit) {
  let response;
  try {
    response = await fetch(base.replace(/\/$/, '') + pathname, Object.assign({ cache: 'no-store' }, options || {}));
  } catch (error) {
    return { response: null, data: null, error: error instanceof Error ? error.message : String(error) };
  }
  let data: unknown = null;
  try { data = await response.json(); } catch { /* Keep null for non-JSON gateway responses. */ }
  return { response, data };
}
