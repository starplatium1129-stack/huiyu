<template>
  <div v-if="isDismissed">
    <StudioTooltip content="重新打开推荐配方与复用">
      <button ref="reopenButton" class="btn btn-quiet btn-sm managed-route-reopen-btn" type="button" @click="restoreBanner">
        <ArchiveIcon name="info" /><span class="studio-control-label">推荐配方：{{ route.title }}</span>
      </button>
    </StudioTooltip>
  </div>
  <details v-else ref="routeCard" class="managed-route-card" :open="!isCollapsed" @toggle="onToggle">
    <StudioDisclosureSummary class="managed-route-summary">
      <span class="managed-route-heading"><span>推荐配方与复用<small v-if="route.experimental">实验路线</small></span><strong aria-live="polite">{{ route.title }}</strong></span>
    </StudioDisclosureSummary>
    <div data-disclosure-content class="managed-route-body">
      <p class="managed-route-kicker">{{ expert ? '系统推荐路线' : '系统自动选择' }}</p>
      <p>{{ route.summary }}</p>
      <div class="managed-route-facts">
        <span>{{ promptFormatLabel(route.promptFormat) }}</span>
        <span class="managed-route-status" :data-experimental="route.experimental || undefined">{{ route.experimental ? '实验路线' : '稳定路线' }}</span>
        <span>{{ route.engine === 'sd' ? '双角色工作流' : '托管高质量工作流' }}</span>
      </div>
      <ul class="managed-route-reasons">
        <li v-for="reason in route.reasons" :key="reason">{{ reason }}</li>
      </ul>
      <div v-if="recipes.length" class="successful-recipes">
        <span>最近成功成片</span>
        <StudioTooltip v-for="recipe in recipes" :key="recipe.id" anchor :content="busy ? '生成中，完成后可复用配方' : '复用这张作品的绘制设置'">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="$emit('reuse', recipe.id)">
            <span class="studio-control-label">{{ recipe.label }}</span>
          </button>
        </StudioTooltip>
      </div>
      <div class="managed-route-actions" role="group" aria-label="推荐配方操作">
        <StudioTooltip v-if="expert" anchor :content="busy ? '生成中，完成后可采用推荐路线' : '用推荐配方更新当前绘制设置'">
          <button class="btn btn-primary btn-sm" type="button" :disabled="busy" @click="$emit('apply')">
            <ArchiveIcon name="spark" /><span class="studio-control-label">采用推荐路线</span>
          </button>
        </StudioTooltip>
        <StudioTooltip content="关闭推荐，可从此处重新打开">
          <button class="btn btn-quiet btn-icon btn-sm managed-route-dismiss" type="button" aria-label="关闭路线推荐" @click="dismissBanner">
            <ArchiveIcon name="close" />
          </button>
        </StudioTooltip>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { computed, nextTick, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { ArtworkRecord } from '@/types/artwork'
import type { DrawSubject } from '@/utils/popularContent'
import {
  promptFormatLabel,
  type DrawingRouteRecommendation,
} from '@/utils/drawingRoute'

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
const routeCard = ref<HTMLDetailsElement | null>(null)
const reopenButton = ref<HTMLButtonElement | null>(null)

function onToggle(event: Event) {
  const collapsed = !(event.currentTarget as HTMLDetailsElement).open
  if (isCollapsed.value === collapsed) return
  isCollapsed.value = collapsed
  try {
    localStorage.setItem(COLLAPSED_KEY, isCollapsed.value ? 'true' : 'false')
  } catch {}
}

async function dismissBanner() {
  isDismissed.value = true
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {}
  await nextTick()
  reopenButton.value?.focus()
}

async function restoreBanner() {
  isDismissed.value = false
  try {
    localStorage.removeItem(DISMISSED_KEY)
  } catch {}
  await nextTick()
  routeCard.value?.querySelector('summary')?.focus()
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

<style scoped src="@/assets/css/director/components/ManagedDrawingRouteCard.css"></style>
