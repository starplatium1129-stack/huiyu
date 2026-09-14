<template>
  <div class="pb-compare-overlay" @click.self="$emit('close')">
    <div ref="dialog" class="pb-compare" role="dialog" aria-modal="true" aria-label="出图对比">
      <div class="pb-compare-head">
        <div><div class="pb-compare-kicker">绘遇 · 画面对照</div><h3>与上一张对比</h3></div>
        <button ref="closeButton" class="btn btn-ghost btn-sm btn-compare-close" type="button" aria-label="关闭出图对比" @click="$emit('close')">
          <ArchiveIcon name="close" /> <span>关闭</span>
        </button>
      </div>
      <div class="pb-compare-grid">
        <figure v-for="(snap, index) in [previous, current]" :key="index" class="pb-compare-card">
          <div class="pb-compare-visual">
            <img :src="snap.url" :alt="'对比图 ' + (index + 1)" loading="eager" decoding="async" />
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
.pb-compare { width:min(1320px, 96vw); max-height:92vh; overflow-y:auto; padding:var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-stage); background:var(--bg-surface); color:var(--text-primary); box-shadow:var(--shadow-lg); transform-origin:center; }
.pb-compare-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--s-4); }
.pb-compare-kicker { color:var(--text-muted); font:700 var(--fs-mono-xs) var(--font-mono); letter-spacing:.12em; }
.pb-compare-head h3 { margin:2px 0 0; font-size:var(--fs-title); }
.pb-compare-head .btn-compare-close { display:inline-flex; align-items:center; gap:4px; border-radius:var(--r-md); }
.pb-compare-grid { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-4); align-items:start; }
.pb-compare-card { min-width:0; border:1px solid var(--border-soft); border-radius:var(--r-2xl); overflow:hidden; background:var(--bg-elevated); }
.pb-compare-visual { position:relative; background:var(--art-backdrop); display:grid; place-items:center; padding:var(--s-2); }
.pb-compare-visual img { display:block; max-width:100%; max-height:72vh; width:auto; height:auto; object-fit:contain; }
.pb-compare-tag { position:absolute; top:var(--s-3); left:var(--s-3); padding:2px var(--s-3); border-radius:var(--r-pill); background:var(--bg-surface); color:var(--text-secondary); font:700 var(--fs-mono-sm) var(--font-mono); }
.pb-compare-tag.current { background:var(--accent); color:var(--text-inverse); }
.pb-compare-facts { display:flex; flex-wrap:wrap; gap:var(--s-2); padding:var(--s-3); }
.pb-compare-facts span { padding:2px var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-pill); color:var(--text-secondary); font:600 var(--fs-mono-xs) var(--font-mono); }
.pb-compare-facts .pb-compare-time { color:var(--text-muted); }
@media (max-width: 900px) { .pb-compare-grid { grid-template-columns:1fr; } .pb-compare-visual img { max-height:56vh; } }
.pb-compare-overlay { position:fixed; inset:0; z-index:var(--z-overlay); display:grid; place-items:center; padding:var(--s-4); background:color-mix(in srgb, var(--art-backdrop) 78%, transparent); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
</style>
