import { computed, ref } from 'vue'
import { mediaPacksApi, type MediaPackId, type MediaPacksStatus } from '@/api/mediaPacksApi'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

const status = ref<MediaPacksStatus | null>(null)
const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const onboardingVisible = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | undefined
let activeRequest: AbortController | null = null
let consumers = 0
let initialChecked = false

export function formatPackBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatPackSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return ''
  return `${formatPackBytes(bps)}/s`
}

function schedulePoll() {
  clearTimeout(pollTimer)
  if (consumers <= 0 || !isLocalStudioHost()) return
  const busy = status.value?.busy === true
  if (!busy) return
  pollTimer = setTimeout(() => void refreshMediaPacks(false), 700)
}

export async function refreshMediaPacks(refreshRemote = false): Promise<MediaPacksStatus | null> {
  if (!isLocalStudioHost()) return null
  activeRequest?.abort()
  const controller = new AbortController()
  activeRequest = controller
  loading.value = true
  try {
    const next = await mediaPacksApi.status(refreshRemote, controller.signal)
    if (activeRequest !== controller) return status.value
    status.value = next
    error.value = ''
    return next
  } catch (err) {
    if (activeRequest === controller && !(err instanceof DOMException && err.name === 'AbortError')) {
      error.value = err instanceof Error ? err.message : '无法读取在线资源包状态'
    }
    return null
  } finally {
    if (activeRequest === controller) {
      activeRequest = null
      loading.value = false
      schedulePoll()
    }
  }
}

export async function checkMediaPacksOnboarding(): Promise<void> {
  if (initialChecked || !isLocalStudioHost()) return
  initialChecked = true
  const current = await refreshMediaPacks(false)
  if (current?.onboarding.shouldPrompt) {
    onboardingVisible.value = true
  }
}

export const onboardingVisibleState = onboardingVisible

export function openMediaPacksOnboarding(): void {
  onboardingVisible.value = true
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('huiyu:media-packs-onboarding'))
  void refreshMediaPacks(false)
}

export function closeMediaPacksOnboarding(): void {
  onboardingVisible.value = false
}

export function useMediaPacks() {
  const isLocal = isLocalStudioHost()
  const busy = computed(() => submitting.value || status.value?.busy === true)
  const portraitsPack = computed(() => status.value?.packs.find(p => p.id === 'portraits') ?? null)
  const showcasePack = computed(() => status.value?.packs.find(p => p.id === 'showcase') ?? null)
  const task = computed(() => status.value?.task ?? null)

  function retain() {
    consumers++
    if (isLocal && !status.value) void refreshMediaPacks(false)
    else schedulePoll()
  }

  function release() {
    consumers = Math.max(0, consumers - 1)
    if (consumers === 0) clearTimeout(pollTimer)
  }

  async function startInstall(packs: MediaPackId[]) {
    if (!isLocal || submitting.value || !packs.length) return false
    submitting.value = true
    error.value = ''
    try {
      const result = await mediaPacksApi.install(packs)
      if (status.value) {
        status.value = { ...status.value, busy: true, task: result.task }
      }
      schedulePoll()
      void refreshMediaPacks(false)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '启动资源包下载失败'
      return false
    } finally {
      submitting.value = false
    }
  }

  async function installPreset(mode: 'full' | 'lite') {
    const packs: MediaPackId[] = []
    if (mode === 'full') {
      if (!portraitsPack.value?.installed || portraitsPack.value.remote.updateAvailable) packs.push('portraits')
      if (!showcasePack.value?.installed || showcasePack.value.remote.updateAvailable) packs.push('showcase')
      if (!packs.length) packs.push('portraits', 'showcase')
    } else {
      packs.push('portraits')
    }
    return startInstall(packs)
  }

  async function cancel() {
    if (!isLocal || submitting.value) return
    submitting.value = true
    try {
      const result = await mediaPacksApi.cancel()
      if (status.value) status.value = { ...status.value, task: result.task }
      void refreshMediaPacks(false)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '暂停下载失败'
    } finally {
      submitting.value = false
    }
  }

  async function uninstall(packId: MediaPackId) {
    if (!isLocal || submitting.value) return false
    submitting.value = true
    error.value = ''
    try {
      await mediaPacksApi.uninstall(packId)
      await refreshMediaPacks(false)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '卸载资源包失败'
      return false
    } finally {
      submitting.value = false
    }
  }

  async function dismissOnboarding() {
    onboardingVisible.value = false
    if (!isLocal) return
    try {
      await mediaPacksApi.updateSettings({ onboardingDismissed: true })
      await refreshMediaPacks(false)
    } catch { /* non-blocking */ }
  }

  async function saveSettings(patch: { mirrorOrigin?: string; manifestUrl?: string }) {
    if (!isLocal || submitting.value) return false
    submitting.value = true
    error.value = ''
    try {
      await mediaPacksApi.updateSettings(patch)
      await refreshMediaPacks(true)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '保存下载源设置失败'
      return false
    } finally {
      submitting.value = false
    }
  }

  return {
    isLocal,
    status,
    loading,
    submitting,
    error,
    busy,
    task,
    portraitsPack,
    showcasePack,
    onboardingVisible,
    retain,
    release,
    refresh: refreshMediaPacks,
    startInstall,
    installPreset,
    cancel,
    uninstall,
    dismissOnboarding,
    saveSettings,
    openOnboarding: openMediaPacksOnboarding,
    closeOnboarding: closeMediaPacksOnboarding,
  }
}
