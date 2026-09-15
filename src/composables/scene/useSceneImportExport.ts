import { ref, type Ref } from 'vue'
import { downloadBlob } from '@/utils/downloadBlob'
import type { SceneDraft, TagRecord, CurationData } from '@/types/api'
import type { SceneBlueprint } from '@/utils/popularContent'
import { confirmAction } from '@/composables/useConfirm'
import { isSceneId } from '@/utils/sceneId'
import { MAX_SCENES, MAX_SCENE_REQUEST_BYTES, parseSceneSnapshot } from '@/utils/sceneChanges'

export interface SceneImportExportDeps {
  scenes: Ref<SceneDraft[]>
  tags: Ref<TagRecord[]>
  curation: Ref<CurationData>
  blueprints: Ref<SceneBlueprint[]>
  canImport?: () => boolean
  markDirty: (message: string) => void
  esc: (s: string) => string
  errorMessage: (error: unknown, fallback: string) => string
}

/**
 * 场景管理页「导入 / 导出」簇（2026-08-22 自 SceneManagerView 下沉）。
 *
 * 导入兼容信封 { scenes, tags, curation } 与裸数组/单对象三种形态；
 * 逐条严格校验（id 格式 / 标题 / story / char / rating 不做静默
 * fallback），未知字段原样保留写回不丢数据；envelope 的 tags 只校验
 * 不写回。导出为带版本号与时间戳的完整维护快照。
 */
export function useSceneImportExport(deps: SceneImportExportDeps) {
  const { scenes, tags, curation, markDirty, esc, errorMessage } = deps

  const importInput = ref('')
  const importResult = ref('')
  const fullImportLoaded = ref(false)
  const importing = ref(false)

  function exportJSON() {
    const payload = {
      scenes: scenes.value,
      tags: tags.value,
      curation: curation.value,
      blueprints: deps.blueprints.value,
      exportedAt: new Date().toISOString(),
      version: 1 as const,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    downloadBlob(blob, `aics-maintenance-${yyyymmdd}.json`)
  }

  function importScenes() {
    if (importing.value || deps.canImport?.() === false) return
    const input = importInput.value.trim()
    if (new TextEncoder().encode(input).byteLength > MAX_SCENE_REQUEST_BYTES) { importResult.value = '<p class="msg-danger">导入 JSON 不能超过 20 MB</p>'; return }
    if (!input) { importResult.value = '<p class="msg-danger">请粘贴 JSON</p>'; return }
    let parsed: unknown
    try { parsed = JSON.parse(input) } catch (e) { importResult.value = '<p class="msg-danger">JSON 错误：' + esc(errorMessage(e, '无法解析')) + '</p>'; return }

    // 兼容两种输入形态：信封 { scenes, tags, curation, ... } 或场景数组/单对象
    let rawScenes: unknown[] = []
    let envelopeTags: unknown = undefined
    let envelopeScenesField = false
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (Array.isArray(obj.scenes)) {
        rawScenes = obj.scenes as unknown[]
        envelopeScenesField = true
        envelopeTags = obj.tags
      } else if (obj.id || obj.title || obj.story) {
        rawScenes = [parsed]
      } else {
        // 未知的对象形态，尝试按数组处理
        rawScenes = [parsed]
      }
    } else if (Array.isArray(parsed)) {
      rawScenes = parsed as unknown[]
    } else {
      rawScenes = [parsed]
    }

    const VALID_CHAR = new Set(['nene', 'natsume', 'triad', 'both'])
    const VALID_RATING = new Set(['All', 'R15', 'R18'])

    const existingIds = new Set(scenes.value.map(s => s.id))
    const seenImportIds = new Set<string>()
    const success: string[] = [], skipped: string[] = [], errors: string[] = []

    rawScenes.forEach((item, idx) => {
      if (!item || typeof item !== 'object') { errors.push('#' + idx + ' 不是对象'); return }
      const raw = item as Record<string, unknown>
      const id = typeof raw.id === 'string' ? raw.id : ''
      // 前置校验：id 格式
      if (!id) { errors.push('#' + idx + ' 缺少 id'); return }
      if (!isSceneId(id)) { errors.push('#' + idx + ' ' + esc(id) + ' ID 非法，需 sc001–sc999 或 sc1000 起的安全整数编号'); return }
      if (existingIds.has(id) || seenImportIds.has(id)) { skipped.push(id); return }
      if (scenes.value.length >= MAX_SCENES) { errors.push('场景数量不能超过 ' + MAX_SCENES); return }

      const title = String(raw.title ?? '').trim()
      const story = String(raw.story ?? '').trim()
      if (!title) { errors.push('#' + idx + ' ' + esc(id) + ' 标题为空'); return }
      if (!story) { errors.push('#' + idx + ' ' + esc(id) + ' story 为空'); return }

      const char = String(raw.char ?? '').trim()
      if (!VALID_CHAR.has(char)) { errors.push('#' + idx + ' ' + esc(id) + ' char 非法：' + esc(char || '(空)')); return }

      // rating 严格校验：不做静默 fallback
      const ratingRaw = String(raw.rating ?? '').trim()
      if (!VALID_RATING.has(ratingRaw)) { errors.push('#' + idx + ' ' + esc(id) + ' rating 非法：' + esc(ratingRaw || '(空)')); return }
      const rating = ratingRaw as SceneDraft['rating']

      const mature = raw.mature === true ? true : rating === 'R18'

      const list = (key: string, fallback: string[]) => Array.isArray(raw[key])
        ? (raw[key] as unknown[]).map(String).map(s => s.trim()).filter(Boolean) : fallback

      const scene: SceneDraft = {
        id, title, category: String(raw.category ?? '恋爱'),
        story, char,
        character: char === 'triad' ? ['nene', 'natsume'] : [char],
        lora: String(raw.lora ?? (char === 'natsume' ? 'shiki_natsume_v18_wd14' : char === 'triad' ? 'ayachi_nene_v18_wd14:0.52, shiki_natsume_v18_wd14:0.52' : 'ayachi_nene_v18_wd14')),
        emotion: String(raw.emotion ?? '恋爱'), season: String(raw.season ?? '不限'), time: String(raw.time ?? '深夜'),
        timeOfDay: String(raw.timeOfDay ?? 'late_night'), tags: list('tags', []), mature,
        rating, location: String(raw.location ?? ''), weather: String(raw.weather ?? ''),
        camera: String(raw.camera ?? ''), lighting: String(raw.lighting ?? ''),
        usage: list('usage', ['壁纸用']), prompt: String(raw.prompt ?? ''),
        negative: String(raw.negative ?? 'worst quality, low quality, normal quality, lowres, blurry, jpeg artifacts, text, watermark, logo, signature, bad anatomy, bad hands'),
        storyJa: String(raw.storyJa ?? '')
      }
      // 保留未知字段（原样写回不丢数据）
      Object.keys(raw).forEach(k => {
        if (!(k in scene)) (scene as Record<string, unknown>)[k] = raw[k]
      })
      scenes.value.push(scene); seenImportIds.add(scene.id); existingIds.add(scene.id); success.push(scene.id)
    })

    // 可选：导入 envelope 中的 tags / curation 校验（不自动写回，仅校验并提示）
    if (envelopeScenesField && envelopeTags !== undefined) {
      if (!Array.isArray(envelopeTags)) {
        errors.push('tags 字段需为数组')
      } else {
        (envelopeTags as unknown[]).forEach((t, i) => {
          if (!t || typeof t !== 'object') { errors.push('tags #' + i + ' 不是对象'); return }
          const r = t as Record<string, unknown>
          const tid = String(r.id ?? '').trim()
          const en = String(r.en ?? '').trim()
          const cn = String(r.cn ?? '').trim()
          const cat = String(r.cat ?? '').trim()
          const w = r.weight
          if (!tid) errors.push('tags #' + i + ' 缺少 id')
          if (!en) errors.push('tags #' + i + ' ' + esc(tid || String(i)) + ' 缺少 en')
          if (!cn) errors.push('tags #' + i + ' ' + esc(tid || String(i)) + ' 缺少 cn')
          if (!cat) errors.push('tags #' + i + ' ' + esc(tid || String(i)) + ' 缺少 cat')
          if (typeof w !== 'number' || !Number.isFinite(w)) errors.push('tags #' + i + ' ' + esc(tid || String(i)) + ' weight 非法')
        })
      }
    }

    let html = ''
    if (success.length) html += '<p class="msg-ok">导入成功 ' + success.length + ' 个：' + esc(success.join(', ')) + '</p>'
    if (skipped.length) html += '<p class="msg-warn">跳过 ' + skipped.length + ' 个（ID 已存在）：' + esc(skipped.join(', ')) + '</p>'
    if (errors.length) html += '<p class="msg-danger">导入失败：' + errors.join('; ') + '</p>'
    importResult.value = html || '<p class="muted">无变化</p>'
    if (success.length) markDirty('批量导入已通过基础检查，等待保存到项目')
  }

  async function loadFullSnapshot() {
    if (importing.value || deps.canImport?.() === false) return
    importing.value = true
    try {
      const snapshot = parseSceneSnapshot(importInput.value)
      if (!(await confirmAction(`载入完整快照将替换当前内存草稿（${snapshot.scenes.length} 个场景、${snapshot.blueprints.length} 个蓝图）。项目文件尚不修改；请先导出需保留的草稿。继续？`))) return
      if (deps.canImport?.() === false) return
      scenes.value = snapshot.scenes
      tags.value = snapshot.tags
      curation.value = snapshot.curation
      deps.blueprints.value = snapshot.blueprints
      fullImportLoaded.value = true
      markDirty('已载入完整快照草稿，请先查看影响预览再保存或全量导入')
      importResult.value = '<p class="msg-ok">完整快照已载入草稿。普通保存仍只提交差异；“全量导入到项目”使用明确的完整导入入口。</p>'
    } catch (error) {
      importResult.value = '<p class="msg-danger">完整快照未载入：' + esc(errorMessage(error, '请检查 JSON')) + '</p>'
    } finally { importing.value = false }
  }

  return { importInput, importResult, importScenes, exportJSON, fullImportLoaded, importing, loadFullSnapshot }
}
