import type { InferenceSetupOperation } from '@/api/inferenceSetupApi'
import type { InterrogateSetupOperation } from '@/api/interrogateSetupApi'

type SetupOperation = InferenceSetupOperation | InterrogateSetupOperation

// Match the stage contracts in native_setup/jobs.rs, flow.rs and pixai/flow.rs.
// Installer output may update `stage` while leaving the last file's `phase` intact.
// Only file stages may display byte percentages; installation never reuses a stale 100%.
export function setupTransferPhase(operation: SetupOperation | null): string {
  if (!operation) return 'preparing'
  const { kind, stageIndex, phase } = operation
  const stage = 'stage' in operation ? operation.stage : undefined
  if (kind === 'prepare-native-engine' || kind === 'prepare-pixai') {
    if (stageIndex === 1 || stageIndex === 4) return phase || 'downloading'
    if (stageIndex === 2) return stage === 'validating' ? 'validating' : 'installing'
    if (stageIndex === 5) return phase === 'converting' ? 'converting' : 'validating'
    if (stageIndex === (kind === 'prepare-pixai' ? 6 : 7)) return 'activating'
    return stageIndex === 0 ? 'preparing' : 'prepared'
  }
  if (kind === 'install-native-runtime' || kind === 'download-native-model') {
    if (stageIndex === 1) return phase || 'downloading'
    if (stageIndex === 2) return phase === 'converting' ? 'converting'
      : kind === 'install-native-runtime' && stage !== 'validating' ? 'installing' : 'validating'
    return stageIndex === 0 ? 'preparing' : 'prepared'
  }
  return phase || 'preparing'
}

export const setupOperationLabels: Record<SetupOperation['kind'], string> = {
  'prepare-native-engine': '准备原生绘图',
  'install-native-runtime': '准备绘图运行库',
  'download-native-model': '准备绘图模型',
  'download-native-resource': '准备辅助模型与资源',
  'prepare-inference-runtime': '准备离线运行环境',
  'import-inference-model': '导入绘图模型',
  'prepare-pixai': '准备图片反推',
}
