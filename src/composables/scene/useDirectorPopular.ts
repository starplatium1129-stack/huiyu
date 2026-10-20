import { computed, ref, watch, type Ref } from 'vue'
import { apiClient } from '@/api/client'
import type { AnimaStatusResponse } from '@/composables/generation/animaSessionContract'
import { inferBlueprintDecisions } from '@/utils/popularBlueprintDecisions'
import { recommendBlueprints } from '@/utils/blueprintRecommendations'
import {
  blueprintCategories as collectBlueprintCategories,
  eligibleBlueprints,
  findBlueprint as findPopularBlueprint,
  findCharacter as findPopularCharacter,
  type PopularCharacter,
  type SceneBlueprint,
} from '@/utils/popularContent'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { useLegacySdTasks } from '@/composables/generation/useLegacySdTasks'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { DrawingRouteRecommendation } from '@/utils/drawingRoute'
import type { DrawEngine } from '@/storage/settingsRepository'
import { applyGeneratedSceneSettings } from './applyGeneratedSceneSettings'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type SDGenerate = ReturnType<typeof useLegacySdTasks>
type AnimaSession = ReturnType<typeof useAnimaSession>

export interface UseDirectorPopularInput {
  pb: PromptBuilderStore
  sd: SDGenerate
  drawEngine: Readonly<Ref<DrawEngine>>
  setDrawEngine: (engine: DrawEngine, options?: { silent?: boolean }) => void
  applyRecommendedSize: (size: string) => void
  generationBusy: Readonly<Ref<boolean>>
  animaState: AnimaSession['state']
  patchAnimaState: AnimaSession['patchState']
  refreshAnimaBackend: AnimaSession['refreshBackend']
  applyModel: AnimaSession['applyModel']
  sdSize: Ref<string>
  flash: (message: string) => void
  getAnimaSettingsRevision?: () => number
  preparedModelId?: string | null
}

/**
 * 热门角色编排层（2026-08-28 编排下沉）：subject/服装/蓝图选择与轮换、
 * 蓝图池过滤与推荐、受控绘图路线（recommendDrawingRoute）的采用与同步、
 * 热门草稿恢复。工作室角色的 selectScene/深链仍归宿主视图编排。
 */
export function useDirectorPopular(input: UseDirectorPopularInput) {
  const {
    pb,
    sd,
    drawEngine,
    setDrawEngine,
    applyRecommendedSize,
    generationBusy,
    animaState,
    patchAnimaState,
    refreshAnimaBackend,
    applyModel,
    sdSize,
    flash,
  } = input

  const popularCategory = ref('all')
  const showAllBlueprints = ref(false)
  const blueprintCursor = ref(0)
  const previousBlueprintIds = ref<string[] | null>(null)

  const popularCharacter = computed<PopularCharacter | null>(() => {
    if (pb.subject.kind !== 'popular') return null
    return findPopularCharacter(pb.popularCharacters, pb.subject.characterId)
  })
  const managedRoute = ref<DrawingRouteRecommendation | null>(null)
  async function refreshManagedRoute(): Promise<DrawingRouteRecommendation> {
    const { recommendDrawingRoute } = await import('@/utils/drawingRoute')
    const route = recommendDrawingRoute({
      subjectKind: pb.isPopular ? 'popular' : 'studio',
      character: pb.char,
      recommendedModelId: popularCharacter.value?.recommendedEngine,
    })
    managedRoute.value = route
    return route
  }
  const popularBlueprintPool = computed(() =>
    eligibleBlueprints(pb.sceneBlueprints, popularCharacter.value),
  )
  const filteredPopularBlueprints = computed(() =>
    eligibleBlueprints(pb.sceneBlueprints, popularCharacter.value, {
      category: popularCategory.value,
    }),
  )
  const blueprintCategories = computed(() =>
    collectBlueprintCategories(popularBlueprintPool.value),
  )
  const recommendedBlueprints = computed(() => {
    const pool = popularBlueprintPool.value
    if (!pool.length) return []
    if (pb.subject.kind !== 'popular') return pool.slice(0, 3)
    const key = `${pb.subject.characterId}#${pb.subject.outfitId}`
    return recommendBlueprints(pool, key, blueprintCursor.value, previousBlueprintIds.value, 3)
  })

  function resetBlueprintRotation() {
    blueprintCursor.value = 0
    previousBlueprintIds.value = null
    showAllBlueprints.value = false
    popularCategory.value = 'all'
  }

  /** 按角色推荐引擎切 drawEngine；角色切回/切换后立即恢复正确的 model/lora 列表。 */
  function applyRecommendedEngine(character: PopularCharacter | null) {
    const target = character?.recommendedEngine === 'krea2-turbo-fp8' ? 'krea2' : 'anima'
    if (drawEngine.value !== target) setDrawEngine(target)
  }

  function selectPopularSource(source: 'studio' | 'popular' | 'none') {
    if (source === 'none') {
      pb.setUnboundSubject()
      patchAnimaState({ loraId: '', styleLoraId: '' })
      void refreshAnimaBackend()
      syncManagedRoute()
      return
    }
    if (source === 'studio' && (pb.isPopular || pb.isUnbound)) {
      patchAnimaState({ online: false, checkMsg: '正在恢复工作室模型与 LoRA…' })
      pb.clearScene({ keepStory: true })
      pb.setStudioSubject()
      if (pb.char === 'none') pb.setChar('nene')
      // 立即恢复 nene/natsume 的 model/lora 白名单，不等 15s 状态轮询。
      void refreshAnimaBackend()
      syncManagedRoute()
      flash('已切回工作室角色（宁宁 / 夏目 LoRA 路径）')
      return
    }
    if (source === 'popular' && !pb.isPopular) {
      // 进入热门模式：整体清空工作室场景、词条、画面描述与故事。热门组装不读
      // story，且故事属于 studio 场景/蓝图的上下文——不清的话故事框会残留上一个
      // 宁宁/夏目场景的故事（裸 ?popular= 深链/页内切换均可见）。选中蓝图后故事
      // 由 selectBlueprint 写回蓝图的 description。
      pb.clearScene()
      // 2026-08-29 需求变更：热门角色画师默认不注入——清掉从工作室/上一会话
      // 继承的画师，保持角色原滋原味；画师完全由用户手动选择。
      pb.setArtistStyleIds([])
      resetBlueprintRotation()
      if (pb.popularCharacters.length) {
        const first = pb.popularCharacters[0]
        pb.setPopularSubject(first.id, first.outfits.find(o => o.default)?.id ?? first.outfits[0].id, null)
        // 2026-08-29 修复：热门角色为无 LoRA 创作，必须清掉 anima 侧残留的
        // studio loraId（默认 L_NENE_V21_ANIMA），否则后端会拿宁宁 lora 生成热门角色。
        const binding = endfieldAnimaBinding(first.id, 'anima', first.recommendedEngine)
        patchAnimaState({ modelId: first.recommendedEngine, loraId: binding?.loraId ?? '',
          ...(binding ? { loraStrength: binding.loraStrength } : {}) })
        applyRecommendedEngine(first)
      } else {
        pb.setPopularSubject('', '')
      }
      void refreshAnimaBackend()
      syncManagedRoute()
      flash('已切换到热门角色：默认 MiaoMiao v1.6，终末地使用专属角色 LoRA')
    }
  }

  function selectPopularCharacter(character: PopularCharacter) {
    if (pb.subject.kind !== 'popular' || pb.subject.characterId === character.id) return
    const previous = pb.subject.blueprintId ? findPopularBlueprint(pb.sceneBlueprints, pb.subject.blueprintId) : null
    if (previous) {
      const decision = inferBlueprintDecisions(previous)
      if (pb.selections.shot === decision.shot) pb.setShot(null)
      if (pb.selections.lighting === decision.lighting) pb.setLighting(null)
      if (pb.selections.composition === decision.composition) pb.setComposition(null)
      if (pb.colorMood === decision.colorMood) pb.setColorMood(null)
    }
    const outfitId = character.outfits.find(o => o.default)?.id ?? character.outfits[0].id
    // Changing identity keeps the reference scene and clothing across successive characters.
    pb.setPopularSubject(character.id, outfitId, null, { preserveReference: true, preserveOutfitOverride: true })
    // 2026-08-29 需求变更：切换热门角色时清空上一角色继承的画师（保持角色
    // 原滋原味），画师由用户按角色手动选择。
    pb.setArtistStyleIds([])
    resetBlueprintRotation()
    // recommendedEngine 为 Krea 时直接切 krea2 引擎（当前数据全 aesthetic，仍保留分支防死字段）。
    applyRecommendedEngine(character)
    const binding = endfieldAnimaBinding(character.id, 'anima', character.recommendedEngine)
    patchAnimaState({ modelId: character.recommendedEngine, loraId: binding?.loraId ?? '',
      ...(binding ? { loraStrength: binding.loraStrength } : {}) })
    syncManagedRoute()
    if (pb.directorMode === 'pro') void refreshAnimaBackend()
  }

  function selectPopularOutfit(outfitId: string) {
    if (pb.subject.kind !== 'popular') return
    pb.setPopularSubject(pb.subject.characterId, outfitId, pb.subject.blueprintId, { preserveReference: true })
    patchAnimaState({ styleLoraId: '' })
    resetBlueprintRotation()
  }

  function selectBlueprint(blueprint: SceneBlueprint) {
    if (generationBusy.value) { flash('生成进行中，完成或停止后再载入场景'); return }
    if (pb.subject.kind !== 'popular') return
    // 若蓝图本身绑定了专属服装形态（如泳池蓝图绑定 summer_swimsuit_night），
    // 则自动将当前角色的服装同步切换到该形态，确保生图与故事描述 100% 一致。
    const targetOutfitId = blueprint.outfitId || pb.subject.outfitId
    pb.setPopularSubject(pb.subject.characterId, targetOutfitId, blueprint.id)
    const decision = inferBlueprintDecisions(blueprint)
    pb.setShot(decision.shot)
    pb.setLighting(decision.lighting)
    pb.setComposition(decision.composition)
    pb.setColorMood(decision.colorMood)
    // 蓝图推荐尺寸必须收敛到当前底模白名单：Krea 已激活时 832x1216 会让
    // 服务端 400 INVALID_PARAMETER。
    applyRecommendedSize(decision.size)
    patchAnimaState({ styleLoraId: '' })
    pb.visualDescription = ''
    // 场景故事跟随所选蓝图（与工作室 selectScene → loadScene 写 story 对齐）：
    // 否则从工作室切热门后 story 框会残留上一个场景的故事。
    pb.setStory(blueprint.description)
    if (blueprint.generatedRecipe) {
      try { flash(`已载入生成场景；${applyGeneratedSceneSettings(blueprint.generatedRecipe, input).join('；')}`) }
      catch (error) { flash(error instanceof Error ? error.message : '生成配方无法载入') }
    } else flash(`已选用场景「${blueprint.title}」，服装/镜头/光照已自动适配`)
  }

  function rotateBlueprintSet() {
    previousBlueprintIds.value = recommendedBlueprints.value.map(blueprint => blueprint.id)
    blueprintCursor.value += 1
  }

  function toggleBlueprintList() {
    showAllBlueprints.value = !showAllBlueprints.value
  }

  function currentGeneratedRecipe() {
    const subject = pb.subject
    return subject.kind === 'popular'
      ? pb.sceneBlueprints.find(item => item.id === subject.blueprintId)?.generatedRecipe
      : pb.activeScene?.generatedRecipe
  }
  // A verified setup choice (including the saved startup default) survives silent
  // recommendations until the user
  // changes the engine, model or subject family. Character LoRAs still follow the route.
  const modelSelection = () => JSON.stringify([drawEngine.value, animaState.value.modelId,
    pb.subject.kind === 'popular' ? pb.subject.characterId : pb.isUnbound ? 'unbound' : pb.char === 'triad' ? 'studio-dual' : 'studio-single'])
  let preparedSelection = drawEngine.value === 'anima' && animaState.value.modelId === input.preparedModelId ? modelSelection() : ''
  watch(modelSelection, value => { if (value !== preparedSelection) preparedSelection = '' }, { flush: 'sync' })
  async function applyPreparedModel(modelId: string, isCurrent: () => boolean) {
    if (generationBusy.value || !isCurrent()) return
    if (!pb.modelProfiles.some(profile => profile.engine === 'anima' && profile.model_id === modelId)) {
      flash('准备的底模未登记为 Anima 模型，请回到控制室重新检查')
      return
    }
    const revision = input.getAnimaSettingsRevision?.(), selection = JSON.stringify([pb.subject, pb.char, drawEngine.value])
    const current = () => isCurrent() && !generationBusy.value && revision === input.getAnimaSettingsRevision?.()
      && selection === JSON.stringify([pb.subject, pb.char, drawEngine.value])
    let status: AnimaStatusResponse
    try {
      // Read all families before changing the workspace; failed handoffs retain its recipe.
      status = await apiClient.request<AnimaStatusResponse>('/api/creative/status', {
        cache: 'no-store', timeoutMs: 10_000, validate: value => value.ok === true,
      })
    } catch {
      if (current()) flash('底模可用性检查未完成，当前选择已保留，请回到控制室重新检查')
      return
    }
    if (!current()) return
    const model = Array.isArray(status.models)
      ? status.models.find(model => model.id === modelId && model.family === 'anima' && model.available === true) : undefined
    const popularId = pb.subject.kind === 'popular' ? pb.subject.characterId : null
    if (!model || pb.isUnbound && model.capabilities?.noLora !== true || (popularId && (model.capabilities?.noLora !== true
      || (endfieldAnimaBinding(popularId, 'anima') && !endfieldAnimaBinding(popularId, 'anima', modelId))))) {
      flash('准备的底模当前不可用或不适用于当前角色，请回到控制室重新检查')
      return
    }
    setDrawEngine('anima', { silent: true })
    if (drawEngine.value !== 'anima') return
    const appliedRevision = input.getAnimaSettingsRevision?.(), subject = JSON.stringify([pb.subject, pb.char])
    // Adopt the checked response through the session's existing whitelist/default policy.
    if (!await refreshAnimaBackend(status) || !isCurrent() || generationBusy.value
      || drawEngine.value !== 'anima' || appliedRevision !== input.getAnimaSettingsRevision?.()
      || subject !== JSON.stringify([pb.subject, pb.char])) return
    applyModel(modelId)
    preparedSelection = modelSelection()
    flash('已选用刚准备的 Anima 底模，可以开始创作')
  }
  async function applyManagedRoute(options: { silent?: boolean } = {}): Promise<void> {
    const selection = JSON.stringify([pb.subject, pb.char, pb.sceneId, pb.directorMode])
    const route = await refreshManagedRoute()
    if (!options.silent) preparedSelection = ''
    if (generationBusy.value || selection !== JSON.stringify([pb.subject, pb.char, pb.sceneId, pb.directorMode])
      // An unloaded selected blueprint may own a generated recipe. Do not
      // replace its saved settings while its catalog is loading or failed.
      || (options.silent && (currentGeneratedRecipe()
        || pb.subject.kind === 'popular' && pb.subject.blueprintId && !pb.popularBlueprintReady))) return
    const preservePreparedModel = options.silent && preparedSelection === modelSelection() && route.engine === drawEngine.value
      && pb.modelProfiles.some(profile => profile.engine === 'anima' && profile.model_id === animaState.value.modelId)
      && animaState.value.models.some(model => model.id === animaState.value.modelId && model.family === 'anima' && model.available === true)
    const targetModelId = preservePreparedModel ? animaState.value.modelId : route.modelId
    const selectedModel = route.engine === 'sd'
      ? pb.sdModelName || sd.checkpoint.value
      : animaState.value.modelId
    const alreadyApplied = drawEngine.value === route.engine
      && selectedModel.includes(targetModelId)
      && (route.engine === 'sd' || route.engine === 'krea2' || animaState.value.loraId === route.loraId)
    if (alreadyApplied) return
    if (route.engine !== drawEngine.value) setDrawEngine(route.engine, { silent: options.silent })
    if (route.engine === 'sd') {
      const model = sd.models.value.find(item => item.includes(route.modelId))
      if (model) {
        pb.sdModelName = model
        pb.applyModelProfile(model, { applySize: false })
      }
      applyRecommendedSize(pb.lastRecommendedSize)
    } else {
      if (animaState.value.modelId !== targetModelId) applyModel(targetModelId)
      patchAnimaState({ loraId: route.loraId, styleLoraId: '' })
      await refreshAnimaBackend()
    }
    if (!options.silent) flash(`已采用${route.title}`)
  }

  function syncManagedRoute() {
    const savedRecipe = currentGeneratedRecipe()
    // Saved result settings are deliberate; an automatic basic-mode recommendation
    // must not replace their engine after the selection's synchronous restoration.
    void (pb.directorMode === 'basic' && !savedRecipe ? applyManagedRoute({ silent: true }) : refreshManagedRoute())
  }

  /** 热门角色草稿恢复：同步无 LoRA 底模与蓝图尺寸/导演决策，并立即刷新 backend，
   *  让面板的 model/lora 列表立刻收敛到热门角色（不等 15s 轮询）。
   *  由宿主 onMounted 在 loadData/loadHistory 之后调用。 */
  function restorePopularDraft() {
    if (!pb.isPopular || pb.subject.kind !== 'popular') return
    const savedRecipe = currentGeneratedRecipe()
    if (savedRecipe) {
      // The draft may contain a newer reference than the saved generation recipe.
      if (!pb.referenceInput && !pb.outfitOverride) {
        try { flash(applyGeneratedSceneSettings(savedRecipe, input).join('；')) }
        catch (error) { flash(error instanceof Error ? error.message : '生成配方无法载入') }
      }
      void refreshAnimaBackend()
      return
    }
    const recommendedEngine = popularCharacter.value?.recommendedEngine === 'krea2-turbo-fp8' ? 'krea2-turbo-fp8' : 'anima-miaomiao-v1.6'
    if (animaState.value.models.some(model => model.id === recommendedEngine)) {
      patchAnimaState({ modelId: recommendedEngine, loraId: '' })
    }
    if (pb.subject.blueprintId) {
      const restoredBlueprint = findPopularBlueprint(pb.sceneBlueprints, pb.subject.blueprintId)
      if (restoredBlueprint) {
        const decision = inferBlueprintDecisions(restoredBlueprint)
        let restoredSize = decision.size
        const activeModel = animaState.value.models.find(model => model.id === animaState.value.modelId)
        if (activeModel && Array.isArray(activeModel.sizes) && activeModel.sizes.length
          && !activeModel.sizes.includes(restoredSize)) {
          restoredSize = activeModel.sizes[0]
        }
        sdSize.value = restoredSize
        const [blueprintWidth, blueprintHeight] = restoredSize.split('x').map(Number)
        if (Number.isInteger(blueprintWidth) && Number.isInteger(blueprintHeight)) patchAnimaState({ width: blueprintWidth, height: blueprintHeight })
      }
    }
    applyRecommendedEngine(popularCharacter.value)
    void refreshAnimaBackend()
  }

  return {
    popularCategory,
    showAllBlueprints,
    managedRoute,
    refreshManagedRoute,
    popularBlueprintPool,
    filteredPopularBlueprints,
    blueprintCategories,
    recommendedBlueprints,
    resetBlueprintRotation,
    applyRecommendedEngine,
    selectPopularSource,
    selectPopularCharacter,
    selectPopularOutfit,
    selectBlueprint,
    rotateBlueprintSet,
    toggleBlueprintList,
    applyManagedRoute,
    applyPreparedModel,
    syncManagedRoute,
    restorePopularDraft,
  }
}
