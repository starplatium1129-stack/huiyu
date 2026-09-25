<template>
  <Teleport to="body">
    <FluidTransition>
      <div v-if="open" class="shot-script-overlay" @click.self="emit('close')">
        <section ref="dialogEl" class="shot-script-panel" role="dialog" aria-modal="true" aria-label="AI 生成分镜脚本">
          <header class="shot-script-head">
            <div>
              <span class="video-step"><ArchiveIcon name="wand" /> AI 生成脚本</span>
              <h2>故事梗概 → 完整分镜表</h2>
              <p>AI 按叙事节奏切镜（景别/镜头/运动/台词/时长全自动），无首帧也可纯文字生成（T2VA）。</p>
            </div>
            <button class="btn btn-ghost" type="button" aria-label="关闭" @click="emit('close')"><ArchiveIcon name="close" /></button>
          </header>
          <label class="field">
            <span class="field-label">故事梗概（中文即可）</span>
            <textarea
              ref="storyInputEl"
              :value="story"
              class="textarea"
              rows="5"
              maxlength="2000"
              placeholder="例如：宁宁在咖啡店值夜班，打烊前收到一封旧信，读完决定去找写信的人……"
              @input="emit('update:story', inputValue($event))"
            ></textarea>
          </label>
          <div class="shot-script-row">
            <label class="field">
              <span class="field-label">镜头数</span>
              <StudioSelect size="sm" label="镜头数" :model-value="count ?? ''" :options="countOptions" @update:model-value="emit('update:count', nullableNumber($event))" />
            </label>
            <label class="field">
              <span class="field-label">总时长（秒）</span>
              <StudioSelect size="sm" label="总时长（秒）" :model-value="total ?? ''" :options="totalOptions" @update:model-value="emit('update:total', nullableNumber($event))" />
            </label>
          </div>
          <footer class="shot-script-foot">
            <span v-if="referenceLabels.length" class="shot-script-hint">
              参考卡角色将作为 &lt;Picture N&gt; 注入：{{ referenceLabels.join('、') }}
            </span>
            <button class="btn btn-primary" type="button" :disabled="busy || !story.trim()" @click="emit('submit')">
              {{ busy ? '生成中…' : '生成分镜表' }}
            </button>
          </footer>
        </section>
      </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'

const props = defineProps<{
  open: boolean
  busy: boolean
  story: string
  count: number | null
  total: number | null
  countOptions: StudioSelectOption[]
  totalOptions: StudioSelectOption[]
  referenceLabels: string[]
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'submit'): void
  (event: 'update:story', value: string): void
  (event: 'update:count', value: number | null): void
  (event: 'update:total', value: number | null): void
}>()

const dialogEl = ref<HTMLElement | null>(null)
const storyInputEl = ref<HTMLElement | null>(null)
useFocusTrap(dialogEl, () => props.open, {
  onEscape: () => emit('close'),
  initialFocus: storyInputEl,
})

function inputValue(event: Event): string {
  return (event.target as HTMLTextAreaElement).value
}

function nullableNumber(value: string | number): number | null {
  return value === '' ? null : Number(value)
}
</script>

<style scoped src="@/assets/css/shot-script-dialog.css"></style>
