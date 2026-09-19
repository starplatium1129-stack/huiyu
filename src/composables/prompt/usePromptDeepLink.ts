import { getCurrentScope, onScopeDispose, type Ref } from 'vue'
import { usePromptBuilderStore, type HistoryEntry, type Scene } from '@/stores/promptBuilderStore'
import { isCharKey } from '@/composables/scene/directorOptions'
import { COLOR_MOODS } from '@/config/promptConstants'
import type { ScenarioCharacter } from '@/config/scenarios'
import {
  findBlueprint as findPopularBlueprint,
  findCharacter as findPopularCharacter,
  type PopularCharacter,
  type SceneBlueprint,
} from '@/utils/popularContent'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>

export interface PromptDeepLinkDeps {
  pb: PromptBuilderStore
  sdSize: Ref<string>
  patchAnimaState: AnimaSession['patchState']
  /** 热门蓝图全量列表展开开关（预选蓝图卡片可能不在推荐 3 个里）。 */
  showAllBlueprints: Ref<boolean>
  selectPopularSource: (source: 'studio' | 'popular') => void
  selectBlueprint: (blueprint: SceneBlueprint) => void
  selectScene: (scene: Scene) => void
  applyRecommendedEngine: (character: PopularCharacter | null) => void
  setDirectorMode: (mode: 'basic' | 'pro') => void
  applyHistory: (entry: HistoryEntry, keepAsVariant?: boolean) => void | boolean | Promise<void | boolean>
}

/**
 * 绘图页深链参数应用（2026-08-22 自 PromptBuilderView 下沉）。
 *
 * ?scene / ?popular&blueprint / ?char / ?mood / ?scenario / ?regen|?remix|
 * ?variant / ?resume / ?quick 八类参数按「与宿主动作同一路径」回放（选角、
 * 选蓝图、应用历史等全部复用视图注入的动作，不另写一份状态写入）。
 * 调用时机归宿主：onMounted 首放 + watch(route.query) 按 deepLinkNeeded
 * 条件重放（bfcache / 组件复用时 onMounted 不重跑）。
 */
export function usePromptDeepLink(deps: PromptDeepLinkDeps) {
  const { pb, sdSize, patchAnimaState, showAllBlueprints } = deps
  let lastHistoryLink = ''
  let lastContextLink = ''
  let historyRequest = 0
  if (getCurrentScope()) onScopeDispose(() => { historyRequest += 1 })
  function historyKey(q: Record<string, unknown>) {
    const mode = ['remix', 'regen', 'variant'].find(key => typeof q[key] === 'string')
    return mode ? mode + ':' + q[mode] : ''
  }
  function contextKey(q: Record<string, unknown>) {
    const fields = ['scenario', 'popular', 'blueprint', 'scene', 'char', 'mood', 'resume', 'quick']
      .flatMap(key => typeof q[key] === 'string' ? [[key, q[key]]] : [])
    return fields.length ? JSON.stringify(fields) : ''
  }

  async function applyDeepLink(q: Record<string, unknown>): Promise<boolean> {
    const request = ++historyRequest
    let handled = false
    const scenarioId = typeof q.scenario === 'string' ? q.scenario : ''
    if (scenarioId) {
      const { findScenario, substituteScenarioPrompt, SCENARIO_RES_MAP } = await import('@/config/scenarios')
      if (request !== historyRequest) return false
      // 剧本模式分幕 → 导演台：第一幕的语义词条落成手动词条，
      // 质量行不搬（质量前缀由模型 profile 决定，剧本里的六连质量词
      // 正是 WAI 作者建议避免的堆叠写法）。
      const scenario = findScenario(scenarioId)
      const act = scenario?.acts[0]
      if (act) {
        const char = isCharKey(q.char) ? (q.char as ScenarioCharacter) : 'nene'
        pb.setChar(char)
        pb.setStory(`${scenario.name} · ${act.title}：${act.desc}`)
        const semanticTokens = substituteScenarioPrompt(act.prompt, char)
          .split('\n')
          .slice(1)
          .flatMap(line => line.split(',').map(token => token.trim().replace(/[\s-]+/g, '_')))
          .filter(Boolean)
        pb.manualTags = new Set(semanticTokens)
        const dim = SCENARIO_RES_MAP[act.res]?.dim
        if (dim) sdSize.value = dim.replace('×', 'x')
        pb.flash(`已载入剧本《${scenario.name}》第一幕 ${act.title}，可调整后生成`)
        handled = true
      }
    }
    if (isCharKey(q.char)) {
      pb.setChar(q.char); handled = true
    }
    // 热门角色深链：不带 !pb.isPopular 前置条件——已在热门模式时二次进入
    // （换角色/换场景）也必须重新应用，否则「点击场景还是上一个」。
    if (typeof q.popular === 'string') {
      // 进入热门模式并选中指定角色；?blueprint= 可预选场景蓝图
      // （角色场景库页面「开始绘制」直达）。
      deps.selectPopularSource('popular')
      const target = findPopularCharacter(pb.popularCharacters, q.popular)
      if (target) {
        const blueprintId = typeof q.blueprint === 'string' && q.blueprint ? q.blueprint : null
        pb.setPopularSubject(target.id, target.outfits.find(o => o.default)?.id ?? target.outfits[0].id, blueprintId)
        patchAnimaState({ modelId: target.recommendedEngine })
        deps.applyRecommendedEngine(target)
        if (blueprintId) {
          const blueprint = findPopularBlueprint(pb.sceneBlueprints, blueprintId)
          if (blueprint) {
            // 与点击卡片同一路径：应用镜头/光照/构图/色调/尺寸推断，并展开全部列表
            // 保证预选场景卡片可见高亮（可能不在推荐 3 个里）。
            deps.selectBlueprint(blueprint)
            showAllBlueprints.value = true
          }
        }
      }
      handled = true
    }
    if (typeof q.remix === 'string' || typeof q.regen === 'string' || typeof q.variant === 'string') {
      const targetId = String(typeof q.remix === 'string' ? q.remix : (typeof q.regen === 'string' ? q.regen : q.variant))
      let entry = targetId ? pb.history.find(h => String(h.id) === targetId) : null
      if (!entry && targetId) {
        await pb.loadHistory()
        if (request !== historyRequest) return handled
        entry = pb.history.find(h => String(h.id) === targetId)
      }
      if (entry) {
        const applied = await deps.applyHistory(entry, typeof q.variant === 'string' || typeof q.remix === 'string')
        if (applied === false) return handled
        if (request !== historyRequest) return handled
        lastHistoryLink = historyKey(q)
        if (typeof q.remix === 'string') {
          deps.setDirectorMode('pro')
        }
        handled = true
      }
    } else if (typeof q.scene === 'string') {
      const sc = pb.scenes.find(s => s.id === q.scene)
      if (sc) { deps.selectScene(sc); handled = true }
    } else if (q.resume === '1') {
      handled = pb.restoreDraft()
    } else if (q.quick === '1' && !pb.story) {
      pb.setStory('用一张画面来讲今天想画的故事')
      handled = true
    }
    // An explicit scene-link mood wins over inferred scene defaults; saved snapshots keep their own mood.
    if (!q.remix && !q.regen && !q.variant && q.resume !== '1'
      && typeof q.mood === 'string' && COLOR_MOODS.some(m => m.id === q.mood)) {
      pb.setColorMood(q.mood); handled = true
    }
    if (handled && !historyKey(q)) lastContextLink = contextKey(q)
    return handled
  }

  /** URL 场景参数与当前选中不一致时才需要重放深链（避免覆盖用户手动编辑的状态）。 */
  function deepLinkNeeded(q: Record<string, unknown>): boolean {
    const history = historyKey(q)
    if (history) return history !== lastHistoryLink
    lastHistoryLink = ''
    const context = contextKey(q)
    if (!context) {
      lastContextLink = ''
      return false
    }
    if (typeof q.popular === 'string') {
      const blueprint = typeof q.blueprint === 'string' && q.blueprint ? q.blueprint : null
      if (pb.subject.kind !== 'popular'
        || pb.subject.characterId !== q.popular
        || pb.subject.blueprintId !== blueprint) return true
    }
    if (typeof q.scene === 'string' && pb.sceneId !== q.scene) return true
    if (isCharKey(q.char) && pb.char !== q.char) return true
    if (typeof q.mood === 'string' && COLOR_MOODS.some(m => m.id === q.mood) && pb.colorMood !== q.mood) return true
    return context !== lastContextLink
  }

  return { applyDeepLink, deepLinkNeeded }
}
