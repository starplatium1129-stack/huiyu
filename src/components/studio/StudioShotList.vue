<template>
  <section class="studio-panel studio-timeline" aria-labelledby="studio-shot-list">
    <header class="studio-heading">
      <h2 id="studio-shot-list">分镜时间线</h2>
      <span class="studio-caption">{{ data.shots.length }} 镜</span>
    </header>
    <div class="studio-actions">
      <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="add()">
        <ArchiveIcon name="plus" />添加镜头
      </button>
      <button v-if="legacyCount" type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="copyDraft">
        导入旧分镜草稿（{{ legacyCount }} 镜）
      </button>
    </div>
    <p v-if="!data.shots.length" class="studio-caption">添加镜头后，就能在这里绑定首帧和尾帧。</p>
    <div v-else class="studio-shot-strip" role="group" aria-label="选择目标镜头">
      <button
        v-for="(item, i) in data.shots"
        :key="item.id"
        type="button"
        class="studio-shot-tab"
        :aria-pressed="item.id === target"
        :disabled="busy"
        @click="choose(item.id)"
      >
        <span>{{ String(i + 1).padStart(2, '0') }}</span> {{ item.title }}
        <small v-if="item.currentClipVersionId"> · 有成片</small>
      </button>
    </div>
    <template v-if="shot">
      <form class="studio-shot-form" aria-label="镜头信息" @submit.prevent="saveShot">
        <div>
          <label for="studio-shot-title">镜头名称</label
          ><input id="studio-shot-title" v-model="title" class="input" maxlength="120" required />
        </div>
        <div>
          <label for="studio-shot-prompt">镜头描述</label
          ><textarea id="studio-shot-prompt" v-model="prompt" class="textarea" maxlength="4000" rows="2" />
        </div>
        <button class="btn btn-ghost btn-sm" :disabled="busy || !edited || !title.trim()" type="submit">
          保存镜头
        </button>
        <button v-if="conflicted" class="btn btn-ghost btn-sm" type="button" @click="adopt(shot)">
          采用最新镜头资料
        </button>
      </form>
      <div class="studio-frame-slots">
        <div
          v-for="slot in slots"
          :key="slot.id"
          class="studio-frame-slot"
          @dragover="allowDrop"
          @drop="dropFrame($event, slot.id)"
        >
          <StudioAssetThumb :version="versionAt(slot.id)" />
          <div>
            <strong>{{ slot.name }}</strong
            ><small>{{ versionAt(slot.id) ? versionLabel(data, versionAt(slot.id)!.id) : '待绑定' }}</small>
          </div>
          <div class="studio-actions">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="busy || !validSelection || versionAt(slot.id)?.id === selected"
              @click="bind(selected, slot.id)"
            >
              绑定选中素材
            </button>
            <button
              v-if="versionAt(slot.id)"
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="busy"
              @click="bind(null, slot.id)"
            >
              清空{{ slot.name }}
            </button>
          </div>
        </div>
      </div>
      <StudioShotInputs ref="inputs" :data="data" :shot="shot" :repo="repo" :busy="busy" @bind="changeInput" />
      <section class="studio-video-group" aria-labelledby="studio-timeline-current">
        <h3 id="studio-timeline-current">当前成片</h3>
        <template v-if="shot.currentClipVersionId">
          <p class="studio-caption">{{ versionLabel(data, shot.currentClipVersionId) }}</p>
          <StudioVersionMedia
            :key="shot.id + ':' + shot.currentClipVersionId"
            :version-id="shot.currentClipVersionId"
            :data="data"
            :repo="repo"
            :label="shot.title"
            save
          />
        </template>
        <p v-else class="studio-caption">生成这个镜头，或从生成历史中选用一个版本。</p>
      </section>
    </template>
    <p v-if="message" class="studio-feedback" role="status">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useVideoStore } from '@/stores/videoStore'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioAssetThumb from './StudioAssetThumb.vue'
import StudioShotInputs from './StudioShotInputs.vue'
import StudioVersionMedia from './StudioVersionMedia.vue'
import { importStoryboard } from './importStoryboard'
import { frameDragType, imageVersion, versionLabel } from './projectAssets'
import type {
  captureStudioProjectRepository,
  StudioProjectSnapshot,
  StudioShot,
} from '@/storage/studioProjectRepository'
const props = defineProps<{
  data: StudioProjectSnapshot
  repo: ReturnType<typeof captureStudioProjectRepository>
  target: string
  selected: string
  refresh: () => Promise<void>
}>()
const emit = defineEmits<{ target: [id: string] }>()
const shot = computed(() => props.data.shots.find((item) => item.id === props.target))
const validSelection = computed(() => imageVersion(props.data.versions.find((item) => item.id === props.selected)))
const videoStore = useVideoStore()
const legacyCount = computed(() => videoStore.shotsDraft?.shots.length || 0)
const slots = [
  { id: 'first', name: '首帧' },
  { id: 'last', name: '尾帧' },
] as const
const title = ref(''),
  prompt = ref(''),
  busy = ref(false),
  message = ref(''),
  life = new AbortController()
onScopeDispose(() => life.abort())
const baseline = shallowRef<StudioShot>()
const inputs = ref<InstanceType<typeof StudioShotInputs>>()
const edited = computed(
  () => !!baseline.value && (title.value !== baseline.value.title || prompt.value !== baseline.value.prompt)
)
const conflicted = computed(() => edited.value && shot.value?.revision !== baseline.value?.revision)
function adopt(value: StudioShot | undefined) {
  baseline.value = value
  title.value = value?.title || ''
  prompt.value = value?.prompt || ''
}
watch(
  shot,
  (value) => {
    if (!edited.value || value?.id !== baseline.value?.id) adopt(value)
    else if (value?.title === baseline.value?.title && value?.prompt === baseline.value?.prompt)
      baseline.value = value
  },
  { immediate: true }
)
function versionAt(slot: 'first' | 'last') {
  const id = slot === 'first' ? shot.value?.firstVersionId : shot.value?.lastVersionId
  return props.data.versions.find((version) => version.id === id)
}
async function act(work: () => Promise<string>) {
  if (busy.value) return false
  busy.value = true
  message.value = ''
  try {
    message.value = await work()
    return true
  } catch (e) {
    if (!life.signal.aborted) message.value = e instanceof Error ? e.message : '镜头更新失败'
    return false
  } finally {
    try {
      if (!life.signal.aborted) await props.refresh()
    } catch (e) {
      if (!life.signal.aborted) message.value = e instanceof Error ? e.message : '镜头读取失败'
    } finally {
      busy.value = false
    }
  }
}
async function saveShot() {
  const original = baseline.value
  if (!original || !edited.value) return true
  if (!title.value.trim()) {
    message.value = '请先填写镜头名称'
    return false
  }
  return act(async () => {
    const saved = await props.repo.updateShot(original, { title: title.value.trim(), prompt: prompt.value })
    life.signal.throwIfAborted()
    adopt(saved)
    return '已保存镜头。'
  })
}
async function choose(id: string) {
  if ((await saveShot()) && !life.signal.aborted) emit('target', id)
}
async function add(firstVersionId?: string) {
  if (!(await saveShot()) || life.signal.aborted) return
  let id = ''
  if (
    (await act(async () => {
      const initial = firstVersionId ? { id: crypto.randomUUID(), firstVersionId } : undefined
      const value = await props.repo.createShot(props.data.project.id, `镜头 ${props.data.shots.length + 1}`, initial)
      id = value.id
      return firstVersionId ? '已用这张图作为新镜头的首帧。' : '已添加镜头。'
    })) &&
    !life.signal.aborted
  )
    emit('target', id)
}
async function copyDraft() {
  await act(async () => {
    const count = await importStoryboard(props.repo, props.data, life.signal)
    return count ? `已导入 ${count} 镜。` : '这份草稿中的镜头已在项目中。'
  })
}
async function bind(id: string | null, slot: 'first' | 'last') {
  const original = shot.value
  if (!original) {
    message.value = '请先添加并选中目标镜头'
    return false
  }
  if (id && !imageVersion(props.data.versions.find((v) => v.id === id))) {
    message.value = '请选择当前素材库中的图片版本'
    return false
  }
  return act(async () => {
    await props.repo.bindFrame(original, slot, id)
    return `「${original.title}」的${slot === 'first' ? '首帧' : '尾帧'}已${id ? '绑定' : '清空'}。`
  })
}
async function changeInput(slot: 'firstVersionId' | 'audioVersionId', id: string | null) {
  const original = shot.value
  if (!original) return
  await act(async () => {
    await props.repo.updateShot(original, { [slot]: id })
    return `「${original.title}」的${slot === 'firstVersionId' ? '首帧' : '配音'}已${id ? '绑定' : '清空'}。`
  })
}
function allowDrop(event: DragEvent) {
  if (event.dataTransfer?.types.includes(frameDragType)) event.preventDefault()
}
function dropFrame(event: DragEvent, slot: 'first' | 'last') {
  const id = event.dataTransfer?.getData(frameDragType)
  if (id) {
    event.preventDefault()
    void bind(id, slot)
  }
}
async function prepareVideo() {
  if (!busy.value) return saveShot()
  message.value = '正在更新分镜，请等这次保存完成后再提交。'
  return false
}
defineExpose({ add, bind, busy, saveShot, prepareVideo, openInputs: () => inputs.value?.reveal() })
</script>
