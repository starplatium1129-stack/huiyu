<script setup lang="ts">
import type { VideoBatch, VideoQuality, VideoQualityOption } from '@/api/videoApi'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'

defineProps<{ disabled: boolean; qualities: VideoQualityOption[] }>()
const aspectRatio = defineModel<VideoBatch['aspectRatio']>('aspectRatio', { required: true })
const quality = defineModel<VideoQuality>('quality', { required: true })
const linkLastFrame = defineModel<boolean>('linkLastFrame', { required: true })
const steps = defineModel<4 | 8>('steps', { required: true })
const identityCard = defineModel<string>('identityCard', { required: true })

const aspectOptions: Array<{
    id: VideoBatch['aspectRatio'];
    label: string;
}> = [
    { id: 'landscape', label: '横屏 16:9' },
    { id: 'portrait', label: '竖屏 9:16' },
    { id: 'square', label: '方形 1:1' },
];
</script>

<template>
  <div class="video-choice-group">
    <span class="field-label">统一画幅</span>
    <div class="video-segmented studio-segments studio-segments--compact" role="group" aria-label="选择分镜画幅">
      <AnimatedSelection />
      <button
        v-for="item in aspectOptions"
        :key="item.id"
        type="button"
        :class="{ active: aspectRatio === item.id }"
        :aria-pressed="aspectRatio === item.id"
        :disabled="disabled"
        @click="aspectRatio = item.id"
      >{{ item.label }}</button>
    </div>
  </div>

  <div class="video-quality-row">
    <span class="field-label">画质档位</span>
    <div class="video-quality-grid" role="group" aria-label="选择视频画质档位">
      <button
        v-for="item in qualities"
        :key="item.id"
        type="button"
        :class="{ active: quality === item.id }"
        :aria-pressed="quality === item.id"
        :disabled="disabled"
        @click="quality = item.id"
      >
        <strong>{{ item.label }}</strong>
        <em>{{ item.sizes[aspectRatio] }}</em>
      </button>
    </div>
  </div>

  <div class="shot-options">
    <ToggleSwitch
      :model-value="linkLastFrame"
      :disabled="disabled"
      label="自动衔接上一镜尾帧"
      @update:model-value="linkLastFrame = $event"
    >
      <span>
        <strong>自动衔接上一镜尾帧</strong>
      </span>
    </ToggleSwitch>

    <slot name="recipe">
    <ToggleSwitch
      :model-value="steps === 4"
      :disabled="disabled"
      label="极速 4 步（整批）"
      @update:model-value="steps = $event ? 4 : 8"
    >
      <span>
        <strong>极速 4 步（整批）</strong>
        <small>更快生成预览，画面细节会略有减少。</small>
      </span>
    </ToggleSwitch>
    </slot>
  </div>

  <label class="field shot-identity-field">
    <span class="field-label">各镜头共用的角色描述</span>
    <textarea
      v-model="identityCard"
      :disabled="disabled"
      class="textarea"
      rows="2"
      maxlength="600"
      placeholder="英文身份锚点：a girl with long silver hair and red eyes, wearing a dark coat …"
      spellcheck="false"
      autocorrect="off"
      autocapitalize="off"
    ></textarea>
  </label>
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.video-choice-group { @apply tw:grid tw:gap-s-2; }
.video-quality-row { @apply tw:grid tw:gap-s-2 tw:mt-s-4; }
.video-quality-grid { @apply tw:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); @apply tw:gap-s-2; }
.video-quality-grid button {
  @apply tw:grid tw:gap-[4px] tw:min-h-[66px]; padding: var(--s-2) var(--s-3);
  border:1px solid transparent; @apply tw:rounded-md;
  background:var(--bg-base); @apply tw:text-secondary tw:text-left tw:cursor-pointer;
}
.video-quality-grid button.active { @apply tw:border-strong; background:var(--bg-elevated); @apply tw:text-primary; }
.video-quality-grid strong { @apply tw:text-body-sm; }
.video-quality-grid em { @apply tw:text-accent; font: 600 var(--fs-mono-xs) var(--font-mono); @apply tw:not-italic; }
.video-segmented { @apply tw:inline-flex tw:flex-wrap tw:p-s-1; border:0; @apply tw:rounded-md; background:var(--bg-base); }
.video-segmented button { @apply tw:min-h-[32px]; padding: 0 var(--s-3); border: 0; @apply tw:rounded-sm; background: transparent; @apply tw:text-muted tw:cursor-pointer; }
.video-segmented button.active { background:var(--bg-elevated); @apply tw:text-primary; }
.video-quality-grid button:disabled,.video-segmented button:disabled { color:var(--text-disabled); background:var(--bg-elevated); border-color:var(--border-soft); cursor:not-allowed; }
.video-quality-grid button:disabled em,.shot-options :deep([data-disabled] small) { color:var(--text-disabled); }
.shot-options { display:grid; gap:var(--s-3); margin-top:var(--s-4); }
.shot-options strong, .shot-options small { @apply tw:block; }
.shot-options small { @apply tw:mt-[3px] tw:text-muted tw:text-label-xs tw:leading-body; }
.shot-identity-field { @apply tw:grid tw:gap-s-2 tw:mt-s-4; }
@container (max-width:620px) {
  .video-quality-grid { grid-template-columns:minmax(0,1fr); }
}
</style>
