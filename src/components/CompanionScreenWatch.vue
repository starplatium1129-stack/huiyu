<template>
  <section v-if="showEntry || state !== 'idle' || notice || open" class="companion-watch"
    :data-dock="docked || undefined" aria-label="陪看">
    <div class="companion-watch-controls">
      <StudioPopover v-model:open="open" label="陪看设置" :side="docked ? 'top' : 'bottom'" :align="docked ? 'start' : 'end'" content-class="companion-watch-popover">
        <template #trigger>
          <button class="btn btn-quiet btn-sm companion-watch-trigger" type="button">
            <ArchiveIcon name="eye" /><span>{{ active ? status : state === 'choosing' ? '正在选画面' : '陪看' }}</span>
            <span class="sr-only">设置</span>
          </button>
        </template>
        <div class="companion-watch-settings">
          <strong>陪看</strong>
          <p v-if="origin">有明显变化的画面会交给 <span class="watch-origin">{{ origin }}</span> 识别。绘遇这边只保留当前的短评，结束共享后清除。</p>
          <p v-else>请先在角色房间配置自己的视觉聊天 API，选择支持图片的模型。</p>
          <p v-if="!supported">当前窗口不支持连续共享。仍可在对白窗使用「看屏幕」。</p>
          <StudioSelect :model-value="pace" label="短评频率" :options="paceOptions" size="sm"
            @update:model-value="setPace" />
          <label v-if="state === 'idle'" class="companion-watch-audio">
            <input v-model="listenForGaps" type="checkbox" />
            <span>等共享声音停下再开口</span>
          </label>
          <small v-if="state === 'idle' && listenForGaps">在共享选择器中开启声音。声音只在本机用来判断空档。</small>
          <small v-if="active && listenForGaps">{{ audioAvailable ? '正在本机检测共享声音' : '此来源暂未提供可检测的共享声音' }}</small>
          <button v-if="state === 'idle'" class="btn btn-primary btn-sm" type="button"
            :disabled="!supported || !origin" @click="start">选择共享画面</button>
          <button v-else-if="state === 'choosing'" class="btn btn-ghost btn-sm" type="button" @click="stop">取消</button>
          <button v-else class="btn btn-primary btn-sm" type="button" :disabled="!canInspect" @click="inspectNow">看现在</button>
        </div>
      </StudioPopover>
      <template v-if="active">
        <button class="btn btn-quiet btn-sm" type="button" @click="state === 'paused' ? resume() : pause()">
          {{ state === 'paused' ? '继续' : '暂停' }}
        </button>
        <button class="btn btn-quiet btn-sm" type="button" @click="stop">结束共享</button>
      </template>
    </div>
    <span v-if="active" class="sr-only" role="status">{{ status }}</span>
    <p v-if="notice" class="companion-watch-feedback" role="status">{{ notice }}</p>
    <p v-else-if="comment" class="companion-watch-comment" aria-live="polite">{{ comment }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { useCompanionScreenWatch } from '@/composables/chat/useCompanionScreenWatch'

const props = defineProps<{ controller: ReturnType<typeof useCompanionScreenWatch>; showEntry: boolean; docked?: boolean }>()
const StudioSelect = defineAsyncComponent(() => import('@/components/ui/StudioSelect.vue'))
const { state, pace, listenForGaps, audioAvailable, comment, notice, supported, origin, canInspect, status,
  start, pause, resume, inspectNow, stop } = props.controller
const open = ref(false)
const active = computed(() => state.value === 'watching' || state.value === 'paused')
const paceOptions = [{ value: 'quiet', label: '少说一点' }, { value: 'balanced', label: '适中' }]
function setPace(value: unknown) { if (value === 'quiet' || value === 'balanced') pace.value = value }
watch(state, (next, previous) => {
  if (next === 'watching' && previous === 'choosing') open.value = false
})
</script>

<style scoped>
.companion-watch { position:absolute; z-index:var(--z-overlay); inset-block-start:var(--s-2); inset-inline-start:var(--s-2); max-inline-size:calc(100% - 2 * var(--s-2)); display:grid; gap:var(--s-1); justify-items:start; pointer-events:none; }
.companion-watch-controls { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-1); pointer-events:auto; }
.companion-watch:not([data-dock]) .companion-watch-controls { background:var(--bg-surface); border:1px solid var(--border-soft); border-radius:var(--r-md); box-shadow:var(--shadow-sm); }
.companion-watch[data-dock] { display:contents; }
.companion-watch[data-dock] :is(.companion-watch-feedback,.companion-watch-comment) {
  order:-1; flex:1 1 100%; max-inline-size:none; padding:var(--s-1) var(--s-2);
  border:0; background:var(--bg-elevated); border-radius:var(--r-md);
}
.companion-watch-trigger { gap:var(--s-1); }
.companion-watch-trigger svg { inline-size:16px; block-size:16px; }
.companion-watch-controls .btn:focus-visible { outline:2px solid var(--focus-color); outline-offset:-2px; box-shadow:none; }
.companion-watch-feedback,.companion-watch-comment { margin:0; max-inline-size:32ch; padding:var(--s-2) var(--s-3); background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--r-lg); color:var(--text-primary); overflow-wrap:anywhere; font-size:var(--fs-body-sm); }
.companion-watch-settings { display:grid; gap:var(--s-2); color:var(--text-primary); font-size:var(--fs-body-sm); }
:global(:root body .studio-popover.companion-watch-popover[data-fluid-glass]) {
  --material-fill:var(--bg-surface);
  inline-size:min(280px,calc(100vw - 32px));
  background:var(--bg-surface);
}
.companion-watch-settings p { margin:0; color:var(--text-secondary); line-height:var(--lh-body); }
.companion-watch-audio { display:flex; align-items:center; gap:var(--s-2); }
.companion-watch-settings small { color:var(--text-secondary); }
.watch-origin { color:var(--text-primary); overflow-wrap:anywhere; }
</style>
