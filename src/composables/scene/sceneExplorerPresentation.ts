import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import type { Scene } from '@/stores/sceneStore'

export interface ExplorerScene extends Scene {
  title?: string
  category?: string
  story?: string
  char?: string
  emotion?: string
  season?: string
  timeOfDay?: string
  rating?: string
  mature?: boolean
  camera?: string
  lighting?: string
  location?: string
  weather?: string
  tags?: string[]
}

export const THEME_DEFS: Array<{
  id: string
  label: string
  iconName: ArchiveIconName
  categories: string[]
}> = [
  { id: 'all', label: '全部', iconName: 'spark', categories: [] },
  { id: 'romance', label: '恋爱', iconName: 'love', categories: ['恋爱'] },
  { id: 'daily', label: '日常', iconName: 'coffee', categories: ['日常'] },
  { id: 'intimate', label: '亲密', iconName: 'moonlight', categories: ['亲密', 'R15'] },
  { id: 'school', label: '校园', iconName: 'cap', categories: ['校园'] },
  { id: 'travel', label: '旅行', iconName: 'plane', categories: ['旅行'] },
  { id: 'festival', label: '节日', iconName: 'flower', categories: ['祭典・节日'] },
  { id: 'story', label: '剧情', iconName: 'clap', categories: ['战斗', 'Active Sync'] },
  { id: 'fanwork', label: '同人', iconName: 'spark', categories: ['同人'] },
]

export const DEFAULT_RAILS = [
  { character: 'nene', icon: 'moonlight', title: '宁宁的月光秘密', subtitle: '图书馆 · 樱色 · 魔女', query: 'nene library' },
  { character: 'natsume', icon: 'coffee', title: '夏目的夜灯关心', subtitle: '咖啡馆 · 雨夜 · 琥珀', query: 'natsume cafe' },
  { character: 'shared', icon: 'goldenhour', title: '夏日远行', subtitle: '海风 · 黄昏 · 纪念', query: 'beach sunset' },
]

/** moodRails 数据兼容 emoji 旧值与本地 ArchiveIconName。 */
export function railIconName(icon: string | undefined): ArchiveIconName {
  switch (icon) {
    case '🌙': return 'moonlight'
    case '☕': return 'coffee'
    case '🌅':
    case '🌄': return 'goldenhour'
    case '🌸': return 'cherry'
    case '🍂': return 'autumnleaf'
    case '💕':
    case '❤': return 'love'
    case '📖': return 'book'
    case '🎬': return 'clap'
    case '✿': return 'flower'
    default:
      return (icon && ['moonlight', 'coffee', 'goldenhour', 'cherry', 'autumnleaf', 'love', 'book', 'clap', 'flower', 'spark', 'sun', 'star', 'leaf', 'wand'].includes(icon))
        ? icon as ArchiveIconName
        : 'spark'
  }
}

export function primaryCategory(scene: ExplorerScene): string {
  const category = scene.category || '其他'
  return category === 'Active_Sync_Scenes' ? 'Active Sync' : category.split('/')[0]
}

export function themeDefinition(id: string) {
  return THEME_DEFS.find(definition => definition.id === id) || THEME_DEFS[0]
}

export function matchesTheme(scene: ExplorerScene, id: string): boolean {
  return id === 'all' || themeDefinition(id).categories.includes(primaryCategory(scene))
}

export function matchesSeries(scene: ExplorerScene, value: string): boolean {
  const category = scene.category || ''
  if (value === 'after') return /After_Story/i.test(category)
  if (value === 'fanwork') return /同人/.test(category)
  if (value === 'active') return category === 'Active_Sync_Scenes'
  return true
}

export function matchesTime(scene: ExplorerScene, value: string): boolean {
  if (value === 'all') return true
  if (value === 'night') return ['night', 'late_night', 'evening'].includes(scene.timeOfDay || '')
  return scene.timeOfDay === value
}

export function sceneVisualLabels(scene: ExplorerScene) {
  const shotLabels: Record<string, string> = { 半身中景: '半身', 全身远景: '远景', 全身中景: '全身', 特写: '特写', 特写镜头: '特写', 面部特写: '特写', 远景: '远景', 中景: '半身', 全身: '全身', 半身: '半身' }
  const lightLabels: Record<string, string> = { 窗光: '窗光', 黄金时刻: '黄昏光', 逆光: '逆光', 月光: '月光', 夜灯: '夜灯', 霓虹: '霓虹', 烛光: '烛光', 阴天: '阴天光', 夕阳光: '黄昏光', 晨光: '晨光' }
  const camera = String(scene.camera || '')
  const shot = shotLabels[scene.camera || ''] || (/第一人称|主观/i.test(camera) ? '第一人称' : /俯视|俯瞰/.test(camera) ? '俯视' : /仰视|微仰/.test(camera) ? '仰视' : /侧面|侧方/.test(camera) ? '侧面' : /近景|特写/.test(camera) ? '特写' : /全身|远景/.test(camera) ? '远景' : '半身')
  const lightingKey = String(scene.lighting || '')
  const lighting = lightLabels[scene.lighting || ''] || (/夕阳|黄昏|黄金|落日/.test(lightingKey) ? '黄昏光' : /逆光|背光/.test(lightingKey) ? '逆光' : /月光|星光/.test(lightingKey) ? '月光' : /窗光|晨光|朝阳/.test(lightingKey) ? '窗光' : /阴天|雨天|漫射/.test(lightingKey) ? '柔光' : /灯|烛|暖光|霓虹/.test(lightingKey) ? '夜灯' : '自然光')
  const tags = (scene.tags || []).join(',').toLowerCase()
  const emotion = (scene.emotion || '').toLowerCase()
  let color = '自然'
  if (/sunset|dusk|golden|黄昏|夕阳|浪漫/.test(tags) || /love|shy|恋爱|害羞/.test(emotion)) color = '暖橙'
  else if (/night|月|夜|星空|moon/.test(tags)) color = '冷蓝'
  else if (/spring|cherry|花|樱花|春/.test(tags)) color = '粉嫩'
  else if (/autumn|red_leaves|秋/.test(tags)) color = '琥珀'
  else if (/rain|雨|cloudy/.test(tags)) color = '灰蓝'
  else if (/winter|snow|雪|冬/.test(tags)) color = '冷白'
  return { shot, lighting, color }
}
