<template>
  <section class="character-particle-stage tw:min-w-0 tw:overflow-hidden tw:rounded-lg" :style="{ '--archive-blue': theme.accent, '--character-aura': theme.aura }" :aria-label="`${name}的形象展台`">
    <header class="portrait-stage-heading tw:flex tw:items-center tw:justify-between tw:flex-wrap tw:gap-s-4">
      <div><span class="portrait-stage-kicker tw:text-secondary">角色画页</span><h2>{{ name }}</h2></div>
      <div class="portrait-stage-modes studio-segments tw:flex tw:gap-s-1 tw:p-s-1 tw:rounded-pill" role="group" aria-label="形象展示方式">
        <AnimatedSelection />
        <button type="button" :aria-pressed="!showOriginal" :disabled="!loading && !available" @click="mode = 'particles'"><ArchiveIcon name="spark" />粒子形象</button>
        <button type="button" :aria-pressed="showOriginal" @click="mode = 'original'"><ArchiveIcon name="image" />人物原画</button>
      </div>
    </header>
    <div class="portrait-stage-canvas">
    <div v-show="!showOriginal" class="particle-theatre tw:relative" :aria-busy="loading">
      <SemanticParticleField v-show="available" :shape="theme.shape" :portrait-id="characterId" :label="`${name}的人物粒子形象`" :caption="name" density="ambient" :portrait-reference-size="referenceSize" />
      <div v-if="loading" class="particle-loading tw:absolute tw:flex tw:items-center tw:justify-center tw:gap-s-3 tw:text-secondary tw:text-body-sm" role="status"><ArchiveIcon name="spark" /><span>正在聚拢{{ name }}的光点…</span></div>
    </div>
    <div v-show="showOriginal" class="stage-original"><slot /></div>
    </div>
    <footer class="portrait-stage-footer tw:flex tw:items-center tw:justify-between tw:flex-wrap tw:gap-s-3">
      <p v-if="!loading && !available" role="status">这位角色的粒子形象暂不可用，先欣赏人物原画。</p>
      <p v-else>{{ showOriginal ? '从原画里的色彩与轮廓，走进她的故事。' : '移动指针，让光点散开、再聚成她的模样。' }}</p>
    </footer>
    <p class="portrait-stage-note tw:m-0 tw:text-secondary tw:text-label-xs tw:leading-body">换一位主角，光点也随之变换。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { characterParticleTheme } from '@/utils/characterParticleTheme'
import { loadPortraitCloud, portraitCloudIdentity } from '@/utils/particlePortrait'

const SemanticParticleField = defineAsyncComponent(() => import('@/components/visual/SemanticParticleField.vue'))
const props = defineProps<{ characterId: string; name: string; initialOriginal?: boolean }>()
const theme = computed(() => characterParticleTheme(props.characterId))
// The removed desktop scene portrait used a 330px-high field and 6000 points.
const referenceSize = { width: 500, height: 330 }
const mode = ref<'particles' | 'original'>(props.initialOriginal ? 'original' : 'particles')
const available = ref(false)
const loading = ref(true)
const showOriginal = computed(() => mode.value === 'original' || (!loading.value && !available.value))
watch(() => portraitCloudIdentity(props.characterId), async (_identity, _old, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  loading.value = true
  const cloud = await loadPortraitCloud(props.characterId)
  if (cancelled) return
  available.value = !!cloud
  loading.value = false
}, { immediate: true })
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.character-particle-stage { border:1px solid var(--border-soft); background:var(--bg-surface); }
.portrait-stage-heading { padding:var(--s-4) var(--s-5); }
.portrait-stage-kicker { font:500 var(--fs-mono-xs) var(--font-mono); letter-spacing:.1em; }
.portrait-stage-heading h2 { margin:var(--s-1) 0 0; @apply tw:text-primary tw:text-body-lg tw:font-semibold; }
.portrait-stage-modes { border:1px solid transparent; background:var(--bg-base); }
.portrait-stage-modes button { @apply tw:flex tw:items-center tw:gap-s-2 tw:min-h-[40px]; padding:var(--s-2) var(--s-3); border:1px solid transparent; @apply tw:rounded-pill; background:transparent; @apply tw:text-secondary; font:500 var(--fs-label) var(--font-sans); @apply tw:cursor-pointer; }
.portrait-stage-modes button[aria-pressed='true'] { @apply tw:text-primary tw:border-strong; background:var(--bg-surface); box-shadow:var(--shadow-sm); }
.portrait-stage-modes button:disabled { @apply tw:text-disabled tw:cursor-default; }
.portrait-stage-modes button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.portrait-stage-canvas { height:clamp(400px,55dvh,660px); }
.particle-theatre { height:100%; background:var(--bg-base); }
.particle-theatre :deep(.semantic-particle-field) { @apply tw:w-full tw:h-full tw:min-h-0; }
.particle-loading { inset:0; }
.stage-original { height:100%; }
.stage-original :deep(.portrait) { height:100%; border:0; border-radius:0; }
.stage-original :deep(.portrait-image) { @apply tw:w-full; height:0; flex:1 1 auto; min-height:0; max-height:none; @apply tw:object-contain; }
.stage-original :deep(.portrait-footer) { flex:none; }
.stage-original :deep(.portrait-missing) { flex:1; min-height:0; }
.portrait-stage-footer { padding:var(--s-4) var(--s-5); border-top:1px solid var(--border-soft); }
.portrait-stage-footer p { @apply tw:m-0 tw:text-secondary tw:text-body-sm tw:leading-body; }
.portrait-stage-note { padding:0 var(--s-5) var(--s-4); }
@media(max-width:600px) { .portrait-stage-heading { @apply tw:p-s-4; } .portrait-stage-footer { @apply tw:p-s-3; } .portrait-stage-note { padding-inline:var(--s-3); } }
</style>
