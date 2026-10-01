<template>
  <nav class="shot-storyboard tw:min-w-0 tw:max-w-full tw:p-s-4 tw:rounded-lg" aria-label="镜头首帧总览">
    <header><div><span class="storyboard-kicker tw:text-accent tw:text-body-sm">STORYBOARD / 镜头手帖</span><h3>先看顺序，再推敲每一镜。</h3></div><span class="storyboard-total tw:text-secondary tw:text-body-sm">{{ shots.length }} 镜 · {{ totalDuration }} 秒</span></header>
    <div class="storyboard-frames tw:flex tw:min-w-0 tw:max-w-full tw:gap-s-3 tw:overflow-x-auto">
      <button v-for="(shot, index) in shots" :key="index" type="button" class="storyboard-frame tw:flex tw:min-w-0 tw:p-0 tw:rounded-md tw:overflow-hidden tw:text-primary tw:cursor-pointer tw:text-left" :aria-label="`查看镜头 ${index + 1}`" @click="emit('locate', index)">
        <span class="storyboard-media tw:block tw:w-full tw:overflow-hidden">
          <img :crossorigin="runtimeResourceCors()" v-if="shot.imageUrl && !failedSources.has(shot.imageUrl)" :key="shot.imageUrl" :src="resolveRuntimeUrl(shot.imageUrl)" :alt="`镜头 ${index + 1} 首帧`" loading="lazy" decoding="async" @error="markFailed" />
          <span v-else class="storyboard-placeholder tw:flex tw:h-full tw:items-center tw:justify-center tw:flex-col tw:gap-s-2 tw:text-secondary tw:text-body-sm"><ArchiveIcon :name="shot.shotSize === 'wide' ? 'wideshot' : shot.shotSize === 'closeup' ? 'closeup' : 'midshot'" /><span>{{ shot.imageUrl ? '首帧暂不可读' : '待补首帧' }}</span></span>
        </span>
        <span class="storyboard-caption tw:flex tw:flex-wrap tw:justify-between tw:gap-s-2 tw:text-body-sm"><strong>镜头 {{ String(index + 1).padStart(2, '0') }}</strong><span>{{ shot.duration }} 秒 · {{ sizeLabel(shot.shotSize) }}</span></span>
        <span class="storyboard-description tw:overflow-hidden tw:text-secondary tw:text-body-sm tw:leading-body">{{ shot.prompt.trim() || '还没有画面描述' }}</span>
      </button>
    </div>
    <p>点击卡片，前往对应镜头。首帧会按原画幅完整展示。</p>
  </nav>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const props = defineProps<{ shots: readonly { imageUrl?: string; prompt: string; duration: number; shotSize: string }[] }>()
const emit = defineEmits<{ locate: [index: number] }>()
const failedSources = ref(new Set<string>())
const totalDuration = computed(() => props.shots.reduce((sum, shot) => sum + shot.duration, 0))
function sizeLabel(value: string) { return ({ wide:'全景', medium:'中景', closeup:'特写' } as Record<string, string>)[value] || '默认景别' }
function markFailed(event: Event) {
  const src = (event.currentTarget as HTMLImageElement).getAttribute('src')
  if (src) failedSources.value.add(src)
}
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.shot-storyboard { margin:0 0 var(--s-2); border:0; background:var(--bg-surface); }
.shot-storyboard header { @apply tw:flex tw:justify-between tw:items-center tw:flex-wrap tw:gap-s-3 tw:mb-s-3; }
.storyboard-kicker { letter-spacing:.05em; font-size:var(--fs-label-xs); }
.shot-storyboard h3 { margin:var(--s-1) 0 0; @apply tw:text-primary; font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.storyboard-frames { padding:var(--s-1) var(--s-1) var(--s-3); scroll-snap-type:x proximity; scrollbar-width:thin; }
.storyboard-frame { @apply tw:flex-col; flex:0 0 200px; border:1px solid transparent; background:var(--bg-base); font:inherit; scroll-snap-align:start; }
.storyboard-media { aspect-ratio:16 / 10; background:var(--bg-deep); }
.storyboard-media img { @apply tw:block tw:w-full tw:h-full tw:object-contain; }
.storyboard-placeholder .archive-icon { @apply tw:w-[36px] tw:h-[36px] tw:text-accent; }
.storyboard-caption { padding:var(--s-3) var(--s-3) var(--s-1); }
.storyboard-caption > span { @apply tw:text-secondary tw:text-label-xs; }
.storyboard-description { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; margin:0 var(--s-3) var(--s-3); }
.shot-storyboard > p { @apply tw:mt-s-2 tw:text-secondary tw:text-body-sm; }
.storyboard-frame:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media(hover:hover) and (pointer:fine) { .storyboard-frame:hover { @apply tw:border-accent; } }
@media(max-width:540px) { .shot-storyboard { @apply tw:p-s-3; } .storyboard-frame { flex-basis:176px; } }
</style>
