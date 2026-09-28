import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { maintenanceApi } from '@/api/maintenanceApi'
import { ApiClientError } from '@/api/client'
import type { SceneChangesPayload, SceneChangesPreview, SceneRating, ScenesStateResult } from '@/types/api'
import type { BlueprintCompositionIntent } from '@/types/sceneBlueprint'
import type { GeneratedSceneCapture } from '@/composables/prompt/useGeneratedSceneCapture'
import { buildGeneratedSceneDraft } from '@/utils/generatedSceneDraft'
import { useSceneStore } from '@/stores/sceneStore'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export function useGeneratedSceneSave(source: GeneratedSceneCapture) {
  const store = useSceneStore()
  const title = ref(source.recipe.sceneTitle || '')
  const story = ref(source.recipe.story || '')
  const rating = ref<SceneRating | ''>('')
  const composition = ref<BlueprintCompositionIntent>('single')
  const compositionEdited = ref(false)
  let applyingComposition = false, initializedComposition = false
  watch(composition, () => { if (!applyingComposition) compositionEdited.value = true }, { flush: 'sync' })
  const attachImage = ref(true)
  const loading = ref(false), saving = ref(false), previewing = ref(false)
  const error = ref(''), imageError = ref(''), savedId = ref('')
  const baseline = shallowRef<ScenesStateResult | null>(null)
  const preview = shallowRef<SceneChangesPreview | null>(null)
  let prepared: SceneChangesPayload | null = null
  let recordId = ''
  let alive = true
  const abort = new AbortController()
  onBeforeUnmount(() => { alive = false; abort.abort() })
  const popular = Boolean(source.recipe.characterId && source.recipe.subject === 'popular')
  const canReview = computed(() => !!baseline.value && !!title.value.trim() && !!story.value.trim()
    && !!rating.value && !loading.value && !saving.value && !previewing.value && !savedId.value)
  watch([title, story, rating, composition], () => { preview.value = null; prepared = null })

  async function load() {
    if (loading.value || saving.value || previewing.value || savedId.value) return
    loading.value = true; error.value = ''; preview.value = null; prepared = null
    try {
      if (!isLocalStudioHost()) throw new Error('请在本机工作室保存场景')
      const state = await maintenanceApi.getScenesState({ signal: abort.signal })
      if (!alive) return
      baseline.value = state
      if (!recordId) recordId = popular
        ? `${source.recipe.characterId}_saved_${crypto.randomUUID().replaceAll('-', '')}` : (state.nextSceneId || '')
      if (!recordId) throw new Error('场景编号已用尽，无法新增场景')
      const origin = state.snapshot.blueprints.find(row => row.id === source.recipe.blueprintId)
      if (!initializedComposition) {
        applyingComposition = true
        if (!compositionEdited.value && origin?.compositionIntent) composition.value = origin.compositionIntent
        applyingComposition = false; initializedComposition = true
      }
    } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : '读取场景库失败' }
    finally { loading.value = false }
  }
  onMounted(load)

  async function review() {
    if (!canReview.value || !baseline.value || !rating.value) return
    previewing.value = true; error.value = ''
    try {
      const state = baseline.value
      const result = buildGeneratedSceneDraft({ recipe: source.recipe,
        scene: state.snapshot.scenes.find(row => row.id === source.recipe.scene),
        blueprint: state.snapshot.blueprints.find(row => row.id === source.recipe.blueprintId),
      }, { id: recordId, title: title.value.trim(), story: story.value.trim(), rating: rating.value, compositionIntent: composition.value })
      const payload: SceneChangesPayload = { baseVersion: state.version, changeSet: { version: 1,
        scenes: { upsert: result.kind === 'scene' ? [result.draft] : [], remove: [] },
        ...(result.kind === 'blueprint' ? { blueprints: { upsert: [result.draft], remove: [] } } : {}),
      } }
      const key = JSON.stringify([title.value, story.value, rating.value, composition.value])
      const impact = await maintenanceApi.previewSceneChanges(payload, { signal: abort.signal })
      if (!alive || key !== JSON.stringify([title.value, story.value, rating.value, composition.value])) return
      if (impact.version !== state.version) throw new Error('场景库已更新，请重新读取后检查；填写的内容会保留')
      prepared = payload; preview.value = impact
    } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : '场景检查失败' }
    finally { previewing.value = false }
  }

  async function saveImage() {
    if (!savedId.value || saving.value) return
    saving.value = true; imageError.value = ''
    try {
      const image = await blobThumbDataUrl(source.image, 2048, 0.92)
      const thumbnail = await blobThumbDataUrl(source.image, 560, 0.84)
      if (!alive) return
      if (!image || !thumbnail) throw new Error('图片转换失败')
      await maintenanceApi.saveShowcase({ id: savedId.value, image, thumbnail }, { signal: abort.signal })
    } catch (cause) {
      if (alive) imageError.value = `场景已保存，样张尚未保存：${cause instanceof Error ? cause.message : '请重试'}`
    } finally { saving.value = false }
  }

  async function save() {
    if (!prepared || !preview.value || saving.value || savedId.value) return
    const payload = prepared
    saving.value = true; error.value = ''
    try {
      await maintenanceApi.saveSceneChanges(payload, { signal: abort.signal })
      if (alive) { savedId.value = recordId; store.invalidate() }
    } catch (cause) {
      // A lost acknowledgement must not turn retry into a second new scene.
      try {
        const state = await maintenanceApi.getScenesState({ signal: abort.signal })
        const expected = payload.changeSet.scenes.upsert[0] || payload.changeSet.blueprints?.upsert[0]
        const actual = popular ? state.snapshot.blueprints.find(row => row.id === recordId)
          : state.snapshot.scenes.find(row => row.id === recordId)
        if (alive && actual && expected && actual.title === expected.title
          && (('story' in actual && 'story' in expected && actual.story === expected.story)
            || ('description' in actual && 'description' in expected && actual.description === expected.description))
          && JSON.stringify(actual.generatedRecipe) === JSON.stringify(expected?.generatedRecipe)) {
          savedId.value = recordId; store.invalidate()
        } else if (alive) {
          recordId = ''
          baseline.value = null; prepared = null; preview.value = null
          const issues = cause instanceof ApiClientError ? cause.responseBody?.issues : null
          const detail = Array.isArray(issues) ? issues.slice(0, 2).join('；') : (cause instanceof Error ? cause.message : '')
          error.value = `保存未完成：${detail}。请重新读取并检查，填写的内容已保留。`
        }
      } catch {
        if (alive) error.value = '暂时无法确认保存结果。请恢复连接后再次保存，将核对同一场景编号，不会另建副本。'
      }
    } finally { saving.value = false }
    if (alive && savedId.value && attachImage.value) await saveImage()
  }
  return { title, story, rating, composition, compositionEdited, attachImage, popular, loading, saving, previewing,
    error, imageError, savedId, baseline, preview, canReview, load, review, save, saveImage }
}
