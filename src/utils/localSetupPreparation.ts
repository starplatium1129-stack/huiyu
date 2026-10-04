import type { LocalSetupModel } from '../../types/local-setup.ts'

/** Length checks intentionally do not claim SHA-256 or inference verification. */
export function modelPreparationState(model: LocalSetupModel): 'missing' | 'unknown' | 'size-mismatch' | 'bytes-match' {
  if (model.state === 'missing') return 'missing'
  if (model.bytes === null || !model.preparation) return 'unknown'
  if (model.bytes !== model.preparation.expectedBytes) return 'size-mismatch'
  return model.state === 'present' ? 'bytes-match' : 'unknown'
}

export function formatSetupBytes(value: number): string {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${value.toLocaleString('zh-CN')} B`
}
