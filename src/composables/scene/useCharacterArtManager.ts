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

export function useCharacterArtManager(initialId: () => string | undefined) {
  const store = useSceneStore()
  const selectedId = ref(''), previewUrl = ref(''), feedback = ref(''), error = ref('')
  const loading = ref(false), saving = ref(false), reading = ref(false), ready = ref(false)
  const file = shallowRef<File | null>(null)
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

  function discard() {
    readRevision++
    reader?.abort(); reader = null
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''; file.value = null
  }
  const releaseMaintenance = registerMaintenanceParticipant(() => {
    if (saving.value || file.value) throw new Error('UNSAVED_CHARACTER_ART')
  })
  onBeforeUnmount(() => { alive = false; abort.abort(); discard(); releaseMaintenance() })
  onBeforeRouteLeave(async () => !saving.value && (!file.value || await confirmAction({
    title: '放弃尚未保存的立绘？', message: '当前选择的图片还未应用，原有形象不受影响。', confirmLabel: '放弃替换',
  })))

  async function selectCharacter(id: string) {
    if (saving.value || reading.value || id === selectedId.value || !profiles.value.some(item => item.id === id)) return
    if (file.value && !await confirmAction({ title: '切换角色并放弃当前图片？', confirmLabel: '切换角色' })) return
    discard(); selectedId.value = id; feedback.value = ''; error.value = ''
  }
  watch(initialId, id => { if (id) void selectCharacter(id) })

  async function load() {
    if (loading.value || saving.value) return
    loading.value = true; error.value = ''
    try {
      if (!local) throw new Error('角色图片维护仅允许在本机使用')
      await Promise.all([
        store.loadCharacterShell(), characterArtApi.get({ signal: abort.signal }),
      ])
      if (!alive) return
      ready.value = true
      if (!selectedId.value) selectedId.value = profiles.value.some(item => item.id === initialId())
        ? initialId()! : profiles.value[0]?.id || ''
    } catch (cause) { if (alive) { ready.value = false; error.value = cause instanceof Error ? cause.message : '读取角色图片失败' } }
    finally { loading.value = false }
  }
  onMounted(load)

  async function pick(candidate: File) {
    if (saving.value || reading.value) return
    error.value = ''; feedback.value = ''; reading.value = true
    const revision = ++readRevision
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(candidate.type)) throw new Error('请选择 PNG、JPEG 或 WebP 静态图片')
      if (candidate.size > 15 * 1024 * 1024) throw new Error('图片不能超过 15 MB')
      if (!await withinImageDecodeBudget(candidate)) throw new Error('图片无法读取，或超过 8192 像素边长 / 3200 万像素上限')
      if (!alive || revision !== readRevision) return
      discard()
      file.value = candidate; previewUrl.value = URL.createObjectURL(candidate)
    } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : '图片读取失败' }
    finally { reading.value = false }
  }
  function dataUrl(image: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      reader = new FileReader()
      reader.onload = () => resolve(String(reader?.result || ''))
      reader.onerror = () => reject(new Error('图片读取失败'))
      reader.onabort = () => reject(new Error('已取消图片读取'))
      reader.readAsDataURL(image)
    })
  }
  async function commit(reset = false) {
    if (!ready.value || saving.value || reading.value || !selectedId.value || (!reset && !file.value)) return
    const id = selectedId.value, baseVersion = characterArtManifest.value.version
    saving.value = true
    try {
      if (reset && !await confirmAction({ title: `恢复${current.value?.name || '该角色'}的内置形象？`,
        message: '立绘、缩略图和粒子会一起恢复为内置资源。', confirmLabel: '恢复内置' })) return
      if (!alive) return
      error.value = ''; feedback.value = ''
      const payload = reset ? { id, baseVersion, reset: true as const } : { id, baseVersion, image: await dataUrl(file.value!) }
      if (!alive) return
      await characterArtApi.save(payload, { signal: abort.signal })
      if (!alive) return
      discard()
      feedback.value = reset ? '已恢复内置立绘、缩略图与粒子形象' : '已替换立绘，关联缩略图和粒子已同步更新'
    } catch (cause) {
      if (!alive) return
      error.value = cause instanceof Error ? cause.message : '保存失败，请重试'
      // Re-read the authority after conflicts or a lost acknowledgement; keep the candidate.
      try { await characterArtApi.get({ signal: abort.signal }) }
      catch { ready.value = false }
    } finally { reader = null; saving.value = false }
  }
  return { selectedId, previewUrl, feedback, error, loading, saving, reading, ready, file,
    profiles, current, custom, originalUrl, local, load, selectCharacter, pick, discard,
    save: () => commit(), reset: () => commit(true) }
}
