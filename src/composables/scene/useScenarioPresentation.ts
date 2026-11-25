import { computed, ref, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import { useMoodReferences } from '@/composables/useMoodReferences'
import { useToast } from '@/composables/useToast'
import type { useScenarioCasting } from '@/composables/scene/useScenarioCasting'
import { CHARACTERS } from '@/config/characters'
import { companionChatAvatars } from '@/config/companionChatAvatars'
import {
  SCENARIO_CHARACTERS,
  SCENARIO_RES_MAP,
  type Scenario,
  type ScenarioAct,
  type ScenarioCharacter,
  type ScenarioResolution,
} from '@/config/scenarios'
import { characterArtEntry } from '@/platform/characterArtState'
import { useVideoStore, type StagedScenarioAct } from '@/stores/videoStore'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { BANNED_TAGS } from '@/utils/promptDiagnostics'
import { scenarioCastPrompt } from '@/utils/scenarioCasting'

export const SCENARIO_LOCK_PARAMS = '底模参数由工作台按引擎自动锁定'
export const SCENARIO_CHARACTER_OPTIONS = [...SCENARIO_CHARACTERS] as const

// Covers are atmosphere references, never generated frames for an act.
const COVER_IDS: Record<string, Record<ScenarioCharacter, string>> = {
  promise: { nene: 'sc001', natsume: 'sc011' },
  rainy: { nene: 'sc007', natsume: 'sc069' },
  sakura: { nene: 'sc002', natsume: 'sc013' },
}

type ActMoodTone = 'joy' | 'love' | 'calm' | 'sad' | 'tension' | 'warmth'
const EMOTION_TONE_MAP: Record<string, ActMoodTone> = {
  '期待': 'joy',
  '开心': 'joy',
  '羞涩': 'love',
  '亲密': 'love',
  '温柔': 'warmth',
  '幸福': 'warmth',
  '失落': 'sad',
  '紧张': 'tension',
}

const MODULE_CLASSES = ['m-q', 'm-c', 'm-cl', 'm-s', 'm-e', 'm-sh', 'm-co', 'm-l', 'm-d', 'm-lora'] as const
const MODULE_LABELS = ['质量', '角色', '衣装', '场景', '情绪', '景别', '构图', '光影', '细节', '引擎'] as const
const bannedTerms = BANNED_TAGS.map(tag => tag.toLowerCase())

function norm(t: string) {
  return t.split(/[,\r\n\u2028\u2029]+/).map(s => s.trim().replace(/[\s-]+/g, '_')).filter(Boolean).join(', ')
}

function violations(a: ScenarioAct) {
  const lower = a.prompt.toLowerCase()
  return BANNED_TAGS.filter(b => lower.includes(b.toLowerCase()))
}

function scenarioShotSize(res: ScenarioResolution): StagedScenarioAct['shotSize'] {
  if (res === 'Close-up') return 'closeup'
  if (res === 'Half-body' || res === 'Portrait') return 'medium'
  return 'wide'
}

export function useScenarioPresentation(options: {
  activeScenario: Ref<Scenario | null>
  currentChar: Ref<ScenarioCharacter>
  casting: ReturnType<typeof useScenarioCasting>
}) {
  const { activeScenario, currentChar, casting } = options
  const videoStore = useVideoStore()
  const router = useRouter()
  const { show: showToast } = useToast()

  const activeCastDisplayName = computed(() =>
    casting.character.value?.displayName || (currentChar.value === 'nene' ? '宁宁' : '夏目'),
  )

  function protagonistAvatar(char: ScenarioCharacter): string {
    return companionChatAvatars[char] || characterArtEntry(char)?.thumbnailUrl || CHARACTERS[char]?.image || ''
  }

  function optionAvatarUrl(id: string): string {
    if (!id) return protagonistAvatar(currentChar.value)
    if (id === 'nene' || id === 'natsume') return protagonistAvatar(id)
    return popularPortraitSrc(id)
  }

  const activeCastAvatarUrl = computed(() => optionAvatarUrl(casting.castId.value))

  const {
    loading: loadingReferences,
    error: referenceError,
    reload: reloadReferences,
    referenceUrl,
    retryReference,
    entries: showcaseEntries,
    thumbUrl: showcaseThumbUrl,
  } = useMoodReferences()
  const referenceRetryStarted = ref(false)
  const portraitRetryVersion = ref<number | undefined>(undefined)

  const castSafeShowcaseEntries = computed(() => {
    const id = casting.castId.value
    if (!id) return []
    return showcaseEntries.value.filter(entry => entry.char === id && entry.rating === 'All')
  })

  function resolveScenarioCover(scenarioId: string, scenarioIndex: number): { src: string; kind: 'scene' | 'portrait'; assetId: string } {
    const castId = casting.castId.value
    if (!castId) {
      const id = COVER_IDS[scenarioId]?.[currentChar.value] || ''
      return { src: referenceUrl(id), kind: 'scene', assetId: id }
    }
    const safeList = castSafeShowcaseEntries.value
    const matched = safeList[scenarioIndex]
    if (matched) {
      return { src: showcaseThumbUrl(matched.id), kind: 'scene', assetId: matched.id }
    }
    return {
      src: popularPortraitSrc(castId, portraitRetryVersion.value),
      kind: 'portrait',
      assetId: castId,
    }
  }

  function retryCover(scenarioId: string, scenarioIndex: number, event: MouseEvent) {
    const origin = event.currentTarget
    if (origin instanceof HTMLElement && document.activeElement === origin) {
      origin.closest('.scenario-book')?.querySelector<HTMLElement>('.scenario-card')?.focus({ preventScroll: true })
    }
    const cover = resolveScenarioCover(scenarioId, scenarioIndex)
    if (cover.kind === 'scene') retryReference(cover.assetId)
    else portraitRetryVersion.value = Date.now()
  }

  function retryReferences() {
    if (loadingReferences.value) return
    referenceRetryStarted.value = true
    void reloadReferences().catch(() => {})
  }

  function frameIcon(res: ScenarioResolution) {
    return res === 'Close-up' ? 'closeup' : res === 'Wide CG' || res === 'Full CG' ? 'wideshot' : 'midshot'
  }

  function actMoodTone(emotion: string): ActMoodTone {
    return EMOTION_TONE_MAP[emotion] || 'warmth'
  }

  function resInfo(res: ScenarioResolution) {
    return SCENARIO_RES_MAP[res]
  }

  function substitutePrompt(tpl: string, char: ScenarioCharacter) {
    return scenarioCastPrompt(tpl, char, casting.character.value, casting.outfit.value)
  }

  function buildFullPrompt(a: ScenarioAct, char: ScenarioCharacter) {
    return norm(substitutePrompt(a.prompt, char))
  }

  function renderModules(a: ScenarioAct) {
    const char = currentChar.value
    const modPrompt = substitutePrompt(a.prompt, char)
    const lines = [...modPrompt.split('\n'), 'LoRA 与采样参数由工作台引擎自动管理']
    return lines.map((line, index) => ({
      style: MODULE_CLASSES[index] || 'm-q',
      label: MODULE_LABELS[index] || '标签',
      tags: line.split(',').map(tag => {
        const text = tag.trim()
        const lower = text.toLowerCase()
        return { text, warn: bannedTerms.some(term => lower.includes(term)) }
      }),
    }))
  }

  const renderedActs = computed(() => (activeScenario.value?.acts ?? []).map(act => ({
    act,
    warnings: violations(act),
    modules: renderModules(act),
  })))

  async function copyPrompt(a: ScenarioAct) {
    if (!casting.ready.value) {
      showToast('请先读取所选角色与衣装')
      return false
    }
    const text = buildFullPrompt(a, currentChar.value)
    return copyWithFeedback(text, '已复制本幕提示词')
  }

  function sendToVideoStudio(actId?: string | Event) {
    const scenario = activeScenario.value
    if (!scenario) return
    if (!casting.ready.value) {
      showToast('请先读取或重新选择故事角色与衣装')
      return
    }
    const characterId = casting.character.value?.id || currentChar.value
    const outfitId = casting.outfit.value?.id
    const acts: StagedScenarioAct[] = scenario.acts.filter(act => typeof actId !== 'string' || act.n === actId).map(act => ({
      prompt: `${act.desc}。${act.emotion}的氛围。`,
      dialogue: '',
      shotSize: scenarioShotSize(act.res),
      camera: 'still',
      motion: 'natural',
      duration: 3,
      characterId,
      storyOrigin: {
        scenarioId: scenario.id,
        actId: act.n,
        title: `${scenario.name} · ${act.title}`,
        characterId,
        outfitId,
        outfitProse: outfitId ? undefined : scenario.outfitProse,
      },
    }))
    if (!videoStore.stageScenarioActs(acts)) {
      showToast('跨页上下文写入失败')
      return
    }
    void router.push('/video-studio?mode=shots')
  }

  return {
    activeCastDisplayName,
    protagonistAvatar,
    optionAvatarUrl,
    activeCastAvatarUrl,
    loadingReferences,
    referenceError,
    referenceRetryStarted,
    resolveScenarioCover,
    retryCover,
    retryReferences,
    frameIcon,
    actMoodTone,
    resInfo,
    renderedActs,
    copyPrompt,
    sendToVideoStudio,
  }
}
