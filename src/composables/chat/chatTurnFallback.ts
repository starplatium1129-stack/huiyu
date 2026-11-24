import { chatApiAddressError, chatApiEndpoint, chatApiPreset, chatApiVendorFor } from '@/config/chatApi'
import { loadSavedApiKeyDrafts } from '@/utils/chatApiDrafts'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { streamErrorCode } from '@/utils/stream'
import type { ChatProvider } from './chatStorageTypes'

export interface ChatFallbackCandidate {
  kind: 'api' | 'host'
  label: string
  baseUrl: string
  model: string
  apiKey: string
}

export interface PrimaryConnectionSnapshot {
  provider: ChatProvider
  baseUrl: string
  apiModel: string
  apiKey: string
  hostConfig: boolean
  hostBaseUrl: string
}

const NON_FALLBACK_CODES = new Set([
  'ABORTED',
  'DESKTOP_DRAINING',
  'LOCAL_ONLY',
  'TOOL_DESTINATION_CHANGED',
  'INVALID_REQUEST',
  'UPSTREAM_REQUEST_SIZE',
  'PRIVATE_UPSTREAM_FORBIDDEN',
])

export function shouldFallbackOnError(error: unknown, aborted: boolean, watchdogIdleTimedOut: boolean, sawFirstEvent: boolean): boolean {
  if (aborted) return watchdogIdleTimedOut && !sawFirstEvent
  const code = streamErrorCode(error)
  if (code && NON_FALLBACK_CODES.has(code)) return false
  return true
}

function candidateKey(baseUrl: string, model: string): string {
  return `${chatApiEndpoint(baseUrl) || baseUrl.trim().toLowerCase()}|${model.trim().toLowerCase()}`
}

function formatApiLabel(baseUrl: string, model: string): string {
  const vendor = chatApiPreset(chatApiVendorFor(baseUrl)).label
  return model ? `${vendor} · ${model}` : vendor
}

/**
 * Build an ordered, deduplicated list of fallback API models that already have
 * a saved API key (plus the configured host API as final fallback when active).
 */
export async function buildChatFallbackCandidates(
  primary: PrimaryConnectionSnapshot,
  host: { configured: boolean; baseUrl: string; model: string },
): Promise<ChatFallbackCandidate[]> {
  if (!isLocalStudioHost() || (primary.provider !== 'chatgpt' && primary.provider !== 'api')) return []
  const seen = new Set<string>()
  if (primary.provider === 'api') {
    const primaryUrl = primary.hostConfig ? primary.hostBaseUrl : primary.baseUrl
    const primaryModel = primary.hostConfig ? host.model : primary.apiModel
    if (primaryUrl && primaryModel) seen.add(candidateKey(primaryUrl, primaryModel))
  }
  const candidates: ChatFallbackCandidate[] = []
  const pushApi = (baseUrl: string, model: string, apiKey: string) => {
    const cleanUrl = baseUrl.trim()
    const cleanKey = apiKey.trim()
    if (!cleanUrl || !cleanKey || chatApiAddressError(cleanUrl)) return
    const preset = chatApiPreset(chatApiVendorFor(cleanUrl))
    const cleanModel = model.trim() || preset.models[0]?.value || ''
    if (!cleanModel) return
    const key = candidateKey(cleanUrl, cleanModel)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({
      kind: 'api',
      label: formatApiLabel(cleanUrl, cleanModel),
      baseUrl: cleanUrl,
      model: cleanModel,
      apiKey: cleanKey,
    })
  }

  // 1. Prefer the user's currently configured personal API when falling back from ChatGPT.
  if (primary.provider === 'chatgpt') {
    pushApi(primary.baseUrl, primary.apiModel, primary.apiKey)
  }

  // 2. Include all other saved provider drafts that already have a non-empty API key.
  const drafts = await loadSavedApiKeyDrafts()
  for (const draft of drafts) {
    pushApi(draft.baseUrl, draft.model, draft.apiKey)
  }

  // 3. Include the host-managed API config as a final fallback if configured and distinct.
  if (host.configured && host.baseUrl.trim() && host.model.trim() && !(primary.provider === 'api' && primary.hostConfig)) {
    const key = candidateKey(host.baseUrl, host.model)
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push({
        kind: 'host',
        label: `${formatApiLabel(host.baseUrl, host.model)}（托管）`,
        baseUrl: host.baseUrl.trim(),
        model: host.model.trim(),
        apiKey: '',
      })
    }
  }

  return candidates
}
