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
  detail?: any;
}

export interface ComfyQueueResponse {
  queue_running?: any;
  queue_pending?: any;
  running?: any;
  pending?: any;
}

export interface ProgressJob {
  status: string;
  progress?: number | null;
  currentNode?: string | null;
  progressText?: string;
}

/** Only the socket operations used by the monitor, also implementable by fixtures. */
export interface ProgressSocket {
  on(event: 'message', listener: (raw: any, isBinary: boolean) => void): any;
  on(event: 'open' | 'close', listener: () => void): any;
  on(event: 'error', listener: (error: Error) => void): any;
  close(): any;
}

export interface ProgressOptions<Job extends ProgressJob> {
  WebSocket?: new (url: string) => ProgressSocket;
  reconnectMs?: number;
  onUpdate?: (job: Job, type: string, data: Record<string, any>) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
}
