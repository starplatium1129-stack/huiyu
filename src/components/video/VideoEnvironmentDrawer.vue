<template>
  <details
    id="video-environment"
    ref="panelEl"
    class="video-panel video-env-drawer"
    :open="open"
    tabindex="-1"
    @toggle="open = ($event.currentTarget as HTMLDetailsElement).open"
  >
    <StudioDisclosureSummary class="video-disclosure-heading video-env-summary">
      <span class="video-env-summary-title">
        <span class="video-step">本机环境与模型目录</span>
        <strong>{{ activeModel?.label || '等待环境检测' }}</strong>
        <small v-if="activeModel?.tier">{{ activeModel.tier }} · {{ activeModel.summary }}</small>
      </span>
      <span class="video-status-pill" :data-state="environmentState">{{ environmentLabel }}</span>
    </StudioDisclosureSummary>
    <div class="video-env-drawer-grid" data-disclosure-content>
      <div v-if="open" class="video-environment-panel">
        <div v-if="statusError" class="video-inline-message error" role="alert">{{ statusError }}</div>
        <template v-else-if="activeModel">
          <div class="video-model-summary">
            <span>{{ activeModel.tier }}</span>
            <strong>{{ activeModel.label }}</strong>
            <p>{{ activeModel.summary }}</p>
          </div>
          <p v-if="nativeVideo && !activeModel.available && activeModel.reason" class="video-install-note">当前原因：{{ activeModel.reason }}</p>
          <template v-if="nativeVideo && !activeModel.available && activeModel.requirements.length">
            <p class="video-install-note">准备 {{ activeModel.label }} 需要：</p>
            <ul class="video-missing-list"><li v-for="requirement in activeModel.requirements" :key="requirement">{{ requirement }}</li></ul>
          </template>
          <details v-if="!nativeVideo && activeModel.missing.length" class="video-advanced">
            <StudioDisclosureSummary class="video-disclosure-heading">需要安装 {{ activeModel.missing.length }} 项资源 · 查看详情</StudioDisclosureSummary>
            <ul class="video-missing-list"><li v-for="file in activeModel.missing" :key="file"><code>{{ file }}</code></li></ul>
          </details>
          <p v-if="activeModel.missing.length && activeModel.executable" class="video-install-note">
            {{ nativeVideo ? '请准备所列模型与运行环境，然后重新检测。' : '请将所列资源放入 ComfyUI/models 的对应目录，然后重新检测。' }}
          </p>
          <p v-else-if="activeModel.missing.length" class="video-install-note">
            此模型暂不支持生成，可选择其他模型。
          </p>
        </template>
        <div class="video-env-links">
          <RouterLink v-if="status && !nativeVideo && !status.online" class="btn btn-ghost btn-sm" :to="comfyControlTarget">打开服务与连接</RouterLink>
          <RouterLink class="btn btn-ghost btn-sm" :to="videoControlTarget">
            {{ nativeVideo && !activeModel?.available ? '准备视频运行环境' : '视频引擎设置' }}
          </RouterLink>
        </div>
      </div>
      <div v-if="open" class="video-model-catalog">
        <div class="video-env-catalog-head">更换生成模型</div>
        <div class="video-model-options">
          <button
            v-for="model in status?.models || []"
            :key="model.id"
            class="video-model-row"
            type="button"
            :class="{ active: selectedModelId === model.id }"
            :aria-pressed="selectedModelId === model.id"
            @click="emit('chooseModel', model.id)"
          >
            <span>
              <strong><ArchiveIcon v-if="selectedModelId === model.id" name="success" />{{ model.label }}</strong>
              <small>{{ model.summary }}</small>
            </span>
            <em :data-state="model.available ? 'ready' : (model.executable ? 'missing' : 'planned')">
              {{ model.available ? '已就绪' : (model.executable ? '待安装' : '待适配') }}
            </em>
          </button>
        </div>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { VideoModelStatus, VideoStatusResponse } from '@/api/videoApi'
import type { StudioMode } from '@/composables/video/useVideoModeOptions'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'

const props = defineProps<{
  status: VideoStatusResponse | null
  activeModel: VideoModelStatus | null
  selectedModelId: string
  selectedMode: StudioMode
  nativeVideo: boolean
  environmentState: string
  environmentLabel: string
  statusError: string
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ chooseModel: [id: string] }>()

const route = useRoute()
const panelEl = ref<HTMLDetailsElement | null>(null)

const videoReturnQuery = computed(() => ({
  ...(typeof route.query.job === 'string' ? { videoJob: route.query.job } : {}),
  ...(props.selectedMode === 'shots' ? { videoMode: 'shots' } : {}),
}))
const videoControlTarget = computed(() => ({
  path: '/control',
  hash: '#control-inference',
  query: { ...videoReturnQuery.value, videoSetup: '1', model: props.selectedModelId },
}))
const comfyControlTarget = computed(() => ({
  path: '/control',
  hash: '#control-services',
  query: { ...videoReturnQuery.value, engine: 'video' },
}))

function focusPanel() {
  panelEl.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  panelEl.value?.focus({ preventScroll: true })
}

defineExpose({ focusPanel })
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.video-env-drawer { margin-bottom:var(--s-4); padding:var(--s-3) var(--s-4); }
.video-env-summary { min-height:40px; }
.video-env-summary-title { display:flex; flex-wrap:wrap; align-items:baseline; gap:var(--s-2) var(--s-3); min-width:0; }
.video-env-summary-title strong { color:var(--text-primary); font-size:var(--fs-body-sm); }
.video-env-summary-title small { color:var(--text-secondary); font-size:var(--fs-label-xs); font-weight:400; }
.video-env-drawer-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr)); gap:var(--s-4); padding-top:var(--s-3); margin-top:var(--s-3); border-top:1px solid var(--border-soft); }
.video-env-links { display:flex; flex-wrap:wrap; gap:var(--s-2); margin-top:var(--s-3); }
.video-env-catalog-head { color:var(--text-secondary); font:600 var(--fs-label-sm)/var(--lh-label) var(--font-sans); }
.video-step { @apply tw:text-accent; font:500 var(--fs-label-xs) var(--font-mono); letter-spacing:.08em; @apply tw:uppercase; }
.video-advanced { @apply tw:mt-s-4 tw:pt-s-4; border-top:1px solid var(--border-soft); }
.video-advanced summary { @apply tw:min-h-[36px] tw:text-secondary tw:font-semibold tw:cursor-pointer; }
.video-disclosure-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); min-height:var(--control-height-sm); padding:var(--s-2); margin-inline:calc(-1 * var(--s-2)); border-radius:var(--r-sm); }
.video-disclosure-heading > span { min-width:0; }
.video-disclosure-heading:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.video-status-pill { padding:3px var(--s-2); @apply tw:rounded-pill; font:700 var(--fs-label) var(--font-mono); }
.video-status-pill[data-state="ready"] { background:color-mix(in srgb,var(--success) 14%,transparent); @apply tw:text-success-text; }
.video-status-pill[data-state="missing"],.video-status-pill[data-state="checking"],.video-status-pill[data-state="planned"] { background:color-mix(in srgb,var(--warning) 14%,transparent); @apply tw:text-warning-text; }
.video-status-pill[data-state="offline"] { background:color-mix(in srgb,var(--danger) 12%,transparent); @apply tw:text-danger-text; }
.video-model-summary { @apply tw:grid tw:gap-[4px]; }
.video-model-summary span { @apply tw:text-accent; font:700 var(--fs-label) var(--font-mono); }
.video-model-summary p { margin:4px 0 0; @apply tw:text-body-sm tw:leading-body; }
.video-missing-list { @apply tw:grid tw:gap-s-1; margin:var(--s-3) 0; @apply tw:p-0; list-style:none; }
.video-missing-list code { @apply tw:block; overflow-wrap:anywhere; @apply tw:text-warning-text; }
.video-install-note { margin:0 0 var(--s-3); @apply tw:text-muted tw:text-body-sm tw:leading-body; }
.video-model-options { display:grid; gap:var(--s-2); margin-top:var(--s-3); }
.video-model-catalog summary { @apply tw:cursor-pointer tw:text-body; font-weight:650; @apply tw:text-primary; }
.video-model-catalog summary small { @apply tw:block tw:mt-s-2 tw:text-secondary tw:text-body-sm tw:font-normal; }
.video-model-row {
  @apply tw:grid; grid-template-columns:minmax(0,1fr) auto; @apply tw:items-center tw:gap-s-3 tw:w-full tw:p-s-3; border:1px solid var(--border-soft); @apply tw:rounded-md;
  background:var(--bg-deep); @apply tw:text-secondary tw:text-left tw:cursor-pointer;
}
.video-model-row.active { border-color:var(--border-strong); background:var(--bg-elevated); box-shadow:var(--shadow-sm); }
.video-model-row:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.video-model-row strong,.video-model-row small { @apply tw:block; overflow-wrap:anywhere; }
.video-model-row strong { display:flex; align-items:center; gap:var(--s-2); color:var(--text-primary); }
.video-model-row strong .archive-icon { width:16px; height:16px; flex:none; color:var(--text-primary); }
.video-model-row small { @apply tw:mt-[3px] tw:text-muted tw:text-body-sm tw:leading-label; }
.video-model-row em { font:700 var(--fs-label) var(--font-mono); @apply tw:not-italic; }
.video-model-row em[data-state="ready"] { @apply tw:text-success-text; }
.video-model-row em[data-state="missing"] { @apply tw:text-warning-text; }
.video-model-row em[data-state="planned"] { @apply tw:text-muted; }
.video-inline-message { padding:var(--s-2) var(--s-3); @apply tw:rounded-md tw:text-body-sm tw:leading-body; overflow-wrap:anywhere; }
.video-inline-message.error { background:color-mix(in srgb,var(--danger) 10%,transparent); @apply tw:text-danger-text; }
@media (hover:hover) and (pointer:fine) {
  .video-model-row:not(:disabled):hover { border-color:var(--border-strong); }
}
@media (forced-colors:active) {
  .video-model-row { border-color:ButtonText; }
  .video-model-row.active { border-color:Highlight; outline:1px solid Highlight; }
  .video-model-row:focus-visible { outline:2px solid Highlight; }
}
</style>
