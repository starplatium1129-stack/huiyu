<template><section class="asset-summary" aria-label="角色素材状态"><div><strong>创作素材</strong><p role="status">{{ checking ? '正在检查默认服装参考图…' : problem || `默认服装参考图 ${available} / ${total} 可读取` }}</p></div><button class="btn btn-ghost" type="button" :disabled="checking" @click="check(true)">重新检查</button></section></template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { ensureCharacterReferencesLoaded, getCharacterReferences } from '@/utils/characterReferenceData'
const props = defineProps<{ characterId: string }>()
const checking = ref(false), available = ref(0), total = ref(0), problem = ref('')
let controller: AbortController | null = null
async function check(refresh = false) {
  controller?.abort(); controller = new AbortController()
  const signal = controller.signal, id = props.characterId
  checking.value = true; available.value = 0; total.value = 0; problem.value = ''
  try {
    await ensureCharacterReferencesLoaded(id, refresh)
    if (signal.aborted) return
    const outfits = getCharacterReferences(id)?.outfits || []
    const outfit = outfits.find(item => item.isDefault && !item.isNsfw) || outfits.find(item => !item.isNsfw)
    const references = outfit?.references || []
    total.value = references.length
    if (!references.length) { problem.value = '默认服装参考图尚未登记'; return }
    const results = await Promise.all(references.map(async reference => {
      if (reference.pending || !/^\/character-references\/[a-z0-9_-]+\/(?:[a-z0-9_-]+\/)?[a-z0-9_.-]+$/i.test(reference.url)) return false
      try { const result = await fetch(reference.url, { method: 'HEAD', signal }); return result.ok && (result.headers.get('content-type') || '').startsWith('image/') } catch { return false }
    }))
    if (!signal.aborted && props.characterId === id) available.value = results.filter(Boolean).length
  } catch { if (!signal.aborted) problem.value = '暂时无法检查素材，请重试' }
  finally { if (!signal.aborted) checking.value = false }
}
watch(() => props.characterId, () => { void check() }, { immediate: true })
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.asset-summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-3); margin-bottom: var(--s-4); padding: var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); color: var(--text-primary); }
.asset-summary strong { font-size: var(--fs-body-sm); }
.asset-summary p { margin: var(--s-1) 0 0; font-size: var(--fs-label); line-height: var(--lh-body); color: var(--text-secondary); }
</style>
