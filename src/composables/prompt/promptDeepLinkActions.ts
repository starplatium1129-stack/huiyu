import { isCharKey } from '@/composables/scene/directorOptions'
import { COLOR_MOODS } from '@/config/promptConstants'
import type { ScenarioCharacter } from '@/config/scenarios'
import { findBlueprint as findPopularBlueprint, findCharacter as findPopularCharacter } from '@/utils/popularContent'
import type { PromptDeepLinkDeps } from './usePromptDeepLink'

/** Applies explicit URL actions; the mounted owner retains request and disposal state. */
export async function applyPromptDeepLink(q: Record<string, unknown>, deps: PromptDeepLinkDeps, isCurrent: () => boolean) {
  const { pb, sdSize, patchAnimaState, showAllBlueprints } = deps
  const historyLink = ['remix', 'regen', 'variant'].some(key => typeof q[key] === 'string')
  let handled = false, historyApplied = false
  const scenarioId = typeof q.scenario === 'string' ? q.scenario : ''
  if (scenarioId) {
    const { findScenario, substituteScenarioPrompt, SCENARIO_RES_MAP } = await import('@/config/scenarios')
    if (!isCurrent()) return { handled: false, historyApplied: false }
    // 剧本模式分幕 → 导演台：第一幕的语义词条落成手动词条，
    // 质量行不搬（质量前缀由模型 profile 决定，剧本里的六连质量词
    // 正是 WAI 作者建议避免的堆叠写法）。
    const scenario = findScenario(scenarioId)
    const act = scenario?.acts[0]
    if (act) {
      if (pb.isPopular) deps.selectPopularSource('studio')
      pb.clearScene()
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
      if (dim) {
        pb.lastRecommendedSize = dim.replace('×', 'x')
        sdSize.value = pb.lastRecommendedSize
      }
      pb.flash(`已载入剧本《${scenario.name}》第一幕 ${act.title}，可调整后生成`)
      handled = true
    }
  }
  if (isCharKey(q.char)) {
    if (pb.isPopular && !q.popular && !historyLink) deps.selectPopularSource('studio')
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
      if (!isCurrent()) return { handled: false, historyApplied: false }
      entry = pb.history.find(h => String(h.id) === targetId)
    }
    if (entry) {
      const applied = await deps.applyHistory(entry, typeof q.variant === 'string' || typeof q.remix === 'string')
      if (applied === false) return { handled, historyApplied }
      if (!isCurrent()) return { handled: false, historyApplied: false }
      historyApplied = true
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
  return { handled, historyApplied }
}
