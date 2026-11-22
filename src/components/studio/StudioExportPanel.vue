<template>
  <section class="studio-video-group studio-export" aria-labelledby="studio-export-title">
    <header class="studio-heading"><h3 id="studio-export-title">整片导出</h3></header>
    <p v-if="records === undefined" class="studio-caption">
      {{
        desktop
          ? '当前工作区服务尚未提供整片导出，请更新后重新打开项目。'
          : '整片导出使用桌面工作区。浏览器项目可以在镜头历史中保存单个片段。'
      }}
    </p>
    <template v-else>
      <form class="studio-video-form" aria-label="时间线导出" @submit.prevent="start">
        <fieldset class="studio-video-selection">
          <legend>导出镜头 · 按时间线顺序</legend>
          <div class="studio-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy || !data.shots.length"
              @click="excluded = []"
            >
              全选
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy || !chosen.length"
              @click="excluded = data.shots.map((shot) => shot.id)"
            >
              清空选择
            </button>
          </div>
          <label v-for="shot in data.shots" :key="shot.id" class="studio-video-check">
            <input
              type="checkbox"
              :checked="!excluded.includes(shot.id)"
              :disabled="busy"
              @change="toggle(shot.id)"
            />
            <span
              >{{ shot.position + 1 }}. {{ shot.title
              }}<small
                >{{ shot.currentClipVersionId ? versionLabel(data, shot.currentClipVersionId) : '待选用成片'
                }}<template v-if="options.useShotAudio && shot.audioVersionId">
                  · {{ versionLabel(data, shot.audioVersionId) }}</template
                ></small
              ></span
            >
          </label>
        </fieldset>
        <fieldset class="studio-video-selection">
          <legend>画面与声音</legend>
          <label class="studio-video-check"
            ><input v-model="options.upscale" type="checkbox" :disabled="busy" />画幅放大 2 倍</label
          >
          <label class="studio-video-check"
            ><input v-model="options.interpolate" type="checkbox" :disabled="busy" />镜内插帧，帧率提升 2 倍</label
          >
          <label class="studio-video-check"
            ><input v-model="options.useShotAudio" type="checkbox" :disabled="busy" />使用各镜头绑定的配音</label
          >
          <small>分辨率和帧率以所选第一镜为基准。没有绑定配音的镜头保留原声。</small>
        </fieldset>
        <p v-if="issue" id="studio-export-issue" class="studio-caption">{{ issue }}</p>
        <button
          type="submit"
          class="btn btn-primary"
          :disabled="!!issue"
          :aria-describedby="issue ? 'studio-export-issue' : undefined"
        >
          <ArchiveIcon name="clap" />导出 {{ chosen.length }} 镜
        </button>
      </form>
      <ol v-if="ordered.length" class="studio-video-runs" aria-label="整片导出记录">
        <li v-for="record in ordered.slice(0, limit)" :key="record.id">
          <div class="studio-heading">
            <strong>{{ record.shots.length }} 镜 · {{ runStatuses[record.status] }}</strong>
            <small>{{ time.format(record.createdAt) }}</small>
          </div>
          <p v-if="record.message">{{ record.message }}</p>
          <template v-if="working(record)">
            <progress :max="1" :value="record.progress ?? undefined" aria-label="整片导出进度" />
            <small v-if="record.progress !== null">{{ Math.round(record.progress * 100) }}%</small>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy || record.cancelRequested"
              @click="$emit('cancel', record)"
            >
              {{ record.cancelRequested ? '正在取消' : '取消此次导出' }}
            </button>
          </template>
          <p v-if="record.error" class="studio-feedback">{{ record.error }}</p>
          <StudioVersionMedia
            v-if="record.status === 'succeeded' && record.clipVersionId"
            :version-id="record.clipVersionId"
            :data="data"
            :repo="repo"
            :label="data.project.title + ' · 整片'"
            save
            :open="playing === record.id"
            @update:open="playing = $event ? record.id : ''"
          />
          <details class="studio-video-source">
            <StudioDisclosureSummary>本次导出的镜头版本</StudioDisclosureSummary>
            <div data-disclosure-content>
              <p>
                {{ record.options.upscale ? '画幅放大 2 倍' : '保留首镜画幅' }} ·
                {{ record.options.interpolate ? '镜内插帧 2 倍' : '保留首镜帧率' }} ·
                {{ record.options.useShotAudio ? '使用绑定配音' : '保留片段音轨' }}
              </p>
              <ol>
                <li v-for="shot in record.shots" :key="shot.shotId">
                  {{ shot.shotTitle || names.get(shot.shotId) || '镜头' }} ·
                  {{ versionLabel(data, shot.clipVersionId)
                  }}<span v-if="shot.audioVersionId"> · {{ versionLabel(data, shot.audioVersionId) }}</span>
                </li>
              </ol>
            </div>
          </details>
        </li>
      </ol>
      <button v-if="ordered.length > limit" class="btn btn-ghost btn-sm" type="button" @click="limit += 6">
        更多导出记录
      </button>
    </template>
    <RouterLink class="studio-caption" to="/gallery?panel=backup">{{
      desktop ? '完整工作区备份' : '数据与备份'
    }}</RouterLink>
  </section>
</template>
<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import {
  runStatuses,
  type StudioExportRecord,
  type StudioExportOptions,
  type StudioExportInput,
} from '@/api/studioVideoApi'
import type { StudioProjectSnapshot, StudioProjectRepository } from '@/storage/studioProjectRepository'
import StudioVersionMedia from './StudioVersionMedia.vue'
import { versionLabel } from './projectAssets'
const props = defineProps<{
  records?: StudioExportRecord[]
  data: StudioProjectSnapshot
  repo: StudioProjectRepository
  busy: boolean
  pending: boolean
  desktop: boolean
  saveShot: () => Promise<boolean>
  submit: (prepare: () => Promise<Omit<StudioExportInput, 'id'>>) => Promise<void>
}>()
defineEmits<{ cancel: [record: StudioExportRecord] }>()
const options = reactive<StudioExportOptions>({ upscale: false, interpolate: false, useShotAudio: true })
const excluded = ref<string[]>([]),
  limit = ref(6),
  playing = ref('')
const names = computed(() => new Map(props.data.shots.map((shot) => [shot.id, shot.title])))
const chosen = computed(() =>
  props.data.shots.filter((shot) => !excluded.value.includes(shot.id)).sort((a, b) => a.position - b.position)
)
const ordered = computed(() => [...(props.records || [])].sort((a, b) => b.createdAt - a.createdAt))
const time = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const working = (record: StudioExportRecord) => record.status === 'running' || record.status === 'queued'
const issue = computed(() => {
  if (props.pending) return '请先核对上次提交的任务。'
  if (props.busy) return '正在更新项目。'
  if (!chosen.value.length || chosen.value.length > 64) return '请选择 1 至 64 个镜头。'
  const missing = chosen.value.find((shot) => !shot.currentClipVersionId)
  return missing ? `「${missing.title}」尚未选用成片，可在这个镜头的生成历史中选择。` : ''
})
function toggle(id: string) {
  excluded.value = excluded.value.includes(id)
    ? excluded.value.filter((item) => item !== id)
    : [...excluded.value, id]
}
function start() {
  if (issue.value) return
  const selected = chosen.value.map((shot) => ({
    id: shot.id,
    version: shot.currentClipVersionId,
    audio: shot.audioVersionId,
  }))
  const settings = { ...options }
  void props.submit(async () => {
    if (!(await props.saveShot())) throw new Error('请先保存当前镜头。')
    const snapshot = await props.repo.getProject(props.data.project.id)
    const rows = new Map(snapshot.shots.map((shot) => [shot.id, shot]))
    const shots = selected.map((item) => {
      const shot = rows.get(item.id)
      if (!shot?.currentClipVersionId || shot.currentClipVersionId !== item.version)
        throw new Error('镜头的当前成片已改变，请刷新后重新导出。')
      if (settings.useShotAudio && shot.audioVersionId !== item.audio)
        throw new Error('镜头绑定的配音已改变，请刷新后重新导出。')
      return { shotId: shot.id, expectedRevision: shot.revision, clipVersionId: shot.currentClipVersionId }
    })
    return { shots, options: settings }
  })
}
</script>
