import type { ComfyConfig, ComfyStateConfig } from '../../server/comfy-types';

export interface ImageGenerationConfig extends ComfyConfig, ComfyStateConfig {
  ROOT_DIR: string;
  AI_WORKSPACE_ROOT?: string;
  RUNTIME?: { state?: string; outputs?: string };
}

export interface ImageModelDefinition {
  file: string;
  label: string;
  family: string;
  profileId: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  sizes: string[];
  noLora?: boolean;
  rebalance?: { preset: string; multiplier: number; normalizeTaps: boolean };
}

export interface ImageLoraDefinition {
  file: string;
  name: string;
  character: string;
  compatibleModels: string[];
  minStrength: number;
  maxStrength: number;
  preview?: boolean;
  validation?: string;
}

export interface ImageJobInput {
  prompt: string;
  negative: string;
  modelId: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  family?: string;
  profileId?: string;
  character?: any;
  loraId?: string | number | false | null;
  loraStrength?: number | null;
  loras?: Array<{ id: string; strength: number }>;
  styleLoraId?: string | null;
  hiresFix: boolean;
  hiresScale: number;
  hiresUpscaler?: string | null;
  hiresDenoise?: number;
  hiresSteps?: number;
  faceDetailer?: boolean;
  superResModel?: string | null;
  teaCache?: boolean;
  teaCacheThresh?: number;
  initImage?: string | null;
  maskImage?: string | null;
  maskPrompt?: string | null;
  denoisingStrength?: number;
  growMaskBy?: number;
  maskThreshold?: number;
}

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, any>;
}
export type ComfyWorkflow = Record<string, ComfyNode>;
export type ComfyLink = [string, number];

export interface ImageResult { path: string; mime: string; bytes: number }

export interface ImageJob<Input extends ImageJobInput = ImageJobInput> {
  id: string;
  owner: string;
  provider: string;
  input: Readonly<Input>;
  metadata: Readonly<Record<string, any>>;
  status: string;
  createdAt: number;
  finishedAt?: number;
  deadline: number;
  upstreamId: string;
  result: ImageResult | null;
  resultConsumed: boolean;
  error: string | null;
  errorCode: string | number | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  pollFailures: number;
  progress: number | null;
  progressText: string;
  currentNode: string | null;
  cancelFailures: number;
  cancelChecks: number;
  cancelDeadline: number;
  cancelPolling: boolean;
}

export interface ImageServiceOptions<Input extends ImageJobInput> {
  buildWorkflow?: (input: Input) => ComfyWorkflow;
  validateResources?: (input: Input) => any;
  outputPrefix?: string;
  outputNodeId?: string;
  mediaNamespace?: string;
  engine?: string;
  provider?: string;
  routeBase?: string;
  loraRoot?: string;
  jobTtlMs?: number;
  inputImageTtlMs?: number;
  cancelPollIntervalMs?: number;
  cancelTimeoutMs?: number;
}

export interface ComfyHistoryEntry {
  status?: any;
  outputs?: Record<string, { images?: any[] }>;
}
export type ComfyHistory = Record<string, ComfyHistoryEntry>;
export interface PromptSubmission { prompt_id?: any }
