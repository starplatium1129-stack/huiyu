import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useSceneStore } from '@/stores/sceneStore'
import { parseCharacterProfiles } from '@/utils/characterProfiles'
import { isPopularPortraitPending, popularPortraitFullSrc } from '@/utils/popularPortraitSource'
import { withinImageDecodeBudget } from '@/utils/imageDecodeBudget'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { confirmAction } from '@/composables/useConfirm'
import { characterArtApi } from '@/api/characterArtApi'
import { characterArtManifest, characterArtEntry } from '@/platform/characterArtState'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export function useCharacterArtManager(initialId: () => string | undefined) {
  const store = useSceneStore()
  const selectedId = ref(''), previewUrl = ref(''), feedback = ref(''), error = ref('')
  const loading = ref(false), saving = ref(false), reading = ref(false), ready = ref(false)
  const file = shallowRef<File | null>(null)
  const fileReady = ref(false)
  const local = isLocalStudioHost()
  const profiles = computed(() => parseCharacterProfiles(store.characters))
  const current = computed(() => profiles.value.find(item => item.id === selectedId.value))
  const custom = computed(() => characterArtEntry(selectedId.value))
  const originalUrl = computed(() => {
    if (custom.value) return custom.value.portraitUrl
    if (isPopularPortraitPending(selectedId.value)) return popularPortraitFullSrc(selectedId.value)
    return current.value?.portrait?.image?.replace(/^\.\.\//, '/') || ''
  })
  const abort = new AbortController()
  let reader: FileReader | null = null
  let alive = true
  let readRevision = 0
  let saveAttempted = false
  const newSource = () => ({ session: imageMediaSession(), controller: new AbortController() })
  let source = newSource()
  type Source = typeof source
  let picker: { source: Source; id: string; revision: number } | undefined
  const ownsSource = (expected: Source) => alive && expected === source && !expected.controller.signal.aborted
    && expected.session === imageMediaSession()
  function syncSource() {
    if (source.session === imageMediaSession()) return
    source.controller.abort(); source = newSource()
    readRevision++; picker = undefined; reader?.abort()
    ready.value = false; fileReady.value = false; feedback.value = ''
    error.value = '连接已变化，请重新读取并重新选择图片；原候选仍保留，已发出的保存需回到原来源核对'
  }
  const stopRuntime = onDesktopRuntime(syncSource)
  const stopResource = watch(runtimeResourceIdentity, syncSource, { flush: 'sync' })

  function discard() {
    readRevision++; picker = undefined
    reader?.abort(); reader = null
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''; file.value = null; fileReady.value = false; saveAttempted = false
  }
  const releaseMaintenance = registerMaintenanceParticipant(() => {
    if (saving.value || file.value) throw new Error('UNSAVED_CHARACTER_ART')
  })
  onBeforeUnmount(() => { alive = false; stopRuntime(); stopResource(); source.controller.abort(); abort.abort(); discard(); releaseMaintenance() })
  async function canLeave() {
    const unapplied = fileReady.value && !saveAttempted
    return !saving.value && (!file.value || await confirmAction({
      title: unapplied ? '放弃尚未保存的立绘？' : '丢弃本窗口保留的候选图片？',
      message: unapplied ? '当前候选图片尚未提交，离开只放弃这次选择，不会提交这张图片。'
        : '离开只丢弃本窗口的候选图片，不会撤销已提交的修改；保存结果未确认时，请回到原来源核对。',
      confirmLabel: unapplied ? '放弃替换' : '丢弃候选并离开',
    }))
  }
  onBeforeRouteLeave(canLeave)

  async function selectCharacter(id: string) {
    if (saving.value || reading.value || id === selectedId.value || !profiles.value.some(item => item.id === id)) return
    const expected = source, previousId = selectedId.value, previousFile = file.value
    if (file.value && !await confirmAction({ title: '切换角色并放弃当前图片？',
      message: fileReady.value && !saveAttempted ? undefined : '切换只丢弃本窗口的候选图片，不会撤销已提交的修改；保存结果未确认时，请回到原来源核对。',
      confirmLabel: '切换角色', signal: expected.controller.signal })) return
    if (!ownsSource(expected) || previousId !== selectedId.value || previousFile !== file.value || saving.value || reading.value) return
    discard(); selectedId.value = id; feedback.value = ''; error.value = ''
  }
  watch(initialId, id => { if (id) void selectCharacter(id) })

  async function load() {
    if (loading.value || saving.value) return
    const expected = source, signal = AbortSignal.any([abort.signal, expected.controller.signal])
    loading.value = true; error.value = ''
    try {
      if (!local) throw new Error('角色图片维护仅允许在本机使用')
      await Promise.all([
        store.loadCharacterShell(), characterArtApi.get({ signal }),
      ])
      if (!ownsSource(expected)) return
      ready.value = true
      if (file.value && !fileReady.value) error.value = '已读取当前来源；原候选尚未绑定，请重新选择图片后再应用'
      if (!selectedId.value) selectedId.value = profiles.value.some(item => item.id === initialId())
        ? initialId()! : profiles.value[0]?.id || ''
    } catch (cause) { if (ownsSource(expected)) { ready.value = false; error.value = cause instanceof Error ? cause.message : '读取角色图片失败' } }
    finally { loading.value = false }
  }
  onMounted(load)

  function beginPick() {
    if (!alive || !ready.value || saving.value || reading.value || !local || !selectedId.value || !ownsSource(source)) return false
    picker = { source, id: selectedId.value, revision: ++readRevision }
    return true
  }
  async function pick(candidate: File) {
    const selected = picker; picker = undefined
    const current = () => !!selected && ownsSource(selected.source) && selected.id === selectedId.value && selected.revision === readRevision
    if (!current() || saving.value || reading.value) return
    error.value = ''; feedback.value = ''; reading.value = true
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(candidate.type)) throw new Error('请选择 PNG、JPEG 或 WebP 静态图片')
      if (candidate.size > 15 * 1024 * 1024) throw new Error('图片不能超过 15 MB')
      if (!await withinImageDecodeBudget(candidate)) throw new Error('图片无法读取，或超过 8192 像素边长 / 3200 万像素上限')
      if (!current()) return
      discard()
      file.value = candidate; fileReady.value = true; previewUrl.value = URL.createObjectURL(candidate)
    } catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : '图片读取失败' }
    finally { reading.value = false }
  }
  function dataUrl(image: Blob, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const selected = new FileReader(); reader = selected
      const cancel = () => selected.abort()
      function finish(error?: Error) {
        signal.removeEventListener('abort', cancel)
        selected.onload = selected.onerror = selected.onabort = null
        if (reader === selected) reader = null
        if (error) reject(error); else resolve(String(selected.result || ''))
      }
      selected.onload = () => finish()
      selected.onerror = () => finish(new Error('图片读取失败'))
      selected.onabort = () => finish(new Error('已取消图片读取'))
      signal.addEventListener('abort', cancel, { once: true })
      try { selected.readAsDataURL(image) } catch { finish(new Error('图片读取失败')) }
    })
  }
  async function commit(reset = false) {
    if (!ready.value || saving.value || reading.value || !selectedId.value || (!reset && (!file.value || !fileReady.value))) return
    const id = selectedId.value, candidate = file.value, expected = source, baseVersion = characterArtManifest.value.version
    const ownsIntent = () => ownsSource(expected) && id === selectedId.value
    let posted = false
    saving.value = true
    try {
      if (reset && !await confirmAction({ title: `恢复${current.value?.name || '该角色'}的内置形象？`,
        message: '立绘、缩略图和粒子会一起恢复为内置资源。', confirmLabel: '恢复内置', signal: expected.controller.signal })) return
      if (!ownsIntent()) return
      error.value = ''; feedback.value = ''
      const payload = reset ? { id, baseVersion, reset: true as const } : { id, baseVersion, image: await dataUrl(candidate!, expected.controller.signal) }
      if (!ownsIntent()) return
      // Source retirement stops preparation, not an already accepted write.
      posted = true
      saveAttempted = true
      await characterArtApi.save(payload, { signal: abort.signal })
      if (!alive) return
      if (!ownsIntent()) { error.value = ''; feedback.value = '原来源的形象保存已完成；连接已变化，请回到原来源核对'; return }
      discard()
      feedback.value = reset ? '已恢复内置立绘、缩略图与粒子形象' : '已替换立绘，关联缩略图和粒子已同步更新'
    } catch (cause) {
      if (!alive) return
      if (!ownsIntent()) {
        if (posted) error.value = '原来源的形象保存结果尚未确认，请回到原来源核对；不会自动重试或绑定当前来源'
        return
      }
      error.value = cause instanceof Error ? cause.message : '保存失败，请重试'
      // Re-read the authority after conflicts or a lost acknowledgement; keep the candidate.
      try { await characterArtApi.get({ signal: AbortSignal.any([abort.signal, expected.controller.signal]) }) }
      catch { ready.value = false }
    } finally { reader = null; saving.value = false }
  }
  return { selectedId, previewUrl, feedback, error, loading, saving, reading, ready, file, fileReady,
    profiles, current, custom, originalUrl, local, load, selectCharacter, beginPick, pick, discard, canLeave,
    save: () => commit(), reset: () => commit(true) }
}
