import { computed, nextTick, onMounted, reactive, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

export const controlSections: Array<{ id: string; group: string; label: string; icon: ArchiveIconName; description: string }> = [
  { id: 'control-overview', group: '开始使用', label: '总览与入门', icon: 'eye', description: '画室环境与模块就绪状态。' },
  { id: 'control-setup', group: '开始使用', label: '绘图与模型', icon: 'download', description: '底模配置、下载管理与本地模型支持。' },
  { id: 'control-interrogate', group: '按需扩展', label: '图片反推', icon: 'search', description: '解析参考图片，提取风格与描述词。' },
  { id: 'control-library', group: '开始使用', label: '资源与素材', icon: 'image', description: '管理角色立绘、场景素材与离线画册。' },
  { id: 'control-personalization', group: '偏好与管理', label: '外观与桌面', icon: 'palette', description: '界面主题、动效、缩放与启动偏好。' },
  { id: 'control-services', group: '偏好与管理', label: '服务与连接', icon: 'gear', description: '服务连接、显存策略与角色声线配置。' },
  { id: 'control-share', group: '偏好与管理', label: '分享与访问', icon: 'upload', description: '局域网与公网临时分享访问。' },
  { id: 'control-logs', group: '偏好与管理', label: '日志与排查', icon: 'book', description: '系统运行日志与脱敏诊断导出。' },
]
const aliases: Record<string, string> = {
  'control-inference': 'control-setup', 'control-image-resources': 'control-setup',
  'control-comfy': 'control-setup', 'setup-chat-options': 'control-setup',
  'control-resources': 'control-services', 'control-service-status': 'control-services',
  'control-connection-settings': 'control-services', 'control-service-webui': 'control-services',
  'control-service-comfy': 'control-services', 'control-service-llama': 'control-services',
  'control-service-voice': 'control-services', 'control-service-ollama': 'control-services',
}
export function useControlNavigation(imageProvider: Ref<'native' | 'comfy' | null | undefined>) {
  const route = useRoute()
  const activeSection = computed(() => {
    const id = route.hash.slice(1) || (typeof route.query.section === 'string' ? route.query.section : '')
    if (controlSections.some(section => section.id === id)) return id
    if (aliases[id]) return aliases[id]
    if (route.query.model || route.query.resource) return 'control-setup'
    if (route.query.engine === 'native') return 'control-setup'
    if (route.query.engine) return ['sd', 'video'].includes(String(route.query.engine)) || imageProvider.value === 'comfy' ? 'control-services' : 'control-setup'
    return 'control-overview'
  })
  const visited = reactive(new Set<string>([activeSection.value]))
  const currentSection = computed(() => controlSections.find(section => section.id === activeSection.value)!)
  const groups = [...new Set(controlSections.map(section => section.group))].map(label => ({
    label, sections: controlSections.filter(section => section.group === label),
  }))
  let navigation = 0
  async function reveal(focus: boolean) {
    const ticket = ++navigation
    visited.add(activeSection.value)
    await nextTick()
    if (ticket !== navigation) return
    // Nested setup panels resolve their own async resource links when ready.
    const hash = route.hash.slice(1)
    const target = controlSections.some(section => section.id === hash) ? null : document.getElementById(hash)
    if (target instanceof HTMLDetailsElement) target.open = true
    const visibleTarget = target?.getClientRects().length ? target : document.getElementById('control-section-intro')
    visibleTarget?.scrollIntoView({ block: 'start', behavior: 'instant' })
    if (focus) document.getElementById('control-section-heading')?.focus({ preventScroll: true })
  }
  watch([() => route.fullPath, activeSection], () => { if (route.path === '/control') void reveal(true) })
  function panelReady(id: string) {
    // Legacy links can target an element inside a lazily loaded subsection.
    // Ordinary section loads keep the user's current scroll and focus.
    if (id === activeSection.value && route.hash && !controlSections.some(section => section.id === route.hash.slice(1))) void reveal(false)
  }
  const compact = useMediaQuery('(max-width: 1000px)')
  function focusNavigation() {
    document.querySelector<HTMLElement>(compact.value ? '.control-compact-nav [role="combobox"]' : '.control-rail-link[aria-current]')?.focus({ preventScroll: true })
  }
  watch(compact, async () => {
    const origin = document.activeElement
    if (!(origin instanceof HTMLElement) || !origin.closest('.control-rail, .control-compact-nav')) return
    await nextTick()
    if (origin.getClientRects().length || document.activeElement !== origin && document.activeElement !== document.body) return
    focusNavigation()
  })
  onMounted(() => { void reveal(false) })
  return { activeSection, currentSection, groups, visited, focusNavigation, panelReady }
}
