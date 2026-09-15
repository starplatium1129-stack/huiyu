import type { PathOrFileDescriptor } from 'node:fs';
import type { InferenceSession } from 'onnxruntime-node';

export interface InterrogateConfig {
  AI_WORKSPACE_ROOT?: string;
  ROOT_DIR?: string;
}

export interface InterrogateModel {
  dir: string;
  modelName: string;
  onnxPath: string;
  csvPath: string;
  bytes: number;
}

export interface TagTable {
  csvPath: PathOrFileDescriptor;
  names: string[];
  generalIndex: number;
  characterIndex: number;
}

export interface ModelSession {
  onnxPath: string;
  session: InferenceSession;
  inputName: string;
  outputName: string;
}

export interface InterrogateOptions {
  config?: InterrogateConfig | null;
  threshold?: number;
  characterThreshold?: number;
  topN?: number;
}

export type InterrogateResult = { ok: false; reason: string } | {
  ok: true;
  engine: 'wd14';
  model: string;
  tags: string[];
  characterTags: string[];
  scores: Record<string, number>;
  rating: Record<string, number>;
  meta: {
    threshold: number;
    characterThreshold: number;
    topN: number;
    modelPath: string;
    modelBytes: number;
    modelDir: string;
    count: number;
    ms: number;
  };
};
