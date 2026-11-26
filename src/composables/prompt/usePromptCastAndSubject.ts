import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { StoryOrigin } from '@/types/storyOrigin'
import type { Scene } from '@/types/scene'
import type { CharKey, Selections } from '@/types/promptHistory'
import type { DirectorControlSources } from '@/types/promptDirector'
import type { CastFormation, CastMember } from '@/types/prompt'
import type { DraftOutfitOverride, DraftReferenceInput } from '@/utils/promptBuilderPersistence'
import type { PopularCharacter, SceneBlueprint } from '@/utils/popularContent'
import { defaultOutfit, type DrawSubject } from '@/utils/popularContent'
import { sceneDirectorSources } from '@/utils/promptDirector'
import { normalizeKey, sceneSupportsCharacter } from '@/utils/promptPolicy'
import { castMemberKey, isCustomCastOutfit, parseCastMember, parseLeadPosition } from '@/utils/promptCast'
import { sanitizeOutfitOverride } from '@/utils/wardrobeContent'
import type { useSceneStore } from '@/stores/sceneStore'

export function usePromptCastAndSubject(params: {
  char: Ref<CharKey>
  subject: Ref<DrawSubject>
  isPopular: ComputedRef<boolean>
  isUnbound: ComputedRef<boolean>
  storyOrigin: Ref<StoryOrigin | undefined>
  story: Ref<string>
  sceneId: Ref<string | null>
  sceneBaseStory: Ref<string>
  selections: Selections
  colorMood: Ref<string | null>
  directorSources: Ref<DirectorControlSources>
  outfitOverride: Ref<DraftOutfitOverride | null>
  referenceInput: Ref<DraftReferenceInput | null>
  coStars: Ref<CastMember[]>
  castFormation: Ref<CastFormation | undefined>
  castInteraction: Ref<string>
  leadCast: Ref<CastMember | null>
  leadPosition: Ref<number>
  artistStyleIds: Ref<string[]>
  manualTags: Ref<Set<string>>
  popularCharacters: ComputedRef<PopularCharacter[]>
  sceneBlueprints: ComputedRef<SceneBlueprint[]>
  activeScene: ComputedRef<Scene | null>
  sceneStore: ReturnType<typeof useSceneStore>
  loadPopularCatalog: () => Promise<unknown>
  clearRandomVariation: () => void
  clearReferenceInput: () => void
  clearInheritedDirectorValues: () => void
}) {
  const {
    char, subject, isPopular, isUnbound, storyOrigin, story, sceneId, sceneBaseStory,
    selections, colorMood, directorSources, outfitOverride, referenceInput,
    coStars, castFormation, castInteraction, leadCast, leadPosition, artistStyleIds, manualTags,
    popularCharacters, sceneBlueprints, activeScene, sceneStore, loadPopularCatalog,
    clearRandomVariation, clearReferenceInput, clearInheritedDirectorValues,
  } = params

  const popularBlueprintCharacter = computed(() => subject.value.kind === 'popular' ? subject.value.characterId : '')
  const popularBlueprintReady = computed(() => !popularBlueprintCharacter.value || sceneStore.hasBlueprintCharacter(popularBlueprintCharacter.value))
  const popularBlueprintLoading = ref(false)
  const popularBlueprintError = ref('')
  let popularBlueprintRequest = 0

  async function loadPopularCharacter(id: string) {
    if (!id) return
    const request = id === popularBlueprintCharacter.value ? ++popularBlueprintRequest : -1
    const current = () => request === popularBlueprintRequest && id === popularBlueprintCharacter.value
    if (current()) {
      popularBlueprintLoading.value = !sceneStore.hasBlueprintCharacter(id)
      popularBlueprintError.value = ''
    }
    try {
      // SceneStore deduplicates reads and owns the catalog epoch/cache; other
      // consumers may still need a character after this workspace switches away.
      await Promise.all([loadPopularCatalog(), sceneStore.loadBlueprintCharacter(id)])
    } catch (error) {
      if (current()) popularBlueprintError.value = error instanceof Error ? error.message : '当前角色场景建议读取失败，请重新读取。'
      throw error
    } finally { if (current()) popularBlueprintLoading.value = false }
  }

  watch([popularBlueprintCharacter, popularBlueprintReady, () => sceneStore.version, isUnbound], ([id, ready, , unbound]) => {
    popularBlueprintRequest++
    popularBlueprintLoading.value = false; popularBlueprintError.value = ''
    if (id && !ready) void loadPopularCharacter(id).catch(() => {})
    else if (id || unbound) void loadPopularCatalog().catch(() => {})
    // The default pre-flush waits for invalidate() to clear its old request map.
  }, { immediate: true })
  onScopeDispose(() => { popularBlueprintRequest++ })

  const castLead = computed<CastMember | null>(() => {
    const current = subject.value
    const lead = leadCast.value
    if (current.kind === 'studio' && char.value === 'none' && lead?.source === 'custom') return lead
    if (lead?.source === current.kind && lead.characterId === (current.kind === 'popular' ? current.characterId : char.value)) return lead
    return parseCastMember(current.kind === 'popular'
      ? { ...current, source: 'popular' }
      : { source: 'studio', characterId: char.value, outfitId: '' })
  })

  const cast = computed<CastMember[]>(() => {
    if (!castLead.value) return []
    const primary = castLead.value
    const companions = coStars.value.filter(member => castMemberKey(member) !== castMemberKey(primary)).slice(0, 4)
    companions.splice(parseLeadPosition(leadPosition.value, companions.length), 0, primary)
    return companions
  })
  // Resolve after a synchronous subject change has set both its kind and character.
  watch([() => castLead.value && castMemberKey(castLead.value), coStars], ([lead]) => {
    if (!lead || !coStars.value.some(member => castMemberKey(member) === lead)) return
    coStars.value = coStars.value.filter(member => castMemberKey(member) !== lead)
    leadPosition.value = Math.min(leadPosition.value, coStars.value.length)
  }, { immediate: true })

  const castRequiresNoLora = computed(() => cast.value.length > 1 || castLead.value?.source === 'custom'
    || (castLead.value && isCustomCastOutfit(castLead.value.outfitId)) === true)

  function clearInheritedStory(nextBlueprintId: string | null = null) {
    const current = subject.value
    if (current.kind === 'popular' && current.blueprintId === nextBlueprintId) return
    const inherited = current.kind === 'popular'
      ? sceneBlueprints.value.find(scene => scene.id === current.blueprintId)?.description
      : sceneBaseStory.value
    if (story.value === inherited) story.value = ''
  }

  function setChar(c: CharKey) {
    if (!isPopular.value && char.value !== c) {
      leadCast.value = null
    }
    if (!isPopular.value && char.value !== c) outfitOverride.value = null
    if (storyOrigin.value && !isPopular.value) storyOrigin.value = ['nene', 'natsume'].includes(c) ? { ...storyOrigin.value, characterId: c, outfitId: undefined } : undefined
    const scene = activeScene.value
    if (!isPopular.value && scene && !sceneSupportsCharacter(scene, c)) {
      clearInheritedStory()
      sceneId.value = null; sceneBaseStory.value = ''
      clearInheritedDirectorValues()
    }
    char.value = c
  }

  function setStudioSubject() {
    if (subject.value.kind === 'studio') return
    storyOrigin.value = undefined
    clearInheritedStory()
    subject.value = { kind: 'studio' }
    leadCast.value = null
    outfitOverride.value = null
  }

  function setUnboundSubject() {
    storyOrigin.value = undefined
    clearInheritedStory()
    clearRandomVariation()
    const override = sanitizeOutfitOverride(outfitOverride.value)
    const suppressed = new Set((override?.suppressedTags || []).map(normalizeKey))
    manualTags.value = new Set([...manualTags.value].filter(tag => !suppressed.has(normalizeKey(tag))))
    for (const token of override?.tokens ?? []) manualTags.value.add(token)
    subject.value = { kind: 'studio' }
    char.value = 'none'
    coStars.value = []; leadCast.value = null; leadPosition.value = 0; castFormation.value = undefined
    castInteraction.value = ''
    sceneId.value = null; sceneBaseStory.value = ''
    outfitOverride.value = null
    selections.emotion = []; selections.shot = null; selections.lighting = null; selections.composition = null
    colorMood.value = null; artistStyleIds.value = []
    directorSources.value = sceneDirectorSources()
  }

  function setPopularSubject(characterId: string, outfitId: string, blueprintId: string | null = null,
    options: { preserveReference?: boolean; preserveOutfitOverride?: boolean; outfitExplicit?: boolean } = {}) {
    const prior = subject.value
    if (prior.kind !== 'popular' || prior.characterId !== characterId) leadCast.value = null
    else if (leadCast.value?.source === 'popular') {
      leadCast.value = { ...leadCast.value, outfitId, outfitExplicit: options.outfitExplicit, outfitPrompt: undefined }
    }
    clearInheritedStory(blueprintId)
    if (storyOrigin.value) storyOrigin.value = blueprintId ? undefined : { ...storyOrigin.value, characterId, outfitId, outfitProse: undefined }
    subject.value = { kind: 'popular', characterId, outfitId, blueprintId, outfitExplicit: options.outfitExplicit }
    if (!options.preserveReference && (blueprintId || referenceInput.value?.subjectMode !== 'free')) clearReferenceInput()
    if (!options.preserveOutfitOverride) outfitOverride.value = null
  }

  function addCoStar(member: CastMember) {
    const parsed = parseCastMember(member)
    const lead = castLead.value
    if (!parsed || cast.value.length >= 5 || cast.value.some(current => castMemberKey(current) === castMemberKey(parsed))) return
    if (lead) applyCastOrder([...cast.value, parsed], lead)
    else if (parsed.source === 'custom' && isUnbound.value) applyCastOrder([parsed], parsed)
  }

  function applyCastOrder(members: CastMember[], primary: CastMember) {
    const previous = castLead.value
    if (previous && castMemberKey(previous) !== castMemberKey(primary)) {
      storyOrigin.value = undefined
      outfitOverride.value = null
      const oldSubject = subject.value
      if (primary.source !== oldSubject.kind
        || activeScene.value && !sceneSupportsCharacter(activeScene.value, primary.characterId)
        || oldSubject.kind === 'popular' && oldSubject.blueprintId) {
        clearInheritedStory()
        sceneId.value = null; sceneBaseStory.value = ''
        clearInheritedDirectorValues()
      }
    }
    if (primary.source === 'popular') {
      const current = subject.value
      const character = popularCharacters.value.find(item => item.id === primary.characterId)
      const outfitId = primary.outfitId && !isCustomCastOutfit(primary.outfitId) ? primary.outfitId : character ? defaultOutfit(character).id : ''
      if (current.kind !== 'popular' || current.characterId !== primary.characterId
        || current.outfitId !== outfitId || current.outfitExplicit !== primary.outfitExplicit) subject.value = {
        kind: 'popular', characterId: primary.characterId,
        outfitId,
        outfitExplicit: primary.outfitExplicit,
        blueprintId: current.kind === 'popular' && current.characterId === primary.characterId ? current.blueprintId : null,
      }
    } else {
      if (subject.value.kind !== 'studio') subject.value = { kind: 'studio' }
      char.value = primary.source === 'custom' ? 'none' : primary.characterId as 'nene' | 'natsume'
    }
    leadCast.value = { ...primary }
    const primaryIndex = members.findIndex(member => castMemberKey(member) === castMemberKey(primary))
    leadPosition.value = Math.max(0, primaryIndex)
    coStars.value = members.filter(member => castMemberKey(member) !== castMemberKey(primary))
  }

  function updateCastMember(index: number, patch: Partial<Omit<CastMember, 'source' | 'characterId'>>) {
    const member = cast.value[index]
    const lead = castLead.value
    if (!member || !lead) return
    // Keep the space at the end while the user is typing a multi-word action.
    const updated = { ...member, ...patch, action: patch.action?.replace(/[\r\n]+/g, ' ').slice(0, 600) ?? member.action }
    const isLead = castMemberKey(member) === castMemberKey(lead)
    if (isLead && patch.outfitId !== undefined) outfitOverride.value = null
    applyCastOrder(cast.value.map((current, slot) => slot === index ? updated : current), isLead ? updated : lead)
  }

  function moveCastMember(from: number, to: number) {
    const members = [...cast.value]
    if (!castLead.value || !members[from] || !members[to] || from === to) return
    const moving = members[from]
    members[from] = members[to]
    members[to] = moving
    applyCastOrder(members, castLead.value)
  }

  function selectCastLead(index: number) {
    const member = cast.value[index]
    if (member && castLead.value && castMemberKey(member) !== castMemberKey(castLead.value)) applyCastOrder(cast.value, member)
  }

  function removeCastMember(index: number) {
    const members = cast.value
    const lead = castLead.value
    if (!lead || !members[index]) return
    if (members.length === 1) {
      if (lead.source === 'custom') {
        leadCast.value = null
        leadPosition.value = 0
      }
      return
    }
    const next = members.filter((_, slot) => slot !== index)
    applyCastOrder(next, castMemberKey(members[index]) === castMemberKey(lead) ? next[0] : lead)
  }

  function setPopularBlueprint(blueprintId: string | null) {
    if (blueprintId) storyOrigin.value = undefined
    clearRandomVariation()
    if (subject.value.kind !== 'popular') return
    clearInheritedStory(blueprintId)
    subject.value = { ...subject.value, blueprintId }
  }

  return {
    popularBlueprintReady,
    popularBlueprintLoading,
    popularBlueprintError,
    loadPopularCharacter,
    castLead,
    castRequiresNoLora,
    cast,
    setChar,
    setStudioSubject,
    setUnboundSubject,
    setPopularSubject,
    setPopularBlueprint,
    addCoStar,
    updateCastMember,
    moveCastMember,
    selectCastLead,
    removeCastMember,
  }
}
