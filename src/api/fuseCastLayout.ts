import { runtimeFetch } from '@/platform/runtimeUrl'
import type { CastMember, PromptPlan } from '@/types/prompt'
import type { DraftReferenceInput } from '@/utils/promptBuilderPersistence'
import { referenceCharacterCount } from '@/utils/promptCast'

export interface FuseCastMemberPayload {
  slot: string
  name: string
  identity: string
  outfitMode: 'reference' | 'explicit' | 'none'
  outfit: string
  action: string
}

export interface FuseCastResult {
  fused: boolean
  prompt: string
  provider?: string | null
  model?: string | null
  cacheHit?: boolean
}

function buildCastSummaryPayload(
  plan: PromptPlan | null,
  cast: readonly CastMember[],
  reference: DraftReferenceInput | null,
): FuseCastMemberPayload[] {
  const subjects = plan?.mossLayout?.subjects ?? []
  const refBoxes = referenceCharacterCount(reference?.layout)
  const useReference = refBoxes >= cast.length && refBoxes > 0
  return subjects.map((subject, index) => {
    const member = cast[index]
    const outfitMode: FuseCastMemberPayload['outfitMode'] = member?.outfitId === 'none'
      ? 'none'
      : subject.outfitExplicit || !useReference
        ? 'explicit'
        : 'reference'
    return {
      slot: `#${index + 1}`,
      name: subject.name || member?.name || member?.characterId || `Character ${index + 1}`,
      identity: subject.identityCaption || subject.caption || '',
      outfitMode,
      outfit: outfitMode === 'explicit' ? (subject.outfitCaption || '') : '',
      action: subject.action || '',
    }
  })
}

/**
 * Best-effort Chat-API semantic fusion for multi-character MOSS layouts.
 * Always falls back cleanly to `draftPrompt` when offline, unconfigured, or timed out.
 */
export async function fuseMossCastPrompt(params: {
  draftPrompt: string
  plan: PromptPlan | null
  cast: readonly CastMember[]
  interaction: string
  userDescription: string
  reference: DraftReferenceInput | null
  signal?: AbortSignal
}): Promise<FuseCastResult> {
  const { draftPrompt, plan, cast, interaction, userDescription, reference } = params
  const timeout = AbortSignal.timeout(18_000)
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout
  try {
    const { interrogateChatHeaders } = await import('./interrogateChatSettings')
    const personal = await interrogateChatHeaders(signal, true).catch(() => ({}))
    const response = await runtimeFetch('/api/interrogate/fuse-cast', {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...personal },
      body: JSON.stringify({
        draftPrompt,
        cast: buildCastSummaryPayload(plan, cast, reference),
        interaction: interaction.trim() || undefined,
        userDescription: userDescription.trim() || undefined,
        referenceScene: reference?.layout?.scene || undefined,
      }),
    })
    if (!response.ok) return { fused: false, prompt: draftPrompt }
    const data = await response.json().catch(() => null) as Record<string, unknown> | null
    if (data && data.ok === true && data.fused === true && typeof data.prompt === 'string' && data.prompt.trim()) {
      return {
        fused: true,
        prompt: data.prompt,
        provider: typeof data.provider === 'string' ? data.provider : null,
        model: typeof data.model === 'string' ? data.model : null,
        cacheHit: data.cacheHit === true,
      }
    }
  } catch {
    // Silent fallback to deterministic Layer-1 compiled layout.
  }
  return { fused: false, prompt: draftPrompt }
}
