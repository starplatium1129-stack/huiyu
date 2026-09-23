<template>
  <div v-if="isDismissed" class="managed-route-dismissed-wrap">
    <StudioTooltip content="点击展开路线推荐">
      <button class="managed-route-reopen-btn" type="button" @click="restoreBanner">
        <ArchiveIcon name="info" />
        <span>路线推荐：{{ route.title }}</span>
      </button>
    </StudioTooltip>
  </div>
  <section v-else class="managed-route-card" :class="{ experimental: route.experimental, 'is-collapsed': isCollapsed }" aria-live="polite">
    <div class="managed-route-main">
      <div class="managed-route-copy">
        <span class="managed-route-kicker">{{ expert ? '系统推荐路线' : '系统自动选择' }}</span>
        <strong>{{ route.title }}</strong>
        <span v-if="!isCollapsed">{{ route.summary }}</span>
      </div>
      <div class="managed-route-actions">
        <button v-if="expert" class="managed-route-apply" type="button"
          :disabled="busy" @click="$emit('apply')">
          采用推荐路线
        </button>
        <button class="managed-route-toggle" type="button"
          :aria-expanded="!isCollapsed"
          @click="toggleCollapse">
          {{ isCollapsed ? '展开详情' : '收起' }}
        </button>
        <StudioTooltip content="关闭横幅（可在顶部重新打开）">
          <button class="managed-route-dismiss" type="button"
            aria-label="关闭路线推荐横幅"
            @click="dismissBanner">
            <ArchiveIcon name="close" />
          </button>
        </StudioTooltip>
      </div>
    </div>
    <template v-if="!isCollapsed">
      <div class="managed-route-facts">
        <span>{{ promptFormatLabel(route.promptFormat) }}</span>
        <span>{{ route.experimental ? '实验路线' : '稳定路线' }}</span>
        <span>{{ route.engine === 'sd' ? '双角色工作流' : '托管高质量工作流' }}</span>
      </div>
      <ul class="managed-route-reasons">
        <li v-for="reason in route.reasons" :key="reason">{{ reason }}</li>
      </ul>
      <div v-if="recipes.length" class="successful-recipes">
        <span>最近成功成片</span>
        <button v-for="recipe in recipes" :key="recipe.id" type="button"
          :disabled="busy" @click="$emit('reuse', recipe.id)">
          {{ recipe.label }}
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { ArtworkRecord } from '@/types/artwork'
import type { DrawSubject } from '@/utils/popularContent'
import {
  promptFormatLabel,
  type DrawingRouteRecommendation,
} from '@/utils/drawingRoute'
import '@/assets/css/director/components/ManagedDrawingRouteCard.css'

const COLLAPSED_KEY = 'aics_managed_route_collapsed_v1'
const DISMISSED_KEY = 'aics_managed_route_dismissed_v1'

const props = defineProps<{
  route: DrawingRouteRecommendation
  history: readonly ArtworkRecord[]
  subject: DrawSubject
  expert: boolean
  busy: boolean
}>()

defineEmits<{
  apply: []
  reuse: [id: string | number]
}>()

const isCollapsed = ref<boolean>(localStorage.getItem(COLLAPSED_KEY) !== 'false')
const isDismissed = ref<boolean>(localStorage.getItem(DISMISSED_KEY) === '1')

function toggleCollapse() {
  isCollapsed.value = !isCollapsed.value
  try {
    localStorage.setItem(COLLAPSED_KEY, isCollapsed.value ? 'true' : 'false')
  } catch {}
}

function dismissBanner() {
  isDismissed.value = true
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {}
}

function restoreBanner() {
  isDismissed.value = false
  try {
    localStorage.removeItem(DISMISSED_KEY)
  } catch {}
}

const recipes = computed(() => [...props.history]
  .reverse()
  .filter(entry => {
    if (!entry.image_id) return false
    if (props.subject.kind === 'popular') {
      return entry.subject === 'popular'
        && entry.characterId === props.subject.characterId
        && entry.engine === props.route.engine
    }
    const character = props.route.engine === 'sd'
      ? 'triad'
      : props.route.generationCharacter === 'natsume' ? 'natsume' : 'nene'
    if (entry.subject === 'popular' || entry.character !== character) return false
    if (props.route.engine === 'sd') return entry.engine == null || entry.engine === 'sd'
    return entry.engine === 'anima' && entry.loraId === props.route.loraId
  })
  .slice(0, 3)
  .map(entry => {
    const title = entry.sceneTitle || (entry.story ? entry.story.slice(0, 12) : '自由创作')
    const engine = entry.engine === 'krea2' ? 'Krea' : entry.engine === 'anima' ? 'Anima' : 'WAI'
    return { id: entry.id, label: `${title} · ${engine}` }
  }))
</script>
