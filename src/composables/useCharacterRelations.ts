import { computed, ref, watch, type Ref } from 'vue'
import { MarkerType, type Edge, type Node } from '@vue-flow/core'
import type { CharacterProfile } from '@/types/character'
import type { CharacterRelation, RelationPerson } from '@/types/characterRelations'
import { relationProfile } from '@/utils/characterRelations'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

/**
 * Greedy circular ordering of people based on shared connection graph.
 * Minimizes crossed lines across the central canvas by placing connected characters
 * in adjacent angular slots along the radial perimeter.
 */
function orderPeopleByConnections(people: RelationPerson[], relations: CharacterRelation[], centerId: string): RelationPerson[] {
  if (people.length <= 2) return [...people]
  const adj = new Map<string, Set<string>>()
  for (const person of people) adj.set(person.id, new Set())
  for (const rel of relations) {
    adj.get(rel.source)?.add(rel.target)
    adj.get(rel.target)?.add(rel.source)
  }

  const remaining = new Set(people.map(p => p.id))
  const ordered: RelationPerson[] = []

  // Start with the character possessing highest connection density
  let currentId = people[0].id
  let maxDegree = -1
  for (const person of people) {
    const deg = (adj.get(person.id)?.size || 0)
    if (deg > maxDegree) {
      maxDegree = deg
      currentId = person.id
    }
  }

  while (remaining.size > 0) {
    const person = people.find(p => p.id === currentId)!
    ordered.push(person)
    remaining.delete(currentId)
    if (remaining.size === 0) break

    let nextId = ''
    let bestScore = -1
    for (const candId of remaining) {
      let score = 0
      if (adj.get(currentId)?.has(candId)) score += 3
      if (relations.some(r => (r.source === centerId && r.target === candId) || (r.target === centerId && r.source === candId))) {
        score += 1
      }
      if (score > bestScore) {
        bestScore = score
        nextId = candId
      }
    }
    currentId = nextId || remaining.values().next().value!
  }
  return ordered
}

export function useCharacterRelations(profiles: Ref<CharacterProfile[]>, characterId: Ref<string>) {
  const graph = computed(() => profiles.value.map(profile => profile.relationshipGraph).find(graph =>
    graph?.people.some(person => relationProfile(person, graph.work, profiles.value)?.id === characterId.value)) ?? null)
  const invalid = computed(() => profiles.value.find(profile => profile.id === characterId.value)?.relationshipGraph === null)
  const profileFor = (person: RelationPerson) => relationProfile(person, graph.value?.work || '', profiles.value)
  const personForProfile = computed(() => graph.value?.people.find(person => profileFor(person)?.id === characterId.value)?.id || '')
  const centerId = ref(''), selectedPersonId = ref(''), selectedRelationId = ref('')
  const hoveredPersonId = ref(''), hoveredRelationId = ref('')
  const scope = ref<'nearby' | 'work'>('nearby'), showSpoilers = ref(false), pendingOnly = ref(false)

  watch([characterId, personForProfile], () => {
    centerId.value = personForProfile.value; selectedPersonId.value = centerId.value; selectedRelationId.value = ''
    hoveredPersonId.value = ''; hoveredRelationId.value = ''
    scope.value = 'nearby'; showSpoilers.value = false; pendingOnly.value = false
  }, { immediate: true })

  const safeRelations = computed(() => graph.value?.relations.filter(relation => showSpoilers.value || !relation.spoiler) || [])
  const safePeople = computed(() => graph.value?.people.filter(person => person.id === personForProfile.value
    || safeRelations.value.some(relation => relation.source === person.id || relation.target === person.id)) || [])
  const pendingPeople = computed(() => safePeople.value.filter(person => !profileFor(person)))
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

  watch(visiblePeople, people => {
    if (!people.some(person => person.id === selectedPersonId.value)) selectedPersonId.value = centerId.value
    if (!people.some(person => person.id === centerId.value)) centerId.value = personForProfile.value
  })
  watch(visibleRelations, relations => {
    if (!relations.some(relation => relation.id === selectedRelationId.value)) selectedRelationId.value = ''
  })

  const selectedPerson = computed(() => safePeople.value.find(person => person.id === selectedPersonId.value))
  const selectedProfile = computed(() => selectedPerson.value && profileFor(selectedPerson.value))
  const selectedRelation = computed(() => visibleRelations.value.find(relation => relation.id === selectedRelationId.value))
  const selectedConnections = computed(() => safeRelations.value.filter(relation => relation.source === selectedPersonId.value || relation.target === selectedPersonId.value))
  const centerPerson = computed(() => safePeople.value.find(person => person.id === centerId.value))

  function selectPerson(id: string) { selectedPersonId.value = id; selectedRelationId.value = '' }
  function selectRelation(id: string) { selectedRelationId.value = id }
  function setHoveredPerson(id: string) { hoveredPersonId.value = id }
  function setHoveredRelation(id: string) { hoveredRelationId.value = id }
  function expandPerson(id: string) { centerId.value = id; selectPerson(id); scope.value = 'nearby' }
  function reset() { centerId.value = personForProfile.value; selectPerson(centerId.value) }

  // Contextual focus & dimming logic
  const activePersonId = computed(() => hoveredPersonId.value || selectedPersonId.value)
  const isAnyActive = computed(() => Boolean(hoveredPersonId.value || hoveredRelationId.value || selectedPersonId.value || selectedRelationId.value))

  const highlightedPersonIds = computed(() => {
    if (hoveredRelationId.value) {
      const rel = visibleRelations.value.find(r => r.id === hoveredRelationId.value)
      return rel ? new Set([rel.source, rel.target]) : new Set<string>()
    }
    if (selectedRelationId.value && !hoveredPersonId.value) {
      const rel = visibleRelations.value.find(r => r.id === selectedRelationId.value)
      if (rel) return new Set([rel.source, rel.target])
    }
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
    if (!activePersonId.value) return new Set<string>()
    const set = new Set<string>()
    for (const rel of visibleRelations.value) {
      if (rel.source === activePersonId.value || rel.target === activePersonId.value) {
        set.add(rel.id)
      }
    }
    return set
  })

  // Multi-tier radial positioning with angular correlation sorting
  const nodes = computed<Node[]>(() => {
    const around = visiblePeople.value.filter(person => person.id !== centerId.value)
    const cx = 520, cy = 380

    if (around.length === 0) {
      const centerP = visiblePeople.value.find(p => p.id === centerId.value)
      if (!centerP) return []
      const profile = profileFor(centerP)
      return [{
        id: centerP.id, type: 'person', position: { x: cx, y: cy },
        draggable: true, connectable: false, deletable: false, focusable: true, selectable: true,
        data: {
          person: centerP, profile, selected: centerP.id === selectedPersonId.value, center: true,
          isDimmed: false, isHighlighted: true,
          image: profile ? resolveRuntimeUrl(profile.type === 'popular' ? popularPortraitSrc(profile.id) : profile.portrait?.image) : '',
        },
      }]
    }

    // Direct connections to center
    const directToCenter = new Set<string>()
    for (const r of visibleRelations.value) {
      if (r.source === centerId.value) directToCenter.add(r.target)
      else if (r.target === centerId.value) directToCenter.add(r.source)
    }

    let tier1: RelationPerson[] = []
    let tier2: RelationPerson[] = []

    if (around.length <= 7) {
      tier1 = around
    } else {
      for (const p of around) {
        if (directToCenter.has(p.id)) tier1.push(p)
        else tier2.push(p)
      }
      if (tier1.length < 3 && tier2.length > 0) {
        const take = tier2.splice(0, Math.min(3 - tier1.length, tier2.length))
        tier1.push(...take)
      }
    }

    const orderedTier1 = orderPeopleByConnections(tier1, visibleRelations.value, centerId.value)
    const orderedTier2 = tier2.length > 0 ? orderPeopleByConnections(tier2, visibleRelations.value, centerId.value) : []

    const r1x = Math.max(340, Math.min(480, orderedTier1.length * 58))
    const r1y = Math.max(250, Math.min(340, orderedTier1.length * 42))
    const r2x = r1x + Math.max(240, Math.min(320, orderedTier2.length * 32))
    const r2y = r1y + Math.max(180, Math.min(240, orderedTier2.length * 24))

    const positions = new Map<string, { x: number; y: number }>()
    positions.set(centerId.value, { x: cx, y: cy })

    orderedTier1.forEach((person, idx) => {
      const angle = (orderedTier1.length <= 2 ? 0 : -Math.PI / 2) + idx * (2 * Math.PI / Math.max(orderedTier1.length, 1))
      positions.set(person.id, {
        x: cx + Math.cos(angle) * r1x,
        y: cy + Math.sin(angle) * r1y,
      })
    })

    orderedTier2.forEach((person, idx) => {
      let baseAngle = -Math.PI / 2 + idx * (2 * Math.PI / Math.max(orderedTier2.length, 1))
      const partner = visibleRelations.value.find(r => (r.source === person.id && directToCenter.has(r.target)) || (r.target === person.id && directToCenter.has(r.source)))
      if (partner) {
        const partnerId = partner.source === person.id ? partner.target : partner.source
        const partnerPos = positions.get(partnerId)
        if (partnerPos) {
          const pAngle = Math.atan2(partnerPos.y - cy, partnerPos.x - cx)
          baseAngle = pAngle + ((idx % 3) - 1) * 0.22
        }
      }
      positions.set(person.id, {
        x: cx + Math.cos(baseAngle) * r2x,
        y: cy + Math.sin(baseAngle) * r2y,
      })
    })

    const hasHighlightContext = isAnyActive.value
    const highlightedPeople = highlightedPersonIds.value

    return visiblePeople.value.map(person => {
      const profile = profileFor(person)
      const pos = positions.get(person.id) || { x: cx, y: cy }
      const isSelected = person.id === selectedPersonId.value
      const isCenter = person.id === centerId.value
      const isHighlighted = highlightedPeople.has(person.id)
      const isDimmed = hasHighlightContext && !isHighlighted

      return {
        id: person.id,
        type: 'person',
        position: pos,
        draggable: true,
        connectable: false,
        deletable: false,
        focusable: true,
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
      const dx = target.position.x - source.position.x
      const dy = target.position.y - source.position.y
      const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top')
      const opposite = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }
      const parallels = visibleRelations.value.filter(other => [other.source, other.target].includes(relation.source) && [other.source, other.target].includes(relation.target))
      const parallelIndex = parallels.findIndex(other => other.id === relation.id)
      const offsetSide = Math.abs(dx) > Math.abs(dy) ? 'bottom' : 'right'

      const isHighlighted = highlightedRels.has(relation.id)
      const isDimmed = hasHighlightContext && !isHighlighted

      return {
        id: relation.id,
        source: relation.source,
        target: relation.target,
        sourceHandle: `source-${parallelIndex ? offsetSide : side}`,
        targetHandle: `target-${parallelIndex ? offsetSide : opposite[side]}`,
        label: relation.label,
        type: parallelIndex ? 'smoothstep' : 'default',
        ...(parallelIndex ? { pathOptions: { offset: 70 * (parallelIndex + 1), borderRadius: 16 } } : {}),
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
          'relation-edge-dimmed': isDimmed,
        },
        labelStyle: {
          fill: isHighlighted ? 'var(--accent)' : 'var(--text-primary)',
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
    graph, invalid, scope, showSpoilers, pendingOnly, pendingPeople, visiblePeople, visibleRelations, centerPerson,
    selectedPerson, selectedProfile, selectedRelation, selectedConnections, nodes, edges, profileFor,
    selectPerson, selectRelation, setHoveredPerson, setHoveredRelation, isAnyActive, expandPerson, reset,
  }
}
