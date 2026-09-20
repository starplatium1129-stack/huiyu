<template>
  <nav class="shot-storyboard" aria-label="镜头首帧总览">
    <header><div><span class="storyboard-kicker">STORYBOARD / 镜头手帖</span><h3>先看顺序，再推敲每一镜。</h3></div><span class="storyboard-total">{{ shots.length }} 镜 · {{ totalDuration }} 秒</span></header>
    <div class="storyboard-frames">
      <button v-for="(shot, index) in shots" :key="index" type="button" class="storyboard-frame" :aria-label="`查看镜头 ${index + 1}`" @click="emit('locate', index)">
        <span class="storyboard-media">
          <img v-if="shot.imageUrl && !failedSources.has(shot.imageUrl)" :key="shot.imageUrl" :src="shot.imageUrl" :alt="`镜头 ${index + 1} 首帧`" loading="lazy" decoding="async" @error="markFailed" />
          <span v-else class="storyboard-placeholder"><ArchiveIcon :name="shot.shotSize === 'wide' ? 'wideshot' : shot.shotSize === 'closeup' ? 'closeup' : 'midshot'" /><span>{{ shot.imageUrl ? '首帧暂不可读' : '待补首帧' }}</span></span>
        </span>
        <span class="storyboard-caption"><strong>镜头 {{ String(index + 1).padStart(2, '0') }}</strong><span>{{ shot.duration }} 秒 · {{ sizeLabel(shot.shotSize) }}</span></span>
        <span class="storyboard-description">{{ shot.prompt.trim() || '还没有画面描述' }}</span>
      </button>
    </div>
    <p>点击卡片，前往对应镜头。首帧会按原画幅完整展示。</p>
  </nav>
</template>

<script setup lang="ts">
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
.shot-storyboard { min-width:0; max-width:100%; margin:var(--s-4) 0 var(--s-5); padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.shot-storyboard header { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:var(--s-3); margin-bottom:var(--s-3); }
.storyboard-kicker { color:var(--accent); font-size:var(--fs-body-sm); letter-spacing:.05em; }
.shot-storyboard h3 { margin:var(--s-1) 0 0; color:var(--text-primary); font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.storyboard-total { color:var(--text-secondary); font-size:var(--fs-body-sm); }
.storyboard-frames { display:flex; min-width:0; max-width:100%; gap:var(--s-3); overflow-x:auto; padding:var(--s-1) var(--s-1) var(--s-3); scroll-snap-type:x proximity; scrollbar-width:thin; }
.storyboard-frame { display:flex; flex-direction:column; flex:0 0 200px; min-width:0; padding:0; border:1px solid var(--border-soft); border-radius:var(--r-md); overflow:hidden; background:var(--bg-surface); color:var(--text-primary); cursor:pointer; text-align:left; font:inherit; scroll-snap-align:start; }
.storyboard-media { display:block; aspect-ratio:16 / 10; width:100%; overflow:hidden; background:var(--bg-deep); }
.storyboard-media img { display:block; width:100%; height:100%; object-fit:contain; }
.storyboard-placeholder { display:flex; height:100%; align-items:center; justify-content:center; flex-direction:column; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-body-sm); }
.storyboard-placeholder .archive-icon { width:36px; height:36px; color:var(--accent); }
.storyboard-caption { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--s-2); padding:var(--s-3) var(--s-3) var(--s-1); font-size:var(--fs-body-sm); }
.storyboard-caption > span { color:var(--text-secondary); }
.storyboard-description { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin:0 var(--s-3) var(--s-3); color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-body); }
.shot-storyboard > p { margin-top:var(--s-2); color:var(--text-secondary); font-size:var(--fs-body-sm); }
.storyboard-frame:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media(hover:hover) { .storyboard-frame:hover { border-color:var(--accent); } }
@media(max-width:540px) { .shot-storyboard { padding:var(--s-3); } .storyboard-frame { flex-basis:176px; } }
</style>
