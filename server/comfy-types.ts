/** Transport contracts shared by the Comfy client, progress monitor and routes. */
export interface ComfyConfig {
  COMFY_HOST: string | URL;
}

export interface ComfyStateConfig {
  RUNTIME?: { state?: string };
  RUNTIME_ROOT?: string;
}

export interface ComfyError extends Error {
  status: number;
  code: string;
  detail?: unknown;
}

export interface ComfyQueueResponse {
  queue_running?: unknown;
  queue_pending?: unknown;
  running?: unknown;
  pending?: unknown;
}

export interface ProgressJob {
  status: string;
  progress?: number | null;
  currentNode?: string | null;
  progressText?: string;
}

/** Only the socket operations used by the monitor, also implementable by fixtures. */
export interface ProgressSocket {
  on(event: 'message', listener: (raw: unknown, isBinary: boolean) => void): unknown;
  on(event: 'open' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(): unknown;
}

export interface ProgressOptions<Job extends ProgressJob> {
  WebSocket?: new (url: string) => ProgressSocket;
  reconnectMs?: number;
  onUpdate?: (job: Job, type: string, data: Record<string, unknown>) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
}
