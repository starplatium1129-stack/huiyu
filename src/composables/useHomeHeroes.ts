import { computed, onScopeDispose, readonly, ref, watch } from 'vue'
import { maintenanceApi } from '@/api/maintenanceApi'
import type { HomeHeroCharacter, HomeHeroManifestEntry } from '@/types/api'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export interface HeroEntry {
  id: HomeHeroCharacter
  title: string
  image: string
  updatedAt: string
}

type HeroOverrides = Partial<Record<HomeHeroCharacter, HomeHeroManifestEntry>>
let cache: { identity: string; entries?: HeroOverrides; revision: number } | undefined
let nextRequest = 0
function currentCache() {
  const identity = runtimeResourceIdentity()
  if (!cache || cache.identity !== identity) cache = { identity, revision: 0 }
  return cache
}

/** 首页和维护预览共用来源；旧样张清单不代表用户主动替换了当前内置图。 */
export function useHomeHeroes() {
  const overrides = ref<HeroOverrides>({}), ready = ref(false)
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
    const snapshot = currentCache(), revision = ++nextRequest
    request?.abort()
    const controller = new AbortController()
    request = controller
    const current = () => !disposed && !controller.signal.aborted && request === controller
      && cache === snapshot && snapshot.identity === runtimeResourceIdentity()
    try {
      const data = await maintenanceApi.getHomeHero({ signal: controller.signal })
      if (!current()) return
      const next: HeroOverrides = {}
      for (const id of ['nene', 'natsume'] as const) {
        const entry = data.entries[id]
        // 同时防止旧后端响应把历史清单重新当成当前首页的自定义图。
        if (entry?.source === 'upload') next[id] = { ...entry }
      }
      // A slower preview request must not replace a newer successful upload refresh.
      if (revision >= snapshot.revision) { snapshot.entries = next; snapshot.revision = revision }
      overrides.value = structuredClone(snapshot.entries ?? {})
      ready.value = true
    } catch (error) {
      if (current()) {
        // First-read failures allow the bundled art; successful overrides stay cached.
        overrides.value = structuredClone(snapshot.entries ?? {})
        ready.value = true
      }
      throw error
    } finally {
      if (request === controller) request = undefined
    }
  }

  watch(runtimeResourceIdentity, () => {
    const snapshot = currentCache()
    overrides.value = structuredClone(snapshot.entries ?? {})
    ready.value = snapshot.entries !== undefined
    void reload().catch(() => {})
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => { disposed = true; request?.abort() })
  return { heroes, ready: readonly(ready), reload }
}
