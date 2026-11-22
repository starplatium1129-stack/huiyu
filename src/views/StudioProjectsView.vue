<template>
  <article class="studio-projects page">
    <header class="studio-title">
      <div>
        <h1 class="page-title">创作项目</h1>
        <p v-if="snapshot" class="studio-caption">{{ snapshot.project.title }} · {{ snapshot.shots.length }} 个镜头</p>
      </div>
      <RouterLink to="/video-studio" class="btn btn-ghost btn-sm"><ArchiveIcon name="clap" />故事短片</RouterLink>
    </header>
    <p v-if="route.query.import === 'storyboard'" class="studio-caption studio-import-note">
      选好项目后，点击分镜时间线的「导入旧分镜草稿」。
    </p>
    <div class="studio-project-bar">
      <div v-if="projects.length">
        <label for="studio-project-selector">当前项目</label
        ><StudioSelect
          id="studio-project-selector"
          :model-value="snapshot?.project.id || ''"
          :options="projectOptions"
          :disabled="creating"
          @update:model-value="switchProject(String($event))"
        />
      </div>
      <form aria-label="新建创作项目" @submit.prevent="create">
        <div>
          <label for="studio-new-project">新项目名称</label
          ><input
            id="studio-new-project"
            v-model="newTitle"
            class="input"
            maxlength="120"
            required
            placeholder="例如，雨后的车站"
          />
        </div>
        <button type="submit" class="btn btn-ghost" :disabled="creating || !repo || !newTitle.trim()">
          <ArchiveIcon name="plus" />新建项目
        </button>
      </form>
    </div>
    <p v-if="error" class="studio-feedback" role="alert">
      {{ error }} <button class="btn btn-ghost btn-sm" type="button" @click="load">重新读取项目</button>
    </p>
    <p v-if="loading" class="studio-caption" role="status">正在读取创作项目…</p>
    <p v-else-if="!error && !projects.length" class="studio-panel">
      创建第一个项目后，就可以为镜头准备角色、场景和关键帧。
    </p>
    <div v-if="snapshot && repo" :key="sessionKey + snapshot.project.id" class="studio-project-layout">
      <StudioAssetHub
        ref="hub"
        :data="snapshot"
        :repo="repo"
        :selected="selected"
        :refresh="refresh"
        @select="selected = $event"
        @reference="addReference"
        @outfit="reuseOutfit"
      />
      <div class="studio-work-area">
        <StudioShotList
          ref="timeline"
          :data="snapshot"
          :repo="repo"
          :selected="selected"
          :target="target"
          :refresh="refresh"
          @target="selectShot"
        />
        <div class="studio-segments studio-segments--compact" role="group" aria-label="镜头工作台">
          <AnimatedSelection />
          <button type="button" :aria-pressed="!videoOpen" @click="setVideoOpen(false)"><ArchiveIcon name="image" />关键帧工坊</button>
          <button type="button" :aria-pressed="videoOpen" @click="setVideoOpen(true)"><ArchiveIcon name="clap" />分镜视频</button>
        </div>
        <KeyframeWorkbench
          :active="!videoOpen"
          :key="workbenchKey"
          ref="workbench"
          :repo="repo"
          :data="snapshot"
          :target-title="targetTitle"
          :shot-busy="timeline?.busy ?? false"
          :import-files="importReferences"
          :refresh="refresh"
          @bind="bindCandidate"
          @add-shot="addCandidateShot"
          @reload="reloadWorkbench"
        />
        <KeepAlive>
          <StudioShotVideoPanel v-if="videoOpen" :repo="repo" :data="snapshot" :target="target"
            :refresh="refresh" :save-shot="saveCurrentShot" :workbench-references="() => workbench?.currentReferences() || []"
            :choose-shot="openVideoShot" :open-inputs="() => timeline?.openInputs()" />
        </KeepAlive>
      </div>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import {
  captureStudioProjectRepository,
  type StudioAssetKind,
  type StudioProject,
  type StudioProjectSnapshot,
} from '@/storage/studioProjectRepository'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioAssetHub from '@/components/studio/StudioAssetHub.vue'
import StudioShotList from '@/components/studio/StudioShotList.vue'
import KeyframeWorkbench from '@/components/studio/KeyframeWorkbench.vue'
const StudioShotVideoPanel = defineAsyncComponent(() => import('@/components/studio/StudioShotVideoPanel.vue'))
const route = useRoute(),
  router = useRouter(),
  repo = shallowRef<ReturnType<typeof captureStudioProjectRepository>>()
const projects = shallowRef<StudioProject[]>([]),
  snapshot = shallowRef<StudioProjectSnapshot>(),
  selected = ref(''),
  target = ref('')
const loading = ref(true),
  creating = ref(false),
  error = ref(''),
  newTitle = ref(''),
  sessionKey = ref(0),
  workbenchKey = ref(0)
const hub = ref<InstanceType<typeof StudioAssetHub>>(),
  timeline = ref<InstanceType<typeof StudioShotList>>(),
  workbench = ref<InstanceType<typeof KeyframeWorkbench>>()
const projectOptions = computed(() => projects.value.map((p) => ({ value: p.id, label: p.title })))
const videoOpen = computed(() => route.query.tool === 'video')
function setVideoOpen(open: boolean) {
  if (videoOpen.value !== open) return router.replace({ path: route.path, query: { ...route.query, tool: open ? 'video' : undefined } })
    .catch(e => { error.value = text(e) })
}
async function saveCurrentShot() { return timeline.value ? timeline.value.prepareVideo() : true }
async function openVideoShot(id: string) {
  if (!snapshot.value?.shots.some(shot => shot.id === id) || !await saveCurrentShot()) return false
  if (target.value !== id) selectShot(id)
  return true
}
const targetTitle = computed(() => snapshot.value?.shots.find((s) => s.id === target.value)?.title || '')
let epoch = '',
  loadSerial = 0,
  refreshSerial = 0,
  disposed = false
function text(e: unknown) {
  return e instanceof Error ? e.message : '读取失败，请重试'
}
function apply(value: StudioProjectSnapshot) {
  snapshot.value = value
  if (!value.shots.some((shot) => shot.id === target.value))
    target.value = value.shots.find((shot) => shot.id === route.query.shot)?.id || value.shots[0]?.id || ''
  if (!value.versions.some((version) => version.id === selected.value)) selected.value = ''
}
async function load() {
  const sequence = ++loadSerial
  refreshSerial++
  loading.value = true
  error.value = ''
  const request = typeof route.query.project === 'string' ? route.query.project : ''
  try {
    const captured = (repo.value = captureStudioProjectRepository())
    const entries = await captured.listProjects()
    if (disposed || sequence !== loadSerial) return
    captured.assertCurrent()
    projects.value = entries
    const id = request || entries[0]?.id
    if (!id) {
      snapshot.value = undefined
      return
    }
    if (!entries.some((p) => p.id === id)) throw new Error('选中的创作项目不在当前资料库中')
    let value = await captured.getProject(id)
    if (captured.selectBrowserClip && value.shots.some(shot => shot.currentClipVersionId === undefined)) {
      const { recoverStoredStudioClips } = await import('@/platform/web/legacyStudioClips')
      if (disposed || sequence !== loadSerial) return
      if (await recoverStoredStudioClips(captured, id, captured.assertCurrent)) value = await captured.getProject(id)
    }
    if (disposed || sequence !== loadSerial) return
    captured.assertCurrent()
    apply(value)
    if (!request && route.path === '/studio-projects')
      await router.replace({ path: route.path, query: { ...route.query, project: id } })
  } catch (e) {
    if (!disposed && sequence === loadSerial) {
      snapshot.value = undefined
      error.value = text(e)
    }
  } finally {
    if (sequence === loadSerial) loading.value = false
  }
}
async function refresh() {
  const captured = repo.value,
    id = snapshot.value?.project.id
  if (!captured || !id) return
  const sequence = ++refreshSerial
  const next = await captured.getProject(id)
  if (disposed || captured !== repo.value || sequence !== refreshSerial || id !== snapshot.value?.project.id) return
  captured.assertCurrent()
  apply(next)
}
async function reloadWorkbench() {
  try {
    await refresh()
    workbenchKey.value++
    error.value = ''
  } catch (e) {
    error.value = text(e)
  }
}
function connectionChanged() {
  const next = imageMediaSession()
  if (next === epoch) return
  epoch = next
  sessionKey.value++
  snapshot.value = undefined
  projects.value = []
  selected.value = ''
  target.value = ''
  void load()
}
const unsubscribe = onDesktopRuntime(connectionChanged)
watch(imageMediaSession, connectionChanged, { flush: 'sync' })
watch(
  () => route.query.project,
  (id) => {
    if (route.path === '/studio-projects' && id !== snapshot.value?.project.id) {
      snapshot.value = undefined
      target.value = ''
      selected.value = ''
      void load()
    }
  }
)
watch(
  () => route.query.shot,
  (id) => {
    if (typeof id === 'string' && snapshot.value?.shots.some((shot) => shot.id === id)) target.value = id
  }
)
function selectShot(id: string) {
  target.value = id
  void router
    .replace({ path: '/studio-projects', query: { ...route.query, project: snapshot.value?.project.id, shot: id } })
    .catch((e) => {
      error.value = text(e)
    })
}
async function switchProject(id: string) {
  if (snapshot.value?.project.id === id) return
  try {
    if (timeline.value && !(await timeline.value.saveShot())) return
    await workbench.value?.flushDraft()
    await router.replace({ path: '/studio-projects', query: { ...route.query, project: id, shot: undefined } })
  } catch (e) {
    error.value = text(e)
  }
}
async function create() {
  const captured = repo.value,
    title = newTitle.value.trim()
  if (!captured || creating.value || !title) return
  creating.value = true
  error.value = ''
  try {
    if (timeline.value && !(await timeline.value.saveShot())) return
    await workbench.value?.flushDraft()
    captured.assertCurrent()
    const project = await captured.createProject(title)
    if (disposed || captured !== repo.value) return
    captured.assertCurrent()
    newTitle.value = ''
    await router.replace({ path: '/studio-projects', query: { ...route.query, project: project.id, shot: undefined } })
  } catch (e) {
    if (!disposed) error.value = text(e)
  } finally {
    creating.value = false
  }
}
async function importReferences(files: File[], kind: StudioAssetKind = 'keyframe') {
  if (!hub.value) throw new Error('素材库尚未就绪')
  const ids = await hub.value.importFiles(files, kind)
  await nextTick()
  return ids
}
async function addReference(id: string) {
  await setVideoOpen(false)
  await nextTick()
  workbench.value?.addReferences([id])
}
async function reuseOutfit(id: string) {
  await setVideoOpen(false)
  await nextTick()
  await workbench.value?.reuseLook(id, 'scene')
}
async function bindCandidate(id: string, slot: 'first' | 'last') {
  if (await timeline.value?.bind(id, slot)) selected.value = id
}
function addCandidateShot(id: string) {
  selected.value = id
  void timeline.value?.add(id)
}
onBeforeRouteLeave(async () => {
  if (timeline.value && !(await timeline.value.saveShot())) return false
})
onScopeDispose(() => {
  disposed = true
  loadSerial++
  refreshSerial++
  unsubscribe()
})
</script>
<style src="@/assets/css/studio-projects.css"></style>
