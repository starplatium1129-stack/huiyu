import { computed, ref, watch, type Ref } from 'vue'
import { Position, type Edge, type Node } from '@vue-flow/core'
import type { CharacterProfile } from '@/types/character'
import type { CharacterRelation, RelationPerson } from '@/types/characterRelations'
import { arrangeTerritories, atlasIdentity, atlasShape, type AtlasShape } from '@/utils/relationAtlas'

export type CircleDimension = 'region' | 'race' | 'school'
const dimensions: Array<{ value: CircleDimension; label: string }> = [
  { value: 'school', label: '学院' }, { value: 'region', label: '地区' }, { value: 'race', label: '种族' },
]

/** Classifications arrange people; only authored relations create connecting lines. */
export function useRelationCircles(input: {
  work: Ref<string>; people: Ref<RelationPerson[]>; classificationPeople: Ref<RelationPerson[]>; relations: Ref<CharacterRelation[]>
  nodes: Ref<Node[]>; edges: Ref<Edge[]>; profileFor: (person: RelationPerson) => CharacterProfile | undefined
  clearSelection: () => void
}) {
  const mode = ref<'circles' | 'person'>('circles')
  const dimension = ref<CircleDimension>('region')
  const groupId = ref(''), hoveredGroup = ref('')
  const options = computed(() => dimensions.filter(item => input.classificationPeople.value.some(person => input.profileFor(person)?.identity?.[item.value])))
  const enabled = computed(() => mode.value === 'circles' && options.value.length > 0)
  const dimensionLabel = computed(() => dimensions.find(item => item.value === dimension.value)!.label)
  const groupFor = (person: RelationPerson) => input.profileFor(person)?.identity?.[dimension.value]?.trim() || '待整理'
  const groups = computed(() => {
    const buckets = new Map<string, RelationPerson[]>()
    for (const person of input.people.value) {
      const key = groupFor(person)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(person)
    }
    return [...buckets].map(([id, people]) => ({ id, people })).sort((a, b) =>
      a.id === '待整理' ? 1 : b.id === '待整理' ? -1 : b.people.length - a.people.length || a.id.localeCompare(b.id, 'zh-CN'))
  })
  const activeGroup = computed(() => groups.value.find(group => group.id === groupId.value))
  const members = computed(() => activeGroup.value?.people || [])
  const memberIds = computed(() => new Set(members.value.map(person => person.id)))
  const groupRelations = computed(() => activeGroup.value ? input.relations.value.filter(relation =>
    memberIds.value.has(relation.source) && memberIds.value.has(relation.target)) : [])
  const outsideConnections = computed(() => {
    if (!activeGroup.value) return []
    const byId = new Map(input.people.value.map(person => [person.id, person]))
    return input.relations.value.flatMap(relation => {
      if (memberIds.value.has(relation.source) === memberIds.value.has(relation.target)) return []
      const person = byId.get(memberIds.value.has(relation.source) ? relation.target : relation.source)
      return person ? [{ relation, person, group: groupFor(person) }] : []
    })
  })

  function overview() { groupId.value = ''; hoveredGroup.value = ''; input.clearSelection() }
  function openGroup(id: string) { groupId.value = id; hoveredGroup.value = ''; input.clearSelection() }
  function reveal(person: RelationPerson) { mode.value = 'circles'; groupId.value = groupFor(person) }
  watch(input.work, () => { mode.value = 'circles'; overview() })
  watch(options, items => {
    if (!items.some(item => item.value === dimension.value)) dimension.value = items[0]?.value || 'region'
  }, { immediate: true })
  watch(dimension, overview)
  watch(mode, input.clearSelection, { flush: 'sync' })
  watch(groups, items => { if (groupId.value && !items.some(item => item.id === groupId.value)) overview() })

  const territoryShapes = computed(() => new Map(groups.value.map(group => [group.id,
    atlasShape(group.id === '待整理' ? 1 : group.people.length > 6 ? 7 : group.people.length > 2 ? 3 : 1)])))
  const territoryPositions = computed(() => {
    const people = new Map(input.people.value.map(person => [person.id, groupFor(person)]))
    return arrangeTerritories(groups.value.map(group => ({ id: group.id, ...territoryShapes.value.get(group.id)! })),
      input.relations.value.flatMap(relation => {
        const a = people.get(relation.source), b = people.get(relation.target)
        return a && b && a !== b ? [[a, b] as [string, string]] : []
      }))
  })
  const detailShape = computed(() => atlasShape(Math.max(1, members.value.length)))
  const neighborGroups = computed(() => [...new Set(outsideConnections.value.map(connection => connection.group))]
    .flatMap(id => groups.value.find(group => group.id === id) || []))

  function territoryNode(group: { id: string; people: RelationPerson[] }, position: { x: number; y: number }, expanded = false, portal = false, shapeOverride?: AtlasShape): Node {
    const shape = shapeOverride || (expanded ? detailShape.value : portal ? atlasShape(1) : territoryShapes.value.get(group.id)!)
    return {
      id: `territory:${group.id}`, type: 'territory', position, draggable: false, selectable: false, connectable: false, focusable: false,
      zIndex: expanded ? -1 : 0, sourcePosition: Position.Right, targetPosition: Position.Left,
      // Vue Flow disables pointer events for nodes that are neither selectable nor draggable.
      // Region buttons own activation; only their expanded decorative ground stays inert.
      style: { pointerEvents: expanded ? 'none' : 'all' },
      data: { label: group.id, count: group.people.length, dimension: options.value.length ? dimensionLabel.value : '作品', active: hoveredGroup.value === group.id,
        expanded, portal, shape, ...atlasIdentity(group.id) },
    }
  }

  const portraitMembership = computed(() => input.nodes.value.map(node => node.id).join('\0'))
  const portraitGroups = computed(() => {
    const ids = new Set(portraitMembership.value.split('\0'))
    const buckets = new Map<string, RelationPerson[]>()
    for (const person of input.classificationPeople.value) {
      if (!ids.has(person.id)) continue
      const key = options.value.length ? groupFor(person) : input.work.value
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(person)
    }
    return [...buckets].map(([id, people]) => ({ id, people }))
  })
  const portraitLayout = computed(() => {
    const shapes = new Map(portraitGroups.value.map(group => [group.id, atlasShape(Math.max(1, group.people.length))]))
    const people = new Map(portraitGroups.value.flatMap(group => group.people.map(person => [person.id, group.id] as const)))
    const links = input.relations.value.flatMap(relation => {
      const a = people.get(relation.source), b = people.get(relation.target)
      return a && b && a !== b ? [[a, b] as [string, string]] : []
    })
    const positions = arrangeTerritories(portraitGroups.value.map(group => ({ id: group.id,
      width: shapes.get(group.id)!.width + 80, height: shapes.get(group.id)!.height + 105 })), links)
    // Keep each region name above its portrait field instead of underneath a portrait.
    for (const position of positions.values()) position.y += 75
    return { shapes, positions }
  })

  function portraitEdges(list: Edge[]): Edge[] {
    const positions = new Map(canvasNodes.value.filter(node => node.type === 'portrait').map(node => [node.id, node.position]))
    const opposite = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }
    return list.map(edge => {
      const a = positions.get(edge.source)!, b = positions.get(edge.target)!, dx = b.x - a.x, dy = b.y - a.y
      const side = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'bottom' : 'top'
      const parallels = list.filter(item => [edge.source, edge.target].includes(item.source) && [edge.source, edge.target].includes(item.target))
      const index = parallels.findIndex(item => item.id === edge.id)
      const showLabel = typeof edge.class === 'object' && !Array.isArray(edge.class) && (edge.class?.['relation-edge-hovered'] || edge.class?.['relation-edge-selected'])
      return { ...edge, type: index ? 'smoothstep' : 'straight', sourceHandle: `source-${side}`, targetHandle: `target-${opposite[side]}`,
        pathOptions: index ? { offset: 50 * (index + 1), borderRadius: 14 } : undefined,
        label: showLabel ? edge.label : undefined, zIndex: 1 }
    })
  }

  const canvasNodes = computed<Node[]>(() => {
    if (!enabled.value) return portraitGroups.value.flatMap(group => {
      const shape = portraitLayout.value.shapes.get(group.id)!, origin = portraitLayout.value.positions.get(group.id)!
      const byId = new Map(input.nodes.value.map(node => [node.id, node]))
      return [territoryNode(group, origin, true, false, shape), ...group.people.map((person, index) => {
        const cell = shape.cells[index], node = byId.get(person.id)!
        return { ...node, type: 'portrait', draggable: false, zIndex: 2,
          position: { x: origin.x + cell.x - 54, y: origin.y + cell.y - 74 }, data: { ...node.data, center: false } }
      })]
    })
    if (activeGroup.value) {
      const portraits = input.nodes.value.filter(node => memberIds.value.has(node.id)).map((node, index) => {
        const cell = detailShape.value.cells[index]
        return { ...node, type: 'portrait', draggable: false, zIndex: 2,
          position: { x: cell.x - 54, y: cell.y - 74 }, data: { ...node.data, center: false } }
      })
      const portals = neighborGroups.value.map((group, index) => territoryNode(group, {
        x: detailShape.value.width + 210 + (index % 2) * 90,
        y: (index - (neighborGroups.value.length - 1) / 2) * 290 + detailShape.value.height / 2 - 110,
      }, false, true))
      return [territoryNode(activeGroup.value, { x: 0, y: 0 }, true), ...portraits, ...portals]
    }
    return groups.value.map(group => territoryNode(group, territoryPositions.value.get(group.id)!))
  })
  const requestedEdges = computed(() => {
    const hasClass = (edge: Edge, name: string) => typeof edge.class === 'object' && !Array.isArray(edge.class) && edge.class?.[name]
    const selected = input.edges.value.filter(edge => hasClass(edge, 'relation-edge-selected'))
    return selected.length ? selected : input.edges.value.filter(edge => hasClass(edge, 'relation-edge-person-selected'))
  })
  const canvasEdges = computed<Edge[]>(() => {
    if (!enabled.value) return portraitEdges(requestedEdges.value)
    if (activeGroup.value) {
      const internal = portraitEdges(requestedEdges.value.filter(edge => memberIds.value.has(edge.source) && memberIds.value.has(edge.target)))
      const external = outsideConnections.value.flatMap(connection => {
        const edge = requestedEdges.value.find(edge => edge.id === connection.relation.id)
        if (!edge) return []
        const sourceInside = memberIds.value.has(edge.source)
        const showLabel = typeof edge.class === 'object' && !Array.isArray(edge.class) && (edge.class?.['relation-edge-hovered'] || edge.class?.['relation-edge-selected'])
        return [{ ...edge, source: sourceInside ? edge.source : `territory:${connection.group}`,
          target: sourceInside ? `territory:${connection.group}` : edge.target,
          sourceHandle: sourceInside ? 'source-right' : undefined, targetHandle: sourceInside ? undefined : 'target-right',
          type: 'straight', label: showLabel ? edge.label : undefined, zIndex: 1 }]
      })
      return [...internal, ...external]
    }
    return []
  })
  return { mode, dimension, options, enabled, dimensionLabel, groups, groupId, activeGroup, members, groupRelations,
    outsideConnections, hoveredGroup, overview, openGroup, reveal, canvasNodes, canvasEdges }
}
