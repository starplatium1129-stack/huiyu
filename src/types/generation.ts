export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface GenerationJob {
  id: string;
  status: GenerationStatus;
  prompt: string;
  createdAt?: string;
}
