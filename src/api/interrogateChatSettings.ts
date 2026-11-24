import { chatApiAddressError, chatApiPreset, chatApiVendorFor } from '@/config/chatApi'
import { readChatPreferences } from '@/storage/chatPreferences'
import { abortableTask } from '@/utils/abortableTask'
import { createChatCredentials } from '@/utils/chatCredentials'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export async function interrogateChatHeaders(signal: AbortSignal, includeSecret: boolean): Promise<Record<string, string>> {
  // Only the trusted loopback runtime receives personal settings. The status
  // request projects the endpoint and model without the saved key.
  if (!isLocalStudioHost()) return {}
  try {
    const preferences = readChatPreferences()
    if (!preferences?.apiConfiguredByUser || !preferences.apiModel.trim()
      || chatApiAddressError(preferences.apiBaseUrl)) return {}
    const { apiBaseUrl: baseUrl, apiModel: model, apiSettingsRevision } = preferences
    const lookup = AbortSignal.any([signal, AbortSignal.timeout(3000)])
    const apiKey = await abortableTask(() => createChatCredentials().load(baseUrl, ''), lookup)
    const current = readChatPreferences()
    if (!current?.apiConfiguredByUser || current.apiBaseUrl !== baseUrl || current.apiModel !== model
      || current.apiSettingsRevision !== apiSettingsRevision
      || (chatApiPreset(chatApiVendorFor(baseUrl)).keyRequired && !apiKey)) return {}
    const bytes = new TextEncoder().encode(JSON.stringify({ baseUrl, model, ...(includeSecret ? { apiKey } : {}) }))
    return { 'x-aics-interrogate-api': btoa(String.fromCharCode(...bytes)) }
  } catch {
    // An unavailable personal credential leaves the host/OAuth and PixAI
    // routes usable. Cancellation must still stop the image upload.
    signal.throwIfAborted()
    return {}
  }
}
