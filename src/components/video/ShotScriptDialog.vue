<template>
  <Teleport to="body">
    <FluidTransition>
      <div v-if="open" class="shot-script-overlay" @click.self="emit('close')">
        <section ref="dialogEl" class="shot-script-panel" role="dialog" aria-modal="true" aria-labelledby="shot-script-title">
          <header class="shot-script-head">
            <div>
              <span class="shot-script-kicker"><ArchiveIcon name="wand" /> 脚本生成</span>
              <h2 id="shot-script-title">生成分镜表</h2>
            </div>
            <button class="btn btn-quiet btn-icon" type="button" aria-label="关闭分镜脚本窗口" @click="emit('close')"><ArchiveIcon name="close" /></button>
          </header>
          <div class="shot-script-body">
            <label class="field">
              <span class="field-label">故事梗概</span>
              <textarea
                ref="storyInputEl"
                :value="story"
                class="textarea"
                rows="5"
                maxlength="2000"
                placeholder="输入故事梗概，如：角色在咖啡店值班，打烊前收到旧信并决定寻找来信者……"
                spellcheck="false"
                autocorrect="off"
                autocapitalize="off"
                @input="emit('update:story', inputValue($event))"
              ></textarea>
            </label>
            <div class="shot-script-row">
              <label class="field">
                <span class="field-label">镜头数</span>
                <StudioSelect label="镜头数" :model-value="count ?? ''" :options="countOptions" @update:model-value="emit('update:count', nullableNumber($event))" />
              </label>
              <label class="field">
                <span class="field-label">总时长（秒）</span>
                <StudioSelect label="总时长（秒）" :model-value="total ?? ''" :options="totalOptions" @update:model-value="emit('update:total', nullableNumber($event))" />
              </label>
            </div>
            <details class="shot-script-help"><StudioDisclosureSummary>分镜说明</StudioDisclosureSummary><p data-disclosure-content>自动规划景别、运镜、台词与时长，支持纯文本（T2VA）及图生视频。</p></details>
            <p v-if="referenceLabels.length" class="shot-script-hint">参考角色：{{ referenceLabels.join('、') }}</p>
          </div>
          <footer class="shot-script-foot">
            <p class="shot-script-feedback" role="status">{{ note }}</p>
            <button class="btn btn-ghost" type="button" @click="emit('close')">{{ busy ? '关闭' : '取消' }}</button>
            <button class="btn btn-primary" type="button" :disabled="!story.trim()" :aria-disabled="busy || undefined" :aria-busy="busy" @click="!busy && emit('submit')">
              {{ busy ? '生成中…' : '生成分镜表' }}
            </button>
          </footer>
        </section>
      </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { onDeactivated, ref } from 'vue'
import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'

const props = defineProps<{
  open: boolean
  busy: boolean
  note: string
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

onDeactivated(() => { if (props.open) emit('close') })
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
