import type { Live2DBackendKind } from './types'
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
} from '@/composables/live2d/constants'

export type Live2DCapabilityStatus = 'detected' | 'needs-confirmation' | 'verified' | 'unsupported' | 'invalid'

export interface Live2DParameterBinding {
  channel: string
  paramIds: string[]
  range?: [number, number]
  neutral?: number
  scale?: number
  reversed?: boolean
}

export interface Live2DAdapterProfile {
  schemaVersion: 1
  profileId: string
  profileVersion: string
  avatarId: string
  backendCompatibility: readonly Live2DBackendKind[]
  parameterBindings: {
    mouth: { id: string; scale: number; range?: [number, number] }
    blink: readonly string[]
    focus?: readonly string[]
    custom?: Record<string, Live2DParameterBinding>
  }
  hitAreaMap?: Record<string, string>
  interactions?: Record<string, Live2DInteraction>
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

/** Builtin verified profile for Nene Ayachi */
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
  layout: {
    bubbleAnchor: { x: 0.5, y: 0.2 },
    scale: 1.0,
  },
  verification: {
    status: 'verified' as const,
    reason: 'Official studio reference model verified across browser and native overlay runtimes.',
    lastVerifiedAt: '2026-09-18',
  },
})

/** Builtin verified profile for Natsume Shiki with verified custom mouth, blink, and overlay resets */
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
  interactions: NATSUME_INTERACTIONS,
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
    status: 'verified' as const,
    reason: 'Verified workshop model with ParamMouthForm3, dual-eye blink sync, and overlay default resets.',
    lastVerifiedAt: '2026-09-18',
  },
})

export function validateAdapterProfile(candidate: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['Profile must be an object'] }
  }
  const p = candidate as Partial<Live2DAdapterProfile>
  if (p.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!p.profileId || typeof p.profileId !== 'string') errors.push('profileId is required')
  if (!p.avatarId || typeof p.avatarId !== 'string') errors.push('avatarId is required')
  if (!p.parameterBindings || typeof p.parameterBindings !== 'object') {
    errors.push('parameterBindings is required')
  } else {
    if (!p.parameterBindings.mouth?.id) errors.push('mouth parameter id is required')
    if (!Array.isArray(p.parameterBindings.blink) || !p.parameterBindings.blink.length) {
      errors.push('blink parameters must be a non-empty array')
    }
  }
  if (!p.verification?.status) {
    errors.push('verification status is required')
  }
  return { valid: errors.length === 0, errors }
}
