export interface PromptPayload {
  positive: string;
  negative?: string;
  model?: string;
  seed?: number;
}
