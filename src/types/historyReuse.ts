export interface HistoryRecipeParts {
  style: boolean
  camera: boolean
  prompts: boolean
  parameters: boolean
}

export type HistoryReuseSelection = 'full' | HistoryRecipeParts
