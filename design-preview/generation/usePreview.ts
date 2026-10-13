import { computed, reactive, onScopeDispose, nextTick, watch, type InjectionKey } from 'vue'
import type { AnimaGenerationState } from '../../src/types/anima'
import sceneOne from '../../data/catalog/scene/sc011-fab5dd18660e.json'
import sceneTwo from '../../data/catalog/scene/sc002-425a3fa9fb86.json'
import sceneFour from '../../data/catalog/scene/sc004-d4253d73f71b.json'
import { CHARACTERS } from '../../src/config/characters'
import { ARTIST_COMBO_PRESETS } from '../../src/config/artistStyles'
import { SHOT, LIGHTING, COMPOSITION, EMOTION } from '../../src/config/promptConstants'
import imageCatalog from '../../runtime-rs/src/images/catalog.json'
import { sceneShot, sceneLighting, sceneComposition, sceneRecommendedSize } from '../../src/utils/sceneInference'

// Read-only catalog snapshots, verified against the running page in the report.
// This prototype has no API client, generation service, Pinia or persistence.
export const scenes = [sceneOne.data, sceneTwo.data, sceneFour.data]
export const choices = { SHOT, LIGHTING, COMPOSITION, EMOTION }
export const styleOptions = [{ value: '', label: '跟随场景 · 不追加画师' }, ...ARTIST_COMBO_PRESETS.map(x => ({ value: x.id, label: x.label }))]
export const characters = [CHARACTERS.nene, CHARACTERS.natsume]
type RenderDraft = Pick<AnimaGenerationState, 'modelId' | 'family' | 'width' | 'height' | 'steps' | 'cfg' | 'seed' | 'sampler' | 'scheduler' | 'loraStrength' | 'hiresFix' | 'teaCache'>
export function usePreview() {
  const query = new URLSearchParams(location.search)
  const narrowWindow = matchMedia('(max-width:1440px)')
  const s = reactive({
    theme: query.get('theme') === 'dark' ? 'dark' : 'light',
    scenario: 'normal', phase: 'idle', progress: null as number | null,
    material: 'character', inspector: 'render', expert: false, advanced: false,
    materialsVisible: true, inspectorVisible: true, focused: false, narrow: narrowWindow.matches, drawerOpen: false,
    sceneId: sceneOne.data.id, char: sceneOne.data.char, source: 'studio', search: '',
    story: sceneOne.data.story, visualDescription: '', style: '',
    shot: sceneShot(sceneOne.data) ?? '', lighting: sceneLighting(sceneOne.data) ?? '', composition: sceneComposition(sceneOne.data) ?? '', emotion: '',
    ratio: '832x1216', sourceImage: 'portrait', hasImage: true, compare: query.get('view')==='matched',
    archived: false, autoSave: false, message: '', materialWidth:336, inspectorWidth:368,
    render: { modelId: 'anima-miaomiao-v1.6', family: 'anima', width: 832, height: 1216,
      steps: 30, cfg: 4.5, seed: null, sampler: 'euler', scheduler: 'normal',
      loraStrength: 1, hiresFix: false, teaCache: false } as RenderDraft,
  })
  const scene = computed(() => scenes.find(x => x.id === s.sceneId) ?? {
    ...scenes[0], id:'', char:s.char, title:'自由创作', story:'', prompt:'', negative:'', animaCaption:'', category:'未绑定场景', camera:'自行调整', lighting:'自行调整',
  })
  const character = computed(() => characters.find(x => x.id === s.char) ?? characters[0])
  const busy = computed(() => s.phase === 'running')
  const materialsOpen = computed(() => s.narrow ? s.drawerOpen : s.materialsVisible)
  const model = computed(() => imageCatalog.MODELS[s.render.family==='anima' ? 'anima-miaomiao-v1.6' : 'krea2-turbo-fp8'])
  const visibleScenes = computed(() => scenes.filter(x => x.title.includes(s.search)))
  const picture = computed(() => s.sourceImage === 'landscape'
    ? '/src/assets/illustrations/natsume-rainy-cafe-header.webp'
    : '/assets/characters/natsume-home-cg-1024.webp')
  function onWindowChange(event: MediaQueryListEvent) { s.narrow=event.matches; s.drawerOpen=false }
  narrowWindow.addEventListener('change',onWindowChange)
  onScopeDispose(()=>narrowWindow.removeEventListener('change',onWindowChange))
  watch(()=>s.expert,value=>{ if(!value && s.material==='history') s.material='character' })
  let resizing: { side:'materialWidth'|'inspectorWidth'; x:number; width:number } | null = null
  function startResize(side:'materialWidth'|'inspectorWidth',event:PointerEvent) {
    resizing={side,x:event.clientX,width:s[side]}; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  function moveResize(event:PointerEvent) {
    if(!resizing) return
    const delta=(event.clientX-resizing.x)*(resizing.side==='materialWidth' ? 1 : -1)
    s[resizing.side]=Math.max(280,Math.min(480,resizing.width+delta))
  }
  function endResize() { resizing=null }
  function keyResize(side:'materialWidth'|'inspectorWidth',event:KeyboardEvent) {
    if(!['ArrowLeft','ArrowRight','Home'].includes(event.key)) return
    event.preventDefault()
    if(event.key==='Home') s[side]=side==='materialWidth' ? 336 : 368
    else s[side]=Math.max(280,Math.min(480,s[side]+(event.key==='ArrowRight' ? 16 : -16)*(side==='materialWidth' ? 1 : -1)))
  }
  async function toggleMaterials() {
    if(s.narrow) s.drawerOpen=!s.drawerOpen
    else s.materialsVisible=!s.materialsVisible
    await nextTick()
    if(materialsOpen.value) document.querySelector<HTMLButtonElement>('.materials button')?.focus()
    else document.getElementById('materials-toggle')?.focus()
  }
  function selectEngine(family: 'anima'|'krea2') {
    s.render.family=family
    const preset=model.value
    Object.assign(s.render,{modelId:family==='anima' ? 'anima-miaomiao-v1.6' : 'krea2-turbo-fp8',steps:preset.steps,cfg:preset.cfg,sampler:preset.sampler,scheduler:preset.scheduler})
    if(!preset.sizes.includes(s.ratio)) setRatio(preset.sizes[0])
  }
  function notify(message: string) { s.message = message }
  function setScenario(value: string, preserveComparison = false) {
    if(!preserveComparison) s.compare=false
    s.scenario = value; s.phase = value === 'generating' ? 'running' : value === 'error' ? 'failed' : 'idle'
    s.progress = value === 'generating' ? 0.46 : null
    s.advanced = value === 'advanced'; s.expert = value === 'advanced'
    s.inspector = 'render'; s.inspectorVisible = true
    s.message = ''; s.hasImage = true; s.sourceImage = 'portrait'
  }
  function selectScene(id: string) {
    const next = scenes.find(x => x.id === id)
    if (!next) return
    s.sceneId = id; s.char = next.char; s.story = next.story; s.visualDescription = ''
    s.shot=sceneShot(next) ?? ''; s.lighting=sceneLighting(next) ?? ''; s.composition=sceneComposition(next) ?? ''; s.emotion=''
    const size=sceneRecommendedSize(next)
    setRatio(model.value.sizes.includes(size) ? size : model.value.sizes[0])
    s.sourceImage = 'scene'; s.hasImage = false; s.archived = false
    notify('已切换场景参考；此原型不编译提示词、不调用生成。')
  }
  function generate() {
    if (busy.value) { s.phase = 'cancelled'; s.progress = null; s.scenario = 'normal'; notify('模拟绘制已停止，保留当前参考。'); return }
    s.phase='running'; s.progress=0.46; s.scenario='generating'; s.message=''
  }
  function editStory() {
    if (!s.sceneId || s.story === scene.value.story) return
    s.sceneId=''; s.visualDescription=''; s.shot=''; s.lighting=''; s.composition=''; s.emotion=''
    notify('已解除场景绑定，保留当前故事，可以继续自由调整。')
  }
  function finish() { s.phase = 'succeeded'; s.progress = 1; s.scenario = 'normal'; notify('模拟完成：仍显示原有素材，未产生新图片。') }
  function setTheme() { s.theme = s.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = s.theme }
  function setRatio(value: string) { s.ratio = value; const [w,h] = value.split('x').map(Number); s.render.width = w; s.render.height = h }
  function changeCharacter(id: string) {
    if(s.sceneId && scene.value.char!==id) {
      const previous=scene.value
      if(s.story===previous.story) s.story=''
      if(s.shot===sceneShot(previous)) s.shot=''
      if(s.lighting===sceneLighting(previous)) s.lighting=''
      if(s.composition===sceneComposition(previous)) s.composition=''
      s.sceneId=''
    }
    s.char = id
    notify('已切换角色并解除不兼容的场景绑定；画布保留独立的品牌素材。')
  }
  document.documentElement.dataset.theme = s.theme
  setScenario(query.get('state') || 'normal',true)
  if(s.compare) { s.sourceImage='scene'; s.hasImage=false }
  return reactive({ s, scene, character, busy, model, materialsOpen, picture, visibleScenes, notify, setScenario, selectScene, generate, editStory, finish, setTheme, setRatio, changeCharacter, toggleMaterials, selectEngine, startResize, moveResize, endResize, keyResize })
}
export const previewKey: InjectionKey<ReturnType<typeof usePreview>> = Symbol('generation-design-reference')
