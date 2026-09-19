import { parseHistoryRecipe } from '@/utils/historyRecipe'
import type { ArtworkRecord } from '@/types/artwork'
import type { Ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { DrawEngine } from '@/storage/settingsRepository'
import { restoreHistorySceneStory } from '@/utils/promptBuilderPersistence'
import {
  findBlueprint as findPopularBlueprint,
  findCharacter as findPopularCharacter,
  findOutfit as findPopularOutfit,
  inferBlueprintDecisions,
} from '@/utils/popularContent'
import { ANIMA_LORA_BY_CHARACTER, type useAnimaSession } from '@/composables/generation/useAnimaSession'
import { confirmAction } from '@/composables/useConfirm'
import { useToast } from '@/composables/useToast'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>

export interface PromptHistoryApplyDeps {
  pb: PromptBuilderStore
  animaState: AnimaSession['state']
  patchAnimaState: AnimaSession['patchState']
  clearAnimaResult: AnimaSession['clearResult']
  refreshAnimaBackend: AnimaSession['refreshBackend']
  /** 视图持有的引擎切换动作（含 settingsRepository 持久化与角色互斥校验）。 */
  setDrawEngine: (engine: DrawEngine) => void
  /** 热门蓝图推荐游标重置（视图持有轮换状态）。 */
  resetBlueprintRotation: () => void
  sdSize: Ref<string>
}

/**
 * 绘图页「历史应用」链路（2026-08-22 自 PromptBuilderView 下沉）。
 *
 * 恢复 / 复制历史条目回导演台：按 entry.subject 分流——热门角色走
 * setPopularSubject + 蓝图决策回放 + Anima 面板收敛；工作室角色走
 * setChar / loadScene / 决策与词条回放，旧历史（无 engine 字段）按
 * 既有 SD 契约恢复。删除历史与「复用成功成片配方」同归此处。
 */
export function usePromptHistoryApply(deps: PromptHistoryApplyDeps) {
  const { pb, animaState, patchAnimaState, clearAnimaResult, refreshAnimaBackend, setDrawEngine, resetBlueprintRotation, sdSize } = deps
  const { show: showToast } = useToast()
  let restoreRevision = 0

  /**
   * 恢复历史条目（2026-09-06 体验报告 F5 修订）。
   *
   * 旧缺口：styleLoraId 被无条件清空、Anima hires 参数不回放、
   * visualDescription 只在热门分支恢复、底模缺失时静默回落。
   * 现在：已记录且当前仍支持的字段一律回放；合法零值（cfg=0 的 Turbo 档、
   * loraStrength=0）用显式判断保留；恢复不了的写进提示，不冒称「已恢复」。
   */
  async function applyHistory(record: ArtworkRecord, keepAsVariant = false) {
    const revision = ++restoreRevision
    const parsed = parseHistoryRecipe(record)
    if (!parsed.ok) {
      pb.historyRestoreReport = { title: '配方未载入', notes: [parsed.error] }
      pb.flash(parsed.error, 9000, 'warning')
      return false
    }
    const { recipe: entry, notes: restoreNotes } = parsed
    const popularEntry = entry.subject === 'popular' || (entry.noLora && entry.characterId)
    if (!entry.engine) restoreNotes.push('旧作品未记录引擎，按 SD 配方读取')
    if (!entry.model && !entry.checkpoint) restoreNotes.push('未记录底模，使用当前底模')
    restoreNotes.push('提示词按当前角色与编译规则重建，请核对后生成')
    // 合法零值保留：Number(x)||fallback 会把 0 误判为缺失，必须显式判有限数。
    const finiteOr = (value: unknown, fallback: number) => {
      if (value === null || value === undefined || value === '') return fallback
      const num = Number(value)
      return Number.isFinite(num) ? num : fallback
    }
    const entryEngine = entry.engine === 'krea2' ? 'krea2' : entry.engine === 'anima' ? 'anima' : 'sd'
    /** Anima 面板字段：风格 LoRA 与高清修复实参（旧历史缺字段时保持面板现值）。 */
    const animaHistoryPatch = () => {
      // 风格 LoRA 只有 Krea 2 有；候选列表在 refresh 后才就位，这里乐观恢复，
      // 由 refreshBackend 的存续校验兜底（不可用则自动清空）。
      let styleLoraId = ''
      if (entry.styleLoraId) {
        if (entryEngine === 'krea2') styleLoraId = entry.styleLoraId
        else restoreNotes.push('风格 LoRA 仅 Krea 2 支持，未恢复')
      }
      return {
        styleLoraId,
        hiresFix: typeof entry.hiresFix === 'boolean' ? entry.hiresFix : animaState.value.hiresFix,
        hiresScale: typeof entry.hiresScale === 'number' ? entry.hiresScale : animaState.value.hiresScale,
        hiresDenoise: typeof entry.hiresDenoise === 'number' ? entry.hiresDenoise : animaState.value.hiresDenoise,
      }
    }
    /** 底模回放：乐观采用历史值（refreshBackend 会收敛到白名单）；同家族且列表已加载时缺失才提示。 */
    const animaModelPatch = (fallback: string) => {
      if (!entry.model) return fallback
      const sameFamilyLoaded = animaState.value.models.length > 0
        && animaState.value.models.every(model => (model.family === 'krea2' ? 'krea2' : 'anima') === entryEngine)
      if (sameFamilyLoaded && !animaState.value.models.some(model => model.id === entry.model)) {
        restoreNotes.push(`原底模 ${entry.model} 当前不可用，已回落到可用底模`)
      }
      return entry.model
    }
    if (popularEntry) {
      const character = findPopularCharacter(pb.popularCharacters, entry.characterId || '')
      const outfit = character ? findPopularOutfit(character, entry.outfitId || '') : null
      if (character && outfit) {
        pb.setPopularSubject(character.id, outfit.id, entry.blueprintId ?? null)
        const blueprint = entry.blueprintId ? findPopularBlueprint(pb.sceneBlueprints, entry.blueprintId) : null
        if (blueprint) {
          const decision = inferBlueprintDecisions(blueprint)
          if (decision.shot) pb.setShot(decision.shot)
          if (decision.lighting) pb.setLighting(decision.lighting)
          pb.setComposition(decision.composition)
          pb.setColorMood(decision.colorMood)
        }
        resetBlueprintRotation()
        const [width, height] = String(entry.size || '832x1216').replace('×', 'x').split('x').map(Number)
        clearAnimaResult()
        setDrawEngine(entry.engine === 'krea2' ? 'krea2' : 'anima')
        patchAnimaState({
          phase: 'idle', progress: null, elapsedSeconds: 0, progressText: '', currentNode: null, statusText: '', errorMsg: '',
          modelId: animaModelPatch(animaState.value.modelId),
           loraId: '', loraStrength: animaState.value.loraStrength,
           ...animaHistoryPatch(),
           width: Number.isInteger(width) && width > 0 ? width : animaState.value.width,
          height: Number.isInteger(height) && height > 0 ? height : animaState.value.height,
          steps: finiteOr(entry.steps, animaState.value.steps),
          cfg: finiteOr(entry.cfg, animaState.value.cfg),
          sampler: entry.sampler || animaState.value.sampler,
          scheduler: entry.scheduler || animaState.value.scheduler,
          seed: entry.seed !== undefined && entry.seed >= 0 ? entry.seed : null,
        })
      } else {
        if (entry.characterId) restoreNotes.push('原角色或服装已不在当前角色库，已回落工作室模式')
        pb.setStudioSubject()
        setDrawEngine('sd')
      }
    } else {
      pb.setStudioSubject()
      if (entry.character === 'nene' || entry.character === 'natsume' || entry.character === 'triad') pb.setChar(entry.character)
      else if (entry.character) restoreNotes.push('原角色不可用，保留当前角色')
      if ((entry.engine === 'anima' || entry.engine === 'krea2') && (entry.character === 'nene' || entry.character === 'natsume')) {
        const [width, height] = String(entry.size || '832x1216').replace('×', 'x').split('x').map(Number)
        clearAnimaResult()
        setDrawEngine(entry.engine)
        patchAnimaState({
          phase: 'idle', progress: null, elapsedSeconds: 0, progressText: '', currentNode: null, statusText: '', errorMsg: '',
          modelId: animaModelPatch(animaState.value.modelId),
           loraId: entryEngine === 'krea2' ? '' : entry.loraId === ANIMA_LORA_BY_CHARACTER[entry.character] ? entry.loraId : ANIMA_LORA_BY_CHARACTER[entry.character],
           loraStrength: entry.loraStrength ?? animaState.value.loraStrength,
           ...animaHistoryPatch(),
           width: Number.isInteger(width) && width > 0 ? width : animaState.value.width,
          height: Number.isInteger(height) && height > 0 ? height : animaState.value.height,
          steps: finiteOr(entry.steps, animaState.value.steps),
          cfg: finiteOr(entry.cfg, animaState.value.cfg),
          sampler: entry.sampler || animaState.value.sampler,
          scheduler: entry.scheduler || animaState.value.scheduler,
          seed: entry.seed !== undefined && entry.seed >= 0 ? entry.seed : null,
        })
      } else {
        // 旧历史没有 engine 字段，必须按既有 SD 契约恢复。
        setDrawEngine('sd')
      }
    }
    if (!popularEntry) {
      const restoredContext = restoreHistorySceneStory(entry, pb.scenes)
      if (restoredContext.scene) pb.loadScene(restoredContext.scene)
      else pb.clearScene({ keepStory: true })
      // loadScene seeds the scene story; restore the historical user story last.
      pb.setStory(restoredContext.story)
      pb.selections.emotion.splice(0, pb.selections.emotion.length, ...(entry.emotion || []))
      pb.setShot(entry.shot || null)
      pb.setLighting(entry.lighting || null)
      pb.setComposition(entry.composition || null)
      pb.setColorMood(entry.colorMood || null)
      pb.manualTags = new Set(entry.manual_tags || [])
    } else {
      pb.setStory(entry.story || '')
      pb.manualTags = new Set((entry.manual_tags || []).filter(tag => !/(?:ayachi_nene|shiki_natsume|nene_|natsume_)/i.test(tag)))
    }
    // visualDescription 两分支都恢复（旧版只有热门分支恢复，工作室路径静默丢失）。
    pb.visualDescription = entry.visualDescription || ''
    // Saved decisions override today's blueprint defaults for both subject kinds.
    pb.selections.emotion = [...(entry.emotion || [])]
    pb.setShot(entry.shot ?? null)
    pb.setLighting(entry.lighting ?? null)
    pb.setComposition(entry.composition ?? null)
    pb.setColorMood(entry.colorMood ?? null)
    pb.projectId = entry.project || ''
    pb.setArtistStyleIds(entry.artistStyleIds || [])
    pb.sdParams.seed = entry.seed !== undefined && entry.seed >= 0 ? entry.seed : -1
    pb.sdParams.seedLock = entry.seed !== undefined && entry.seed >= 0
    pb.sdParams.cfg = finiteOr(entry.cfg, pb.sdParams.cfg)
    pb.sdParams.steps = finiteOr(entry.steps, pb.sdParams.steps)
    if (entry.sampler) pb.sdParams.sampler = entry.sampler
    pb.sdParams.scheduler = entry.scheduler || ''
    if (entryEngine === 'sd' && !popularEntry) {
      const savedModel = entry.model || entry.checkpoint
      if (savedModel && pb.sdModelName && savedModel !== pb.sdModelName) restoreNotes.push(`原底模 ${savedModel} 与当前底模 ${pb.sdModelName} 不同；需先切换后端底模`)
    }
    pb.sdParams.negative = Boolean(entry.negative)
    pb.sdParams.negativeCustom = ''
    // SD 家族条目回放到 SD 面板（Anima 家族的 hires 字段属于 Anima 面板，不串写）。
    if (entryEngine === 'sd') {
      if (typeof entry.hiresFix === 'boolean') pb.sdParams.hiresFix = entry.hiresFix
      if (typeof entry.hiresScale === 'number') pb.sdParams.hiresScale = entry.hiresScale
      if (typeof entry.hiresUpscaler === 'string' && entry.hiresUpscaler) pb.sdParams.hiresUpscaler = entry.hiresUpscaler
      if (typeof entry.hiresSteps === 'number') pb.sdParams.hiresSteps = entry.hiresSteps
      if (typeof entry.hiresDenoise === 'number') pb.sdParams.hiresDenoise = entry.hiresDenoise
      if (typeof entry.faceDetailer === 'boolean') pb.sdParams.faceDetailer = entry.faceDetailer
    }
    // 历史成片负面是"当时场景+当时 profile"的快照，不得写回 negativeCustom ——
    // 否则会作为自定义负面跨场景/跨 profile 泄漏。恢复时由当前场景+profile
    // 重新生成模型原生负面。
    if (entry.size) sdSize.value = entry.size.replace('×', 'x')
    Object.keys(pb.sdParams).forEach(key => pb.markParamTouched(key))
    if (entryEngine !== 'sd' && (!popularEntry || pb.isPopular)) {
      const before = { ...animaState.value }
      await refreshAnimaBackend()
      if (revision !== restoreRevision) return
      const after = animaState.value
      if (!after.online) restoreNotes.push('生成后端未就绪，模型与 LoRA 可用性尚未确认')
      for (const [key, label] of [['modelId', '底模'], ['loraId', '角色 LoRA'], ['styleLoraId', '风格 LoRA'], ['width', '宽度'], ['height', '高度'], ['steps', '步数'], ['cfg', 'CFG'], ['sampler', '采样器'], ['scheduler', '调度器']] as const) {
        if (before[key] !== after[key]) restoreNotes.push(`${label}：${before[key] || '未设置'} → ${after[key] || '不可用'}`)
      }
      if (entry.loraId && before.loraId !== entry.loraId) restoreNotes.push(`原角色 LoRA ${entry.loraId} 不适用于当前角色，已使用角色绑定`)
    }
    pb.historyRestoreReport = { title: `配方载入检查 · ${entry.sceneTitle || entry.id}`, notes: restoreNotes }
    pb.flash(`${keepAsVariant ? '已复制为新变体草稿' : '已载入历史配方'}，请核对配方检查`, 4000, 'info')
  }

  function reuseSuccessfulRecipe(id: string | number) {
    const entry = pb.history.find(item => item.id === id)
    if (!entry) return
    applyHistory(entry, true)
  }

  function resumeHistory(entry: ArtworkRecord) { applyHistory(entry) }
  function duplicateHistory(entry: ArtworkRecord) { applyHistory(entry, true) }
  /**
   * 删除历史条目（2026-08-30 UX 审计 P0-8）。
   *
   * 底层已改软删，确认文案不再写「不可撤销」，并给 5 秒撤销窗口——原图在
   * 回收站留 30 天，但用户真正会后悔的就是点下去的这几秒。
   */
  async function deleteHistory(entry: ArtworkRecord) {
    if (!(await confirmAction(`删除历史「${entry.sceneTitle || entry.scene || '未命名'}」？`))) return
    try {
      await pb.removeHistoryEntry(entry.id)
      pb.flash('历史记录已删除')
      showToast('已移入回收站，30 天内可撤销', 'info', 5000, {
        label: '撤销',
        onClick: () => {
          void pb.restoreHistoryEntry(entry.id).then(ok => {
            showToast(ok ? '已恢复' : '这条记录已不在回收站，无法恢复', ok ? 'success' : 'warning')
          })
        },
      })
    } catch {
      pb.flash('删除失败，请重试')
    }
  }

  return { applyHistory, reuseSuccessfulRecipe, resumeHistory, duplicateHistory, deleteHistory }
}
