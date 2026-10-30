import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import { Position, type Edge, type Node, type NodeChange } from '@vue-flow/core'
import type { CharacterProfile } from '@/types/character'
import type { CharacterRelation, RelationPerson } from '@/types/characterRelations'
import { arrangeTerritories, atlasIdentity, atlasShape, atlasPortraitField, type AtlasShape } from '@/utils/relationAtlas'

export type CircleDimension = 'region' | 'race' | 'school'
const dimensions: Array<{ value: CircleDimension; label: string }> = [
  { value: 'school', label: '学院' }, { value: 'region', label: '地区' }, { value: 'race', label: '种族' },
]

/** Classifications arrange people; only authored relations create connecting lines. */
export function useRelationCircles(input: {
  work: Ref<string>; workSize: Ref<number>; people: Ref<RelationPerson[]>; classificationPeople: Ref<RelationPerson[]>; relations: Ref<CharacterRelation[]>
  nodes: Ref<Node[]>; edges: Ref<Edge[]>; profileFor: (person: RelationPerson) => CharacterProfile | undefined
  size: Ref<{ width: number; height: number }>
  clearSelection: () => void
}) {
  const usesTerritories = computed(() => input.workSize.value > 10)
  const mode = ref<'circles' | 'person'>(usesTerritories.value ? 'circles' : 'person')
  const dimension = ref<CircleDimension>('region')
  const groupId = ref(''), hoveredGroup = ref('')
  const page = ref(0)
  const readingAnchor = ref('')
  const readingPlaces = new Map<string, string>()
  const trail = ref<Array<{ id: string; first: string }>>([])
  const options = computed(() => usesTerritories.value
    ? dimensions.filter(item => input.classificationPeople.value.some(person => input.profileFor(person)?.identity?.[item.value])) : [])
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

  function anchorAt(id: string) {
    readingAnchor.value = members.value.find(person => person.id === id)?.id || members.value[0]?.id || ''
    page.value = Math.max(0, Math.floor(members.value.findIndex(person => person.id === readingAnchor.value) / pageSize.value))
    if (groupId.value) readingPlaces.set(`${dimension.value}:${groupId.value}`, readingAnchor.value)
  }
  function overview() { groupId.value = ''; page.value = 0; readingAnchor.value = ''; trail.value = []; hoveredGroup.value = ''; input.clearSelection() }
  function openGroup(id: string) {
    if (id === groupId.value) return
    if (groupId.value) trail.value.push({ id: groupId.value, first: readingAnchor.value })
    groupId.value = id; anchorAt(readingPlaces.get(`${dimension.value}:${id}`) || '')
    hoveredGroup.value = ''; input.clearSelection()
  }
  function backGroup() {
    const previous = trail.value.pop()
    if (!previous) return
    groupId.value = previous.id
    anchorAt(previous.first)
    hoveredGroup.value = ''; input.clearSelection()
  }
  function reveal(person: RelationPerson) {
    mode.value = 'circles'; openGroup(groupFor(person))
    anchorAt(person.id)
  }
  watch([input.work, usesTerritories], () => { readingPlaces.clear(); mode.value = usesTerritories.value ? 'circles' : 'person'; overview() })
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
  // Keep the portraits readable instead of shrinking a large group into a single screen.
  const pageSize = computed(() => {
    const { width, height } = input.size.value
    if (!width || !height) return 7
    let count = 1
    for (let next = 2; next <= 36; next++) {
      const shape = atlasShape(next)
      if (shape.width * .9 > Math.max(264, width - 420) || shape.height * .9 > Math.max(230, height - 190)) break
      count = next
    }
    return count
  })
  const pageCount = computed(() => Math.max(1, Math.ceil(members.value.length / pageSize.value)))
  const pageMembers = computed(() => members.value.slice(page.value * pageSize.value, (page.value + 1) * pageSize.value))
  const pageIds = computed(() => new Set(pageMembers.value.map(person => person.id)))
  function setPage(value: number) {
    const next = Math.max(0, Math.min(pageCount.value - 1, value))
    anchorAt(members.value[next * pageSize.value]?.id || ''); input.clearSelection()
  }
  watch(pageSize, () => { if (activeGroup.value) anchorAt(readingAnchor.value) }, { flush: 'sync' })
  watch(members, () => { if (activeGroup.value) anchorAt(readingAnchor.value) })
  watch(pageCount, count => { page.value = Math.min(page.value, count - 1) })
  const detailShape = computed(() => atlasShape(Math.max(1, pageMembers.value.length)))
  const neighborGroups = computed(() => [...new Set(outsideConnections.value.filter(connection =>
    requestedEdges.value.some(edge => edge.id === connection.relation.id) &&
    (pageIds.value.has(connection.relation.source) || pageIds.value.has(connection.relation.target))).map(connection => connection.group))]
    // A few nearby portals keep the canvas quiet; the inspector lists every cross-group relation.
    .slice(0, 3).flatMap(id => groups.value.find(group => group.id === id) || []))

  function territoryNode(group: { id: string; people: RelationPerson[] }, position: { x: number; y: number }, expanded = false, portal = false, shapeOverride?: AtlasShape): Node {
    const shape = shapeOverride || (expanded ? detailShape.value : portal ? atlasShape(1) : territoryShapes.value.get(group.id)!)
    return {
      id: `territory:${group.id}`, type: 'territory', position, draggable: false, selectable: false, connectable: false, focusable: false,
      zIndex: expanded ? -1 : 0, sourcePosition: Position.Right, targetPosition: Position.Left,
      // Vue Flow disables pointer events for nodes that are neither selectable nor draggable.
      // Region buttons own activation; only their expanded decorative ground stays inert.
      style: { pointerEvents: expanded ? 'none' : 'all' },
      data: { label: group.id, count: group.people.length, dimension: options.value.length ? dimensionLabel.value : '作品', active: hoveredGroup.value === group.id,
        expanded, portal, shape, origin: { ...position }, ...atlasIdentity(group.id) },
    }
  }

  const portraitMembership = computed(() => input.nodes.value.map(node => node.id).join('\0'))
  const centerId = computed(() => input.nodes.value.find(node => node.data.center)?.id || '')
  const layoutKey = computed(() => `${input.work.value}:${mode.value}:${dimension.value}:${enabled.value ? groupId.value : portraitMembership.value}:${usesTerritories.value ? '' : centerId.value}\0`)
  const manualPositions = shallowRef(new Map<string, { x: number; y: number }>())
  const hasManualPositions = computed(() => [...manualPositions.value.keys()].some(key => key.startsWith(layoutKey.value)))
  function rememberPositions(changes: NodeChange[]) {
    const positions = changes.filter(change => change.type === 'position' && change.position &&
      canvasNodes.value.some(node => node.id === change.id && node.type === 'portrait'))
    if (!positions.length) return
    const next = new Map(manualPositions.value)
    for (const change of positions) if (change.type === 'position' && change.position) next.set(layoutKey.value + change.id, { ...change.position })
    manualPositions.value = next
  }
  function movePerson(id: string, dx: number, dy: number) {
    const node = canvasNodes.value.find(node => node.id === id && node.type === 'portrait')
    if (!node) return
    manualPositions.value = new Map(manualPositions.value).set(layoutKey.value + id, { x: node.position.x + dx, y: node.position.y + dy })
  }
  function resetPositions() {
    manualPositions.value = new Map([...manualPositions.value].filter(([key]) => !key.startsWith(layoutKey.value)))
  }
  function portraitField(group: { id: string; people: RelationPerson[] }, portraits: Node[]) {
    const moved = portraits.map(node => ({ ...node, draggable: true,
      position: manualPositions.value.get(layoutKey.value + node.id) || node.position }))
    if (!usesTerritories.value) return moved
    const field = atlasPortraitField(moved.map(node => ({ x: node.position.x + 54, y: node.position.y + 74 })))
    const ground = territoryNode(group, field.origin, true, false, field.shape)
    return [ground, ...moved]
  }
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

  const hasClass = (edge: Edge, name: string) => typeof edge.class === 'object' && !Array.isArray(edge.class) && edge.class?.[name]
  function bundleEdges(list: Edge[]): Edge[] {
    const names = new Map(canvasNodes.value.map(node => [node.id,
      node.type === 'portrait' ? node.data.person.name : `${node.data.label}分组`]))
    const pairs = new Map<string, Edge[]>()
    for (const edge of list) {
      const key = [edge.source, edge.target].sort().join('\0')
      if (!pairs.has(key)) pairs.set(key, [])
      pairs.get(key)!.push(edge)
    }
    return [...pairs.values()].map(relations => {
      const edge = relations[0], count = relations.length
      const showLabel = hasClass(edge, 'relation-edge-hovered') || hasClass(edge, 'relation-edge-selected')
      return { ...edge, type: 'straight',
        class: { 'relation-edge-active': relations.some(relation => hasClass(relation, 'relation-edge-active')),
          'relation-edge-hovered': relations.some(relation => hasClass(relation, 'relation-edge-hovered')),
          'relation-edge-selected': relations.some(relation => hasClass(relation, 'relation-edge-selected')),
          'relation-edge-person-selected': relations.some(relation => hasClass(relation, 'relation-edge-person-selected')),
          'relation-edge-dimmed': relations.every(relation => hasClass(relation, 'relation-edge-dimmed')) },
        markerStart: count > 1 ? undefined : edge.markerStart, markerEnd: count > 1 ? undefined : edge.markerEnd,
        ariaLabel: count > 1 ? `${names.get(edge.source)}与${names.get(edge.target)}：${count} 条关系` : edge.ariaLabel,
        data: { ...edge.data, relationIds: relations.map(relation => relation.id) },
        label: count > 1 ? `${count} 条关系` : showLabel ? edge.label : undefined, zIndex: 1 }
    })
  }
  function portraitEdges(list: Edge[]): Edge[] {
    const positions = new Map(canvasNodes.value.filter(node => node.type === 'portrait').map(node => [node.id, node.position]))
    const opposite = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }
    return bundleEdges(list).map(edge => {
      const a = positions.get(edge.source)!, b = positions.get(edge.target)!, dx = b.x - a.x, dy = b.y - a.y
      const side = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'bottom' : 'top'
      return { ...edge, sourceHandle: `source-${side}`, targetHandle: `target-${opposite[side]}` }
    })
  }

  const canvasNodes = computed<Node[]>(() => {
    if (!enabled.value) return portraitGroups.value.flatMap(group => {
      const shape = portraitLayout.value.shapes.get(group.id)!, origin = portraitLayout.value.positions.get(group.id)!
      const byId = new Map(input.nodes.value.map(node => [node.id, node]))
      const people = usesTerritories.value ? group.people : [
        ...group.people.filter(person => person.id === centerId.value), ...group.people.filter(person => person.id !== centerId.value),
      ]
      return portraitField(group, people.map((person, index) => {
        const cell = shape.cells[index], node = byId.get(person.id)!
        return { ...node, type: 'portrait', draggable: false, zIndex: 2,
          position: { x: origin.x + cell.x - 54, y: origin.y + cell.y - 74 }, data: { ...node.data, center: false } }
      }))
    })
    if (activeGroup.value) {
      const portraits = pageMembers.value.map((person, index) => {
        const node = input.nodes.value.find(node => node.id === person.id)!
        const cell = detailShape.value.cells[index]
        return { ...node, type: 'portrait', draggable: false, zIndex: 2,
          position: { x: cell.x - 54, y: cell.y - 74 }, data: { ...node.data, center: false } }
      })
      const portals = neighborGroups.value.map((group, index) => territoryNode(group, {
        x: detailShape.value.width + 210 + (index % 2) * 90,
        y: (index - (neighborGroups.value.length - 1) / 2) * 290 + detailShape.value.height / 2 - 110,
      }, false, true))
      return [...portraitField(activeGroup.value, portraits), ...portals]
    }
    return groups.value.map(group => territoryNode(group, territoryPositions.value.get(group.id)!))
  })
  const selectedEdges = computed(() => input.edges.value.filter(edge => hasClass(edge, 'relation-edge-selected')))
  const requestedEdges = computed(() => selectedEdges.value.length ? selectedEdges.value
    : input.edges.value.filter(edge => hasClass(edge, 'relation-edge-person-selected')))
  const canvasEdges = computed<Edge[]>(() => {
    if (!enabled.value) {
      if (usesTerritories.value) return portraitEdges(requestedEdges.value)
      const focus = input.nodes.value.find(node => node.data.selected)?.id || centerId.value
      const relations = selectedEdges.value.length ? selectedEdges.value
        : input.edges.value.filter(edge => edge.source === focus || edge.target === focus)
      return portraitEdges(relations)
    }
    if (activeGroup.value) {
      const internal = portraitEdges(requestedEdges.value.filter(edge => pageIds.value.has(edge.source) && pageIds.value.has(edge.target)))
      const external = outsideConnections.value.flatMap(connection => {
        const edge = requestedEdges.value.find(edge => edge.id === connection.relation.id)
        if (!edge || !neighborGroups.value.some(group => group.id === connection.group)) return []
        const sourceInside = memberIds.value.has(edge.source)
        const showLabel = typeof edge.class === 'object' && !Array.isArray(edge.class) && (edge.class?.['relation-edge-hovered'] || edge.class?.['relation-edge-selected'])
        return [{ ...edge, source: sourceInside ? edge.source : `territory:${connection.group}`,
          target: sourceInside ? `territory:${connection.group}` : edge.target,
          sourceHandle: sourceInside ? 'source-right' : undefined, targetHandle: sourceInside ? undefined : 'target-right',
          type: 'straight', label: showLabel ? edge.label : undefined, zIndex: 1 }]
      })
      return [...internal, ...bundleEdges(external)]
    }
    return []
  })
  return { mode, dimension, options, enabled, usesTerritories, dimensionLabel, groups, groupId, activeGroup, members, groupRelations,
    outsideConnections, hoveredGroup, overview, openGroup, backGroup, trail, reveal, canvasNodes, canvasEdges,
    page, pageSize, pageCount, pageMembers, setPage, rememberPositions, movePerson, resetPositions, hasManualPositions }
}
