import { computed, onScopeDispose, ref, watch } from 'vue'
import { maintenanceApi } from '@/api/maintenanceApi'
import type { HomeHeroCharacter, HomeHeroManifestEntry } from '@/types/api'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export interface HeroEntry {
  id: HomeHeroCharacter
  title: string
  image: string
  updatedAt: string
}

/** 首页和维护预览共用来源；旧样张清单不代表用户主动替换了当前内置图。 */
export function useHomeHeroes() {
  const overrides = ref<Partial<Record<HomeHeroCharacter, HomeHeroManifestEntry>>>({})
  let request: AbortController | undefined
  let disposed = false
  const heroes = computed(() => {
    const entry = (id: HomeHeroCharacter, title: string): HeroEntry => {
      const custom = overrides.value[id]
      return {
        id, title,
        image: custom?.image || `/assets/characters/${id}-home-cg-1024.webp`,
        updatedAt: custom?.updatedAt ? new Date(custom.updatedAt).toLocaleString('zh-CN') : '',
      }
    }
    return { nene: entry('nene', '宁宁'), natsume: entry('natsume', '夏目') }
  })

  async function reload() {
    if (disposed) return
    request?.abort()
    const controller = new AbortController()
    request = controller
    try {
      const data = await maintenanceApi.getHomeHero({ signal: controller.signal })
      if (controller.signal.aborted) return
      const next: typeof overrides.value = {}
      for (const id of ['nene', 'natsume'] as const) {
        const entry = data.entries[id]
        // 同时防止旧后端响应把历史清单重新当成当前首页的自定义图。
        if (entry?.source === 'upload') next[id] = { ...entry }
      }
      overrides.value = next
    } finally {
      if (request === controller) request = undefined
    }
  }

  watch(runtimeResourceIdentity, () => {
    overrides.value = {}
    void reload().catch(() => {})
  }, { immediate: true })
  onScopeDispose(() => { disposed = true; request?.abort() })
  return { heroes, reload }
}
