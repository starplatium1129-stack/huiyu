import { computed, ref, watch, type Ref } from 'vue'
import type { KeyframeModel } from '@/api/keyframeApi'
import { useSceneStore } from '@/stores/sceneStore'
import { UNIVERSAL_WARDROBE_PRESETS } from '@/config/universalWardrobe'
import { OUTFIT_PRESETS } from '@/components/inpaint/useInpaintOutfitPresets'
import { catalogWardrobe, prepareCatalogWardrobe } from '@/utils/catalogWardrobe'
import { wardrobeProse, wardrobeTokens } from '@/utils/wardrobeContent'
import type { StudioAssetVersion, StudioProjectSnapshot } from '@/storage/studioProjectRepository'
import { compileH3Tags, type KeyframeTag } from './h3TagCompiler'
import {
  canvasSupported, defaultForm, type KeyframeDraft, type KeyframeGuideDraft, type GuideMode, type WorkbenchForm,
} from './keyframeDraft'
import { clothingParts, expressionTags, framingTags, poseTags, settingTags } from './keyframePresets'
import { projectAssetIndex, referenceIssue, versionLabel } from './projectAssets'

const startingOutfits = ['sailor_uniform', 'evening_dress', 'casual_trench', 'yukata_floral']
const commonOutfits = [
  ...startingOutfits.flatMap(id => OUTFIT_PRESETS.filter(preset => preset.id === id)),
  ...OUTFIT_PRESETS.filter(preset => !startingOutfits.includes(preset.id)),
].map(preset => ({ id: preset.id, label: preset.label, directive: wardrobeProse(preset.prompt) }))
const universal: readonly KeyframeTag[] = [
  ...commonOutfits,
  ...UNIVERSAL_WARDROBE_PRESETS.map(preset => ({
    id: `universal/${preset.id}`, label: preset.label, directive: wardrobeProse('', wardrobeTokens(preset.tags)),
  })),
]
const scenePrefix = 'scene/'
const presetPrefix = 'preset/'
const originOf = (version?: StudioAssetVersion) => version?.source.kind === 'generation' ? version.source.keyframe : undefined
const withChoices = (tags: readonly KeyframeTag[], ids: readonly string[]) =>
  ids.flatMap(id => tags.find(tag => tag.id === id) ?? [])
const lookKinds = new Set(['outfit', 'expression', 'pose'])

export function useGuidedKeyframes(
  data: () => StudioProjectSnapshot, draft: Ref<KeyframeDraft>, model: Readonly<Ref<KeyframeModel | undefined>>,
  locked: Readonly<Ref<boolean>>, visited: Readonly<Ref<boolean>>,
) {
  const sceneStore = useSceneStore()
  const guide = computed(() => draft.value.guide)
  const assets = computed(() => projectAssetIndex(data()).assets)
  const versions = computed(() => projectAssetIndex(data()).versions)
  const imageVersions = computed(() => data().versions.filter(version => !referenceIssue(version)))
  const kindOf = (version: StudioAssetVersion) => assets.value.get(version.assetId)?.kind
  const rawCharacter = (version: StudioAssetVersion) => kindOf(version) === 'character' && !originOf(version)?.neutralAnchor
  const optionFor = (version: StudioAssetVersion) => ({ value: version.id, label: versionLabel(data(), version.id) })
  const characters = computed(() => imageVersions.value.filter(rawCharacter).map(optionFor))
  const character = computed(() => {
    const original = versions.value.get(guide.value.characterVersionId)
    return original && rawCharacter(original) && !referenceIssue(original) ? original : undefined
  })
  const catalogId = computed(() => {
    const source = character.value?.source
    return source?.kind === 'catalog' && source.catalogKind === 'character' ? source.catalogId : ''
  })
  const wardrobeLoading = ref(false)
  const wardrobeError = ref('')
  async function loadWardrobe() {
    if (wardrobeLoading.value) return
    wardrobeLoading.value = true
    wardrobeError.value = ''
    try {
      await sceneStore.loadCharacterShell()
      if (sceneStore.metaFailedFiles.has('characters.json') || sceneStore.metaFailedFiles.has('popular-characters.json'))
        wardrobeError.value = '角色衣柜暂时没有读到。'
    } catch {
      wardrobeError.value = '角色衣柜暂时没有读到。'
    } finally {
      wardrobeLoading.value = false
    }
  }
  watch(() => visited.value ? catalogId.value : '', id => { if (id) void loadWardrobe() }, { immediate: true })
  const characterOutfits = computed<KeyframeTag[]>(() => {
    if (!catalogId.value) return []
    return catalogWardrobe(sceneStore.characters, sceneStore.popularCharacters, catalogId.value).flatMap((recipe) => {
      const { tokens, prose } = prepareCatalogWardrobe(recipe, recipe.id.startsWith('studio/'))
      const directive = wardrobeProse(prose, tokens)
      return directive ? [{ id: recipe.id, label: recipe.name, directive }] : []
    })
  })
  const anchor = computed(() => imageVersions.value.find((version) => {
    const origin = originOf(version)
    return kindOf(version) === 'character' && origin?.neutralAnchor && origin.characterVersionId === character.value?.id
  }))
  const lookVersions = computed(() => imageVersions.value.filter((version) => {
    const origin = originOf(version)
    return lookKinds.has(kindOf(version) ?? '') && (!origin || origin.characterVersionId === character.value?.id)
  }))
  const look = computed(() => lookVersions.value.find(version => version.id === guide.value.lookVersionId))
  const looks = computed(() => [{ value: '', label: '角色原造型' }, ...lookVersions.value.map(optionFor)])
  const sceneGroups = computed(() => {
    const images = imageVersions.value.filter(version => kindOf(version) === 'scene').map(version => ({
      ...optionFor(version), value: scenePrefix + version.id,
    }))
    return [
      ...(images.length ? [{ label: '项目空镜', options: images }] : []),
      { label: '场景预设', options: settingTags.map(tag => ({ value: presetPrefix + tag.id, label: tag.label })) },
    ]
  })
  const scene = computed(() => {
    const selection = guide.value.scene
    if (!selection.startsWith(scenePrefix)) return undefined
    const version = versions.value.get(selection.slice(scenePrefix.length))
    return version && kindOf(version) === 'scene' && !referenceIssue(version) ? version : undefined
  })
  const setting = computed(() => settingTags.find(tag => presetPrefix + tag.id === guide.value.scene))
  const faceOptions = computed(() => [
    { value: '', label: '自动找同角色特写' },
    { value: 'none', label: '不附带特写' },
    ...imageVersions.value.filter(version =>
      (kindOf(version) === 'character' || kindOf(version) === 'expression') &&
      version.id !== character.value?.id && version.id !== anchor.value?.id &&
      version.sha256 !== look.value?.sha256 &&
      (version.source.kind !== 'catalog' || version.source.catalogId === catalogId.value) &&
      (!originOf(version) || originOf(version)?.characterVersionId === character.value?.id)
    ).map(optionFor),
  ])
  const garmentOptions = computed(() => [
    { value: '', label: '只用点选标签' },
    ...imageVersions.value.filter(version => version.sha256 !== character.value?.sha256 &&
      version.sha256 !== anchor.value?.sha256 && (kindOf(version) === 'outfit' || kindOf(version) === 'keyframe')).map(optionFor),
  ])
  const differences = computed(() => guide.value.difference === 'expression' ? expressionTags : poseTags)

  function sceneFace(subjectId: string) {
    const choice = guide.value.faceVersionId
    if (choice) return choice !== 'none' && faceOptions.value.some(option => option.value === choice) ? choice : ''
    const subject = versions.value.get(subjectId)
    if (subject && kindOf(subject) === 'expression') return ''
    return imageVersions.value.find(version =>
      kindOf(version) === 'expression' && version.sha256 !== subject?.sha256 &&
      originOf(version)?.characterVersionId === character.value?.id
    )?.id ?? ''
  }

  function formFor(kind: WorkbenchForm['kind'], subjectVersionId: string): WorkbenchForm {
    const activeModel = model.value
    const base = defaultForm(activeModel?.id)
    const desired = kind === 'keyframe' ? 'landscapeHd' : 'portraitHd'
    const fallback = kind === 'keyframe' ? 'landscape' : 'portrait'
    const canvases: WorkbenchForm['canvas'][] = [desired, fallback, 'square', 'squareHd']
    base.canvas = activeModel ? canvases.find(canvas => canvasSupported(activeModel, canvas)) ?? desired : desired
    const options = guide.value
    const garmentVersionId = garmentOptions.value.some(option => option.value === options.garmentVersionId) ? options.garmentVersionId : ''
    const title = kind === 'character' ? `${assets.value.get(character.value!.assetId)?.title ?? '角色'} · 干净立绘` : ''
    let choices: KeyframeTag[] = []
    let editPartsOnly = false
    if (kind === 'outfit') {
      const picked = withChoices([...characterOutfits.value, ...universal], options.outfitIds)
      const parts = withChoices(clothingParts, options.partIds)
      const mix = parts.map(tag => tag.directive).join(', ')
      choices = picked.map(tag => ({
        ...tag,
        directive: `Outfit: ${tag.directive.replace(/[.!?]+$/, '')}.${mix ? ` Adjust these pieces: ${mix}.` : ''}`,
      }))
      if (!choices.length && mix) {
        editPartsOnly = true
        choices = [{ id: 'parts', label: '自选搭配', directive: `Outfit pieces to change: ${mix}.` }]
      }
    } else if (kind === 'expression' || kind === 'pose') {
      choices = withChoices(differences.value, options.differenceIds)
    } else if (kind === 'keyframe') {
      choices = withChoices(framingTags, options.framingIds)
    }
    return {
      ...base, kind, title,
      ...compileH3Tags({
        kind, subjectVersionId, choices,
        faceVersionId: kind === 'keyframe' ? sceneFace(subjectVersionId) : '',
        garmentVersionId: kind === 'outfit' ? garmentVersionId : '', editPartsOnly,
        sceneVersionId: scene.value?.id, setting: setting.value?.directive,
      }),
      keyframe: {
        characterVersionId: character.value!.id,
        ...(kind === 'character' ? { neutralAnchor: true } : {}),
        ...(kind === 'keyframe' && scene.value ? { sceneVersionId: scene.value.id } : {}),
      },
    }
  }
  const plan = computed(() => {
    if (!character.value) return undefined
    const { mode, difference } = guide.value
    const kind = mode === 'scene' ? 'keyframe' : mode === 'difference' ? difference : mode === 'neutral' ? 'character' : 'outfit'
    const subject = (kind === 'outfit' || kind === 'character' ? undefined : look.value)
      ?? (kind === 'character' ? undefined : anchor.value)
    const form = formFor(kind, subject?.id ?? character.value.id)
    const prepare = !subject && kind !== 'character' ? formFor('character', character.value.id) : undefined
    return { form, prepare }
  })
  const issue = computed(() => {
    if (!plan.value) return '请先选一张角色立绘。'
    const { form } = plan.value
    if (form.kind === 'outfit' && !form.variations && form.references.length < 2) return '选一至四套衣装，或搭配服装部件。'
    if ((form.kind === 'expression' || form.kind === 'pose') && !form.variations) return '选一至四个变化。'
    if (form.kind === 'keyframe' && !scene.value && !setting.value) return '请选择一个场景。'
    if (form.kind === 'keyframe' && !form.variations) return '请至少选一种构图。'
    if (form.kind === 'character' && anchor.value) return '这张角色立绘已经整理好了。'
    if (model.value && (!canvasSupported(model.value, form.canvas) || form.references.length > model.value.maxReferences))
      return '本地模型暂不支持这组参考图或画幅。'
    return ''
  })
  function update(patch: Partial<KeyframeGuideDraft>) {
    if (locked.value) return
    const current = draft.value.form
    const previous = plan.value?.form
    const mirrored = !!previous && current.kind === previous.kind && current.prompt === previous.prompt
      && current.variations === previous.variations && sameReferences(current, previous)
    const old = guide.value
    const changingCharacter = patch.characterVersionId !== undefined && old.characterVersionId !== patch.characterVersionId
    draft.value.guide = {
      ...old,
      ...(changingCharacter ? { lookVersionId: old.characterVersionId ? '' : old.lookVersionId, faceVersionId: '', garmentVersionId: '', outfitIds: [] } : {}),
      ...patch,
    }
    const preview = plan.value?.form
    if (preview && (!issue.value || mirrored)) {
      const { prompt, variations, references, kind, count, title, canvas } = preview
      draft.value.form = { ...current, title, prompt, variations, references, kind, count, canvas }
    } else if (!preview && mirrored) {
      draft.value.form = { ...defaultForm(current.modelId), seedText: current.seedText, steps: current.steps }
    }
  }
  function sameReferences(form: WorkbenchForm, preview: WorkbenchForm) {
    return form.references.length === preview.references.length && form.references.every((id, index) => id === preview.references[index])
  }
  function advancedPlan() {
    const form = draft.value.form
    const current = plan.value
    if (!current || current.form.kind !== form.kind || !sameReferences(form, current.form)
      || (form.kind === 'character' && anchor.value)) return { form }
    return { form: { ...form, keyframe: current.form.keyframe }, prepare: current.prepare }
  }
  function useLook(id: string, mode?: GuideMode) {
    const version = versions.value.get(id)
    if (!version || !lookKinds.has(kindOf(version) ?? '') || referenceIssue(version)) return
    const characterVersionId = originOf(version)?.characterVersionId
    update({
      lookVersionId: id,
      ...(characterVersionId ? { characterVersionId } : {}),
      ...(mode ? { mode } : {}),
      ...(mode === 'difference' ? { difference: 'expression', differenceIds: [] } : {}),
    })
  }
  return {
    guide, characters, character, anchor, looks, look, sceneGroups, faceOptions, garmentOptions, differences,
    universal, characterOutfits, wardrobeLoading, wardrobeError, loadWardrobe, plan, issue, update, useLook, advancedPlan,
  }
}
