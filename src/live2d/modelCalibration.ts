import type { Live2DAdapterProfile } from './adapterProfile'
import { validateAdapterProfile } from './adapterProfile'

export interface ModelParameter { id: string; min: number; max: number; default: number; value?: number }
export interface CalibrationBinding { id: string; closed: number; open: number }

export function calibratedBinding(binding: CalibrationBinding, parameters: readonly ModelParameter[]) {
  const parameter = parameters.find(item => item.id === binding.id)
  if (!parameter || ![parameter.min, parameter.max, parameter.default].every(Number.isFinite)
    || parameter.min > parameter.max || parameter.default < parameter.min || parameter.default > parameter.max
    || ![binding.closed, binding.open].every(value => Number.isFinite(value) && value >= parameter.min && value <= parameter.max)
    || binding.closed === binding.open) throw new Error(`参数 ${binding.id} 的端点无效，请按实际范围校准`)
  return { closed: binding.closed, open: binding.open, range: [parameter.min, parameter.max] as [number, number] }
}

export function buildCalibratedProfile(id: string, parameters: readonly ModelParameter[], mouth: CalibrationBinding,
  eyes: readonly CalibrationBinding[], previous?: Live2DAdapterProfile): Live2DAdapterProfile {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error('请先填写有效的角色 ID')
  const channels = [mouth, ...eyes].filter(binding => binding.id).map(binding => binding.id)
  if (new Set(channels).size !== channels.length) throw new Error('口型和双眼不能重复控制同一参数')
  const profile: Live2DAdapterProfile = previous ? structuredClone(previous) : {
    schemaVersion: 1, profileId: `profile-${id}-local-v1`, avatarId: `avatar-${id}-local`, profileVersion: '1.0.0',
    backendCompatibility: ['browser'], parameterBindings: {}, verification: { status: 'needs-confirmation' },
  }
  profile.backendCompatibility = ['browser']
  profile.verification = { status: 'needs-confirmation', reason: '已保存本机校准；真实音画同步和原生设备仍待验收' }
  delete profile.parameterBindings.mouth
  if (mouth.id) profile.parameterBindings.mouth = { id: mouth.id, scale: 1, ...calibratedBinding(mouth, parameters) }
  profile.parameterBindings.blink = eyes.filter(item => item.id).map(item => item.id)
  profile.parameterBindings.blinkCalibration = Object.fromEntries(eyes.filter(item => item.id).map(item => [item.id, calibratedBinding(item, parameters)]))
  const validation = validateAdapterProfile(profile)
  if (!validation.valid) throw new Error(validation.errors.join('；'))
  return profile
}

export function calibrationValue(binding: CalibrationBinding, level: number): number {
  if (![binding.closed, binding.open, level].every(Number.isFinite)) throw new Error('校准端点和电平必须为有效数字')
  return binding.closed + Math.max(0, Math.min(1, level)) * (binding.open - binding.closed)
}
