<template>
  <section class="container home-section home-chibi-section" aria-labelledby="home-chibi-title" data-reveal>
    <div class="chibi-spread">
      <header class="chibi-intro">
        <h2 id="home-chibi-title" data-screentone-furniture>画室拍立得</h2>
      </header>

      <div class="chibi-strip" role="list" aria-label="角色 Q 版拍立得手帖">
        <div v-for="entry in entries" :key="entry.id" class="chibi-strip-slot" role="listitem">
          <button
            type="button"
            class="chibi-polaroid"
            :data-character="entry.id"
            :style="{ '--polaroid-tilt': entry.tilt }"
            :aria-label="`翻看${entry.name}的拍立得手帖：${entry.caption}`"
            @click="openLightbox(entry, $event)"
          >
            <span class="chibi-photo-frame">
              <img
                :src="entry.thumb"
                :alt="entry.alt"
                class="chibi-photo"
                width="480"
                height="288"
                loading="lazy"
                decoding="async"
                draggable="false"
              />
              <span class="chibi-stamp" aria-hidden="true">{{ entry.stamp }}</span>
            </span>
            <span class="chibi-polaroid-foot">
              <span class="chibi-meta-row">
                <strong class="chibi-char-name">{{ entry.name }}</strong>
                <span class="chibi-index">{{ entry.noteCode }}</span>
              </span>
              <span class="chibi-caption">{{ entry.caption }}</span>
            </span>
          </button>
        </div>
      </div>
    </div>

    <HomeChibiLightbox ref="lightbox" />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import HomeChibiLightbox from './HomeChibiLightbox.vue'
import { CHIBI_POLAROID_ENTRIES as entries, type ChibiPolaroidEntry } from './chibiPolaroidData'

const lightbox = ref<InstanceType<typeof HomeChibiLightbox> | null>(null)

function openLightbox(entry: ChibiPolaroidEntry, event: MouseEvent) {
  lightbox.value?.open(entry, event.currentTarget as HTMLElement, document.activeElement)
}
</script>

<style scoped>
.home-chibi-section {
  margin-block: var(--s-7);
}

.chibi-spread {
  display: grid;
  grid-template-columns: minmax(220px, 0.72fr) minmax(0, 1.28fr);
  align-items: center;
  gap: clamp(24px, 3vw, 48px);
  padding: clamp(20px, 2.4vw, 32px);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  background:
    radial-gradient(ellipse 60% 70% at 100% 0%, color-mix(in srgb, var(--character-accent, var(--accent)) 8%, transparent), transparent 72%),
    var(--bg-surface);
  box-shadow: var(--shadow-card);
}

.chibi-intro {
  min-width: 0;
}

.chibi-eyebrow {
  display: block;
  color: var(--text-muted);
  font: 500 var(--fs-label-xs)/var(--lh-label) var(--font-mono);
  letter-spacing: 0.16em;
}

.chibi-intro h2 {
  margin: var(--s-2) 0 var(--s-3);
  color: var(--text-primary);
  font: 500 var(--fs-title-sm)/var(--lh-label) var(--font-serif);
  letter-spacing: 0;
}

.chibi-lead {
  margin: 0;
  max-width: 28ch;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  line-height: var(--lh-loose);
}

.chibi-strip {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: clamp(18px, 2.4vw, 32px);
  align-items: start;
  padding-block: var(--s-2);
}

.chibi-strip-slot {
  min-width: 0;
}

/* Polaroid frame: strictly for unpacked chibi material (DESIGN.md:658-663).
   Static at rest with zero looping wobble; subtle straighten on fine-pointer hover. */
.chibi-polaroid {
  --stamp-color: var(--accent);
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: var(--s-3) var(--s-3) var(--s-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  color: var(--text-primary);
  text-align: left;
  font: inherit;
  cursor: pointer;
  box-shadow: inset 0 1px 0 var(--glass-highlight), var(--shadow-md);
  transform: rotate(var(--polaroid-tilt, 0deg));
  transition: transform var(--motion-surface) var(--spring-soft), border-color var(--motion-hover) var(--ease-out);
}

.chibi-polaroid[data-character='nene'] {
  --stamp-color: var(--nene-violet);
}

.chibi-polaroid[data-character='natsume'] {
  --stamp-color: var(--natsume-amber);
}

:root[data-theme='light'] .chibi-polaroid {
  background: var(--bg-surface);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-glass-md);
}

.chibi-photo-frame {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 5 / 3;
  overflow: hidden;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xs);
  background: var(--art-mat);
}

.chibi-photo {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 35%;
}

.chibi-stamp {
  position: absolute;
  top: var(--s-2);
  right: var(--s-2);
  padding: 2px 8px;
  border: 1.5px solid color-mix(in srgb, var(--stamp-color) 76%, transparent);
  outline: 1px dashed color-mix(in srgb, var(--stamp-color) 42%, transparent);
  outline-offset: -4px;
  border-radius: var(--r-xs);
  background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
  color: var(--stamp-color);
  font: 700 var(--fs-mono-xs)/1.3 var(--font-mono);
  letter-spacing: 0.14em;
  transform: rotate(8deg);
  pointer-events: none;
  box-shadow: var(--shadow-sm);
}

.chibi-polaroid[data-character='natsume'] .chibi-stamp {
  transform: rotate(-7deg);
}

.chibi-polaroid-foot {
  display: grid;
  gap: var(--s-1);
  padding: var(--s-3) var(--s-1) 0;
}

.chibi-meta-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-2);
}

.chibi-char-name {
  color: var(--text-primary);
  font: 500 var(--fs-body-sm)/var(--lh-label) var(--font-serif);
}

.chibi-index {
  color: var(--text-muted);
  font: 500 var(--fs-mono-xs)/var(--lh-flush) var(--font-mono);
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.chibi-caption {
  color: var(--text-secondary);
  font: 400 var(--fs-label-sm)/var(--lh-body) var(--font-serif);
}

.chibi-polaroid:focus-visible {
  outline: none;
  box-shadow: var(--focus-shadow), var(--shadow-md);
}

.chibi-polaroid:active:not(:focus-visible) {
  transform: rotate(var(--polaroid-tilt, 0deg)) scale(0.985);
  transition-duration: var(--motion-press);
}

@media (hover: hover) and (pointer: fine) {
  .chibi-polaroid:hover:not(:focus-visible) {
    transform: rotate(0deg) translateY(-4px);
    border-color: color-mix(in srgb, var(--stamp-color) 52%, var(--border-strong));
  }
}

:root[data-theme-style='terraria'] .home-chibi-section {
  display: none;
}

@media (max-width: 960px) {
  .chibi-spread {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-5);
  }
  .chibi-lead {
    max-width: none;
  }
}

@media (max-width: 600px) {
  .chibi-strip {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-5);
  }
}

@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .chibi-polaroid {
    transition: none;
  }
  :root:not([data-motion='full']) .chibi-polaroid:hover,
  :root:not([data-motion='full']) .chibi-polaroid:active {
    transform: rotate(var(--polaroid-tilt, 0deg));
  }
}

:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .chibi-polaroid {
  transition: none;
}

:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .chibi-polaroid:hover,
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .chibi-polaroid:active {
  transform: rotate(var(--polaroid-tilt, 0deg));
}

@media (forced-colors: active) {
  .chibi-polaroid {
    border-color: ButtonText;
    box-shadow: none;
  }
  .chibi-stamp {
    background: Canvas;
    color: CanvasText;
    border-color: CanvasText;
    outline-color: CanvasText;
  }
}
</style>
