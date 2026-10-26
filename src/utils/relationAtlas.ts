import type { AtlasEmblemName } from '@/components/visual/icons/atlas'

export interface AtlasCell { x: number; y: number; points: string }
export interface AtlasShape { cells: AtlasCell[]; outline: string; width: number; height: number }
const RADIUS = 126

/** Flat-top hexagons share exact edges; the perimeter excludes internal seams. */
export function atlasShape(count: number): AtlasShape {
  const axial: Array<[number, number]> = [[0, 0]], seen = new Set(['0,0'])
  const directions = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]
  for (let index = 0; axial.length < count; index++) {
    const [q, r] = axial[index]
    for (const [dq, dr] of directions) {
      const next: [number, number] = [q + dq, r + dr], key = next.join(',')
      if (seen.has(key)) continue
      seen.add(key); axial.push(next)
      if (axial.length >= count) break
    }
  }
  const centers = axial.map(([q, r]) => ({ x: RADIUS * 1.5 * q, y: RADIUS * Math.sqrt(3) * (r + q / 2) }))
  const minX = Math.min(...centers.map(p => p.x)) - RADIUS, minY = Math.min(...centers.map(p => p.y)) - RADIUS * Math.sqrt(3) / 2
  const edges = new Map<string, { path: string; count: number }>()
  const cells = centers.map(center => {
    const x = center.x - minX + 6, y = center.y - minY + 6
    const vertices = Array.from({ length: 6 }, (_, i) => ({ x: x + RADIUS * Math.cos(i * Math.PI / 3), y: y + RADIUS * Math.sin(i * Math.PI / 3) }))
    for (let i = 0; i < 6; i++) {
      const a = vertices[i], b = vertices[(i + 1) % 6]
      const key = [a, b].map(v => `${v.x.toFixed(2)},${v.y.toFixed(2)}`).sort().join('|')
      const edge = edges.get(key)
      if (edge) edge.count++
      else edges.set(key, { path: `M${a.x},${a.y}L${b.x},${b.y}`, count: 1 })
    }
    return { x, y, points: vertices.map(v => `${v.x},${v.y}`).join(' ') }
  })
  return { cells, outline: [...edges.values()].filter(edge => edge.count === 1).map(edge => edge.path).join(''),
    width: Math.max(...cells.map(p => p.x)) + RADIUS + 6, height: Math.max(...cells.map(p => p.y)) + RADIUS * Math.sqrt(3) / 2 + 6 }
}

const emblems: Record<string, AtlasEmblemName> = {
  '龙门': 'atlas-dragon', '炎': 'atlas-sun', '拉特兰': 'atlas-halo', '莱塔尼亚': 'atlas-lyre', '叙拉古': 'atlas-wolf',
  '萨尔贡': 'atlas-leaf', '萨米': 'atlas-pine', '哥伦比亚': 'atlas-city', '东国': 'atlas-gate', '玻利瓦尔': 'atlas-bird',
  '罗德岛': 'atlas-tower', '维多利亚': 'atlas-crown', '阿戈尔': 'atlas-wave', '卡兹戴尔': 'atlas-spire',
  '千年科学学园': 'atlas-orbit', '崔尼蒂综合学院': 'atlas-lily', '歌赫娜学园': 'atlas-wings',
  '龙': 'atlas-dragon', '菲林': 'atlas-cat', '鲁珀': 'atlas-wolf', '萨卡兹': 'atlas-spire', '萨科塔': 'atlas-halo',
  '黎博利': 'atlas-bird', '卡普里尼': 'atlas-horns', '埃拉菲亚': 'atlas-leaf', '沃尔珀': 'atlas-cat', '斐迪亚': 'atlas-wave',
}
const colors = ['--accent', '--accent-violet', '--info', '--success', '--warning']
export function atlasIdentity(label: string) {
  let hash = 0
  for (const letter of label) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0
  return { emblem: emblems[label] || 'atlas-leaf', color: `var(${colors[hash % colors.length]})` }
}

/** Compact, irregular packing follows actual links without implying geographic coordinates. */
export function arrangeTerritories(items: Array<{ id: string; width: number; height: number }>, links: Array<[string, string]>) {
  const placed = new Map<string, { x: number; y: number; width: number; height: number }>()
  for (const item of items) {
    const neighbors = links.flatMap(([a, b]) => a === item.id ? [b] : b === item.id ? [a] : []).flatMap(id => placed.has(id) ? [placed.get(id)!] : [])
    let best = { x: 0, y: 0 }, bestScore = Infinity
    for (let i = 0; i < 600; i++) {
      const angle = i * 2.399963229728653, radius = 68 * Math.sqrt(i)
      const x = Math.cos(angle) * radius - item.width / 2, y = Math.sin(angle) * radius * .68 - item.height / 2
      if ([...placed.values()].some(p => x < p.x + p.width + 38 && x + item.width + 38 > p.x && y < p.y + p.height + 38 && y + item.height + 38 > p.y)) continue
      const distance = (p: { x: number; y: number; width: number; height: number }) => Math.hypot(x + item.width / 2 - p.x - p.width / 2, y + item.height / 2 - p.y - p.height / 2)
      const score = radius * .4 + (neighbors.length ? neighbors.reduce((sum, p) => sum + distance(p), 0) / neighbors.length : radius)
      if (score < bestScore) { best = { x, y }; bestScore = score }
    }
    // The search radius grows with catalog size so every territory keeps its own space.
    if (!Number.isFinite(bestScore)) best = { x: Math.max(0, ...[...placed.values()].map(p => p.x + p.width)) + 80, y: 0 }
    placed.set(item.id, { ...best, width: item.width, height: item.height })
  }
  return placed
}
