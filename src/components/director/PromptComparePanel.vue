<template>
  <div class="pb-compare-overlay" @click.self="$emit('close')">
    <div ref="dialog" class="pb-compare" role="dialog" aria-modal="true" aria-label="出图对比">
      <div class="pb-compare-head">
        <div><div class="pb-compare-kicker">COMPARE</div><h3>画面对比</h3></div>
        <button ref="closeButton" class="btn btn-ghost btn-sm btn-compare-close" type="button" aria-label="关闭" @click="$emit('close')">
          <ArchiveIcon name="close" /> <span>关闭</span>
        </button>
      </div>
      <div class="pb-compare-grid" role="region" aria-label="对比画面与生成参数" tabindex="0">
        <figure v-for="(snap, index) in [previous, current]" :key="index" class="pb-compare-card">
          <div class="pb-compare-visual" :style="{ '--snapshot-ratio': snapshotRatio(snap.size) }" tabindex="-1" role="group" :aria-label="index === 0 ? '上一张画面' : '当前画面'" :aria-busy="!!previews[index]!.src.value && !previews[index]!.loaded.value && !previews[index]!.failed.value">
            <img v-if="previews[index]!.src.value && !previews[index]!.failed.value" v-bind="previews[index]!.image.value" :alt="index === 0 ? '上一张生成结果' : '当前生成结果'" decoding="async" :class="{ 'is-ready': previews[index]!.loaded.value }" />
            <div v-if="!previews[index]!.loaded.value" class="pb-compare-feedback" role="status"><ArchiveIcon :name="previews[index]!.failed.value ? 'warning' : 'image'" /><span>{{ previews[index]!.failed.value ? '加载失败' : previews[index]!.src.value ? '加载中…' : '无画面' }}</span><button v-if="previews[index]!.failed.value" class="btn btn-ghost btn-sm" type="button" @click="retryImage(index, $event)">重新读取</button></div>
            <span class="pb-compare-tag" :class="{ current: index === 1 }">{{ index === 0 ? '上一张' : '当前' }}</span>
          </div>
          <figcaption class="pb-compare-facts">
            <span>Seed {{ snap.seed ?? '随机' }}</span><span>{{ snap.size }}</span><span>{{ snap.sampler }}</span>
            <span>CFG {{ snap.cfg }}</span><span>Steps {{ snap.steps }}</span><span>Hires {{ snap.hires }}</span>
            <span class="pb-compare-time">{{ snap.at }}</span>
          </figcaption>
        </figure>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import type { ResultSnapshot } from '@/composables/prompt/promptResultSnapshot'

const props = defineProps<{ open: boolean; previous: ResultSnapshot; current: ResultSnapshot }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const previews = [useRuntimeImage(() => props.previous.url), useRuntimeImage(() => props.current.url)]
function snapshotRatio(size: string) {
  const dimensions = /^(\d+)\s*[x×]\s*(\d+)$/.exec(size)
  return dimensions && Number(dimensions[1]) > 0 && Number(dimensions[2]) > 0 ? `${dimensions[1]}/${dimensions[2]}` : '4/3'
}
function retryImage(index: number, event: MouseEvent) {
  if (document.activeElement === event.currentTarget && event.currentTarget instanceof HTMLElement) event.currentTarget.closest<HTMLElement>('.pb-compare-visual')?.focus({ preventScroll: true })
  previews[index]?.retry()
}

useFocusTrap(dialog, () => props.open, {
  onEscape: () => emit('close'),
  initialFocus: closeButton,
})

</script>
<style>
@reference "../../assets/css/tailwind.css";
.pb-compare { box-sizing:border-box; width:min(1320px, 100%); max-height:min(92dvh, calc(100dvh - var(--desktop-chrome-height, 0px) - 2 * var(--s-4))); @apply tw:flex tw:flex-col tw:min-h-0 tw:overflow-hidden tw:p-s-5; border:1px solid var(--border-soft); @apply tw:rounded-stage; background:var(--bg-surface); @apply tw:text-primary; box-shadow:var(--shadow-lg); transform-origin:center; }
.pb-compare-head { flex:0 0 auto; @apply tw:flex tw:items-center tw:justify-between tw:gap-s-4 tw:mb-s-4; }
.pb-compare-kicker { @apply tw:text-muted; font:700 var(--fs-mono-xs) var(--font-mono); letter-spacing:.12em; }
.pb-compare-head h3 { margin:2px 0 0; @apply tw:text-title; }
.pb-compare-head .btn-compare-close { @apply tw:inline-flex tw:shrink-0 tw:items-center tw:gap-[4px] tw:rounded-md; }
.pb-compare-grid { @apply tw:grid tw:min-h-0 tw:overflow-y-auto; grid-template-columns:minmax(0,1fr) minmax(0,1fr); @apply tw:gap-s-4; align-items:start; overscroll-behavior:contain; scrollbar-gutter:stable; scroll-padding-block:var(--s-2); }
.pb-compare-grid:focus-visible { outline:none; border-radius:var(--r-lg); box-shadow:var(--focus-shadow); }
.pb-compare-card { @apply tw:min-w-0; border:1px solid var(--border-soft); @apply tw:rounded-2xl tw:overflow-hidden; background:var(--bg-elevated); }
.pb-compare-visual { @apply tw:relative; background:var(--art-backdrop); display:grid; grid-template:minmax(0,1fr)/minmax(0,1fr); place-items:center; aspect-ratio:var(--snapshot-ratio,4/3); max-height:72vh; @apply tw:p-s-2; }
.pb-compare-visual > img,.pb-compare-feedback { grid-area:1/1; }
.pb-compare-visual img { display:block; width:100%; height:100%; min-height:0; object-fit:contain; opacity:0; transition:opacity var(--motion-surface) var(--ease-out); }
.pb-compare-visual img.is-ready { opacity:1; }
.pb-compare-feedback { display:flex; flex-direction:column; align-items:center; gap:var(--s-3); max-width:100%; padding:var(--s-4); color:var(--text-secondary); font-size:var(--fs-label); text-align:center; }
.pb-compare-feedback > .archive-icon { width:28px; height:28px; color:var(--accent); }
.pb-compare-visual:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.pb-compare-tag { @apply tw:absolute tw:top-s-3 tw:left-s-3; padding:2px var(--s-3); @apply tw:rounded-pill; background:var(--bg-surface); @apply tw:text-secondary; font:700 var(--fs-mono-sm) var(--font-mono); }
.pb-compare-tag.current { background:var(--accent); @apply tw:text-inverse; }
.pb-compare-facts { @apply tw:flex tw:flex-wrap tw:gap-s-2 tw:p-s-3; }
.pb-compare-facts span { min-width:0; max-width:100%; overflow-wrap:anywhere; padding:2px var(--s-2); border:1px solid var(--border-soft); @apply tw:rounded-pill tw:text-secondary; font:600 var(--fs-mono-xs) var(--font-mono); }
.pb-compare-facts .pb-compare-time { @apply tw:text-muted; }
@media (max-width: 900px) { .pb-compare-grid { grid-template-columns:1fr; } .pb-compare-visual { max-height:56vh; } }
@media (forced-colors:active) { .pb-compare-visual:focus-visible { outline:2px solid Highlight; outline-offset:-2px; } }
.pb-compare-overlay { @apply tw:fixed; inset:var(--desktop-chrome-height, 0px) 0 0; z-index:var(--z-overlay); @apply tw:grid; place-items:center; @apply tw:p-s-4; background:color-mix(in srgb, var(--art-backdrop) 78%, transparent); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
</style>
