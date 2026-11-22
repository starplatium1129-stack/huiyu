<template>
  <div class="studio-video-log">
    <section v-if="active.length" aria-labelledby="studio-video-active" class="studio-video-group">
      <h3 id="studio-video-active">进行中的镜头 · {{ active.length }}</h3>
      <ul class="studio-video-runs">
        <li v-for="run in active" :key="run.id">
          <div class="studio-heading">
            <strong>{{ run.shotTitle }}</strong>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy || run.cancelRequested"
              :aria-label="'取消「' + run.shotTitle + '」的任务'"
              @click="$emit('cancel', run)"
            >
              {{ run.cancelRequested ? '正在取消' : '取消任务' }}
            </button>
          </div>
          <p class="studio-caption">{{ run.statusLabel || runStatuses[run.status] }} · {{ recipe(run) }}</p>
          <p v-if="run.preparation?.tasks?.length" class="studio-caption">{{ frameStatus(run) }}</p>
          <template v-if="isWorking(run) || run.liveProgress">
            <p>
              {{ run.liveProgress?.message || '正在处理镜头…' }}
              <span v-if="run.liveProgress?.value != null">{{ Math.round(run.liveProgress.value * 100) }}%</span>
            </p>
            <progress
              :value="run.liveProgress?.value ?? undefined"
              :max="1"
              :aria-label="run.shotTitle + '生成进度'"
            />
            <p v-if="run.gpuRetry?.reason === 'oom'" class="studio-caption">
              显存不足，已改用 {{ run.gpuRetry.width }} × {{ run.gpuRetry.height }} 重试。
            </p>
            <img
              v-if="run.id === live?.id && previewUrl"
              class="studio-video-preview"
              :src="previewUrl"
              alt="生成中的中间帧"
            />
            <small v-else-if="run.id === live?.id && previewError">{{ previewError }}</small>
          </template>
        </li>
      </ul>
    </section>
    <section class="studio-video-group" aria-labelledby="studio-video-history">
      <header class="studio-heading">
        <h3 id="studio-video-history">生成历史</h3>
        <label class="studio-video-check"><input v-model="allShots" type="checkbox" />显示全部镜头</label>
      </header>
      <p v-if="!history.length" class="studio-caption">
        {{ allShots ? '项目中还没有已结束的镜头任务。' : '当前镜头还没有已结束的任务。' }}
      </p>
      <ol v-else class="studio-video-runs">
        <li v-for="run in history.slice(0, limit)" :key="run.id">
          <div class="studio-heading">
            <strong>{{ run.shotTitle }} · {{ runStatuses[run.status] }}</strong>
            <small
              ><time :datetime="new Date(run.createdAt).toISOString()">{{
                time.format(run.createdAt)
              }}</time></small
            >
          </div>
          <p class="studio-caption">
            {{ recipe(run)
            }}<template v-if="run.settings.mode !== 'dialogue'">
              · 种子 {{ run.settings.seed ?? '未记录' }}</template
            >
          </p>
          <p v-if="run.error" class="studio-feedback">{{ run.error }}</p>
          <div class="studio-actions">
            <small v-if="run.clipVersionId && selected.get(run.shotId) === run.clipVersionId">时间线当前成片</small>
            <button
              v-else-if="run.clipVersionId && run.status === 'succeeded'"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy"
              @click="$emit('select', run)"
            >
              选为当前成片
            </button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="$emit('rework', run)">
              返工此镜
            </button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="$emit('reuse', run)">
              沿用导演设置
            </button>
          </div>
          <StudioVersionMedia
            v-if="run.clipVersionId"
            :version-id="run.clipVersionId"
            :data="data"
            :repo="repo"
            :label="run.shotTitle"
            :open="playingId === run.id"
            @update:open="playingId = $event ? run.id : ''"
            save
          />
          <details class="studio-video-source">
            <StudioDisclosureSummary>{{
              run.gpuRetry?.reason === 'oom' ? '输入、模板与显存降级' : '输入与模板'
            }}</StudioDisclosureSummary>
            <div data-disclosure-content>
              <p>首帧 · {{ run.firstVersionId ? versionLabel(data, run.firstVersionId) : '尚未绑定' }}</p>
              <p v-if="run.lastVersionId">尾帧 · {{ versionLabel(data, run.lastVersionId) }}</p>
              <p v-if="run.audioVersionId">配音 · {{ versionLabel(data, run.audioVersionId) }}</p>
              <p>模板 · {{ run.templateId }} v{{ run.templateVersion }}</p>
              <template v-if="run.preparation">
                <p>补帧模型 · {{ run.preparation.modelId }}</p>
                <p v-for="(id, index) in run.preparation.referenceVersionIds" :key="id">
                  参考 {{ index + 1 }} · {{ versionLabel(data, id) }}
                </p>
                <p v-for="child in run.preparation.tasks" :key="child.slot">
                  {{ child.slot === 'first' ? '首帧' : '尾帧' }} · {{ runStatuses[child.status] }} ·
                  {{ child.error || child.prompt }}
                </p>
              </template>
              <p v-if="run.settings.prompt">{{ run.settings.prompt }}</p>
              <p v-if="run.gpuRetry?.reason === 'oom'">
                显存降级 · {{ run.gpuRetry.width }} × {{ run.gpuRetry.height }}
              </p>
              <div v-if="run.gpuRetry?.reason === 'oom' && run.gpuRetry.cause?.trim()">
                <strong>原生引擎返回的原因</strong>
                <p class="studio-video-cause">{{ run.gpuRetry.cause }}</p>
              </div>
            </div>
          </details>
        </li>
      </ol>
      <button v-if="history.length > limit" type="button" class="btn btn-ghost btn-sm" @click="limit += 8">
        显示更多记录
      </button>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue'
import {
  runStatuses,
  videoCameras,
  videoModes,
  videoMotions,
  videoQualities,
  type captureStudioVideoApi,
  type StudioVideoRun,
} from '@/api/studioVideoApi'
import type { StudioProjectRepository, StudioProjectSnapshot } from '@/storage/studioProjectRepository'
import StudioVersionMedia from './StudioVersionMedia.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { versionLabel } from './projectAssets'
import { activeRun, videoError } from './useStudioVideoBoard'

const props = defineProps<{
  data: StudioProjectSnapshot
  repo: StudioProjectRepository
  api: NonNullable<ReturnType<typeof captureStudioVideoApi>>
  runs: StudioVideoRun[]
  target: string
  busy: boolean
}>()
defineEmits<{
  cancel: [run: StudioVideoRun]
  reuse: [run: StudioVideoRun]
  rework: [run: StudioVideoRun]
  select: [run: StudioVideoRun]
}>()
const selected = computed(() => new Map(props.data.shots.map((shot) => [shot.id, shot.currentClipVersionId])))
const allShots = ref(false),
  limit = ref(8)
const active = computed(() =>
  props.runs
    .filter(activeRun)
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.createdAt - b.createdAt)
)
const history = computed(() =>
  props.runs
    .filter((run) => !activeRun(run) && (allShots.value || run.shotId === props.target))
    .sort((a, b) => b.createdAt - a.createdAt)
)
const time = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
function recipe(run: StudioVideoRun) {
  const s = run.settings
  if (s.mode === 'dialogue') return '角色对白 · 25 fps · 时长随配音'
  return [
    videoModes[s.mode],
    videoCameras[s.camera],
    videoMotions[s.motion] + '运动',
    videoQualities[s.quality],
    s.resolution + 'p',
    s.seconds + ' 秒',
  ].join(' · ')
}
const playingId = ref('')
watch([() => props.target, allShots], () => {
  limit.value = 8
  playingId.value = ''
})
function isWorking(run: StudioVideoRun) {
  return run.status === 'running' || run.preparation?.tasks?.some((task) => task.status === 'running')
}
function frameStatus(run: StudioVideoRun) {
  return run.preparation?.tasks
    ?.map((task) => (task.slot === 'first' ? '首帧' : '尾帧') + ' ' + runStatuses[task.status])
    .join(' · ')
}
const live = computed(() => active.value.find(isWorking))
const enabled = ref(true),
  previewUrl = ref(''),
  previewError = ref('')
let previousId = '',
  objectUrl = ''
function clearPreview() {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = ''
  previewUrl.value = ''
  previewError.value = ''
}
watch(
  [
    enabled,
    () => live.value?.id,
    () => live.value?.liveProgress?.previewDataUrl,
    () => live.value?.liveProgress?.previewUrl,
    () => live.value?.liveProgress?.value,
  ],
  async ([show, id, data, path], _, onCleanup) => {
    if (previousId !== id || !show || (!data && !path)) clearPreview()
    previousId = id ?? ''
    const run = live.value
    if (!show || !run || (!data && !path)) return
    if (
      typeof data === 'string' &&
      data.length <= 768 * 1024 &&
      /^data:image\/jpeg;base64,[a-z\d+/]+={0,2}$/i.test(data)
    ) {
      clearPreview()
      previewUrl.value = data
      return
    }
    if (!path) {
      clearPreview()
      return
    }
    const request = new AbortController()
    onCleanup(() => request.abort())
    try {
      const blob = await props.api.preview(run, request.signal)
      request.signal.throwIfAborted()
      clearPreview()
      objectUrl = URL.createObjectURL(blob)
      previewUrl.value = objectUrl
    } catch (e) {
      if (!request.signal.aborted) previewError.value = videoError(e)
    }
  },
  { immediate: true }
)
onDeactivated(() => {
  enabled.value = false
  playingId.value = ''
  clearPreview()
})
onActivated(() => {
  enabled.value = true
})
onScopeDispose(() => {
  clearPreview()
})
</script>
