<template>
  <section class="studio-panel studio-video-panel" aria-labelledby="studio-video-title">
    <header class="studio-heading">
      <h2 id="studio-video-title" ref="director" tabindex="-1">分镜视频</h2>
      <span v-if="api" class="studio-caption">{{ dialogue ? '音频驱动 · 25 fps' : 'Wan 2.2 · 本机 GPU' }}</span>
    </header>
    <template v-if="!api">
      <p role="status">当前工作区尚未连接。连接恢复后，重新打开项目即可继续查看镜头任务。</p>
    </template>
    <template v-else>
      <p v-if="api.kind === 'browser'" class="studio-caption">
        浏览器可逐镜生成动态或对白镜头，回到此项目会继续取回片段。批量补帧与整片导出在桌面工作区执行。
        <RouterLink to="/gallery?panel=backup">桌面资料迁移</RouterLink>
      </p>
      <details v-if="board?.templateWarnings?.length" class="studio-video-source">
        <StudioDisclosureSummary
          >有 {{ board.templateWarnings.length }} 个工作流模板无法读取</StudioDisclosureSummary
        >
        <ul data-disclosure-content>
          <li v-for="warning in board.templateWarnings" :key="warning">{{ warning }}</li>
        </ul>
      </details>
      <form
        v-if="data.shots.length"
        class="studio-video-form"
        aria-label="分镜视频导演设置"
        @submit.prevent="generate"
      >
        <div class="studio-heading">
          <strong>{{ multiple ? '批量选镜' : currentShot?.title }}</strong>
          <label v-if="api.kind === 'desktop'" class="studio-video-check"
            ><input v-model="multiple" type="checkbox" :disabled="busy" />批量选择镜头</label
          >
        </div>
        <fieldset v-if="multiple" class="studio-video-selection">
          <legend>要生成的镜头</legend>
          <div class="studio-actions">
            <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="chooseReady">
              选中可生成镜头
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy || !selectedIds.length"
              @click="selectedIds = []"
            >
              清空选择
            </button>
          </div>
          <div class="studio-video-shot-options">
            <label v-for="(shot, index) in data.shots" :key="shot.id" class="studio-video-check">
              <input v-model="selectedIds" type="checkbox" :value="shot.id" :disabled="busy" />
              <span
                >{{ index + 1 }}. {{ shot.title }}<small v-if="shotIssue(shot)">{{ shotIssue(shot) }}</small></span
              >
            </label>
          </div>
          <small>使用下方导演设置，每个镜头沿用自己的描述和关键帧。</small>
        </fieldset>
        <div class="studio-video-fields">
          <div>
            <label for="studio-video-mode">画面输入</label
            ><StudioSelect id="studio-video-mode" v-model="form.mode" :options="modeOptions" :disabled="busy" />
          </div>
          <div v-if="!dialogue">
            <label for="studio-video-camera">运镜</label
            ><StudioSelect
              id="studio-video-camera"
              v-model="form.camera"
              :options="cameraOptions"
              :disabled="busy"
            />
          </div>
          <div v-if="!dialogue">
            <label for="studio-video-motion">动态幅度</label
            ><StudioSelect
              id="studio-video-motion"
              v-model="form.motion"
              :options="motionOptions"
              :disabled="busy"
            />
          </div>
          <div v-if="!dialogue">
            <label for="studio-video-quality">速度与画质</label
            ><StudioSelect
              id="studio-video-quality"
              v-model="form.quality"
              :options="qualityOptions"
              :disabled="busy"
            />
          </div>
          <div v-if="!dialogue">
            <label for="studio-video-resolution">分辨率</label
            ><StudioSelect
              id="studio-video-resolution"
              v-model="form.resolution"
              :options="resolutions"
              :disabled="busy"
            />
          </div>
          <div v-if="!dialogue">
            <label for="studio-video-seconds">时长</label
            ><StudioSelect id="studio-video-seconds" v-model="form.seconds" :options="durations" :disabled="busy" />
          </div>
          <div v-if="templates.length > 1">
            <label for="studio-video-template">工作流模板</label>
            <StudioSelect
              id="studio-video-template"
              v-model="templateId"
              :options="templates.map((t) => ({ value: t.id, label: t.label + ' · v' + t.version }))"
              :disabled="busy"
            />
          </div>
        </div>
        <div v-if="dialogue" class="studio-actions">
          <span class="studio-caption">按各镜头绑定的角色首帧与配音生成口型和微表情。</span>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy || !inputShot" @click="editInputs">
            选择角色画面与配音
          </button>
        </div>
        <fieldset
          v-else-if="api.kind === 'desktop' && (missingFirst || missingLast)"
          class="studio-video-selection"
        >
          <legend>关键帧准备</legend>
          <label class="studio-video-check"
            ><input v-model="fillFrames" type="checkbox" :disabled="busy" />先补齐缺帧</label
          >
          <template v-if="fillFrames">
            <small>先生成所选镜头缺少的关键帧，再切换到视频模型。已绑定的版本继续用于本次生成。</small>
            <StudioVideoFramePlan
              v-model="framePlan"
              :data="data"
              :busy="busy"
              :missing-first="missingFirst"
              :missing-last="missingLast"
              :workbench-references="workbenchReferences"
            />
          </template>
        </fieldset>
        <div v-if="!dialogue" class="studio-actions">
          <label class="studio-video-check"
            ><input v-model="locked" type="checkbox" :disabled="busy" />锁定种子</label
          >
          <template v-if="locked">
            <label for="studio-video-seed">种子值</label>
            <input
              id="studio-video-seed"
              v-model="seedText"
              class="input studio-video-seed"
              inputmode="numeric"
              pattern="[0-9]+"
              maxlength="10"
              required
              :disabled="busy"
              :aria-invalid="!validSeed"
              :aria-describedby="!validSeed ? 'studio-video-admission' : undefined"
            />
          </template>
        </div>
        <p v-if="issue" id="studio-video-admission" class="studio-caption">{{ issue }}</p>
        <div class="studio-actions">
          <button
            class="btn btn-primary"
            type="submit"
            :disabled="busy || !!issue"
            :aria-describedby="issue ? 'studio-video-admission' : undefined"
          >
            <ArchiveIcon name="clap" />{{
              multiple
                ? '生成所选 ' + selectedShots.length + ' 镜'
                : currentShot?.currentClipVersionId
                  ? '重新生成此镜'
                  : '生成当前镜头'
            }}
          </button>
          <small v-if="chosenTemplate">{{ chosenTemplate.label }} · v{{ chosenTemplate.version }}</small>
        </div>
      </form>
      <p v-else class="studio-caption">先在分镜时间线添加镜头并绑定关键帧。</p>
      <div class="studio-video-queue">
        <div>
          <strong>本机 GPU 队列</strong>
          <p v-if="queue" class="studio-caption">
            {{ queue.blocked ? '等待核对上一个 GPU 任务' : queue.paused ? '已暂停接续任务' : '按模型串行执行' }} ·
            等待 {{ queue.waiting }} 项<span v-if="queue.activeModel"> · 正在运行 {{ queue.activeModel }}</span>
          </p>
          <p v-else class="studio-caption">{{ queueError || '正在读取队列…' }}</p>
        </div>
        <div class="studio-actions">
          <button v-if="queue" type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="pause">
            <ArchiveIcon :name="queue.paused ? 'play' : 'pause'" />{{
              queue.paused ? '继续本机队列' : '暂停本机队列'
            }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy || reading" @click="refreshBoard">
            <ArchiveIcon name="refresh" />刷新
          </button>
        </div>
      </div>
      <p v-if="readError" class="studio-feedback" role="alert">{{ readError }}</p>
      <p v-if="journalError" class="studio-feedback" role="alert">{{ journalError }}</p>
      <p v-if="error" class="studio-feedback" role="alert">{{ error }}</p>
      <p v-if="pending" class="studio-feedback" role="status">
        正在核对上次提交的{{ 'options' in pending ? '整片导出' : pending.shots.length + ' 个镜头' }}。
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="retry">核对并重送原批次</button>
      </p>
      <p v-if="notice" class="studio-feedback" role="status">{{ notice }}</p>
      <StudioVideoHistory
        v-if="board"
        :data="data"
        :repo="repo"
        :api="api"
        :runs="board.runs"
        :target="target"
        :busy="busy"
        @cancel="cancel"
        @reuse="reuse"
        @select="selectCurrent"
        @rework="rework"
      />
      <StudioExportPanel
        v-if="board"
        :records="board.exports"
        :desktop="api.kind === 'desktop'"
        :data="data"
        :repo="repo"
        :busy="busy"
        :pending="!!pending || !!journalError || !!readError"
        :save-shot="saveShot"
        :submit="submitExport"
        @cancel="cancelExport"
      />
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import {
  videoModes,
  videoCameras,
  videoMotions,
  videoQualities,
  type StudioFramePlan,
  type StudioVideoRun,
  type StudioVideoSettings,
} from '@/api/studioVideoApi'
import type { StudioProjectRepository, StudioProjectSnapshot, StudioShot } from '@/storage/studioProjectRepository'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioVideoHistory from './StudioVideoHistory.vue'
import StudioVideoFramePlan from './StudioVideoFramePlan.vue'
import StudioExportPanel from './StudioExportPanel.vue'
import { referenceIssue } from './projectAssets'
import { useStudioVideoBoard } from './useStudioVideoBoard'

const props = defineProps<{
  data: StudioProjectSnapshot
  repo: StudioProjectRepository
  target: string
  refresh: () => Promise<void>
  saveShot: () => Promise<boolean>
  workbenchReferences: () => string[]
  chooseShot: (id: string) => Promise<boolean>
  openInputs: () => void
}>()
const director = ref<HTMLElement>()
const {
  api,
  board,
  queue,
  activeShots,
  pending,
  busy,
  reading,
  notice,
  error,
  readError,
  queueError,
  journalError,
  refreshBoard,
  submitExport,
  cancelExport,
  selectCurrent,
  retry,
  submit,
  cancel,
  pause,
} = useStudioVideoBoard(props)
const form = reactive<StudioVideoSettings>({
  mode: 'first-last',
  camera: 'fixed',
  motion: 'medium',
  quality: 'standard',
  resolution: 480,
  seconds: 3,
  seed: null,
})
const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }))
const dialogue = computed(() => form.mode === 'dialogue')
const modeOptions = computed(() =>
    options(videoModes).filter(
      (option) => option.value !== 'dialogue' || board.value?.templates.some((t) => t.mode === 'dialogue')
    )
  ),
  cameraOptions = options(videoCameras),
  motionOptions = options(videoMotions)
const resolutions = [480, 720].map((value) => ({ value, label: value + 'p' })),
  durations = [2, 3, 5].map((value) => ({ value, label: value + ' 秒' }))
const locked = ref(false),
  seedText = ref(''),
  templateId = ref('')
const multiple = ref(false),
  selectedIds = ref<string[]>([])
const currentShot = computed(() => props.data.shots.find((s) => s.id === props.target))
const selectedShots = computed(() =>
  multiple.value
    ? props.data.shots.filter((s) => selectedIds.value.includes(s.id))
    : currentShot.value
      ? [currentShot.value]
      : []
)
const fillFrames = ref(false),
  framePlan = ref<StudioFramePlan>({ modelId: 'flux-kontext-dev', referenceVersionIds: [], canvas: 'landscape' })
const missingFirst = computed(() => selectedShots.value.some((s) => !s.firstVersionId))
const missingLast = computed(() => form.mode === 'first-last' && selectedShots.value.some((s) => !s.lastVersionId))
const byId = computed(() => new Map(props.data.versions.map((v) => [v.id, v])))
const inputShot = computed(
  () => selectedShots.value.find((shot) => !shot.firstVersionId || !shot.audioVersionId) || selectedShots.value[0]
)
async function editInputs() {
  const shot = inputShot.value
  if (shot && (await props.chooseShot(shot.id))) {
    await nextTick()
    props.openInputs()
  }
}
const templates = computed(() => board.value?.templates.filter((t) => t.mode === form.mode) || [])
const chosenTemplate = computed(
  () =>
    templates.value.find((t) => t.id === templateId.value) ||
    templates.value.find(
      (t) => t.id === (dialogue.value ? 'dialogue-audio' : form.mode === 'first-last' ? 'wan22-flf' : 'wan22-i2v')
    ) ||
    templates.value[0]
)
const qualityOptions = computed(() => {
  const template = chosenTemplate.value
  const builtin = template?.version === 1 && ['wan22-flf', 'wan22-i2v'].includes(template.id)
  return options(videoQualities).map((item) => {
    const steps =
      template?.steps?.[item.value as StudioVideoSettings['quality']] ??
      (builtin ? (item.value === 'quality' ? 8 : 4) : null)
    return { ...item, label: steps ? item.label + ' · ' + steps + ' 步' : item.label }
  })
})
watch(chosenTemplate, (template) => {
  templateId.value = template?.id || ''
})
const validSeed = computed(() => /^\d+$/.test(seedText.value) && Number(seedText.value) <= 2_147_483_647)
watch(locked, (value) => {
  if (value && !seedText.value) seedText.value = String(crypto.getRandomValues(new Uint32Array(1))[0] >>> 1)
})
watch(multiple, (value) => {
  if (value && !selectedIds.value.length && props.target) selectedIds.value = [props.target]
})
function shotIssue(shot: StudioShot) {
  if (activeShots.value.has(shot.id)) return '已有一条任务在队列中'
  if (dialogue.value) {
    if (!shot.firstVersionId) return '待绑定角色首帧'
    if (!shot.audioVersionId) return '待绑定配音'
    const audio = byId.value.get(shot.audioVersionId)
    if (audio?.mime !== 'audio/wav' || audio.bytes > 20 * 1024 * 1024) return '需要 20 MiB 以内的 PCM WAV 配音'
  }
  const slots = form.mode === 'first-last' ? [shot.firstVersionId, shot.lastVersionId] : [shot.firstVersionId]
  if (
    slots.some((id) => {
      if (!id) return false
      const version = byId.value.get(id)
      return (
        !version ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(version.mime) ||
        version.bytes > 20 * 1024 * 1024
      )
    })
  )
    return '视频帧需要 20 MiB 以内的 PNG、JPEG 或 WebP'
  if (!fillFrames.value && !shot.firstVersionId) return '待绑定首帧'
  if (!fillFrames.value && form.mode === 'first-last' && !shot.lastVersionId) return '待绑定尾帧'
  return ''
}
function chooseReady() {
  selectedIds.value = props.data.shots.filter((shot) => !shotIssue(shot)).map((shot) => shot.id)
}
const issue = computed(() => {
  if (!board.value || readError.value) return '请先读取本项目的视频队列。'
  if (journalError.value || pending.value) return '请先核对上次提交的批次。'
  if (board.value.unavailable) return board.value.unavailable
  if (board.value.modelIssues?.[form.mode]) return board.value.modelIssues[form.mode]
  if (!chosenTemplate.value) return '这个模式的原生工作流尚未就绪。'
  if (!selectedShots.value.length) return '请先选择要生成的镜头。'
  if (selectedShots.value.length > 64) return '一个批次最多可提交 64 个镜头。'
  if (!dialogue.value && fillFrames.value && (missingFirst.value || missingLast.value)) {
    const refs = framePlan.value.referenceVersionIds
    if (!refs.length || refs.length > 4 || refs.some((id) => referenceIssue(byId.value.get(id))))
      return '补帧需要 1 至 4 张参考图，每张为 16 MiB 以内的 PNG、JPEG 或 WebP。'
  }
  if (!dialogue.value && locked.value && !validSeed.value) return '种子范围为 0 至 2147483647。'
  const incomplete = selectedShots.value.find((shot) => shotIssue(shot))
  return incomplete ? `「${incomplete.title}」${shotIssue(incomplete)}。` : ''
})
function generate() {
  if (issue.value) return
  const ids = selectedShots.value.map((shot) => shot.id)
  const template = chosenTemplate.value!
  const settings: StudioVideoSettings & { templateId: string } = dialogue.value
    ? {
        mode: 'dialogue',
        camera: 'fixed',
        motion: 'low',
        quality: 'standard',
        resolution: 480,
        seconds: 2,
        seed: null,
        templateId: template.id,
      }
    : { ...form, seed: locked.value ? Number(seedText.value) : null, templateId: template.id }
  const plan = fillFrames.value
    ? { ...framePlan.value, referenceVersionIds: [...framePlan.value.referenceVersionIds] }
    : null
  void submit(async () => {
    if (!(await props.saveShot())) throw new Error('请先保存分镜时间线里的镜头信息。')
    await nextTick()
    return ids.map((id) => {
      const shot = props.data.shots.find((s) => s.id === id)
      if (!shot || activeShots.value.has(id)) throw new Error('镜头资料已变化，请重新核对首尾帧后提交。')
      const first = !shot.firstVersionId,
        last = settings.mode === 'first-last' && !shot.lastVersionId
      const input = { ...settings, shotId: shot.id, expectedRevision: shot.revision }
      if (settings.mode === 'dialogue') {
        if (!shot.firstVersionId || !shot.audioVersionId) throw new Error('请先为对白镜头绑定角色首帧与配音。')
        return input
      }
      if (!first && !last) return input
      if (!plan?.referenceVersionIds.length) throw new Error('请先选择参考图或绑定缺少的关键帧。')
      const prompt = (change: string) => {
        const value = [shot.prompt.trim() || shot.title, change.trim()].join('\n')
        if (value.length > 4000) throw new Error(`「${shot.title}」的镜头描述与补帧变化合计超过 4000 字符。`)
        return value
      }
      return {
        ...input,
        framePlan: {
          modelId: plan.modelId,
          referenceVersionIds: plan.referenceVersionIds,
          canvas: plan.canvas,
          ...(first && plan.firstPrompt?.trim() ? { firstPrompt: prompt(plan.firstPrompt) } : {}),
          ...(last && plan.lastPrompt?.trim() ? { lastPrompt: prompt(plan.lastPrompt) } : {}),
        },
      }
    })
  })
}
function reuse(run: StudioVideoRun) {
  const { mode, camera, motion, quality, resolution, seconds, seed } = run.settings
  Object.assign(form, { mode, camera, motion, quality, resolution, seconds })
  templateId.value = run.templateId
  locked.value = seed !== null
  seedText.value = seed === null ? '' : String(seed)
  notice.value = `已载入「${run.shotTitle}」的导演设置。`
}
async function rework(run: StudioVideoRun) {
  if (busy.value || !(await props.chooseShot(run.shotId))) return
  multiple.value = false
  fillFrames.value = false
  reuse(run)
  await nextTick()
  director.value?.focus()
  notice.value = `已选中「${run.shotTitle}」。可更换关键帧或配音，再生成此镜。`
}
</script>
<style src="@/assets/css/studio-shot-video.css"></style>
