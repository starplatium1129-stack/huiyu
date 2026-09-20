import type { ComfyConfig, ComfyStateConfig } from '../../server/comfy-types';
import type validation = require('./validation');
import type comfy = require('./comfy');
export interface VideoConfig extends ComfyConfig, ComfyStateConfig {
  ROOT_DIR: string;
  AI_WORKSPACE_ROOT?: string;
}
export type VideoInput = Omit<ReturnType<typeof validation.validateInput>,
  'modelId' | 'width' | 'height' | 'image' | 'lastFrame' | 'references'> & {
  modelId: string;
  width: number;
  height: number;
  image: string | null;
  lastFrame: string | null;
  references: string[];
};
export interface VideoServiceDependencies {
  jobTtlMs?: number;
  pollIntervalMs?: number;
}
export interface VideoJob {
  id: string;
  owner: string;
  input: VideoInput;
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'failed' | 'succeeded';
  createdAt: number;
  estimatedSeconds: number;
  deadline: number;
  upstreamId: string;
  result: Awaited<ReturnType<typeof comfy.materializeResult>> | null;
  error: string | null;
  errorCode: string | number | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  pollFailures: number;
}
