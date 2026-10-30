import { computed, ref, watch, type Ref } from 'vue'
import { MarkerType, type Edge, type Node } from '@vue-flow/core'
import type { CharacterProfile } from '@/types/character'
import type { CharacterRelation, RelationPerson } from '@/types/characterRelations'
import { relationProfile } from '@/utils/characterRelations'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

export function useCharacterRelations(profiles: Ref<CharacterProfile[]>, characterId: Ref<string>) {
  const graph = computed(() => profiles.value.map(profile => profile.relationshipGraph).find(graph =>
    graph?.people.some(person => relationProfile(person, graph.work, profiles.value)?.id === characterId.value)) ?? null)
  const invalid = computed(() => profiles.value.find(profile => profile.id === characterId.value)?.relationshipGraph === null)
  const profileFor = (person: RelationPerson) => relationProfile(person, graph.value?.work || '', profiles.value)
  const personForProfile = computed(() => graph.value?.people.find(person => profileFor(person)?.id === characterId.value)?.id || '')
  const centerId = ref(''), selectedPersonId = ref(''), selectedRelationId = ref('')
  const selectedPair = ref<{ source: string; target: string; relationIds: string[] } | null>(null)
  const hoveredPersonId = ref(''), hoveredRelationId = ref('')
  const scope = ref<'nearby' | 'work'>('nearby'), showSpoilers = ref(false), pendingOnly = ref(false)
  const personQuery = ref('')

  watch([characterId, personForProfile], () => {
    centerId.value = personForProfile.value; selectedPersonId.value = ''; selectedRelationId.value = ''
    selectedPair.value = null
    hoveredPersonId.value = ''; hoveredRelationId.value = ''
    scope.value = 'nearby'; showSpoilers.value = false; pendingOnly.value = false
    personQuery.value = ''
  }, { immediate: true })

  const safeRelations = computed(() => graph.value?.relations.filter(relation => showSpoilers.value || !relation.spoiler) || [])
  const safePeople = computed(() => graph.value?.people.filter(person => person.id === personForProfile.value
    || safeRelations.value.some(relation => relation.source === person.id || relation.target === person.id)) || [])
  const pendingPeople = computed(() => safePeople.value.filter(person => !profileFor(person)))
  const matchingPeople = computed(() => {
    const query = personQuery.value.trim().toLocaleLowerCase()
    return query ? safePeople.value.filter(person => [person.name, ...person.aliases]
      .some(name => name.toLocaleLowerCase().includes(query))) : []
  })
  const visibleRelations = computed(() => safeRelations.value.filter(relation => {
    if (scope.value === 'nearby' && relation.source !== centerId.value && relation.target !== centerId.value) return false
    if (!pendingOnly.value) return true
    return [relation.source, relation.target].some(id => {
      const person = safePeople.value.find(person => person.id === id)
      return person && !profileFor(person)
    })
  }))
  const visiblePeople = computed(() => safePeople.value.filter(person => person.id === centerId.value
    || visibleRelations.value.some(relation => relation.source === person.id || relation.target === person.id)
    || (scope.value === 'work' && !pendingOnly.value)))
  function isSelectedPair(relation: CharacterRelation) {
    return !!selectedPair.value?.relationIds.includes(relation.id)
  }

  watch(visiblePeople, people => {
    if (selectedPersonId.value && !people.some(person => person.id === selectedPersonId.value)) selectedPersonId.value = ''
    if (!people.some(person => person.id === centerId.value)) centerId.value = personForProfile.value
  })
  watch(visibleRelations, relations => {
    if (!relations.some(relation => relation.id === selectedRelationId.value)) selectedRelationId.value = ''
    if (selectedPair.value && !relations.some(isSelectedPair)) selectedPair.value = null
  })

  const selectedPerson = computed(() => safePeople.value.find(person => person.id === selectedPersonId.value))
  const selectedProfile = computed(() => selectedPerson.value && profileFor(selectedPerson.value))
  const selectedRelation = computed(() => visibleRelations.value.find(relation => relation.id === selectedRelationId.value))
  const pairRelations = computed(() => selectedPair.value ? visibleRelations.value.filter(isSelectedPair) : [])
  const selectedConnections = computed(() => safeRelations.value.filter(relation => relation.source === selectedPersonId.value || relation.target === selectedPersonId.value))
  const centerPerson = computed(() => safePeople.value.find(person => person.id === centerId.value))

  const listedRelations = computed(() => selectedPair.value ? pairRelations.value : selectedRelation.value || !selectedPerson.value ? visibleRelations.value
    : visibleRelations.value.filter(relation => relation.source === selectedPersonId.value || relation.target === selectedPersonId.value))

  function selectPerson(id: string) { selectedPair.value = null; selectedPersonId.value = id; selectedRelationId.value = ''; hoveredRelationId.value = '' }
  function selectPair(source: string, target: string, relationIds: string[]) {
    selectedPair.value = { source, target, relationIds: [...relationIds] }; selectedRelationId.value = ''; hoveredPersonId.value = ''
  }
  function selectRelation(id: string) {
    if (!pairRelations.value.some(relation => relation.id === id)) selectedPair.value = null
    selectedRelationId.value = id; hoveredPersonId.value = ''
  }
  function clearSelection() { selectedPair.value = null; selectedPersonId.value = ''; selectedRelationId.value = ''; hoveredPersonId.value = ''; hoveredRelationId.value = '' }
  function setHoveredPerson(id: string) { hoveredPersonId.value = id }
  function setHoveredRelation(id: string) { hoveredRelationId.value = id }
  function expandPerson(id: string) { centerId.value = id; selectPerson(id); scope.value = 'nearby' }
  function reset() {
    centerId.value = personForProfile.value; clearSelection()
    scope.value = 'nearby'; pendingOnly.value = false; personQuery.value = ''
  }
  function locatePerson(id: string) { pendingOnly.value = false; expandPerson(id); personQuery.value = '' }
  // Contextual focus & dimming logic
  const activePersonId = computed(() => hoveredPersonId.value || selectedPersonId.value)
  const isAnyActive = computed(() => Boolean(hoveredPersonId.value || hoveredRelationId.value || selectedPersonId.value || selectedRelationId.value || selectedPair.value))

  const highlightedPersonIds = computed(() => {
    if (hoveredRelationId.value) {
      const rel = visibleRelations.value.find(r => r.id === hoveredRelationId.value)
      return rel ? new Set([rel.source, rel.target]) : new Set<string>()
    }
    if (selectedRelationId.value && !hoveredPersonId.value) {
      const rel = visibleRelations.value.find(r => r.id === selectedRelationId.value)
      if (rel) return new Set([rel.source, rel.target])
    }
    if (selectedPair.value && !hoveredPersonId.value) return new Set([selectedPair.value.source, selectedPair.value.target])
    if (!activePersonId.value) return new Set<string>()
    const set = new Set<string>([activePersonId.value])
    for (const rel of visibleRelations.value) {
      if (rel.source === activePersonId.value) set.add(rel.target)
      else if (rel.target === activePersonId.value) set.add(rel.source)
    }
    return set
  })

  const highlightedRelationIds = computed(() => {
    if (hoveredRelationId.value) return new Set<string>([hoveredRelationId.value])
    if (selectedRelationId.value && !hoveredPersonId.value) return new Set<string>([selectedRelationId.value])
    if (selectedPair.value && !hoveredPersonId.value) return new Set(pairRelations.value.map(relation => relation.id))
    if (!activePersonId.value) return new Set<string>()
    const set = new Set<string>()
    for (const rel of visibleRelations.value) {
      if (rel.source === activePersonId.value || rel.target === activePersonId.value) {
        set.add(rel.id)
      }
    }
    return set
  })

  const nodes = computed<Node[]>(() => {
    const hasHighlightContext = isAnyActive.value
    const highlightedPeople = highlightedPersonIds.value

    return visiblePeople.value.map(person => {
      const profile = profileFor(person)
      const isSelected = person.id === selectedPersonId.value
      const isCenter = person.id === centerId.value
      const isHighlighted = highlightedPeople.has(person.id)
      const isDimmed = hasHighlightContext && !isHighlighted

      return {
        id: person.id,
        type: 'person',
        position: { x: 0, y: 0 },
        draggable: false,
        connectable: false,
        deletable: false,
        focusable: false,
        selectable: true,
        data: {
          person,
          profile,
          selected: isSelected,
          center: isCenter,
          isDimmed,
          isHighlighted,
          image: profile ? resolveRuntimeUrl(profile.type === 'popular' ? popularPortraitSrc(profile.id) : profile.portrait?.image) : '',
        },
      }
    })
  })

  const edges = computed<Edge[]>(() => {
    const hasHighlightContext = isAnyActive.value
    const highlightedRels = highlightedRelationIds.value

    return visibleRelations.value.map((relation): Edge => {
      const source = nodes.value.find(node => node.id === relation.source)!
      const target = nodes.value.find(node => node.id === relation.target)!
      const isHighlighted = highlightedRels.has(relation.id)
      const isDimmed = hasHighlightContext && !isHighlighted

      return {
        id: relation.id,
        source: relation.source,
        target: relation.target,
        label: relation.label,
        focusable: true,
        deletable: false,
        updatable: false,
        ariaLabel: `${source.data.person.name}${relation.directed ? '对' : '与'}${target.data.person.name}：${relation.label}`,
        markerEnd: relation.directed ? {
          type: MarkerType.ArrowClosed,
          color: isHighlighted ? 'var(--accent)' : 'var(--text-secondary)',
          width: 16,
          height: 16,
        } : undefined,
        class: {
          'relation-edge-active': isHighlighted,
          'relation-edge-hovered': relation.id === hoveredRelationId.value,
          'relation-edge-selected': relation.id === selectedRelationId.value,
          'relation-edge-person-selected': Boolean(selectedPersonId.value && (relation.source === selectedPersonId.value || relation.target === selectedPersonId.value)),
          'relation-edge-dimmed': isDimmed,
        },
        labelStyle: {
          fill: 'var(--text-primary)',
          fontSize: '12px',
          fontWeight: isHighlighted ? 600 : 500,
        },
        labelBgStyle: {
          fill: 'var(--bg-surface)',
          stroke: isHighlighted ? 'var(--accent)' : 'var(--border-strong)',
          strokeWidth: isHighlighted ? 1.5 : 1,
        },
        labelBgPadding: [8, 4],
        labelBgBorderRadius: 6,
        interactionWidth: 24,
      }
    })
  })

  return {
    safePeople, safeRelations,
    graph, invalid, scope, showSpoilers, pendingOnly, pendingPeople, visiblePeople, visibleRelations, centerPerson,
    personQuery, matchingPeople, listedRelations, locatePerson, clearSelection,
    selectedPerson, selectedProfile, selectedRelation, selectedPair, selectedConnections, nodes, edges, profileFor,
    selectPerson, selectPair, selectRelation, setHoveredPerson, setHoveredRelation, isAnyActive, expandPerson, reset,
  }
}
