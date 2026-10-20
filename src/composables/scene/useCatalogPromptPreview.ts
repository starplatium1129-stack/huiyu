import { computed, onActivated, onDeactivated, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { catalogApi, type CatalogChange, type CatalogRecord } from '@/api/catalogApi'
import { useSceneStore } from '@/stores/sceneStore'
import { ANIMA_LORA_BY_CHARACTER } from '@/composables/generation/animaSessionContract'
import { parsePopularCharacter, parseSceneBlueprint, defaultOutfit } from '@/utils/popularContent'
import { parsePromptLoras, parsePromptScenes } from '@/utils/promptCatalog'
import { parsePresetCatalog, fillMissingModelProfiles } from '@/utils/modelProfileDefaults'
import { resolveModelProfile, tokenize, type ModelProfile } from '@/utils/promptPolicy'
import { compilePromptRecipe } from '@/utils/promptRecipe'
import { sceneDirectorSources } from '@/utils/promptDirector'
import { parseGeneratedRecipe } from '@/utils/generatedSceneDraft'
import { artistStyleProse, artistTagsForEngine } from '@/config/artistStyles'
import { COLOR_MOODS, EMOTION } from '@/config/promptConstants'
import type { PopularCharacter } from '@/types/character'

type Data = Record<string, unknown>
type Engine = 'anima' | 'krea2'
interface Context {
  character: unknown
  profile: unknown
  outfits: Array<{ data: Data; order: number }>
  loras: unknown
}
interface Source { label: string; value: string }
const object = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value : ''
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const studioIds = new Set(['nene', 'natsume', 'triad', 'none'])
const defaultModels = { anima: 'anima-miaomiao-v1.6', krea2: 'krea2-turbo-fp8' }

// Catalog patches recursively merge objects and replace arrays/scalars, including null.
function merge(base: Data, patch: Data): Data {
  const result = clone(base)
  for (const [key, value] of Object.entries(patch)) {
    Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
      value: object(value) && object(result[key]) ? merge(result[key], value) : clone(value) })
  }
  return result
}
function changed(base: unknown, change?: CatalogChange): unknown {
  if (!change) return base
  if (change.remove) return null
  if (change.data !== undefined) return clone(change.data)
  if (change.patch) {
    if (!object(base)) throw new Error('关联内容尚未创建，无法应用局部修改。请先补全这份内容。')
    return merge(base, change.patch)
  }
  return base
}

export function useCatalogPromptPreview(
  record: Readonly<Ref<CatalogRecord>>, pending: Readonly<Ref<CatalogChange[]>>, opened: Readonly<Ref<boolean>>,
  dirty: Readonly<Ref<boolean>>,
) {
  const sceneStore = useSceneStore()
  const active = ref(true), loading = ref(false), readError = ref('')
  const modelId = ref(defaultModels.anima), outfitId = ref('')
  const profiles = shallowRef<ModelProfile[]>([]), context = shallowRef<Context | null>(null)
  const cache = new Map<string, Context>()
  let controller: AbortController | undefined, sequence = 0
  const currentChange = computed(() => pending.value.find(change => change.kind === record.value.kind && change.id === record.value.id))
  const sourceData = computed<Data>(() => {
    const data = dirty.value ? record.value.data : changed(record.value.data, currentChange.value)
    return object(data) ? data : {}
  })
  const characterId = computed(() => record.value.kind === 'character' ? record.value.id
    : record.value.kind === 'scene' ? text(sourceData.value.char) : text(sourceData.value.characterId))
  const isStudio = computed(() => record.value.kind === 'scene'
    || record.value.kind === 'character' && studioIds.has(characterId.value) && !sourceData.value.popular)
  const characterChange = computed(() => pending.value.find(change => change.kind === 'character' && change.id === characterId.value))
  const isNewCharacter = computed(() => Boolean(record.value.kind === 'character' && !record.value.revision
    || characterChange.value?.expectedRevision === 0 && characterChange.value.data !== undefined))
  const contextKey = computed(() => isStudio.value ? 'studio' : characterId.value ? `popular:${characterId.value}:${isNewCharacter.value}` : '')
  const selectedModel = computed(() => profiles.value.find(profile => profile.model_id === modelId.value))
  const engine = computed<Engine>(() => selectedModel.value?.engine === 'krea2' ? 'krea2' : 'anima')
  const modelGroups = computed(() => (['anima', 'krea2'] as const).map(family => ({
    label: family === 'anima' ? 'Anima' : 'Krea 2',
    options: profiles.value.filter(profile => profile.engine === family && profile.model_id)
      .map(profile => ({ value: profile.model_id!, label: profile.name || profile.model_id! })),
  })))
  const generated = computed(() => {
    try {
      return { recipe: sourceData.value.generatedRecipe ? parseGeneratedRecipe(sourceData.value.generatedRecipe) : null, error: '' }
    } catch (error) { return { recipe: null, error: (error as Error).message } }
  })
  watch([() => `${record.value.kind}:${record.value.id}`, () => generated.value.recipe?.engine,
    () => generated.value.recipe?.parameters.model, () => generated.value.recipe?.parameters.checkpoint], () => {
    outfitId.value = ''
    const recipe = generated.value.recipe
    modelId.value = recipe
      ? recipe.parameters.model || recipe.parameters.checkpoint || (recipe.engine === 'krea2' ? defaultModels.krea2 : defaultModels.anima)
      : defaultModels.anima
  }, { immediate: true })

  function cancel() { sequence++; controller?.abort(); controller = undefined; loading.value = false }
  async function load(refresh = false) {
    cancel()
    readError.value = ''; context.value = null
    if (!opened.value || !active.value || !contextKey.value) return
    const key = contextKey.value, seq = sequence, signalController = new AbortController()
    controller = signalController
    loading.value = true
    if (refresh) cache.delete(key)
    const current = () => seq === sequence && key === contextKey.value && opened.value && active.value && !signalController.signal.aborted
    const readContext = async (): Promise<Context> => {
      const saved = cache.get(key)
      if (saved) return saved
      if (isStudio.value) {
        const { record: loras } = await catalogApi.record('document', 'loras', undefined, signalController.signal)
        return { character: null, profile: null, outfits: [], loras: loras.data }
      }
      if (isNewCharacter.value) return { character: null, profile: null, outfits: [], loras: [] }
      const id = characterId.value
      const [bundle, first] = await Promise.all([
        catalogApi.character(id, signalController.signal),
        catalogApi.query({ kind: 'outfit', character: id, pageSize: 100, sort: 'order' }, signalController.signal),
      ])
      const summaries = [...first.items]
      for (let page = 2; summaries.length < first.total; page++) {
        const next = await catalogApi.query({ kind: 'outfit', character: id, page, pageSize: first.pageSize, sort: 'order' }, signalController.signal)
        if (!next.items.length) break
        summaries.push(...next.items)
      }
      const rawOutfits = object(bundle.character) && Array.isArray(bundle.character.outfits) ? bundle.character.outfits : []
      return { ...bundle, loras: [], outfits: rawOutfits.filter(object).map(outfit => ({
        data: { characterId: id, outfit },
        order: summaries.find(item => item.id === `${id}/${text(outfit.id)}`)?.sortOrder ?? 0,
      })) }
    }
    try {
      const [loaded, modelProfiles] = await Promise.all([
        readContext(),
        sceneStore.loadPresetCatalog().then(() => fillMissingModelProfiles(parsePresetCatalog(sceneStore.presets).modelProfiles)),
      ])
      if (!current()) return
      cache.set(key, loaded); context.value = loaded; profiles.value = modelProfiles
    } catch (error) {
      if (current()) readError.value = `预览资料暂时无法读取：${(error as Error).message}`
      signalController.abort()
    } finally { if (seq === sequence) { loading.value = false; controller = undefined } }
  }
  watch([opened, active, contextKey, () => sceneStore.version], () => { void load() }, { immediate: true })
  watch(() => sceneStore.version, () => cache.clear(), { flush: 'sync' })
  onDeactivated(() => { active.value = false; cancel() })
  onActivated(() => { active.value = true })
  onScopeDispose(() => { active.value = false; cancel(); cache.clear() })

  const merged = computed(() => {
    try {
      if (!context.value || isStudio.value) return { character: null, error: '' }
      const id = characterId.value
      let characterData = changed({ popular: context.value.character, profile: context.value.profile }, characterChange.value)
      if (record.value.kind === 'character') characterData = clone(sourceData.value)
      if (!object(characterData)) throw new Error('所属角色已准备归档。请先恢复角色或调整绑定。')
      if (!object(characterData.popular)) throw new Error('这份档案还没有绘制身份。请先补全“绘制时使用的人物描述”。')
      const outfits = new Map(context.value.outfits.map(item => [text((item.data.outfit as Data).id), clone(item)]))
      for (const change of pending.value.filter(item => item.kind === 'outfit' && item.id.startsWith(`${id}/`))) {
        const outfitKey = change.id.slice(id.length + 1)
        const before = outfits.get(outfitKey)
        const data = changed(before?.data, change)
        if (!data) outfits.delete(outfitKey)
        else if (object(data)) outfits.set(outfitKey, { data, order: change.sortOrder ?? before?.order ?? 0 })
      }
      if (record.value.kind === 'outfit') {
        const outfit = sourceData.value.outfit
        if (!object(outfit)) throw new Error('请先填写这套服装。')
        outfits.set(text(outfit.id), { data: clone(sourceData.value),
          order: !dirty.value ? currentChange.value?.sortOrder ?? record.value.sortOrder : record.value.sortOrder })
      }
      const ordered = [...outfits.values()].sort((a, b) => a.order - b.order
        || text((a.data.outfit as Data)?.id).localeCompare(text((b.data.outfit as Data)?.id)))
      if (!ordered.length) throw new Error('这个角色还没有可用衣装，请先补全并暂存一套服装方案。')
      const character = parsePopularCharacter({ ...characterData.popular, id, outfits: ordered.map(item => item.data.outfit) })
      if (!character) throw new Error('所属角色的绘制资料不完整。')
      return { character, error: '' }
    } catch (error) { return { character: null, error: (error as Error).message } }
  })
  const outfitOptions = computed(() => [{ value: '', label: '仅人物身份' },
    ...(merged.value.character?.outfits || []).map(outfit => ({ value: outfit.id, label: outfit.name }))])
  const provenance = computed(() => {
    const recipe = generated.value.recipe
    if (!recipe) return ''
    const model = recipe.parameters.model || recipe.parameters.checkpoint
    return `来自已生成画面 · ${model || recipe.engine}。${model ? '' : '原记录未保存底模，使用下方选择的预览模型。'}沿用保存的画面参数，按当前规则重新编译，可能与原提示词不同。`
  })
  function sourceLabel(kind: CatalogRecord['kind'], id: string) {
    return record.value.kind === kind && record.value.id === id ? '当前编辑'
      : pending.value.some(change => change.kind === kind && change.id === id) ? '已暂存修改' : '已保存内容'
  }
  function commonParameters() {
    const recipe = generated.value.recipe
    if (!recipe) return {}
    const params = recipe.parameters
    return {
      shot: params.shot || null, lighting: params.lighting || null, composition: params.composition || null,
      directorSources: sceneDirectorSources(),
      emotion: (params.emotion || []).map(id => EMOTION.find(item => item.id === id)?.prompt || id),
      palette: tokenize(COLOR_MOODS.find(item => item.id === params.colorMood)?.prompt || ''),
      artistTags: artistTagsForEngine(params.artistStyleIds || [], engine.value),
      artistProse: artistStyleProse(params.artistStyleIds || [], engine.value),
    }
  }
  const preview = computed(() => {
    const sources: Source[] = []
    try {
      if (!opened.value || !active.value || loading.value || readError.value) return { result: null, sources, error: '' }
      if (!dirty.value && currentChange.value?.remove) throw new Error('这份内容已准备归档。撤回归档后可以继续预览。')
      if (generated.value.error) throw new Error(generated.value.error)
      if (generated.value.recipe?.engine === 'sd') throw new Error('这份画面使用 SD 保存，请在绘图工作台载入并核对原配方。')
      if (!characterId.value) throw new Error('先为这份内容选择所属角色，即可查看提示词。')
      if (!context.value) return { result: null, sources, error: '' }
      const profile = resolveModelProfile(profiles.value, modelId.value, engine.value)
      if (!profile) throw new Error(`找不到预览模型 ${modelId.value} 的配置。请选择已有模型，或在绘图工作台载入原配方。`)
      sources.push({ label: '模型', value: `${profile.name || modelId.value} · ${engine.value === 'anima' ? 'Anima' : 'Krea 2'}` })
      const id = characterId.value
      if (isStudio.value) {
        if (!studioIds.has(id)) throw new Error('这份场景的工作室角色无法识别，请检查所属角色。')
        const scene = record.value.kind === 'scene' ? parsePromptScenes([{ ...sourceData.value, id: record.value.id }])[0] : null
        const recipe = generated.value.recipe
        const savedCharacter = recipe?.parameters.characterId || recipe?.parameters.character
        if (savedCharacter && savedCharacter !== id) throw new Error('保存配方的角色与当前场景绑定不同，请在绘图工作台载入核对。')
        const loras = changed(context.value.loras, pending.value.find(change => change.kind === 'document' && change.id === 'loras'))
        const loraMeta = parsePromptLoras(loras)
        const activeLoras = id === 'nene' || id === 'natsume'
          ? { [id]: recipe ? recipe.parameters.loraId || '' : ANIMA_LORA_BY_CHARACTER[id] } : {}
        sources.push({ label: '人物', value: id === 'nene' ? '绫地宁宁 · 工作室身份' : id === 'natsume' ? '四季夏目 · 工作室身份' : id === 'triad' ? '宁宁与夏目' : '不指定人物' })
        sources.push({ label: '画面与穿着', value: scene ? `${scene.title} · 当前编辑` : '仅人物身份，不指定衣装' })
        if (engine.value === 'anima' && Object.values(activeLoras).some(Boolean))
          sources.push({ label: '角色 LoRA', value: Object.values(activeLoras).filter(Boolean).join('、') })
        const result = compilePromptRecipe({ kind: 'studio', character: id, scene, engine: engine.value, profile, activeLoras, loraMeta, ...commonParameters() })
        return { result, sources, error: '' }
      }
      if (merged.value.error) throw new Error(merged.value.error)
      const character = merged.value.character as PopularCharacter
      const blueprint = record.value.kind === 'blueprint' ? parseSceneBlueprint({ ...sourceData.value, id: record.value.id }) : null
      const selectedOutfit = record.value.kind === 'outfit' ? text((sourceData.value.outfit as Data)?.id)
        : blueprint?.outfitId || outfitId.value
      const outfit = selectedOutfit ? character.outfits.find(item => item.id === selectedOutfit) : defaultOutfit(character)
      if (!outfit) throw new Error('绑定的服装不存在或已准备归档，请先调整服装绑定。')
      sources.push({ label: '人物', value: `${character.displayName} · ${sourceLabel('character', id)}` })
      sources.push({ label: '衣装', value: blueprint?.adult ? '由蓝图的画面描述决定；不套用绑定衣装'
        : record.value.kind === 'character' && !outfitId.value ? '仅人物身份，不指定衣装'
          : `${outfit.name} · ${sourceLabel('outfit', `${id}/${outfit.id}`)}${!selectedOutfit ? '（默认）' : ''}` })
      if (blueprint) sources.push({ label: '画面', value: `${blueprint.title} · 当前编辑` })
      const result = compilePromptRecipe({ kind: 'popular', character, outfit, blueprint, engine: engine.value, profile,
        outfitExplicit: record.value.kind === 'outfit' || !!outfitId.value, ...commonParameters() })
      return { result, sources, error: '' }
    } catch (error) { return { result: null, sources, error: `暂时无法编译：${(error as Error).message}` } }
  })
  return { modelId, modelGroups, engine, outfitId, outfitOptions, isStudio, loading, readError, preview, provenance,
    reload: () => load(true) }
}
