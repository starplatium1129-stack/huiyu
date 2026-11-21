<script setup lang="ts">
import { onActivated, onDeactivated, ref, useId, watch } from 'vue'
import type { VideoPromptPreview, VideoPromptPreviewRequest } from '../../../types/videoPrompt'
import { previewVideoPrompt } from '@/api/videoApi'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'

const props = defineProps<{ request: VideoPromptPreviewRequest | null; modelLabel: string }>()
const id = useId()
const isOpen = ref(false)
const active = ref(true)
const retry = ref(0)
const waiting = ref(false)
const error = ref('')
const preview = ref<VideoPromptPreview | null>(null)

onActivated(() => { active.value = true })
onDeactivated(() => { active.value = false })

function retryPreview(event: MouseEvent) {
  const button = event.currentTarget as HTMLButtonElement
  button.closest('details')?.querySelector('summary')?.focus({ preventScroll: true })
  retry.value++
}

watch([isOpen, active, () => props.request, retry], ([open, visible, request], _, onCleanup) => {
  preview.value = null
  error.value = ''
  waiting.value = false
  if (!open || !visible || !request) return
  waiting.value = true
  const controller = new AbortController()
  const timer = window.setTimeout(async () => {
    try {
      const result = await previewVideoPrompt(request, controller.signal)
      if (!controller.signal.aborted) preview.value = result
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '提示词预览暂时无法生成'
    } finally {
      if (!controller.signal.aborted) waiting.value = false
    }
  }, 250)
  onCleanup(() => { window.clearTimeout(timer); controller.abort() })
})
</script>

<template>
  <details class="video-compiled-preview" @toggle="isOpen = ($event.currentTarget as HTMLDetailsElement).open">
    <StudioDisclosureSummary class="compiled-summary">
      模型提示词预览
      <small v-if="modelLabel">{{ modelLabel }}</small>
    </StudioDisclosureSummary>
    <div class="compiled-content" :aria-busy="waiting" data-disclosure-content>
      <p v-if="!request" class="field-hint">选择积木或填写镜头描述后可预览。</p>
      <p v-else-if="waiting" class="field-hint">正在编译提示词…</p>
      <template v-else-if="preview">
        <div class="field">
          <label class="field-label" :for="`${id}-prompt`">正向提示词</label>
          <textarea :id="`${id}-prompt`" class="textarea input-mono" rows="6" readonly spellcheck="false" :value="preview.prompt" />
        </div>
        <div v-if="preview.negative" class="field">
          <label class="field-label" :for="`${id}-negative`">负向提示词</label>
          <textarea :id="`${id}-negative`" class="textarea input-mono" rows="2" readonly spellcheck="false" :value="preview.negative" />
        </div>
      </template>
      <p class="compiled-error" role="status">{{ error }}</p>
      <button v-if="error" class="btn btn-quiet btn-sm compiled-retry" type="button" @click="retryPreview">重试预览</button>
    </div>
  </details>
</template>

<style scoped>
.video-compiled-preview { border-block-start: 1px solid var(--border-soft); padding-block-start: var(--s-2); }
.compiled-summary { color: var(--text-secondary); font-size: var(--fs-label); font-weight: 600; }
.compiled-summary small { color: var(--text-secondary); font-size: var(--fs-label-xs); font-weight: 400; }
.compiled-content { display: grid; gap: var(--s-2); padding-block-start: var(--s-2); }
.compiled-content p { margin: 0; }
.compiled-content textarea { background: var(--bg-base); resize: vertical; }
.compiled-retry { justify-self: start; }
.compiled-error { color: var(--danger-text); font-size: var(--fs-label-sm); }
.compiled-error:empty { position: absolute; }
@media (pointer: coarse) { .compiled-summary { min-block-size: 48px; } }
</style>
