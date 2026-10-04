import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { catalogApi, type CatalogChange, type CatalogReceipt } from '@/api/catalogApi'
import { maintenanceApi } from '@/api/maintenanceApi'
import { ApiClientError } from '@/api/client'
import type { SceneDraft, SceneRating } from '@/types/api'
import type { SceneBlueprint, BlueprintCompositionIntent } from '@/types/sceneBlueprint'
import type { GeneratedSceneCapture } from '@/composables/prompt/useGeneratedSceneCapture'
import { buildGeneratedSceneDraft } from '@/utils/generatedSceneDraft'
import { useSceneStore } from '@/stores/sceneStore'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export function useGeneratedSceneSave(source: GeneratedSceneCapture) {
  const store = useSceneStore()
  const title = ref(source.recipe.sceneTitle || ''), story = ref(source.recipe.story || '')
  const rating = ref<SceneRating | ''>(''), composition = ref<BlueprintCompositionIntent>('single'), compositionEdited = ref(false)
  let applyingComposition = false, initializedComposition = false
  watch(composition, () => { if (!applyingComposition) compositionEdited.value = true }, { flush: 'sync' })
  const attachImage = ref(true), loading = ref(false), saving = ref(false), previewing = ref(false)
  const error = ref(''), imageError = ref(''), savedId = ref('')
  const baseline = shallowRef<{ scene?: SceneDraft; blueprint?: SceneBlueprint } | null>(null)
  const preview = shallowRef<CatalogReceipt | null>(null)
  let prepared: CatalogChange[] | null = null, recordId = '', alive = true
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
      const stats = await catalogApi.stats(abort.signal)
      const originId = popular ? source.recipe.blueprintId : source.recipe.scene
      const context: { scene?: SceneDraft; blueprint?: SceneBlueprint } = {}
      if (originId) {
        try {
          const origin = (await catalogApi.record(popular ? 'blueprint' : 'scene', originId, undefined, abort.signal)).record.data
          if (popular) context.blueprint = origin as unknown as SceneBlueprint
          else context.scene = origin as SceneDraft
        } catch (cause) { if (!(cause instanceof ApiClientError && cause.status === 404)) throw cause }
      }
      if (!alive) return
      baseline.value = context
      if (!recordId) recordId = popular ? source.recipe.characterId + '_saved_' + crypto.randomUUID().replaceAll('-', '') : stats.nextSceneId
      if (!initializedComposition) {
        applyingComposition = true
        if (!compositionEdited.value && context.blueprint?.compositionIntent) composition.value = context.blueprint.compositionIntent
        applyingComposition = false; initializedComposition = true
      }
    } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : '读取场景来源失败' }
    finally { loading.value = false }
  }
  onMounted(load)
  async function review() {
    if (!canReview.value || !baseline.value || !rating.value) return
    previewing.value = true; error.value = ''
    try {
      const result = buildGeneratedSceneDraft({ recipe: source.recipe, ...baseline.value }, { id: recordId, title: title.value.trim(), story: story.value.trim(), rating: rating.value, compositionIntent: composition.value })
      const payload: CatalogChange[] = [{ kind: result.kind, id: recordId, expectedRevision: 0, data: result.draft as unknown as Record<string, unknown> }]
      const key = JSON.stringify([title.value, story.value, rating.value, composition.value])
      const impact = await catalogApi.changes(payload, true, abort.signal)
      if (!alive || key !== JSON.stringify([title.value, story.value, rating.value, composition.value])) return
      prepared = payload; preview.value = impact
    } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : '场景检查失败' }
    finally { previewing.value = false }
  }
  async function saveImage() {
    if (!savedId.value || saving.value) return
    saving.value = true; imageError.value = ''
    try {
      const image = await blobThumbDataUrl(source.image, 4096, 0.94), thumbnail = await blobThumbDataUrl(source.image, 560, 0.84)
      if (!alive) return
      if (!image || !thumbnail) throw new Error('图片转换失败')
      await maintenanceApi.saveShowcase({ id: savedId.value, image, thumbnail }, { signal: abort.signal })
    } catch (cause) { if (alive) imageError.value = '场景已保存，样张尚未保存：' + (cause instanceof Error ? cause.message : '请重试') }
    finally { saving.value = false }
  }
  async function save() {
    if (!prepared || !preview.value || saving.value || savedId.value) return
    const payload = prepared
    saving.value = true; error.value = ''
    try {
      await catalogApi.changes(payload, false, abort.signal)
      if (alive) { savedId.value = recordId; store.invalidate() }
    } catch (cause) {
      try {
        const actual = (await catalogApi.record(popular ? 'blueprint' : 'scene', recordId, undefined, abort.signal)).record.data
        if (alive && JSON.stringify(actual) === JSON.stringify(payload[0].data)) { savedId.value = recordId; store.invalidate() }
        else if (alive) { error.value = '保存未完成：' + (cause instanceof Error ? cause.message : '') + '。填写内容已保留。' }
      } catch (confirmation) {
        if (alive) error.value = confirmation instanceof ApiClientError && confirmation.status === 404
          ? '保存未完成：' + (cause instanceof Error ? cause.message : '') + '。填写内容已保留，请检查后再保存。'
          : '暂时无法确认保存结果。恢复连接后再次保存，将核对同一编号，不会另建副本。'
      }
    } finally { saving.value = false }
    if (alive && savedId.value && attachImage.value) await saveImage()
  }
  return { title, story, rating, composition, compositionEdited, attachImage, popular, loading, saving, previewing, error, imageError, savedId, baseline, preview, canReview, load, review, save, saveImage }
}
