import { computed, type Ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { Scene } from '@/types/scene'

export interface DirectorDerivedInput {
  pb: ReturnType<typeof usePromptBuilderStore>
  hiddenSceneIds: Ref<Set<string>>
  sceneCollection: Ref<'core' | 'curated' | 'all'>
  sceneLimit: Ref<number>
  sdSize: Ref<string>
}

/**
 * 导演台派生状态：场景筛选、显存与分辨率风险提示。
 * 只做派生，不持有场景/UI/队列生命周期。
 */
export function useDirectorDerived(input: DirectorDerivedInput) {
  const { pb, hiddenSceneIds, sceneCollection, sceneLimit, sdSize } = input

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
  const scenePools = computed(() => {
    const all: Scene[] = [], core: Scene[] = [], curated: Scene[] = []
    const hidden = hiddenSceneIds.value, coreIds = personaCoreIds.value, curatedSceneIds = curatedIds.value
    for (const scene of pb.filteredScenes) {
      if (hidden.has(scene.id)) continue
      all.push(scene)
      if (coreIds.has(scene.id)) core.push(scene)
      if (curatedSceneIds.has(scene.id)) curated.push(scene)
    }
    return { all, core, curated }
  })
  const availableScenes = computed(() => {
    // 搜索永远扫完整可用库，避免用户必须先猜场景属于哪一层。
    return scenePools.value[pb.sceneSearch.trim() ? 'all' : sceneCollection.value]
  })
  const visibleScenes = computed(() => availableScenes.value.slice(0, sceneLimit.value))
  const personaCoreCount = computed(() => scenePools.value.core.length)
  const curatedCount = computed(() => scenePools.value.curated.length)

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
    personaCoreIds,
    availableScenes,
    visibleScenes,
    personaCoreCount,
    curatedCount,
    vramLevel,
    baseResolutionRisk,
    vramHint,
    baseResolutionHint,
    canUseFaceDetailer,
  }
}
