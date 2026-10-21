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
import { catalogShowcaseId } from '@/utils/showcaseManifest'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export function useGeneratedSceneSave(source: GeneratedSceneCapture) {
  const store = useSceneStore()
  const sourceIdentity = runtimeResourceIdentity()
  function requireOriginalSource() {
    if (runtimeResourceIdentity() !== sourceIdentity) throw new Error('运行时连接已变化，不能在新连接核对原保存或保存样张。请记下原编号，在原内容库中确认。')
  }
  const title = ref(source.recipe.sceneTitle || ''), story = ref(source.recipe.story || '')
  const rating = ref<SceneRating | ''>(''), composition = ref<BlueprintCompositionIntent>('single'), compositionEdited = ref(false)
  let applyingComposition = false, initializedComposition = false
  watch(composition, () => { if (!applyingComposition) compositionEdited.value = true }, { flush: 'sync' })
  const attachImage = ref(true), loading = ref(false), saving = ref(false), previewing = ref(false)
  const error = ref(''), imageError = ref(''), savedId = ref('')
  const baseline = shallowRef<{ scene?: SceneDraft; blueprint?: SceneBlueprint } | null>(null)
  const preview = shallowRef<CatalogReceipt | null>(null)
  const pending = shallowRef<{ payload: CatalogChange[]; attachImage: boolean } | null>(null)
  const pendingId = computed(() => pending.value?.payload[0].id || '')
  let prepared: CatalogChange[] | null = null, recordId = '', alive = true
  const abort = new AbortController()
  onBeforeUnmount(() => { alive = false; abort.abort() })
  const popular = Boolean(source.recipe.characterId && source.recipe.subject === 'popular')
  const canReview = computed(() => !!baseline.value && !!title.value.trim() && !!story.value.trim()
    && !!rating.value && !loading.value && !saving.value && !previewing.value && !savedId.value && !pending.value)
  watch([title, story, rating, composition], () => { preview.value = null; prepared = null })
  async function load() {
    if (loading.value || saving.value || previewing.value || savedId.value || pending.value) return
    loading.value = true; error.value = ''; preview.value = null; prepared = null
    try {
      requireOriginalSource()
      if (!isLocalStudioHost()) throw new Error('请在本机工作室保存场景')
      const stats = await catalogApi.stats(abort.signal)
      requireOriginalSource()
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
      requireOriginalSource()
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
      requireOriginalSource()
      const result = buildGeneratedSceneDraft({ recipe: source.recipe, ...baseline.value }, { id: recordId, title: title.value.trim(), story: story.value.trim(), rating: rating.value, compositionIntent: composition.value })
      const payload: CatalogChange[] = [{ kind: result.kind, id: recordId, expectedRevision: 0, data: result.draft as unknown as Record<string, unknown> }]
      const key = JSON.stringify([title.value, story.value, rating.value, composition.value])
      const impact = await catalogApi.changes(payload, true, abort.signal)
      if (!alive || key !== JSON.stringify([title.value, story.value, rating.value, composition.value])) return
      requireOriginalSource()
      prepared = payload; preview.value = impact
    } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : '场景检查失败' }
    finally { previewing.value = false }
  }
  let imageSubmissionAttempted = false
  async function saveImage() {
    if (!savedId.value || saving.value) return
    saving.value = true; imageError.value = ''
    try {
      requireOriginalSource()
      const image = await blobThumbDataUrl(source.image, 4096, 0.94), thumbnail = await blobThumbDataUrl(source.image, 560, 0.84)
      if (!alive) return
      requireOriginalSource()
      if (!image || !thumbnail) throw new Error('图片转换失败')
      const id = catalogShowcaseId({ kind: popular ? 'blueprint' : 'scene', id: savedId.value, characterId: source.recipe.characterId || '' })
      imageSubmissionAttempted = true
      await maintenanceApi.saveShowcase({ id, image, thumbnail }, { signal: abort.signal })
    } catch (cause) {
      if (alive) imageError.value = imageSubmissionAttempted
        ? '场景已保存，样张提交尚未获得成功确认：' + (cause instanceof Error ? cause.message : '请核对结果')
          + '。样张可能已生效，请回到原来源核对；重新提交会再次写入同一场景的样张，不会撤销此前提交。'
        : '场景已保存，本次尚未提交样张：' + (cause instanceof Error ? cause.message : '请重试')
    }
    finally { saving.value = false }
  }
  async function reconcilePending() {
    const operation = pending.value
    if (!operation) return
    const target = operation.payload[0]
    try {
      requireOriginalSource()
      const actual = (await catalogApi.record(target.kind, target.id, undefined, abort.signal)).record.data
      if (!alive) return
      requireOriginalSource()
      if (JSON.stringify(actual) === JSON.stringify(target.data)) {
        savedId.value = target.id; pending.value = null; store.invalidate()
      } else {
        error.value = '原编号已有不同内容，不能认领为本次保存。请在原内容库核对；不会重新提交。'
      }
    } catch (cause) {
      if (!alive) return
      error.value = runtimeResourceIdentity() !== sourceIdentity
        ? '运行时连接已变化，不能在新连接核对原保存。请记下原编号，在原内容库中确认。'
        : cause instanceof ApiClientError && cause.status === 404
          ? '暂未查到原编号，但原保存仍可能完成。请稍后核对；不会重新提交。'
          : '暂时无法确认保存结果。恢复连接后核对原编号；不会重新提交。'
    }
  }
  async function reconcile() {
    if (!pending.value || saving.value || savedId.value) return
    const operation = pending.value
    saving.value = true; error.value = ''
    try { await reconcilePending() } finally { saving.value = false }
    if (alive && savedId.value && operation.attachImage) await saveImage()
  }
  async function save() {
    if (!prepared || !preview.value || saving.value || savedId.value || pending.value) return
    try { requireOriginalSource() } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '运行时连接已变化'
      return
    }
    // Keep the submitted wire payload independent of later form invalidation.
    const operation = { payload: JSON.parse(JSON.stringify(prepared)) as CatalogChange[], attachImage: attachImage.value }
    pending.value = operation
    saving.value = true; error.value = ''
    try {
      await catalogApi.changes(operation.payload, false, abort.signal)
      if (!alive) return
      requireOriginalSource()
      savedId.value = operation.payload[0].id; pending.value = null; store.invalidate()
    } catch (cause) {
      // These explicit catalog errors are returned before transaction.commit().
      // A timeout, lost response or a later GET 404 does not prove rejection.
      const rejected = cause instanceof ApiClientError && cause.kind === 'http'
        && ((cause.status === 400 && cause.code === 'INVALID_REQUEST')
          || (cause.status === 409 && cause.code === 'CATALOG_CONFLICT'))
      if (alive && rejected) {
        pending.value = null; prepared = null; preview.value = null
        error.value = '保存被拒绝：' + cause.message + '。可修改后重新检查。'
      } else if (alive) await reconcilePending()
    } finally { saving.value = false }
    if (alive && savedId.value && operation.attachImage) await saveImage()
  }
  return { title, story, rating, composition, compositionEdited, attachImage, popular, loading, saving, previewing, error, imageError, savedId, baseline, preview, pendingId, canReview, load, review, save, reconcile, saveImage }
}
