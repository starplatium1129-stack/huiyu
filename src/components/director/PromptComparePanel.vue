<template>
  <div class="pb-compare-overlay" @click.self="$emit('close')">
    <div ref="dialog" class="pb-compare" role="dialog" aria-modal="true" aria-label="出图对比">
      <div class="pb-compare-head">
        <div><div class="pb-compare-kicker">绘遇 · 画面对照</div><h3>与上一张对比</h3></div>
        <button ref="closeButton" class="btn btn-ghost btn-sm btn-compare-close" type="button" aria-label="关闭" @click="$emit('close')">
          <ArchiveIcon name="close" /> <span>关闭</span>
        </button>
      </div>
      <div class="pb-compare-grid">
        <figure v-for="(snap, index) in [previous, current]" :key="index" class="pb-compare-card">
          <div class="pb-compare-visual">
            <img :crossorigin="runtimeResourceCors()" :src="resolveRuntimeUrl(snap.url)" :alt="'对比图 ' + (index + 1)" loading="eager" decoding="async" />
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
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { onMounted, onBeforeUnmount, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import type { ResultSnapshot } from '@/composables/prompt/promptResultSnapshot'

defineProps<{ previous: ResultSnapshot; current: ResultSnapshot }>()
const emit = defineEmits<{ close: []; ready: [element: HTMLElement | null] }>()
const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)

useFocusTrap(dialog, () => true, {
  onEscape: () => emit('close'),
  initialFocus: closeButton,
})

onMounted(() => { emit('ready', dialog.value); closeButton.value?.focus({ preventScroll: true }) })
onBeforeUnmount(() => emit('ready', null))
</script>
<style>
@reference "../../assets/css/tailwind.css";
.pb-compare { width:min(1320px, 96vw); @apply tw:max-h-[92vh] tw:overflow-y-auto tw:p-s-5; border:1px solid var(--border-soft); @apply tw:rounded-stage; background:var(--bg-surface); @apply tw:text-primary; box-shadow:var(--shadow-lg); transform-origin:center; }
.pb-compare-head { @apply tw:flex tw:items-center tw:justify-between tw:mb-s-4; }
.pb-compare-kicker { @apply tw:text-muted; font:700 var(--fs-mono-xs) var(--font-mono); letter-spacing:.12em; }
.pb-compare-head h3 { margin:2px 0 0; @apply tw:text-title; }
.pb-compare-head .btn-compare-close { @apply tw:inline-flex tw:items-center tw:gap-[4px] tw:rounded-md; }
.pb-compare-grid { @apply tw:grid; grid-template-columns:1fr 1fr; @apply tw:gap-s-4; align-items:start; }
.pb-compare-card { @apply tw:min-w-0; border:1px solid var(--border-soft); @apply tw:rounded-2xl tw:overflow-hidden; background:var(--bg-elevated); }
.pb-compare-visual { @apply tw:relative; background:var(--art-backdrop); @apply tw:grid; place-items:center; @apply tw:p-s-2; }
.pb-compare-visual img { @apply tw:block tw:max-w-full tw:max-h-[72vh] tw:w-auto tw:h-auto tw:object-contain; }
.pb-compare-tag { @apply tw:absolute tw:top-s-3 tw:left-s-3; padding:2px var(--s-3); @apply tw:rounded-pill; background:var(--bg-surface); @apply tw:text-secondary; font:700 var(--fs-mono-sm) var(--font-mono); }
.pb-compare-tag.current { background:var(--accent); @apply tw:text-inverse; }
.pb-compare-facts { @apply tw:flex tw:flex-wrap tw:gap-s-2 tw:p-s-3; }
.pb-compare-facts span { padding:2px var(--s-2); border:1px solid var(--border-soft); @apply tw:rounded-pill tw:text-secondary; font:600 var(--fs-mono-xs) var(--font-mono); }
.pb-compare-facts .pb-compare-time { @apply tw:text-muted; }
@media (max-width: 900px) { .pb-compare-grid { grid-template-columns:1fr; } .pb-compare-visual img { @apply tw:max-h-[56vh]; } }
.pb-compare-overlay { @apply tw:fixed; inset:0; z-index:var(--z-overlay); @apply tw:grid; place-items:center; @apply tw:p-s-4; background:color-mix(in srgb, var(--art-backdrop) 78%, transparent); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
</style>
