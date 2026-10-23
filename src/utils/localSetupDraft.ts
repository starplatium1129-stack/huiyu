import { settingsRepository, type SettingDefinition } from '../storage/settingsRepository'
import { LOCAL_SETUP_DRAFT_KEY } from './storageKeys'

export type SetupOperationKind = 'prepare-environment' | 'comfy-start' | 'llama-start'
export interface SetupDraft {
  workspace: string
  modelId: string
  chatId: string
  drawing: boolean
  loras: boolean
  environment: '' | 'comfy-nvidia' | 'comfy-cu126' | 'comfy-amd'
  llamaEnvironment: 'llama-cuda' | 'llama-vulkan'
  operation?: { id: string; kind: SetupOperationKind }
}
export const setupOperationKind = (kind: unknown): kind is SetupOperationKind =>
  kind === 'prepare-environment' || kind === 'comfy-start' || kind === 'llama-start'
export const LOCAL_SETUP_DRAFT_SETTING: SettingDefinition<SetupDraft> = {
  key: LOCAL_SETUP_DRAFT_KEY,
  parse(raw) {
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const draft = value as Record<string, unknown>
    if (typeof draft.workspace !== 'string' || typeof draft.modelId !== 'string' || typeof draft.chatId !== 'string'
      || typeof draft.drawing !== 'boolean' || typeof draft.loras !== 'boolean'
      || !['', 'comfy-nvidia', 'comfy-cu126', 'comfy-amd'].includes(String(draft.environment))
      || !['llama-cuda', 'llama-vulkan'].includes(String(draft.llamaEnvironment))) return null
    const operation = draft.operation as Record<string, unknown> | undefined
    if (operation !== undefined && (!operation || typeof operation.id !== 'string' || !operation.id || !setupOperationKind(operation.kind))) return null
    return draft as unknown as SetupDraft
  },
  serialize: value => JSON.stringify(value),
}
export function readSetupDraft(workspace: string): SetupDraft | null {
  const draft = settingsRepository.get(LOCAL_SETUP_DRAFT_SETTING)
  return draft?.workspace === workspace ? draft : null
}
export function clearSetupOperation(workspace: string, id: string) {
  const draft = readSetupDraft(workspace)
  if (draft?.operation?.id === id) {
    delete draft.operation
    settingsRepository.set(LOCAL_SETUP_DRAFT_SETTING, draft)
  }
}
