import type { CharKey } from '@/stores/promptBuilderStore'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

export const storyChips = [
  '放学后在樱花树下等人的宁宁',
  '第一次在海边看日出的夏目',
  '夏夜祭典穿浴衣看烟花',
  '雪天围围巾的温柔一瞬',
]

export const charOptions: Array<{ id: CharKey; iconName: ArchiveIconName; label: string }> = [
  { id: 'nene',    iconName: 'nene',    label: '宁宁' },
  { id: 'natsume', iconName: 'natsume', label: '夏目' },
  { id: 'triad',   iconName: 'triad',   label: '双人' },
]

export function isCharKey(value: unknown): value is CharKey {
  return value === 'nene' || value === 'natsume' || value === 'triad' || value === 'none'
}
