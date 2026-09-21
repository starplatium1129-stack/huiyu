import { computed, type Ref } from 'vue'
import { usePromptBuilderStore, type Scene } from '@/stores/promptBuilderStore'
import { EMOTION, SHOT, LIGHTING, COMPOSITION, COLOR_MOODS } from '@/config/promptConstants'

export interface DirectorDerivedInput {
  pb: ReturnType<typeof usePromptBuilderStore>
  hiddenSceneIds: Ref<Set<string>>
  sceneCollection: Ref<'core' | 'curated' | 'all'>
  sceneLimit: Ref<number>
  sdSize: Ref<string>
}

/**
 * 导演台派生状态：场景筛选、镜头/光照/情绪摘要、
 * 显存与分辨率风险提示。只做派生，不持有场景/UI/队列生命周期。
 */
export function useDirectorDerived(input: DirectorDerivedInput) {
  const { pb, hiddenSceneIds, sceneCollection, sceneLimit, sdSize } = input

  const optionName = (options: readonly { id: string; name: string }[], id: string | null) =>
    options.find(option => option.id === id)?.name ?? '自动'
  const emotionSummary = computed(() => {
    const names = pb.selections.emotion
      .map(id => EMOTION.find(option => option.id === id)?.name)
      .filter(Boolean)
    if (!names.length) return '自动'
    return names.length > 2 ? `${names.slice(0, 2).join('、')} +${names.length - 2}` : names.join('、')
  })
  const shotSummary = computed(() => optionName(SHOT, pb.selections.shot))
  const lightingSummary = computed(() => optionName(LIGHTING, pb.selections.lighting))
  const compositionSummary = computed(() => optionName(COMPOSITION, pb.selections.composition))
  const moodSummary = computed(() => optionName(COLOR_MOODS, pb.colorMood))

  const personaCoreIds = computed(() => new Set(
    Array.isArray(pb.curation.personaCoreSceneIds)
      ? pb.curation.personaCoreSceneIds as string[]
      : Array.isArray(pb.curation.signatureSceneIds)
        ? pb.curation.signatureSceneIds as string[]
        : [],
  ))
  const curatedIds = computed(() => new Set(
    Array.isArray(pb.curation.curatedSceneIds) ? pb.curation.curatedSceneIds as string[] : [],
  ))
  const availableScenes = computed(() => {
    const base = pb.filteredScenes.filter(scene => !hiddenSceneIds.value.has(scene.id))
    // 搜索永远扫完整可用库，避免用户必须先猜场景属于哪一层。
    if (pb.sceneSearch.trim() || sceneCollection.value === 'all') return base
    const ids = sceneCollection.value === 'core' ? personaCoreIds.value : curatedIds.value
    return base.filter(scene => ids.has(scene.id))
  })
  const visibleScenes = computed(() => availableScenes.value.slice(0, sceneLimit.value))
  const personaCoreCount = computed(() =>
    pb.filteredScenes.filter(scene => !hiddenSceneIds.value.has(scene.id) && personaCoreIds.value.has(scene.id)).length,
  )
  const curatedCount = computed(() =>
    pb.filteredScenes.filter(scene => !hiddenSceneIds.value.has(scene.id) && curatedIds.value.has(scene.id)).length,
  )

  const modeDescription = computed(() => pb.directorMode === 'basic'
    ? '挑一幕喜欢的场景，镜头与光影已经备好。'
    : '角色、光影和画面细节，这次由你来导演。')

  // ── 显存预算提示 ─────────────────────────────────────────────────────────
  const vramBudget = computed(() => {
    const [w, h] = sdSize.value.split('x').map(Number)
    const scale = pb.sdParams.hiresFix ? (pb.sdParams.hiresScale || 1.5) : 1
    const finalW = Math.round((w || 832) * scale)
    const finalH = Math.round((h || 1216) * scale)
    return { width: finalW, height: finalH, megapixels: (finalW * finalH) / 1_000_000 }
  })
  const vramLevel = computed(() => {
    const mp = vramBudget.value.megapixels
    // 16GB 显存下 SDXL：约 4MP 内稳，6MP 起偏紧
    if (mp > 6) return 'danger'
    if (mp > 4) return 'warn'
    return ''
  })
  const baseResolutionRisk = computed(() => {
    const [w, h] = sdSize.value.split('x').map(Number)
    const megapixels = ((w || 832) * (h || 1216)) / 1_000_000
    // SDXL is most coherent near its 1024^2 training buckets. This is unrelated to VRAM.
    if (megapixels > 1.8) return 'danger'
    if (megapixels > 1.5) return 'warn'
    return ''
  })
  const vramHint = computed(() => {
    const b = vramBudget.value
    const base = `最终 ${b.width}×${b.height} · ${b.megapixels.toFixed(1)} MP`
    if (vramLevel.value === 'danger') return base + ' · 16G 显存可能 OOM'
    if (vramLevel.value === 'warn') return base + ' · 接近 16G 上限'
    return base
  })
  const baseResolutionHint = computed(() => {
    const [w, h] = sdSize.value.split('x').map(Number)
    const megapixels = ((w || 832) * (h || 1216)) / 1_000_000
    const base = `基础 ${w}×${h} · ${megapixels.toFixed(1)} MP`
    if (baseResolutionRisk.value === 'danger') return base + ' · SDXL 人物结构风险高'
    return base + ' · SDXL 人物结构风险偏高'
  })
  const canUseFaceDetailer = computed(() => {
    const [w, h] = sdSize.value.split('x').map(Number)
    return pb.char !== 'triad' && !pb.sdParams.hiresFix && ((w || 832) * (h || 1216)) > 1_500_000
  })

  return {
    optionName,
    emotionSummary,
    shotSummary,
    lightingSummary,
    compositionSummary,
    moodSummary,
    personaCoreIds,
    availableScenes,
    visibleScenes,
    personaCoreCount,
    curatedCount,
    modeDescription,
    vramBudget,
    vramLevel,
    baseResolutionRisk,
    vramHint,
    baseResolutionHint,
    canUseFaceDetailer,
  }
}

export type { Scene }
