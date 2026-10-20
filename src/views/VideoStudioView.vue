<template>
  <article class="video-studio page">
    <header class="video-header">
      <div>
        <div class="page-kicker">画室 / 影像创作</div>
        <h1 class="page-title">故事短片</h1>
      </div>
      <div class="video-header-actions">
      <span class="video-connection" :data-state="archiveState" role="status">{{ archiveStatus }}</span>
      <button class="btn btn-ghost" type="button" :disabled="statusLoading" @click="loadStatus">
        <ArchiveIcon name="refresh" />
        {{ statusLoading ? '检测中' : '重新检测' }}
      </button>
      </div>
    </header>

    <VideoDraftNotice />

    <section class="video-mode-strip studio-segments" data-fluid-glass role="group" aria-label="视频创作方式"><AnimatedSelection />
      <StudioTooltip v-for="mode in modes" :key="mode.id" :anchor="!modeReady(mode.id)" :content="!modeReady(mode.id) ? modeBadge(mode.id) : undefined">
      <button
        class="video-mode-card"
        type="button"
        :class="{ active: selectedMode === mode.id }"
        :aria-pressed="selectedMode === mode.id"
        :aria-describedby="selectedMode === mode.id ? 'video-mode-description' : undefined"
        :disabled="!modeReady(mode.id)"
        @click="selectedMode = mode.id"
      >
        <span class="video-mode-icon studio-control-icon"><ArchiveIcon :name="mode.icon" /></span>
        <strong class="studio-control-label">{{ mode.label }}</strong>
      </button>
      </StudioTooltip>
    </section>
    <div class="video-mode-context">
      <p id="video-mode-description"><strong>{{ modeBadge(selectedMode) }}</strong></p>
      <nav v-if="selectedMode !== 'shots'" class="video-jump-nav tw:p-s-1 tw:rounded-md" data-fluid-glass aria-label="视频工作区导航"><RouterLink v-if="selectedMode !== 'text'" :to="{ query: $route.query, hash: '#video-frames' }">准备画面</RouterLink><RouterLink :to="{ query: $route.query, hash: '#video-brief' }">镜头描述</RouterLink><RouterLink :to="{ query: $route.query, hash: '#video-settings' }">画幅与时长</RouterLink><RouterLink :to="{ query: $route.query, hash: '#video-queue' }">查看成片</RouterLink></nav>
    </div>
    <VideoGenerationBar v-if="selectedMode !== 'shots'" id="video-settings"
      v-model:aspect-ratio="aspectRatio" v-model:duration="duration" v-model:quality="quality"
      :aspect-options="aspectSelectOptions"
      :duration-options="durationSelectOptions"
      :quality-options="qualitySelectOptions"
      :can-generate="canGenerate" :submitting="submitting" :submit-title="submitTitle" :submit-description="submitDescription"
      @generate="submitVideo" />
    <div class="video-workspace" data-route-arrive :class="{ 'video-workspace--shots': selectedMode === 'shots' }" v-content-motion:up="selectedMode">
      <div class="video-creation-column">
        <KeepAlive><AsyncPanel v-if="selectedMode === 'shots'" :loader="loadShotListEditor" label="分镜工作台" v-slot="{ component }"><component :is="component" :status="status" /></AsyncPanel></KeepAlive>
        <template v-if="selectedMode !== 'shots'">
        <div class="video-draft-grid" :class="{ 'has-frames': selectedMode !== 'text' }">
        <section v-if="selectedMode === 'image'" id="video-frames" class="video-panel video-first-frame-panel">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">00 · 首帧</span>
              <h2>故事从这里展开</h2>
            </div>
            <button v-if="hasFirstFrame" class="btn btn-ghost" type="button" @click="removeFrame($event, 'first')">移除</button>
          </div>
          <RuntimeImage v-if="videoImageUrl" :src="videoImageUrl" v-slot="{ image, loaded, failed }"><div class="video-frame-preview"><img v-if="image.src && !failed" v-bind="image" class="video-first-frame" :class="{ 'is-ready': loaded }" alt="视频首帧" /><span v-if="!loaded" role="status">{{ failed ? '首帧暂时无法展开，请移除后重新选择' : '正在展开首帧…' }}</span></div></RuntimeImage>
          <label v-else class="video-upload-drop video-upload-drop--single" tabindex="-1" :data-busy="uploadingImage || undefined">
            <input ref="firstFrameInput" type="file" accept="image/*" aria-label="上传视频首帧" :disabled="uploadingImage" @change="handleFrameFile($event, 'first')" />
            <span class="video-upload-icon" aria-hidden="true"><ArchiveIcon name="image" /></span>
            <strong>{{ uploadingImage ? '正在准备首帧…' : '上传首帧' }}</strong>
            <span>选择故事的起点，让画面接着动起来</span>
          </label>
        </section>

        <section v-else-if="selectedMode === 'first-last-frame'" id="video-frames" class="video-panel video-first-frame-panel">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">00 · 首尾帧</span>
              <h2>锁定开始与结束画面</h2>
            </div>
            <span class="video-count">首尾画面衔接</span>
          </div>
          <div class="video-dual-frame-grid">
            <div class="video-frame-slot tw:grid tw:gap-s-2 tw:content-start">
              <span class="field-label">A · 故事开始 / 输入首帧</span>
              <RuntimeImage v-if="videoImageUrl" :src="videoImageUrl" v-slot="{ image, loaded, failed }"><div class="video-frame-preview"><img v-if="image.src && !failed" v-bind="image" class="video-first-frame" :class="{ 'is-ready': loaded }" alt="视频首帧" /><span v-if="!loaded" role="status">{{ failed ? '首帧暂时无法展开，请移除后重新选择' : '正在展开首帧…' }}</span></div></RuntimeImage>
              <label v-else class="video-upload-drop" tabindex="-1" :data-busy="uploadingImage || undefined">
                <input ref="firstFrameInput" type="file" accept="image/*" aria-label="上传视频首帧" :disabled="uploadingImage" @change="handleFrameFile($event, 'first')" />
                <span class="video-upload-icon" aria-hidden="true"><ArchiveIcon name="image" /></span>
                <span>上传首帧</span>
              </label>
              <button v-if="hasFirstFrame" class="btn btn-ghost btn-block" type="button" @click="removeFrame($event, 'first')">移除首帧</button>
            </div>
            <div class="video-frame-slot tw:grid tw:gap-s-2 tw:content-start">
              <span class="field-label">B · 故事落点 / 输入尾帧</span>
              <RuntimeImage v-if="lastFrameUrl" :src="lastFrameUrl" v-slot="{ image, loaded, failed }"><div class="video-frame-preview"><img v-if="image.src && !failed" v-bind="image" class="video-first-frame" :class="{ 'is-ready': loaded }" alt="视频尾帧" /><span v-if="!loaded" role="status">{{ failed ? '尾帧暂时无法展开，请移除后重新选择' : '正在展开尾帧…' }}</span></div></RuntimeImage>
              <label v-else class="video-upload-drop" tabindex="-1" :data-busy="uploadingImage || undefined">
                <input ref="lastFrameInput" type="file" accept="image/*" aria-label="上传视频尾帧" :disabled="uploadingImage" @change="handleFrameFile($event, 'last')" />
                <span class="video-upload-icon" aria-hidden="true"><ArchiveIcon name="image" /></span>
                <span>上传尾帧</span>
              </label>
              <button v-if="hasLastFrame" class="btn btn-ghost btn-block" type="button" @click="removeFrame($event, 'last')">移除尾帧</button>
            </div>
          </div>
        </section>

        <section id="video-brief" class="video-panel video-brief-panel">
          <div class="video-panel-heading">
            <div>
              <span class="video-step">01 · 镜头意图</span>
              <h2>{{ selectedMode === 'text' ? '把脑海中的一幕，写成镜头' : selectedMode === 'image' ? '这张画里，接下来会发生什么？' : '从开始到结束，故事怎样发生？' }}</h2>
            </div>
            <span class="video-count" :data-warning="prompt.length > 900 || undefined">
              {{ prompt.length }} / 4000
            </span>
          </div>
          <textarea
            v-model="prompt"
            aria-label="镜头描述"
            class="textarea video-prompt"
            maxlength="4000"
            rows="7"
            placeholder="例如：黄昏的电车站，少女回头看向镜头，风吹起发丝和裙摆，镜头缓慢推进，暖色逆光，动作自然连续。"
          ></textarea>
        </section>
        </div>

        <section class="video-panel video-details-panel">
          <div class="video-panel-heading">
            <div>
              <h2>镜头与细节</h2>
            </div>
          </div>

          <div class="video-choice-pair">
            <label class="field">
              <span class="field-label">镜头运动</span>
              <StudioSelect
                v-model="camera"
                label="镜头运动"
                :options="cameraSelectOptions"
              />
            </label>
            <label class="field">
              <span class="field-label">主体运动</span>
              <StudioSelect
                v-model="motion"
                label="主体运动"
                :options="motionSelectOptions"
              />
            </label>
          </div>

          <details class="video-advanced">
            <StudioDisclosureSummary class="video-disclosure-heading">高级设置</StudioDisclosureSummary>
            <div class="video-advanced-grid" data-disclosure-content>
              <ToggleSwitch
                v-if="activeModel?.id === 'minimax-h3'"
                class="video-steps-toggle"
                :model-value="steps === 4"
                label="极速 4 步"
                @update:model-value="steps = $event ? 4 : 8"
              >
                <span>
                  <strong>极速 4 步</strong>
                  <small>更快生成预览，画面细节会略有减少。</small>
                </span>
              </ToggleSwitch>
              <label class="field">
                <span class="field-label">负向描述</span>
                <textarea
                  v-model="negative"
                  class="textarea"
                  rows="3"
                  maxlength="1000"
                  placeholder="可选。基础质量与稳定性负向词已由工作室自动补全。"
                ></textarea>
              </label>
              <label class="field">
                <span class="field-label">固定 Seed</span>
                <input v-model="seedText" class="input input-mono" inputmode="numeric" placeholder="留空则随机" />
              </label>
            </div>
          </details>
        </section>

        </template>
      </div>

      <aside class="video-side-column">
        <section id="video-queue" ref="queuePanel" class="video-panel video-queue-panel" aria-live="polite" aria-labelledby="video-queue-title" tabindex="-1">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">任务队列</span>
              <h2 id="video-queue-title">{{ jobSelectionPending && job ? '上次读取的成片' : '当前成片' }}</h2>
            </div>
            <span v-if="t8State" class="video-t8-badge" :data-state="t8State.available ? 'fast' : 'slow'">
              <ArchiveIcon :name="t8State.available ? 'lightning' : 'warning'" />
              <span>{{ !status?.online ? '加速状态待检测' : t8State.available ? 'T8 双时钟加速' : '原生采样' }}</span>
            </span>
          </div>
          <div v-if="jobSelectionPending || selectedJobReading || selectedJobError" class="video-inline-message" :class="{ error: selectedJobError }" role="status">
            <strong>{{ selectedJobError ? '所选任务暂未读取' : '正在读取所选视频任务…' }}</strong>
            <p>{{ selectedJobError || (job ? '上一段预览已保留，任务读取完成后更新。' : '读取完成后会显示任务与成片。') }}</p>
            <button v-if="selectedJobError" class="btn btn-ghost" type="button" :disabled="selectedJobReading" @click="retrySelectedTask">重新读取所选任务</button>
          </div>
          <div v-if="requestPending" class="video-inline-message warning" role="status">
            <p>原视频请求尚未确认结束，已保留身份；查询不会重新生成。</p>
            <button class="btn btn-ghost" type="button" :disabled="submitting || reconnectState === 'reading'" @click="reconnectVideo">查询原请求</button>
            <button class="btn btn-ghost" type="button" :disabled="cancelling" @click="cancelOriginalRequest">{{ cancelling ? '请求取消…' : '取消原请求' }}</button>
          </div>
          <div v-if="!job && !jobSelectionPending" class="video-queue-empty">
            <span class="video-empty-reel" aria-hidden="true"><ArchiveIcon name="play" /></span>
            <strong role="status">{{ reconnectState === 'reading' ? '正在读取上次任务…' : reconnectState === 'failed' ? '上次任务状态待确认' : '暂无成片' }}</strong>
            <span v-if="reconnectState === 'idle'">准备好镜头与描述，生成的短片会出现在这里。</span>
            <button v-if="reconnectState === 'failed'" class="btn btn-ghost" type="button" @click="reconnectVideo">重新读取上次任务</button>
            <button v-if="reconnectState !== 'idle'" class="btn btn-ghost" type="button" @click="openTaskCenter">到任务中心核对</button>
          </div>
          <template v-else-if="job">
            <div class="video-job-head">
              <span class="video-job-state" :data-state="job.needsReview ? 'review' : job.status" role="status">{{ jobStatusLabel }}</span>
              <time>{{ formatTime(job.createdAt) }}</time>
            </div>
            <div class="video-job-meta">
              <span>{{ job.width }} × {{ job.height }}</span>
              <span>{{ job.duration }} 秒</span>
              <span>Seed {{ job.seed }}</span>
            </div>
            <StudioMediaPlayer
              v-if="job.status === 'succeeded' && job.resultUrl"
              :key="job.resultUrl"
              class="video-player video-player--queue"
              kind="video"
              :src="job.resultUrl"
              label="生成的视频成片"
            />
            <TaskMediaDownload v-if="job.status === 'succeeded' && job.resultUrl" class="btn btn-ghost btn-block" :src="job.resultUrl">下载这段故事 · MP4</TaskMediaDownload>
            <p v-if="job.needsReview" class="video-inline-message warning" role="status">{{ job.error || '任务状态尚待确认，请到任务中心核对现有任务与已保存结果。' }}</p>
            <p v-else-if="job.status === 'cancelled'" class="video-install-note">任务已取消。镜头描述和输入画面仍在，可以调整后重新生成。</p>
            <p v-else-if="job.status === 'queued'" class="video-install-note">镜头已进入队列，等待本机开始处理。</p>
            <p v-else-if="job.status === 'cancelling'" class="video-install-note">正在等待本机停止任务，完成后可以重新生成。</p>
            <div v-if="!job.needsReview && (job.status === 'queued' || job.status === 'running' || job.status === 'cancelling')" class="video-progress" :data-indeterminate="progressPercent === null || undefined" role="progressbar" aria-label="视频生成进度" :aria-valuenow="progressPercent ?? undefined" :aria-valuetext="progressPercent === null ? jobStatusLabel : undefined" aria-valuemin="0" aria-valuemax="100">
              <i :style="progressPercent === null ? undefined : { '--progress': progressPercent + '%' }"></i>
            </div>
            <p v-if="!job.needsReview && job.status === 'running'" class="video-job-eta">
              <span v-if="progressPercent !== null">{{ progressPercent }}% · </span>已 {{ formatSeconds(job.elapsedSeconds) }}<span v-if="job.estimatedSeconds"> / 预估 {{ formatSeconds(job.estimatedSeconds) }}</span>
            </p>
            <p v-if="progressWarning" class="video-inline-message" :class="progressWarning.level === 'danger' ? 'error' : 'warning'">
              {{ progressWarning.text }}
            </p>
            <!--
              任务失败：后端给的是 ComfyUI 的英文技术串（节点名 / 张量形状 /
              traceback）。走一遍分类器换成中文结论，原始串折进「技术细节」，
              与出图路径的失败呈现对齐（2026-08-30 UX 审计）。
            -->
            <div v-if="jobErrorReport" class="video-inline-message error" role="alert">
              <p>{{ jobErrorReport.title }}：{{ jobErrorReport.message }}</p>
              <details v-if="jobErrorReport.details" class="video-error-detail">
                <StudioDisclosureSummary class="video-disclosure-heading">技术细节</StudioDisclosureSummary>
                <code>{{ jobErrorReport.details }}</code>
              </details>
            </div>
            <button
              v-if="!job.needsReview && (job.status === 'queued' || job.status === 'running')"
              class="btn btn-danger btn-block"
              type="button"
              :disabled="cancelling || jobSelectionPending || selectedJobReading"
              @click="cancelJob"
            >{{ cancelling ? '正在取消…' : '取消任务' }}</button>
            <button v-if="job.needsReview" class="btn btn-ghost btn-block" type="button" :disabled="jobReading || jobSelectionPending || selectedJobReading" @click="refreshJob">{{ jobReading ? '正在读取状态…' : '重新读取状态' }}</button>
            <button class="btn btn-ghost btn-block" type="button" @click="openTaskCenter">{{ job.needsReview ? '到任务中心核对' : '在任务中心查看' }}</button>
          </template>
          <details v-if="t8State" class="video-advanced">
            <StudioDisclosureSummary class="video-disclosure-heading">生成速度与加速状态</StudioDisclosureSummary>
            <p class="video-t8-bar" :data-state="t8State.available ? 'fast' : 'slow'">{{ t8State.reason }}</p>
          </details>
        </section>

        <section class="video-panel video-environment-panel">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">本机环境</span>
              <h2>执行路线</h2>
            </div>
            <span class="video-status-pill" :data-state="environmentState">{{ environmentLabel }}</span>
          </div>

          <div v-if="statusError" class="video-inline-message error" role="alert">{{ statusError }}</div>
          <template v-else-if="activeModel">
            <div class="video-model-summary">
              <span>{{ activeModel.tier }}</span>
              <strong>{{ activeModel.label }}</strong>
              <p>{{ activeModel.summary }}</p>
            </div>
            <details v-if="activeModel.missing.length" class="video-advanced">
              <StudioDisclosureSummary class="video-disclosure-heading">需要安装 {{ activeModel.missing.length }} 项资源 · 查看详情</StudioDisclosureSummary>
              <ul class="video-missing-list"><li v-for="file in activeModel.missing" :key="file"><code>{{ file }}</code></li></ul>
            </details>
            <p v-if="activeModel.missing.length && activeModel.executable" class="video-install-note">
              ComfyUI 节点已支持；安装所列资源后即可启用生成按钮。
            </p>
            <p v-else-if="activeModel.missing.length" class="video-install-note">
              此模型暂不支持生成，可选择其他模型。
            </p>
            <div v-if="activeModel.id === 'minimax-h3'" class="video-route-note">
              <strong>推荐用法</strong>
              <span>Wan 5B 快速验证镜头，H3 再做带原生音效与音乐的最终成片。</span>
            </div>
          </template>
          <RouterLink v-if="!status?.online" class="btn btn-ghost btn-block" to="/control">
            打开控制面板
          </RouterLink>
        </section>

        <details class="video-panel video-model-catalog">
          <StudioDisclosureSummary class="video-disclosure-heading"><span>更换生成模型 <small>{{ activeModel?.label || '等待环境检测' }}</small></span></StudioDisclosureSummary>
          <div class="video-model-options" data-disclosure-content>
          <button
            v-for="model in status?.models || []"
            :key="model.id"
            class="video-model-row"
            type="button"
            :class="{ active: selectedModelId === model.id }"
            :aria-pressed="selectedModelId === model.id"
            @click="selectedModelId = model.id"
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
        </details>


      </aside>
    </div>

    <section v-if="job?.status === 'succeeded' && job.resultUrl" class="video-result-panel">
      <div class="video-result-heading">
        <div>
          <span class="video-step">03 · 成片预览</span>
          <h2>检查连贯性，再决定是否加长</h2>
        </div>
        <TaskMediaDownload class="btn btn-ghost" :src="job.resultUrl">下载 MP4</TaskMediaDownload>
      </div>
      <RouterLink class="btn btn-ghost" :to="{ query: $route.query, hash: '#video-queue' }">回到成片播放器</RouterLink>
      <div class="video-review-checklist">
        <span>身份是否稳定</span>
        <span>脸与手是否连续</span>
        <span>动作是否自然</span>
        <span>镜头是否符合意图</span>
        <span>背景是否闪烁</span>
      </div>
    </section>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
const loadShotListEditor = () => import('@/components/video/ShotListEditor.vue')
import VideoDraftNotice from '@/components/video/VideoDraftNotice.vue'
import VideoGenerationBar from '@/components/video/VideoGenerationBar.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import TaskMediaDownload from '@/components/tasks/TaskMediaDownload.vue'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useVideoWorkspace } from "@/composables/video/useVideoWorkspace"
function openTaskCenter() { useTaskCenter().opened.value = true }
const queuePanel = ref<HTMLElement | null>(null)
function retrySelectedTask() { queuePanel.value?.focus({ preventScroll: true }); void retrySelectedJob() }
const firstFrameInput = ref<HTMLInputElement | null>(null), lastFrameInput = ref<HTMLInputElement | null>(null)
async function removeFrame(event: MouseEvent, slot: 'first' | 'last') {
  const button = event.currentTarget as HTMLElement, ownedFocus = document.activeElement === button, mode = selectedMode.value
  if (slot === 'first') clearFirstFrame(); else clearLastFrame()
  await nextTick()
  const input = slot === 'first' ? firstFrameInput.value : lastFrameInput.value
  const target = input?.disabled ? input.parentElement : input
  if (ownedFocus && !button.isConnected && document.activeElement === document.body && selectedMode.value === mode && target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true })
}
const {
archiveStatus,
archiveState,
statusLoading,
loadStatus,
modes,
selectedMode,
modeReady,
modeBadge,
t8State,
status,
videoImageUrl,
hasFirstFrame,
hasLastFrame,
clearFirstFrame,
uploadingImage,
handleFrameFile,
lastFrameUrl,
clearLastFrame,
prompt,
aspectOptions,
aspectRatio,
aspectSize,
camera,
cameraOptions,
motion,
motionOptions,
quality,
durationOptions,
duration,
activeModel,
steps,
negative,
seedText,
canGenerate,
submitTitle,
submitDescription,
submitVideo,
submitting,
environmentState,
environmentLabel,
statusError,
selectedModelId,
job,
jobStatusLabel,
formatTime,
progressPercent,
formatSeconds,
progressWarning,
jobErrorReport,
cancelling,
cancelJob, cancelOriginalRequest,
reconnectState, reconnectVideo, requestPending,
jobReading, refreshJob,
jobSelectionPending, selectedJobReading, selectedJobError, retrySelectedJob,
} = useVideoWorkspace()
const aspectSelectOptions = computed(() => aspectOptions.value.map(item => {
  const size = aspectSize.value(item.id)
  return { value: item.id, label: `${item.label}${size ? ` · ${size}` : ''}` }
}))
const durationSelectOptions = computed(() => durationOptions.value.map(seconds => ({ value: seconds, label: `${seconds} 秒` })))
const qualitySelectOptions = computed(() => (status.value?.qualities || []).map(item => ({ value: item.id, label: item.label })))
const cameraSelectOptions = cameraOptions.map(item => ({ value: item.id, label: item.label }))
const motionSelectOptions = motionOptions.map(item => ({ value: item.id, label: item.label }))
</script>

<style scoped src="@/assets/css/video-studio-view.css"></style>
