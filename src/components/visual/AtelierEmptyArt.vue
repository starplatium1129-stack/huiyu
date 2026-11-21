<template>
  <Transition name="atelier-art-fade" mode="out-in">
    <img
      :key="artSrc"
      class="atelier-empty-art"
      :class="{ 'is-chibi': isChibiMode }"
      :src="artSrc"
      :width="dimensions.width"
      :height="dimensions.height"
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import studioOriginal from '@/assets/illustrations/atelier-studio-768.webp'
import neneHeader from '@/assets/illustrations/nene-moonlit-study-header-1024.webp'
import natsumeHeader from '@/assets/illustrations/natsume-rainy-cafe-header-1024.webp'
import neneStudyChibi from '../../../assets/chibi/nene-study.webp'
import neneHappyChibi from '../../../assets/chibi/nene-happy.webp'
import neneNightChibi from '../../../assets/chibi/nene-night.webp'
import natsumeCafeChibi from '../../../assets/chibi/natsume-cafe.webp'
import natsumeCoffeeChibi from '../../../assets/chibi/natsume-coffee.webp'
import natsumeFeedChibi from '../../../assets/chibi/natsume-feed.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'

export type AtelierChibiPose = 'study' | 'happy' | 'night' | 'cafe' | 'coffee' | 'feed'

const props = withDefaults(defineProps<{
  /** 角色语境（nene / natsume）；缺省展示默认画室书桌插画 */
  character?: string
  /** auto: 有角色时优先 Q 版轻贴纸，无角色时用书桌；illustration: 场景插画；chibi: Q 版轻贴纸 */
  variant?: 'auto' | 'illustration' | 'chibi'
  /** 指定 Q 版姿势，默认按角色自动匹配 */
  pose?: AtelierChibiPose
}>(), {
  character: '',
  variant: 'auto',
  pose: undefined,
})

const CHIBI_BY_POSE: Record<AtelierChibiPose, string> = {
  study: neneStudyChibi,
  happy: neneHappyChibi,
  night: neneNightChibi,
  cafe: natsumeCafeChibi,
  coffee: natsumeCoffeeChibi,
  feed: natsumeFeedChibi,
}

const DEFAULT_CHIBI: Record<string, string> = {
  nene: neneStudyChibi,
  natsume: natsumeCafeChibi,
}

const CHARACTER_ILLUSTRATIONS: Record<string, string> = {
  nene: neneHeader,
  natsume: natsumeHeader,
}

// Keep Terraria pixel illustration ownership through useThemeIllustration.
const terrariaOverride = useThemeIllustration('', 'draw')

const normalizedCharacter = computed(() => props.character.trim().toLowerCase())

const isChibiMode = computed(() => {
  if (terrariaOverride.value) return false
  if (props.variant === 'chibi') return Boolean(props.pose || DEFAULT_CHIBI[normalizedCharacter.value])
  if (props.variant === 'illustration') return false
  return Boolean(props.pose || DEFAULT_CHIBI[normalizedCharacter.value])
})

const atelierSrc = computed(() => {
  if (isChibiMode.value) {
    if (props.pose && CHIBI_BY_POSE[props.pose]) return CHIBI_BY_POSE[props.pose]
    if (DEFAULT_CHIBI[normalizedCharacter.value]) return DEFAULT_CHIBI[normalizedCharacter.value]
  }
  if (props.variant === 'illustration' && CHARACTER_ILLUSTRATIONS[normalizedCharacter.value]) {
    return CHARACTER_ILLUSTRATIONS[normalizedCharacter.value]
  }
  return studioOriginal
})

const artSrc = computed(() => terrariaOverride.value || atelierSrc.value)

const dimensions = computed(() => {
  if (isChibiMode.value) return { width: 480, height: 480 }
  if (!terrariaOverride.value && props.variant === 'illustration' && CHARACTER_ILLUSTRATIONS[normalizedCharacter.value]) {
    return { width: 1024, height: 576 }
  }
  return { width: 768, height: 512 }
})
</script>

<style scoped>
/* Static artwork only — zero perpetual floating or wobble (DESIGN.md:231,655). */
.atelier-empty-art {
  display: block;
  width: min(336px, 100%);
  height: auto;
  margin: 0 auto;
  pointer-events: none;
}

.atelier-empty-art.is-chibi {
  width: min(192px, 100%);
  border-radius: var(--r-lg);
  object-fit: contain;
}

.atelier-art-fade-enter-active,
.atelier-art-fade-leave-active {
  transition: opacity var(--motion-surface) var(--ease-out), transform var(--motion-surface) var(--ease-out);
}

.atelier-art-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.atelier-art-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .atelier-art-fade-enter-active,
  :root:not([data-motion='full']) .atelier-art-fade-leave-active {
    transition: none;
  }

  :root:not([data-motion='full']) .atelier-art-fade-enter-from,
  :root:not([data-motion='full']) .atelier-art-fade-leave-to {
    transform: none;
  }
}

:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .atelier-art-fade-enter-active,
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .atelier-art-fade-leave-active {
  transition: none;
}

:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .atelier-art-fade-enter-from,
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .atelier-art-fade-leave-to {
  transform: none;
}
</style>
