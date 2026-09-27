<template>
  <div class="director-col col-right">
    <!-- Emotion -->
    <details class="panel step-panel advanced-decision decision-fold" id="stepEmotion">
      <summary class="panel-title decision-summary">
        <span>情绪 · Emotion</span>
        <span class="decision-current">{{ emotionSummary }}</span>
      </summary>
      <div class="emotion-list">
        <button v-for="e in EMOTION" :key="e.id"
          class="option" type="button"
          :class="{ selected: pb.selections.emotion.includes(e.id) }"
          :aria-pressed="pb.selections.emotion.includes(e.id)"
          @click="pb.toggleEmotion(e.id)">
          <span class="opt-icon"><ArchiveIcon :name="e.iconName" /></span>
          <span class="opt-name">{{ e.name }}</span>
        </button>
      </div>
    </details>

    <!-- Camera / Shot -->
    <details class="panel step-panel advanced-decision decision-fold" id="stepCamera">
      <summary class="panel-title decision-summary">
        <span>镜头 · Camera</span>
        <span class="decision-current">{{ shotSummary }}</span>
      </summary>
      <div class="camera-list">
        <button v-for="s in SHOT" :key="s.id"
          class="option" type="button"
          :class="{ selected: pb.selections.shot === s.id }"
          :aria-pressed="pb.selections.shot === s.id"
          @click="pb.setShot(pb.selections.shot === s.id ? null : s.id)">
          <span class="opt-icon"><ArchiveIcon :name="s.iconName" /></span>
          <span class="opt-name">{{ s.name }}</span>
        </button>
      </div>
    </details>

    <!-- Lighting -->
    <details class="panel step-panel advanced-decision decision-fold" id="stepLighting">
      <summary class="panel-title decision-summary">
        <span>光照 · Lighting</span>
        <span class="decision-current">{{ lightingSummary }}</span>
      </summary>
      <div class="lighting-list">
        <button v-for="l in LIGHTING" :key="l.id"
          class="option" type="button"
          :class="{ selected: pb.selections.lighting === l.id }"
          :aria-pressed="pb.selections.lighting === l.id"
          @click="pb.setLighting(pb.selections.lighting === l.id ? null : l.id)">
          <span class="opt-icon"><ArchiveIcon :name="l.iconName" /></span>
          <span class="opt-name">{{ l.name }}</span>
        </button>
      </div>
    </details>

    <!-- Composition -->
    <details class="panel step-panel advanced-decision decision-fold" id="stepComposition">
      <summary class="panel-title decision-summary">
        <span>构图 · Composition</span>
        <span class="decision-current">{{ compositionSummary }}</span>
      </summary>
      <div class="comp-list">
        <button v-for="c in COMPOSITION" :key="c.id"
          class="option" type="button"
          :class="{ selected: pb.selections.composition === c.id }"
          :aria-pressed="pb.selections.composition === c.id"
          @click="pb.setComposition(pb.selections.composition === c.id ? null : c.id)">
          <span class="opt-icon"><ArchiveIcon :name="c.iconName" /></span>
          <span class="opt-name">{{ c.name }}</span>
        </button>
      </div>
    </details>

    <!-- Color Mood -->
    <details class="panel step-panel advanced-decision decision-fold" id="stepMood">
      <summary class="panel-title decision-summary">
        <span>色彩情调 · Mood</span>
        <span class="decision-current">{{ moodSummary }}</span>
      </summary>
      <div class="mood-grid">
        <button v-for="m in COLOR_MOODS" :key="m.id"
          class="mood-card" type="button"
          :class="{ active: pb.colorMood === m.id }"
          :aria-pressed="pb.colorMood === m.id"
          @click="pb.setColorMood(pb.colorMood === m.id ? null : m.id)">
          <span class="mood-icon"><ArchiveIcon :name="m.iconName" /></span>
          <span class="mood-name">{{ m.name }}</span>
          <span class="mood-desc">{{ m.desc }}</span>
        </button>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import '@/assets/css/mood.css'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { EMOTION, SHOT, LIGHTING, COMPOSITION, COLOR_MOODS } from '@/config/promptConstants'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import '@/assets/css/director/components/DirectorDecisionsRail.css'

defineProps<{
  emotionSummary: string
  shotSummary: string
  lightingSummary: string
  compositionSummary: string
  moodSummary: string
}>()

const pb = usePromptBuilderStore()
</script>
