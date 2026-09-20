<template>
  <section class="character-particle-stage" :style="{ '--portrait-accent': theme.accent }" :aria-label="`${name}的形象展台`">
    <header class="portrait-stage-heading">
      <div><span class="portrait-stage-kicker">光点成像 · CHARACTER PORTRAIT</span><h2>{{ name }}</h2></div>
      <div class="portrait-stage-modes" role="group" aria-label="形象展示方式">
        <button type="button" :aria-pressed="!showOriginal" :disabled="!loading && !available" @click="mode = 'particles'"><ArchiveIcon name="spark" />粒子形象</button>
        <button type="button" :aria-pressed="showOriginal" @click="mode = 'original'"><ArchiveIcon name="image" />人物原画</button>
      </div>
      <div v-if="!showOriginal" class="portrait-stage-controls">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="loading || !available" @click="field?.replay()"><ArchiveIcon name="refresh" />重新聚拢</button>
        <button type="button" class="btn btn-ghost btn-sm" :aria-pressed="paused" @click="paused = !paused">{{ paused ? '继续动态' : '暂停动态' }}</button>
      </div>
    </header>
    <div v-show="!showOriginal" class="particle-theatre" :aria-busy="loading">
      <SemanticParticleField ref="field" v-show="available" :shape="theme.shape" :portrait-id="characterId" :label="`${name}的人物粒子形象`" density="hero" bare :paused="paused" />
      <div v-if="loading" class="particle-loading" role="status"><ArchiveIcon name="spark" /><span>正在聚拢{{ name }}的光点…</span></div>
    </div>
    <div v-show="showOriginal" class="stage-original"><slot /></div>
    <footer class="portrait-stage-footer">
      <p v-if="!loading && !available" role="status">这位角色的粒子形象暂不可用，先欣赏人物原画。</p>
      <p v-else>{{ showOriginal ? '从原画里的色彩与轮廓，走进她的故事。' : paused ? '光点已定格，可以安静欣赏每一处细节。' : '移动指针，让光点散开、再聚成她的模样。' }}</p>
    </footer>
    <p class="portrait-stage-note">切换左侧角色，光点也随之变换。减少动态效果时保留静态形象。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { characterParticleTheme } from '@/utils/characterParticleTheme'
import { loadPortraitCloud } from '@/utils/particlePortrait'

const SemanticParticleField = defineAsyncComponent(() => import('@/components/visual/SemanticParticleField.vue'))
const props = defineProps<{ characterId: string; name: string }>()
const theme = computed(() => characterParticleTheme(props.characterId))
const mode = ref<'particles' | 'original'>('particles')
const paused = ref(false)
const available = ref(false)
const loading = ref(true)
const field = ref<{ replay: () => void }>()
const showOriginal = computed(() => mode.value === 'original' || (!loading.value && !available.value))
watch(() => props.characterId, async (id, _old, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  loading.value = true
  const cloud = await loadPortraitCloud(id)
  if (cancelled) return
  available.value = !!cloud
  loading.value = false
}, { immediate: true })
</script>

<style scoped>
.character-particle-stage { min-width:0; overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); }
.portrait-stage-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-4); padding:var(--s-5) var(--s-6); border-bottom:1px solid var(--border-soft); }
.portrait-stage-kicker { color:var(--text-secondary); font:500 var(--fs-mono-xs) var(--font-mono); letter-spacing:.1em; }
.portrait-stage-heading h2 { margin:var(--s-2) 0 0; color:var(--text-primary); font-size:var(--fs-title); font-weight:600; }
.portrait-stage-modes { display:flex; gap:var(--s-1); padding:var(--s-1); border:1px solid var(--border-soft); border-radius:var(--r-pill); background:var(--bg-base); }
.portrait-stage-modes button { display:flex; align-items:center; gap:var(--s-2); min-height:40px; padding:var(--s-2) var(--s-3); border:1px solid transparent; border-radius:var(--r-pill); background:transparent; color:var(--text-secondary); font:500 var(--fs-label) var(--font-sans); cursor:pointer; }
.portrait-stage-modes button[aria-pressed='true'] { color:var(--text-primary); border-color:var(--border-strong); background:var(--bg-surface); box-shadow:var(--shadow-sm); }
.portrait-stage-modes button:disabled { color:var(--text-disabled); cursor:default; }
.portrait-stage-modes button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.particle-theatre { position:relative; height:clamp(440px,65dvh,760px); background:radial-gradient(ellipse at 50% 48%,color-mix(in srgb,var(--portrait-accent) 8%,transparent),transparent 70%),var(--bg-base); }
.particle-theatre :deep(.semantic-particle-field) { --particle-accent:var(--portrait-accent); width:100%; height:100%; min-height:0; background:none; }
.particle-loading { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:var(--s-3); color:var(--text-secondary); font-size:var(--fs-body-sm); }
.stage-original :deep(.portrait) { border:0; border-radius:0; }
.stage-original :deep(.portrait-image) { width:100%; height:clamp(440px,65dvh,760px); max-height:none; object-fit:contain; }
.portrait-stage-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-3); padding:var(--s-4) var(--s-5); border-top:1px solid var(--border-soft); }
.portrait-stage-footer p { margin:0; color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-body); }
.portrait-stage-controls { display:flex; gap:var(--s-2); }
.portrait-stage-note { margin:0; padding:0 var(--s-5) var(--s-4); color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); }
@media(max-width:600px) { .portrait-stage-heading { padding:var(--s-4); } .particle-theatre { height:440px; } .portrait-stage-footer { padding:var(--s-3); } .portrait-stage-note { padding-inline:var(--s-3); } .portrait-stage-controls { width:100%; } }
</style>
