import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

interface NavItem {
  id: string
  label: string
  to: string
  icon: ArchiveIconName
}

export const primaryNav: NavItem[] = [
  { id: 'home', label: '首页', to: '/', icon: 'gallery' },
  { id: 'director', label: '绘制', to: '/prompt-builder', icon: 'spark' },
  { id: 'character', label: '角色', to: '/character', icon: 'character' },
  { id: 'scene',    label: '灵感',   to: '/scene-explorer', icon: 'scene' },
  { id: 'showcase', label: '参考画册', to: '/showcase', icon: 'image' },
  { id: 'gallery', label: '我的作品', to: '/gallery', icon: 'gallery' },
  { id: 'chat', label: '房间', to: '/chat', icon: 'chat' },
]
export const archiveGroups: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: '创作工具',
    items: [
      { id: 'studio-projects', label: '创作项目', to: '/studio-projects', icon: 'folder' },
      { id: 'video', label: '故事短片', to: '/video-studio', icon: 'play' },
      { id: 'scenario', label: '剧本模式', to: '/scenario', icon: 'clap' },
      { id: 'color-script', label: '色彩情绪', to: '/color-script', icon: 'palette' },
    ],
  },
  {
    heading: '素材资料',
    items: [
      { id: 'popular-scenes', label: '角色场景', to: '/popular-scenes', icon: 'character' },
      { id: 'style',     label: '画风',     to: '/style',        icon: 'palette' },
      { id: 'lora', label: '模型资料', to: '/lora', icon: 'model' },
    ],
  },
  {
    heading: '工作室',
    items: [
      { id: 'manager',   label: '内容维护', to: '/scene-manager', icon: 'manager' },
      { id: 'control',   label: '控制面板', to: '/control',       icon: 'gear' },
      { id: 'guide', label: '使用指南', to: '/guide', icon: 'book' },
    ],
  },
]
export const secondaryNav: NavItem[] = archiveGroups.flatMap(g => g.items)

const pageOrder = [...primaryNav, ...secondaryNav].map(item => item.to)

export function navigationDirection(from: string, to: string): number {
  const previous = pageOrder.indexOf(from)
  const next = pageOrder.indexOf(to)
  return previous < 0 || next < 0 ? 0 : Math.sign(next - previous)
}
