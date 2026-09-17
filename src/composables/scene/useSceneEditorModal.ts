import { copyWithFeedback } from '@/composables/useCopyFeedback'
import { ref, type Ref } from 'vue'
import { confirmAction } from '@/composables/useConfirm'
import type { SceneDraft, CurationData } from '@/types/api'
import { allocateSceneId, isSceneId } from '@/utils/sceneId'
import { MAX_SCENES } from '@/utils/sceneChanges'

export interface SceneEditorModalDeps {
  scenes: Ref<SceneDraft[]>
  curation: Ref<CurationData>
  markDirty: (message: string) => void
  /** 向服务端申请下一个稳定场景 ID（排除活跃+已退役）；null 时禁止分配，避免重用已退役身份。 */
  nextSceneId: () => Promise<string | null>
  allocationError?: (message: string) => void
}

/** 策展层级 → curation.json 里对应的数组字段 */
const TIER_BUCKETS = {
  signature: 'signatureSceneIds',
  curated: 'curatedSceneIds',
  review: 'reviewSceneIds',
} as const

/**
 * 场景管理页「场景编辑弹层 + CRUD + 策展」簇（2026-08-22 自 SceneManagerView 下沉）。
 *
 * 编辑表单全量快照（JSON round-trip 脱离 reactive proxy）+ 脏关闭确认
 * （serializeModal 比对）、新增/编辑/保存/下架/复制，以及策展三层级
 * （招牌/精选/待审）在 curation 数组间的迁移与推荐理由维护。
 * 本簇只改内存草稿；落盘归 useSceneMaintenance 的 saveToProject。
 */
export function useSceneEditorModal(deps: SceneEditorModalDeps) {
  const { scenes, curation, markDirty } = deps

  const editing = ref<SceneDraft | null>(null)
  const editingId = ref('')
  const curationTierValue = ref('normal')
  const curationReason = ref('')
  const tagsInput = ref('')
  const usageInput = ref('')
  /** 弹窗打开时的表单快照，用于脏关闭确认 */
  const modalSnapshot = ref('')
  const triedSave = ref(false)
  const formHint = ref('')

  function curationTier(id: string) {
    if ((curation.value.signatureSceneIds || []).includes(id)) return 'signature'
    if ((curation.value.curatedSceneIds || []).includes(id)) return 'curated'
    if ((curation.value.reviewSceneIds || []).includes(id)) return 'review'
    return 'normal'
  }

  function updateCharacterDefaults() {
    const scene = editing.value
    if (!scene || editingId.value) return
    if (scene.char === 'nene') scene.lora = 'ayachi_nene_v18_wd14'
    else if (scene.char === 'natsume') scene.lora = 'shiki_natsume_v18_wd14'
    else if (scene.char === 'triad') scene.lora = 'ayachi_nene_v18_wd14:0.52, shiki_natsume_v18_wd14:0.52'
  }

  function onCurationTierChange() {
    if (curationTierValue.value === 'normal' || curationTierValue.value === 'review') curationReason.value = ''
  }

  function blankScene(): SceneDraft {
    return {
      id: '', title: '', category: '恋爱', char: 'nene',
      lora: 'ayachi_nene_v18_wd14', emotion: '恋爱',
      season: '不限', time: '深夜', timeOfDay: 'late_night',
      rating: 'All', mature: false,
      location: '', weather: '', camera: '', lighting: '',
      tags: [], usage: ['壁纸用'],
      story: '', storyJa: '', prompt: '', negative: 'worst quality, low quality, normal quality, lowres, blurry, jpeg artifacts, text, watermark, logo, signature, bad anatomy, bad hands',
    }
  }

  function serializeModal() {
    return JSON.stringify({
      ...editing.value,
      curationTierValue: curationTierValue.value,
      curationReason: curationReason.value,
      tagsInput: tagsInput.value,
      usageInput: usageInput.value,
    })
  }

  // 服务端返回候选号而非预留号；会话预留也防止并发复制取得同号。
  const allocatedIds = new Set<string>()
  async function allocateId(): Promise<string | null> {
    try {
      if (scenes.value.length >= MAX_SCENES) throw new Error(`场景数量已达到 ${MAX_SCENES} 上限`)
      const candidate = await deps.nextSceneId()
      if (!candidate) return null
      const id = allocateSceneId(candidate, new Set([...allocatedIds, ...scenes.value.map(scene => scene.id)]))
      allocatedIds.add(id)
      return id
    } catch (error) {
      formHint.value = error instanceof Error ? error.message : '无法分配场景编号，请重新读取'
      deps.allocationError?.(formHint.value)
      return null
    }
  }

  async function openAddModal() {
    const id = await allocateId()
    if (!id) return
    editing.value = blankScene()
    editing.value.id = id
    editingId.value = ''
    curationTierValue.value = 'normal'
    curationReason.value = ''
    tagsInput.value = ''
    usageInput.value = '壁纸用'
    triedSave.value = false
    formHint.value = ''
    modalSnapshot.value = serializeModal()
  }

  function openEditModal(id: string) {
    const s = scenes.value.find(x => x.id === id)
    if (!s) return
    // sceneStore 的值是 Vue reactive proxy；structuredClone(proxy) 会抛 DataCloneError。
    // 这里需要的是脱离响应式的可编辑快照，JSON round-trip 正合适（场景数据是 JSON）。
    editing.value = JSON.parse(JSON.stringify(s)) as SceneDraft
    editingId.value = id
    curationTierValue.value = curationTier(id)
    curationReason.value = (curation.value.recommendationReasons || {})[id] || ''
    tagsInput.value = (s.tags || []).join(', ')
    usageInput.value = (s.usage || []).join(', ')
    triedSave.value = false
    formHint.value = ''
    modalSnapshot.value = serializeModal()
  }

  async function closeModal() {
    if (editing.value && modalSnapshot.value && serializeModal() !== modalSnapshot.value) {
      const confirmed = await confirmAction({
        title: '放弃未保存的修改？',
        message: '当前编辑的内容尚未保存，离开弹窗将丢失本次修改。',
        confirmLabel: '放弃修改',
        danger: true,
      })
      if (!confirmed) return
    }
    editing.value = null
    editingId.value = ''
    modalSnapshot.value = ''
  }

  function setSceneCuration(id: string, tier: string, reason: string) {
    const buckets = ['signatureSceneIds', 'curatedSceneIds', 'reviewSceneIds'] as const
    buckets.forEach(key => {
      const list = curation.value[key]
      curation.value[key] = (Array.isArray(list) ? list : []).filter(x => x !== id)
    })
    const target = TIER_BUCKETS[tier as keyof typeof TIER_BUCKETS]
    if (target) (curation.value[target] as string[]).push(id)
    if (!curation.value.recommendationReasons) curation.value.recommendationReasons = {}
    if (reason) curation.value.recommendationReasons[id] = reason
    else delete curation.value.recommendationReasons[id]
  }

  function saveScene() {
    triedSave.value = true
    const e = editing.value
    if (!e) return
    if (!isSceneId(e.id)) { formHint.value = 'ID 需为 sc001–sc999 或 sc1000 起的安全整数编号'; return }
    if (editingId.value && e.id !== editingId.value) { formHint.value = '已有场景不能更换 ID'; return }
    if (!editingId.value && scenes.value.length >= MAX_SCENES) { formHint.value = `场景数量不能超过 ${MAX_SCENES}`; return }
    if (!e.title?.trim() || !e.story?.trim()) { formHint.value = '请先补齐标题和故事'; return }
    if (curationTierValue.value === 'signature' && !curationReason.value.trim()) { formHint.value = '招牌场景必须填写推荐理由'; return }
    if (editingId.value && serializeModal() === modalSnapshot.value) { void closeModal(); return }
    e.character = e.char === 'triad' ? ['nene', 'natsume'] : [e.char]
    e.tags = tagsInput.value.split(',').map((t: string) => t.trim()).filter(Boolean)
    e.usage = usageInput.value.split(',').map((t: string) => t.trim()).filter(Boolean)
    e.mature = e.rating === 'R18'
    if (editingId.value) {
      const idx = scenes.value.findIndex(s => s.id === editingId.value)
      if (idx >= 0) scenes.value[idx] = JSON.parse(JSON.stringify(e)) as SceneDraft
    } else {
      if (scenes.value.some(s => s.id === e.id)) { formHint.value = 'ID 已存在：' + e.id; return }
      scenes.value.push(JSON.parse(JSON.stringify(e)) as SceneDraft)
    }
    setSceneCuration(e.id, curationTierValue.value, curationReason.value.trim())
    modalSnapshot.value = serializeModal()
    closeModal()
    markDirty('场景内容有修改，等待保存到项目')
  }

  async function deleteScene(id: string) {
    if (!(await confirmAction('确认下架 ' + id + '？保存到项目后它将不再出现在场景库中。'))) return
    scenes.value = scenes.value.filter(s => s.id !== id)
    setSceneCuration(id, 'normal', '')
    markDirty('有场景等待下架')
  }

  async function duplicateScene(id: string) {
    const source = scenes.value.find(s => s.id === id)
    if (!source) return
    const copy = JSON.parse(JSON.stringify(source)) as SceneDraft
    const allocatedId = await allocateId()
    if (!allocatedId) return
    copy.id = allocatedId
    copy.title = source.title + ' · 副本'
    scenes.value.push(copy)
    markDirty('已复制场景，请编辑副本内容')
    openEditModal(copy.id)
  }

  function copyJson() {
    if (!editing.value) return
    void copyWithFeedback(JSON.stringify(editing.value, null, 2), '场景 JSON 已复制')
  }

  return {
    editing,
    editingId,
    curationTierValue,
    curationReason,
    tagsInput,
    usageInput,
    triedSave,
    formHint,
    curationTier,
    updateCharacterDefaults,
    onCurationTierChange,
    openAddModal,
    openEditModal,
    closeModal,
    saveScene,
    deleteScene,
    duplicateScene,
    copyJson,
  }
}
