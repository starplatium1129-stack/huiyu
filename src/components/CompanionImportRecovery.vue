<template>
  <input ref="input" type="file" class="sr-only" tabindex="-1" aria-hidden="true" accept="image/*" @change="recovery.selectedOriginal" />
  <FluidTransition panel=".companion-import-recovery">
    <section v-if="status.items.length || status.error || recovery.feedback.value" class="companion-import-recovery" aria-label="图片导入恢复">
      <strong ref="heading" tabindex="-1">图片导入{{ status.items.length ? `待确认 · ${status.items.length} 张` : '已处理' }}</strong>
      <p v-if="status.items.length">继续时只核对原编号，不会重复导入。重新打开应用后如缺少原图，可选择原文件继续。</p>
      <p v-if="status.error" role="alert">{{ status.error }}</p>
      <p v-if="recovery.feedback.value" role="status">{{ recovery.feedback.value }}</p>
      <ul v-if="status.items.length" class="companion-import-list">
        <li v-for="item in status.items" :key="item.id">
          <span class="companion-import-name">{{ item.name }}</span>
          <p v-if="item.error" class="companion-import-error" role="alert">{{ item.error }}</p>
          <div class="companion-import-actions">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="blocked(item)" :aria-busy="item.busy || recovery.workingId.value === item.id"
              @click="resolve(item.id, 'save')">{{ item.busy || recovery.workingId.value === item.id ? '正在核对…' : '继续原导入' }}</button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="blocked(item) || !item.canSelectOriginal" @click="recovery.selectOriginal(item.id)">选择原文件</button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="blocked(item)" @click="resolve(item.id, 'abort')">结束待办</button>
          </div>
        </li>
      </ul>
      <button v-if="status.error" type="button" class="btn btn-ghost btn-sm" @click="recovery.refresh">重新读取</button>
    </section>
  </FluidTransition>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import FluidTransition from './visual/FluidTransition.vue'
import type { LocalImageImportRecovery } from '../composables/useLocalImageImportRecovery'
const props = defineProps<{ recovery: LocalImageImportRecovery }>()
const input = ref<HTMLInputElement>(), heading = ref<HTMLElement>()
const status = computed(() => props.recovery.status.value)
watch(input, value => { props.recovery.bindInput(value) })
const blocked = (item: { busy: boolean; available: boolean }) => Boolean(status.value.busy || props.recovery.workingId.value || item.busy || !item.available || status.value.error)
async function resolve(id: string, kind: 'save' | 'abort') {
  const focused = document.activeElement
  await (kind === 'save' ? props.recovery.retry(id) : props.recovery.end(id))
  await nextTick()
  if (!status.value.items.some(item => item.id === id) && (document.activeElement === focused || document.activeElement === document.body)) heading.value?.focus()
}
</script>
<style scoped>
.companion-import-recovery { margin:var(--s-3) var(--s-4) 0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); color:var(--text-primary); font-size:var(--fs-label); }
.companion-import-recovery p { margin:var(--s-2) 0; color:var(--text-secondary); overflow-wrap:anywhere; }
.companion-import-list { display:grid; gap:var(--s-3); margin:var(--s-3) 0 0; padding:0; list-style:none; max-height:40vh; overflow:auto; }
.companion-import-list li { min-width:0; padding-bottom:var(--s-3); border-bottom:1px solid var(--border-soft); }
.companion-import-name { display:block; overflow-wrap:anywhere; font-weight:600; }
.companion-import-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.companion-import-recovery .companion-import-error { color:var(--warning-text); }
.companion-import-actions button:disabled { opacity:1; color:var(--text-disabled); }
</style>
