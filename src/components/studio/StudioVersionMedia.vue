<template>
  <div class="studio-version-media">
    <div class="studio-actions">
      <button class="btn btn-ghost btn-sm" type="button" :aria-expanded="open" @click="open = !open">
        <ArchiveIcon :name="kind === 'audio' ? 'speaker' : 'play'" />{{
          open ? '收起播放器' : kind === 'audio' ? '试听配音' : '播放成片'
        }}
      </button>
      <button v-if="save" class="btn btn-ghost btn-sm" type="button" :disabled="saving" @click="download">
        <ArchiveIcon name="download" />{{ saving ? '正在读取原件…' : '保存视频文件' }}
      </button>
    </div>
    <StudioMediaPlayer v-if="open && url" :src="url" :kind="kind" :label="label" />
    <p v-else-if="open && !error" class="studio-caption" role="status">正在读取素材原件…</p>
    <p v-if="error" class="studio-feedback" role="alert">{{ error }}</p>
    <p v-if="notice" class="studio-caption" role="status">{{ notice }}</p>
  </div>
</template>
<script setup lang="ts">
import { onDeactivated, onScopeDispose, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import { runtimeResultFilename } from '@/api/runtimeTasks'
import { downloadBlob } from '@/utils/downloadBlob'
import type { StudioProjectRepository, StudioProjectSnapshot } from '@/storage/studioProjectRepository'
const props = withDefaults(
  defineProps<{
    data: StudioProjectSnapshot
    repo: StudioProjectRepository
    versionId: string
    label: string
    kind?: 'audio' | 'video'
    save?: boolean
  }>(),
  { kind: 'video' }
)
const open = defineModel<boolean>('open', { default: false })
const url = ref(''),
  error = ref(''),
  notice = ref(''),
  saving = ref(false)
let playback: AbortController | undefined, savingFile: AbortController | undefined, playingBlob: Blob | undefined
function release() {
  playback?.abort()
  playback = undefined
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = ''
  playingBlob = undefined
}
async function original(signal: AbortSignal) {
  const { versionId, repo, data, kind } = props
  repo.assertCurrent()
  let version = data.versions.find((item) => item.id === versionId)
  if (!version) version = (await repo.getProject(data.project.id)).versions.find((item) => item.id === versionId)
  signal.throwIfAborted()
  if (!version || !version.mime.startsWith(kind + '/')) throw new Error('这个素材版本的原件无法读取。')
  const blob = await repo.readOriginal(version, signal)
  signal.throwIfAborted()
  repo.assertCurrent()
  return blob
}
watch(
  [open, () => props.versionId],
  async ([show, id], previous) => {
    release()
    if (previous?.[1] && previous[1] !== id) savingFile?.abort()
    error.value = ''
    notice.value = ''
    if (!show) return
    const request = new AbortController()
    playback = request
    try {
      const blob = await original(request.signal)
      request.signal.throwIfAborted()
      playingBlob = blob
      url.value = URL.createObjectURL(blob)
    } catch (e) {
      if (!request.signal.aborted) error.value = e instanceof Error ? e.message : '播放失败。'
    }
  },
  { immediate: true, flush: 'sync' }
)
async function download() {
  if (!props.save || saving.value) return
  const request = new AbortController()
  savingFile = request
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const blob = playingBlob || (await original(request.signal))
    request.signal.throwIfAborted()
    props.repo.assertCurrent()
    downloadBlob(blob, runtimeResultFilename(props.label, blob.type))
    notice.value = '文件已交给本机下载。'
  } catch (e) {
    if (!request.signal.aborted) error.value = e instanceof Error ? e.message : '保存失败。'
  } finally {
    if (savingFile === request) {
      savingFile = undefined
      saving.value = false
    }
  }
}
function stop() {
  release()
  savingFile?.abort()
}
onDeactivated(() => {
  open.value = false
  stop()
})
onScopeDispose(stop)
</script>
