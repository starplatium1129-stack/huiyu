import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import {
  fetchVideoAiStatus,
  generateVideoScript,
  polishVideoShots,
  reviewVideoShots,
  rewriteVideoShot,
  suggestDialogue,
  type VideoAiIssue,
  type VideoAiScriptShot,
  type VideoAiStatusResponse,
  type VideoShotSize,
} from '@/api/videoApi'
import type { ShotDraft } from './shotListTypes'
import type { ReferenceCard } from './useReferenceCards'

export interface ShotAiToolsDeps {
  shots: Ref<ShotDraft[]>
  identityCard: Ref<string>
  /** 整批生成进行中禁用全部 AI 动作（useShotBatchMachine.batchActive）。 */
  batchActive: ComputedRef<boolean>
  /** 参考卡（AI 脚本生成的 <Picture N> 角色名注入）。 */
  referenceCards: Ref<ReferenceCard[]>
}

/**
 * 分镜编辑器·AI 整理链路（2026-08-22 自 ShotListEditor 下沉）。
 *
 * 五条 AI 流水线共用一份状态面板（aiNote + aiFlowStep 引导）：
 * ① 逐镜整理（并发 2 改写描述，整批快照可撤销）
 * ② 整批编排（全局视角只调构图字段，独立快照与 ① 的撤销互不干扰）
 * ③ 脚本生成（故事梗概 → 整表替换镜头清单）
 * ④ 单镜台词备选
 * ⑤ 整批质量检查（问题标红 + 按字段应用建议）。
 * 复用聊天 LLM 配置（服务端自动选：站主 API → 本地 Ollama）。
 */
export function useShotAiTools(deps: ShotAiToolsDeps) {
  const { shots, identityCard, batchActive, referenceCards } = deps

  const controller = new AbortController()
  const { signal } = controller
  onScopeDispose(() => {
    controller.abort()
    aiBusy.value = scriptBusy.value = dialogueBusy.value = reviewBusy.value = false
  })
  const aiBusy = ref(false)
  const aiProgress = ref(0)
  const aiTotal = ref(0)
  const aiSnapshot = ref<ShotDraft[] | null>(null)
  const aiNote = ref('')
  let rewriteTargets: ShotDraft[] = []
  let polishTargets: ShotDraft[] = []
  let reviewTargets: ShotDraft[] = []
  let dialogueTarget: ShotDraft | null = null
  const textFields = ['prompt', 'dialogue', 'shotSize', 'camera', 'motion'] as const
  const unchanged = (target: ShotDraft, snapshot: ShotDraft) => textFields.every(key => target[key] === snapshot[key])
  function restoreText(snapshot: ShotDraft[], targets: ShotDraft[]) {
    targets.forEach((target, index) => {
      if (shots.value.includes(target) && snapshot[index]) Object.assign(target, Object.fromEntries(textFields.map(key => [key, snapshot[index][key]])))
    })
  }
  const anyAiBusy = () => signal.aborted || aiBusy.value || scriptBusy.value || dialogueBusy.value || reviewBusy.value || batchActive.value
  /** 整批编排的独立快照：撤销编排只回编排前，不影响「AI 整理」的撤销。 */
  const polishSnapshot = ref<ShotDraft[] | null>(null)

  // ── AI 流程引导：推荐顺序 ① 逐镜整理 → ② 整批编排 → 生成 ──────────────
  // aiFlowStep：0=未整理 1=已整理 2=已编排；导入新镜头时由宿主重置。
  const aiFlowStep = ref(0)
  const flowHint = computed(() => {
    if (!shots.value.length) return ''
    if (aiFlowStep.value === 0) return '推荐流程：先点 ① AI 整理分镜（逐镜改写描述 + 推断台词/景别/镜头/运动）'
    if (aiFlowStep.value === 1) return '推荐流程：再点 ② AI 整批编排（统稿全片节奏：景别/镜头/台词分布）'
    return '镜头已整理并编排，可以直接「生成全部镜头」，或逐镜微调后生成。'
  })

  // ── 「AI 整理分镜」：逐镜把静态绘图提示词改写成视频分镜描述 ──────────────
  // 复用聊天 LLM 配置；并发 2 逐镜改写（Ollama 有进程内串行队列，API 也不
  // 压上游）；失败单镜保留原内容，可再点一次重试；应用前整批快照，随时
  // 「撤销整理」恢复。
  async function runAiRewrite() {
    if (anyAiBusy() || !shots.value.length) return
    aiBusy.value = true
    aiNote.value = ''
    let status: VideoAiStatusResponse
    try {
      status = await fetchVideoAiStatus(signal)
      if (signal.aborted) return
    } catch (error) {
      if (signal.aborted) return
      aiBusy.value = false
      aiNote.value = 'AI 状态读取失败：' + (error instanceof Error ? error.message : String(error))
      return
    }
    if (!status.available) {
      aiBusy.value = false
      aiNote.value = status.reason || 'AI 整理暂不可用'
      return
    }
    const total = shots.value.length
    aiSnapshot.value = shots.value.map((shot) => ({ ...shot }))
    rewriteTargets = shots.value.slice()
    const originals = aiSnapshot.value
    aiTotal.value = total
    aiProgress.value = 0
    aiBusy.value = true
    aiNote.value = `AI 整理中 0/${total}（${status.label}）…`
    let failed = 0
    let cursor = 0
    const worker = async () => {
      while (!signal.aborted && cursor < total) {
        const index = cursor
        cursor += 1
        try {
          const response = await rewriteVideoShot({
            identity: identityCard.value.trim() || undefined,
            prompt: originals[index].prompt,
            shotSize: originals[index].shotSize || undefined,
            camera: originals[index].camera,
            motion: originals[index].motion,
            dialogue: originals[index].dialogue || undefined,
          }, signal)
          if (signal.aborted) return
          const shot = rewriteTargets[index]
          if (!shots.value.includes(shot) || !unchanged(shot, originals[index])) throw new Error('镜头已编辑，保留用户改动')
          if (response.shot.prompt) shot.prompt = response.shot.prompt
          if (response.shot.shotSize) shot.shotSize = response.shot.shotSize
          shot.camera = response.shot.camera
          shot.motion = response.shot.motion
          shot.dialogue = response.shot.dialogue
        } catch {
          if (signal.aborted) return
          failed += 1
        } finally {
          if (!signal.aborted) {
            aiProgress.value += 1
            aiNote.value = `AI 整理中 ${aiProgress.value}/${total}（${status.label}）…`
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, total) }, worker))
    if (signal.aborted) return
    aiBusy.value = false
    if (failed < total) aiFlowStep.value = Math.max(aiFlowStep.value, 1)
    aiNote.value = failed
      ? `AI 整理完成：${total - failed}/${total} 镜已改写，${failed} 镜失败（保留原描述，可再点一次重试）`
      : `AI 整理完成：${total} 镜全部改写，可逐镜微调或直接生成。`
  }

  function restoreAiSnapshot() {
    if (!aiSnapshot.value || anyAiBusy()) return
    restoreText(aiSnapshot.value, rewriteTargets)
    aiSnapshot.value = null
    aiFlowStep.value = 0
    aiNote.value = '已撤销 AI 整理，恢复整理前内容。'
  }

  // ── 「AI 整批编排」：全局视角审整批镜头，只调构图字段（不动描述）──────
  // 一次 LLM 调用返回整批建议（index 对齐，null = 保持）；应用前独立快照，
  // 「撤销编排」只回编排前状态，与「AI 整理」的撤销互不干扰。
  async function runAiPolish() {
    if (anyAiBusy() || shots.value.length < 2) return
    aiBusy.value = true
    aiNote.value = ''
    let status: VideoAiStatusResponse
    try {
      status = await fetchVideoAiStatus(signal)
      if (signal.aborted) return
    } catch (error) {
      if (signal.aborted) return
      aiBusy.value = false
      aiNote.value = 'AI 状态读取失败：' + (error instanceof Error ? error.message : String(error))
      return
    }
    if (!status.available) {
      aiBusy.value = false
      aiNote.value = status.reason || 'AI 编排暂不可用'
      return
    }
    polishSnapshot.value = shots.value.map((shot) => ({ ...shot }))
    polishTargets = shots.value.slice()
    const originals = polishSnapshot.value
    aiBusy.value = true
    aiNote.value = `AI 整批编排中（${status.label}）…`
    try {
      const response = await polishVideoShots({
        identity: identityCard.value.trim() || undefined,
        shots: shots.value.map((shot) => ({
          prompt: shot.prompt,
          shotSize: shot.shotSize || undefined,
          camera: shot.camera,
          motion: shot.motion,
          dialogue: shot.dialogue || undefined,
        })),
      }, signal)
      if (signal.aborted) return
      let changed = 0
      response.shots.forEach((suggestion, index) => {
        const shot = polishTargets[index]
        if (!shot || !shots.value.includes(shot) || !unchanged(shot, originals[index])) return
        if (suggestion.shotSize && suggestion.shotSize !== shot.shotSize) {
          shot.shotSize = suggestion.shotSize
          changed += 1
        }
        if (suggestion.camera && suggestion.camera !== shot.camera) {
          shot.camera = suggestion.camera
          changed += 1
        }
        if (suggestion.motion && suggestion.motion !== shot.motion) {
          shot.motion = suggestion.motion
          changed += 1
        }
        if (suggestion.dialogue !== null && suggestion.dialogue !== shot.dialogue) {
          shot.dialogue = suggestion.dialogue
          changed += 1
        }
      })
      aiNote.value = changed
        ? `AI 整批编排完成：调整 ${changed} 处（景别/镜头/运动/对白分布），可逐镜微调或「撤销编排」恢复`
        : 'AI 整批编排完成：当前镜头语言已比较均衡，未做调整。'
      aiFlowStep.value = 2
    } catch (error) {
      if (signal.aborted) return
      polishSnapshot.value = null
      aiNote.value = 'AI 整批编排失败：' + (error instanceof Error ? error.message : String(error))
    } finally {
      aiBusy.value = false
    }
  }

  function restorePolishSnapshot() {
    if (!polishSnapshot.value || anyAiBusy()) return
    restoreText(polishSnapshot.value, polishTargets)
    polishSnapshot.value = null
    aiFlowStep.value = Math.min(aiFlowStep.value, 1)
    aiNote.value = '已撤销 AI 整批编排，恢复编排前内容。'
  }

  // ── 「✎ AI 生成脚本」：故事梗概 → 完整分镜表（T2VA 可直接生成）─────────
  const scriptOpen = ref(false)
  const scriptStory = ref('')
  const scriptCount = ref<number | null>(null)
  const scriptTotal = ref<number | null>(null)
  const scriptBusy = ref(false)

  async function runAiScript() {
    if (anyAiBusy() || !scriptStory.value.trim()) return
    scriptBusy.value = true
    const originalShots = shots.value.slice()
    const originalText = JSON.stringify(shots.value)
    aiNote.value = 'AI 生成分镜脚本中…'
    try {
      const cardLabels = referenceCards.value
        .map(card => card.label.trim())
        .filter(Boolean)
      const response = await generateVideoScript({
        identity: identityCard.value.trim() || undefined,
        story: scriptStory.value.trim(),
        shotCount: scriptCount.value ?? undefined,
        totalSeconds: scriptTotal.value ?? undefined,
        characterLabels: cardLabels.length ? cardLabels : undefined,
      }, signal)
      if (signal.aborted) return
      if (!response.shots.length) {
        aiNote.value = 'AI 脚本生成为空，请调整故事梗概后重试'
        return
      }
      if (JSON.stringify(shots.value) !== originalText || shots.value.some((shot, index) => shot !== originalShots[index])) {
        aiNote.value = '生成期间镜头已编辑，已保留当前内容；请确认后重新生成脚本'
        return
      }
      aiSnapshot.value = null
      polishSnapshot.value = null
      reviewIssues.value = []
      // 替换现有镜头清单（保留参考卡与整批方向）。
      shots.value.forEach((shot) => {
        if (shot.imageUrl) URL.revokeObjectURL(shot.imageUrl)
      })
      shots.value = response.shots.map((shot: VideoAiScriptShot) => ({
        prompt: shot.prompt,
        dialogue: shot.dialogue,
        shotSize: shot.shotSize ?? '',
        camera: shot.camera,
        motion: shot.motion,
        duration: shot.duration,
        seedText: '',
        imageName: '',
        imageUrl: '',
        cast: '',
      }))
      aiFlowStep.value = 1
      scriptOpen.value = false
      scriptStory.value = ''
      aiNote.value = `AI 脚本已生成：${shots.value.length} 镜（无首帧，纯文字 T2VA 可直接生成；也可逐镜上传首帧锁构图）`
    } catch (error) {
      if (signal.aborted) return
      aiNote.value = 'AI 脚本生成失败：' + (error instanceof Error ? error.message : String(error))
    } finally {
      scriptBusy.value = false
    }
  }

  // ── 「✦ AI 台词」：3 条备选 / 润色 ──────────────────────────────────────
  /** 台词润色：当前弹出选项的镜头 index（-1 关闭）。 */
  const dialogueIndex = ref(-1)
  const dialogueOptions = ref<Array<{ text: string; label: string }>>([])
  const dialogueBusy = ref(false)

  async function runAiDialogue(index: number) {
    const shot = shots.value[index]
    if (!shot || anyAiBusy()) return
    dialogueTarget = shot
    dialogueBusy.value = true
    dialogueIndex.value = index
    dialogueOptions.value = []
    try {
      const response = await suggestDialogue({
        identity: identityCard.value.trim() || undefined,
        prompt: shot.prompt,
        currentDialogue: shot.dialogue.trim() || undefined,
      }, signal)
      if (signal.aborted) return
      if (shots.value[index] !== shot) { dialogueIndex.value = -1; return }
      dialogueOptions.value = response.options
      if (!response.options.length) {
        dialogueIndex.value = -1
        aiNote.value = 'AI 台词未返回可用选项，请重试'
      }
    } catch (error) {
      if (signal.aborted) return
      dialogueIndex.value = -1
      aiNote.value = 'AI 台词失败：' + (error instanceof Error ? error.message : String(error))
    } finally {
      dialogueBusy.value = false
    }
  }

  function applyDialogueOption(index: number, text: string) {
    const shot = shots.value[index]
    if (!shot || shot !== dialogueTarget || anyAiBusy()) return
    shot.dialogue = text
    dialogueIndex.value = -1
    dialogueOptions.value = []
  }

  // ── 「◉ 质量检查」：整批审查 → 标红 + 建议应用 ──────────────────────────
  /** 质量检查结果（index 对齐 shots）。 */
  const reviewIssues = ref<VideoAiIssue[]>([])
  const reviewBusy = ref(false)

  async function runAiReview() {
    if (anyAiBusy() || !shots.value.length) return
    reviewBusy.value = true
    aiNote.value = 'AI 质量检查中…'
    reviewIssues.value = []
    reviewTargets = shots.value.slice()
    try {
      const response = await reviewVideoShots(shots.value.map(shot => ({
        prompt: shot.prompt,
        shotSize: shot.shotSize || undefined,
        camera: shot.camera,
        motion: shot.motion,
        dialogue: shot.dialogue || undefined,
      })), signal)
      if (signal.aborted) return
      reviewIssues.value = response.issues
      aiNote.value = response.issues.length
        ? `质量检查：发现 ${response.issues.length} 个问题（${response.issues.filter(i => i.severity === 'error').length} 个必须修），可点击建议应用`
        : '质量检查：未发现问题，可以生成。'
    } catch (error) {
      if (signal.aborted) return
      aiNote.value = 'AI 质量检查失败：' + (error instanceof Error ? error.message : String(error))
    } finally {
      reviewBusy.value = false
    }
  }

  /** 应用质量检查建议（按字段回写镜头）。 */
  function applyReviewSuggestion(issue: VideoAiIssue) {
    const shot = shots.value[issue.index]
    if (!shot || shot !== reviewTargets[issue.index] || !issue.suggestion || anyAiBusy()) return
    if (issue.field === 'shotSize' && ['wide', 'medium', 'closeup'].includes(issue.suggestion)) {
      shot.shotSize = issue.suggestion as VideoShotSize
    } else if (issue.field === 'camera' && ['still', 'push', 'pull', 'pan', 'orbit'].includes(issue.suggestion)) {
      shot.camera = issue.suggestion as ShotDraft['camera']
    } else if (issue.field === 'motion' && ['subtle', 'natural', 'expressive'].includes(issue.suggestion)) {
      shot.motion = issue.suggestion as ShotDraft['motion']
    } else if (issue.field === 'dialogue') {
      shot.dialogue = issue.suggestion.slice(0, 300)
    } else if (issue.field === 'prompt') {
      shot.prompt = issue.suggestion.slice(0, 4000)
    } else return
    reviewIssues.value = reviewIssues.value.filter(item => item !== issue)
    aiNote.value = '已应用建议：' + issue.suggestion
  }

  function shotIssueCount(index: number): number {
    return reviewIssues.value.filter(issue => issue.index === index).length
  }

  return {
    aiBusy,
    aiNote,
    aiSnapshot,
    polishSnapshot,
    aiFlowStep,
    flowHint,
    scriptOpen,
    scriptStory,
    scriptCount,
    scriptTotal,
    scriptBusy,
    runAiRewrite,
    restoreAiSnapshot,
    runAiPolish,
    restorePolishSnapshot,
    runAiScript,
    dialogueIndex,
    dialogueOptions,
    dialogueBusy,
    runAiDialogue,
    applyDialogueOption,
    reviewIssues,
    reviewBusy,
    runAiReview,
    applyReviewSuggestion,
    shotIssueCount,
  }
}
