import type { Live2DBackendKind } from './types.ts'
import {
  INTERACTION_MOTIONS,
  NATSUME_INTERACTIONS,
  NATSUME_HIT_AREA_MAP,
  MOUTH_PARAMS,
  BLINK_PARAMS,
  POINTER_FOCUS_PARAMS,
  OVERLAY_SETTLE_MS,
  NATSUME_RESET_PARAMS,
  ENTRANCE_GROUP,
  LEAVE_GROUP,
  type Live2DInteraction,
} from '../composables/live2d/constants.ts'
import { NATSUME_RUNTIME_CONFIG, NENE_RUNTIME_CONFIG } from '../utils/emotionRuntime.ts'

export type Live2DCapabilityStatus = 'detected' | 'needs-confirmation' | 'verified' | 'unsupported' | 'invalid'

export interface Live2DParameterBinding {
  channel: string
  paramIds: string[]
  range?: [number, number]
  neutral?: number
  scale?: number
  reversed?: boolean
}

export interface Live2DStageHitZone {
  interactionId: string
  minY: number
  maxY: number
  minX?: number
  maxX?: number
  maxXInclusive?: boolean
}

export interface Live2DAdapterProfile {
  schemaVersion: 1
  profileId: string
  profileVersion: string
  avatarId: string
  backendCompatibility: readonly Live2DBackendKind[]
  parameterBindings: {
    mouth?: { id: string; scale: number; range?: [number, number] }
    blink?: readonly string[]
    focus?: readonly string[]
    custom?: Record<string, Live2DParameterBinding>
  }
  hitAreaMap?: Record<string, string>
  hitAreaFallbacks?: readonly string[]
  interactions?: Record<string, Live2DInteraction>
  defaultInteractionId?: string
  stageHitZones?: readonly Live2DStageHitZone[]
  interactionHint?: string
  emotionParams?: Record<string, Record<string, number>>
  overlaySettle?: {
    settleMs: number
    resetDefaults: Record<string, number>
  }
  layout?: {
    entranceGroup?: string
    leaveGroup?: string
    bubbleAnchor?: { x: number; y: number }
    scale?: number
  }
  verification: {
    status: Live2DCapabilityStatus
    reason?: string
    lastVerifiedAt?: string
  }
}

export interface Live2DAdapterCapabilityItem {
  id: 'mouth' | 'blink' | 'focus' | 'emotions' | 'interactions' | 'hit-areas' | 'overlay-reset'
  status: Live2DCapabilityStatus
  reason: string
}

export interface Live2DAdapterCapabilityReport {
  profileId: string
  avatarId: string
  backend: Live2DBackendKind
  status: Live2DCapabilityStatus
  items: Live2DAdapterCapabilityItem[]
  errors: string[]
}

export interface CompiledLive2DAdapter {
  profileId: string
  profileVersion: string
  avatarId: string
  backend: Live2DBackendKind
  mouth?: { id: string; scale: number; range?: [number, number] }
  blink: readonly string[]
  focus: readonly string[]
  interactions: Readonly<Record<string, Live2DInteraction>>
  hitAreaMap: Readonly<Record<string, string>>
  hitAreaFallbacks: readonly string[]
  stageHitZones: readonly Live2DStageHitZone[]
  defaultInteractionId?: string
  interactionHint: string
  emotionParams: Readonly<Record<string, Record<string, number>>>
  overlaySettle?: Live2DAdapterProfile['overlaySettle']
  entranceGroup?: string
  leaveGroup?: string
  report: Live2DAdapterCapabilityReport
}

/** Builtin profile migrated from the existing Nene runtime constants. */
export const NENE_BUILTIN_PROFILE: Live2DAdapterProfile = Object.freeze({
  schemaVersion: 1,
  profileId: 'profile-nene-v1',
  profileVersion: '1.0.0',
  avatarId: 'avatar-nene-default',
  backendCompatibility: ['browser', 'native'] as const,
  parameterBindings: {
    mouth: { id: MOUTH_PARAMS.nene.id, scale: MOUTH_PARAMS.nene.scale },
    blink: BLINK_PARAMS.nene,
    focus: POINTER_FOCUS_PARAMS,
  },
  interactions: INTERACTION_MOTIONS,
  defaultInteractionId: 'Head',
  stageHitZones: [
    { interactionId: 'Hair', minY: 0, maxY: 0.12 },
    { interactionId: 'Head', minY: 0.12, maxY: 0.19 },
    { interactionId: 'Face', minY: 0.19, maxY: 0.29 },
    { interactionId: 'LeftChest', minX: 0.40, maxX: 0.50, minY: 0.29, maxY: 0.42 },
    { interactionId: 'RightChest', minX: 0.50, maxX: 0.60, maxXInclusive: true, minY: 0.29, maxY: 0.42 },
    { interactionId: 'Body', minY: 0.29, maxY: 0.42 },
    { interactionId: 'Skirt', minY: 0.42, maxY: 0.57 },
    { interactionId: 'Body', minY: 0.57, maxY: 1 },
  ],
  interactionHint: '移动鼠标可跟随视线；点击呆毛、头部、脸、身体、两侧或裙摆可互动',
  emotionParams: NENE_RUNTIME_CONFIG.emotionParams,
  layout: {
    leaveGroup: LEAVE_GROUP,
    bubbleAnchor: { x: 0.5, y: 0.2 },
    scale: 1.0,
  },
  verification: {
    status: 'needs-confirmation' as const,
    reason: 'Migrated from the existing browser/native runtime constants; paired C7 visual evidence is still required.',
  },
})

/** Builtin profile migrated from the existing Natsume mouth, blink and overlay contracts. */
export const NATSUME_BUILTIN_PROFILE: Live2DAdapterProfile = Object.freeze({
  schemaVersion: 1,
  profileId: 'profile-natsume-v1',
  profileVersion: '1.0.0',
  avatarId: 'avatar-natsume-default',
  backendCompatibility: ['browser', 'native'] as const,
  parameterBindings: {
    mouth: { id: MOUTH_PARAMS.natsume.id, scale: MOUTH_PARAMS.natsume.scale },
    blink: BLINK_PARAMS.natsume,
    focus: POINTER_FOCUS_PARAMS,
  },
  hitAreaMap: NATSUME_HIT_AREA_MAP,
  hitAreaFallbacks: ['外框'],
  interactions: NATSUME_INTERACTIONS,
  defaultInteractionId: 'Head',
  stageHitZones: [
    { interactionId: 'Head', minY: 0, maxY: 0.14 },
    { interactionId: 'Hand', minY: 0.14, maxY: 0.26 },
    { interactionId: 'Chest', minY: 0.26, maxY: 0.38 },
    { interactionId: 'Skirt', minY: 0.38, maxY: 0.55 },
    { interactionId: 'Leg', minY: 0.55, maxY: 0.72 },
    { interactionId: 'Foot', minY: 0.72, maxY: 1 },
  ],
  interactionHint: '移动鼠标可跟随视线；点击头部、手、胸前、裙子、腿或脚可互动',
  emotionParams: NATSUME_RUNTIME_CONFIG.emotionParams,
  overlaySettle: {
    settleMs: OVERLAY_SETTLE_MS,
    resetDefaults: Object.fromEntries(NATSUME_RESET_PARAMS.map(p => [p.id, p.value])),
  },
  layout: {
    entranceGroup: ENTRANCE_GROUP,
    leaveGroup: LEAVE_GROUP,
    bubbleAnchor: { x: 0.5, y: 0.18 },
    scale: 1.0,
  },
  verification: {
    status: 'needs-confirmation' as const,
    reason: 'ParamMouthForm3, dual-eye blink and overlay defaults come from the existing runtime; paired C7 backend evidence is still required.',
  },
})

export function validateAdapterProfile(candidate: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['Profile must be an object'] }
  }
  const p = candidate as Partial<Live2DAdapterProfile>
  if (p.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!validIdentifier(p.profileId, 160)) errors.push('profileId is required')
  if (!p.profileVersion || typeof p.profileVersion !== 'string' || p.profileVersion.length > 80) errors.push('profileVersion is required')
  if (!validIdentifier(p.avatarId, 160)) errors.push('avatarId is required')
  if (!Array.isArray(p.backendCompatibility) || !p.backendCompatibility.length
    || p.backendCompatibility.some(backend => backend !== 'browser' && backend !== 'native')) {
    errors.push('backendCompatibility must contain browser or native')
  }
  if (!p.parameterBindings || typeof p.parameterBindings !== 'object') {
    errors.push('parameterBindings is required')
  } else {
    const mouth = p.parameterBindings.mouth
    if (mouth) {
      if (!validParameterId(mouth.id)) errors.push('mouth parameter id must be a non-empty string')
      if (!Number.isFinite(mouth.scale)) errors.push('mouth scale must be finite')
      if (mouth.range && (!validRange(mouth.range))) errors.push('mouth range must be finite and ordered')
    }
    const blink = p.parameterBindings.blink
    if (blink && (!Array.isArray(blink) || blink.some(id => !validParameterId(id)))) {
      errors.push('blink parameters must contain non-empty strings')
    }
    const focus = p.parameterBindings.focus
    if (focus && (!Array.isArray(focus) || focus.some(id => !validParameterId(id)))) {
      errors.push('focus parameters must contain non-empty strings')
    }
  }
  if (!p.verification?.status || !CAPABILITY_STATUSES.has(p.verification.status)) {
    errors.push('verification status is required')
  }
  if (p.overlaySettle) {
    if (!Number.isFinite(p.overlaySettle.settleMs) || p.overlaySettle.settleMs <= 0) errors.push('overlay settleMs must be positive')
    if (!p.overlaySettle.resetDefaults || Object.entries(p.overlaySettle.resetDefaults)
      .some(([id, value]) => !validParameterId(id) || !Number.isFinite(value))) errors.push('overlay reset defaults must be finite')
  }
  if (p.interactions && Object.entries(p.interactions).some(([id, interaction]) =>
    !id.trim() || !interaction?.group || !interaction.hint || !Number.isFinite(interaction.duration) || interaction.duration <= 0)) {
    errors.push('interactions must contain a group, hint, and positive duration')
  }
  if (p.stageHitZones && p.stageHitZones.some(zone => !validStageHitZone(zone, p.interactions))) {
    errors.push('stage hit zones must be ordered, normalized, and reference an interaction')
  }
  if (p.defaultInteractionId && !p.interactions?.[p.defaultInteractionId]) {
    errors.push('defaultInteractionId must reference an interaction')
  }
  if (p.hitAreaFallbacks && (!Array.isArray(p.hitAreaFallbacks)
    || p.hitAreaFallbacks.some(id => typeof id !== 'string' || !id.trim()))) {
    errors.push('hitAreaFallbacks must contain non-empty strings')
  }
  if (p.hitAreaMap && Object.entries(p.hitAreaMap).some(([source, target]) =>
    !source.trim() || !target.trim() || !p.interactions?.[target])) {
    errors.push('hitAreaMap must reference configured interactions')
  }
  if (p.emotionParams && Object.entries(p.emotionParams).some(([emotion, params]) =>
    !emotion.trim() || !params || Object.entries(params).some(([id, value]) => !validParameterId(id) || !Number.isFinite(value)))) {
    errors.push('emotion parameters must use non-empty IDs and finite values')
  }
  return { valid: errors.length === 0, errors }
}

const CAPABILITY_STATUSES = new Set<Live2DCapabilityStatus>([
  'detected', 'needs-confirmation', 'verified', 'unsupported', 'invalid',
])

function validIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) && value.length <= maxLength
}

function validParameterId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function validRange(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2
    && value.every(item => Number.isFinite(item)) && value[0] <= value[1]
}

function validStageHitZone(
  zone: Live2DStageHitZone,
  interactions?: Record<string, Live2DInteraction>,
): boolean {
  const values = [zone.minY, zone.maxY, zone.minX ?? 0, zone.maxX ?? 1]
  return Boolean(zone.interactionId && interactions?.[zone.interactionId])
    && values.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    && zone.minY < zone.maxY && (zone.minX ?? 0) < (zone.maxX ?? 1)
}

export function adapterCapabilityReport(
  profile: Live2DAdapterProfile,
  backend: Live2DBackendKind,
): Live2DAdapterCapabilityReport {
  const validation = validateAdapterProfile(profile)
  const compatible = profile.backendCompatibility.includes(backend)
  const mapped = (present: boolean): Live2DAdapterCapabilityItem['status'] => {
    if (!compatible || !present) return 'unsupported'
    if (profile.verification.status === 'verified') return 'verified'
    if (profile.verification.status === 'detected') return 'detected'
    return 'needs-confirmation'
  }
  const mouth = profile.parameterBindings.mouth
  const blink = profile.parameterBindings.blink || []
  const items: Live2DAdapterCapabilityItem[] = [
    { id: 'mouth', status: mapped(Boolean(mouth?.id)), reason: mouth?.id || '未配置口型参数；语音仍可播放，嘴部保持静止' },
    { id: 'blink', status: mapped(blink.length > 0), reason: blink.join(', ') || '未配置眨眼覆写；保留模型作者动作' },
    { id: 'focus', status: mapped(Boolean(profile.parameterBindings.focus?.length)), reason: profile.parameterBindings.focus?.join(', ') || '未配置视线跟随参数' },
    { id: 'emotions', status: mapped(Boolean(profile.emotionParams && Object.keys(profile.emotionParams).length)), reason: profile.emotionParams ? `${Object.keys(profile.emotionParams).length} 组情绪参数映射` : '未配置参数级情绪映射' },
    { id: 'interactions', status: mapped(Boolean(profile.interactions && Object.keys(profile.interactions).length)), reason: profile.interactions ? `${Object.keys(profile.interactions).length} 组互动动作映射` : '未配置点击互动' },
    { id: 'hit-areas', status: mapped(Boolean((profile.hitAreaMap && Object.keys(profile.hitAreaMap).length) || profile.stageHitZones?.length)), reason: profile.hitAreaMap && Object.keys(profile.hitAreaMap).length ? `${Object.keys(profile.hitAreaMap).length} 个原生命中区映射` : profile.stageHitZones?.length ? `${profile.stageHitZones.length} 个舞台点击分区` : '未配置命中区或舞台分区' },
    { id: 'overlay-reset', status: mapped(Boolean(profile.overlaySettle && Object.keys(profile.overlaySettle.resetDefaults).length)), reason: profile.overlaySettle ? `${Object.keys(profile.overlaySettle.resetDefaults).length} 个叠层复位参数` : '未需要或未配置叠层复位' },
  ]
  const errors = [...validation.errors]
  return {
    profileId: profile.profileId,
    avatarId: profile.avatarId,
    backend,
    status: errors.length ? 'invalid' : compatible ? profile.verification.status : 'unsupported',
    items: errors.length ? items.map(item => ({ ...item, status: 'invalid' as const })) : items,
    errors,
  }
}

export function compileAdapterProfile(
  profile: Live2DAdapterProfile,
  backend: Live2DBackendKind,
): { ok: true; adapter: CompiledLive2DAdapter } | { ok: false; report: Live2DAdapterCapabilityReport } {
  const report = adapterCapabilityReport(profile, backend)
  if (report.status === 'invalid' || report.status === 'unsupported') return { ok: false, report }
  return {
    ok: true,
    adapter: {
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      avatarId: profile.avatarId,
      backend,
      mouth: profile.parameterBindings.mouth,
      blink: profile.parameterBindings.blink || [],
      focus: profile.parameterBindings.focus || [],
      interactions: profile.interactions || {},
      hitAreaMap: profile.hitAreaMap || {},
      hitAreaFallbacks: profile.hitAreaFallbacks || [],
      stageHitZones: profile.stageHitZones || [],
      defaultInteractionId: profile.defaultInteractionId,
      interactionHint: profile.interactionHint || '移动鼠标可跟随视线；当前模型未配置点击互动',
      emotionParams: profile.emotionParams || {},
      overlaySettle: profile.overlaySettle,
      entranceGroup: profile.layout?.entranceGroup,
      leaveGroup: profile.layout?.leaveGroup,
      report,
    },
  }
}
