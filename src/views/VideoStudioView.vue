<template>
  <article class="video-studio page">
    <header class="video-header">
      <div class="video-header-lead">
        <h1 class="page-title" data-screentone-furniture>故事短片</h1>
        <div class="video-project-entry">
          <RouterLink to="/studio-projects?tool=video" class="btn btn-primary btn-sm">
            <ArchiveIcon name="clap" />进入分镜首尾帧
          </RouterLink>
        </div>
      </div>
      <div class="video-header-actions">
        <RouterLink class="btn btn-ghost btn-sm" to="/studio-projects"><ArchiveIcon name="folder" />关键帧工坊</RouterLink>
        <span class="video-connection" :data-state="archiveState" role="status">{{ archiveStatus }}</span>
        <button
          class="btn btn-ghost btn-sm video-env-trigger"
          type="button"
          :aria-expanded="envDrawerOpen"
          aria-controls="video-environment"
          @click="envDrawerOpen = !envDrawerOpen"
        >
          <ArchiveIcon name="model" />
          <span>{{ activeModel?.label || '视频模型' }}</span>
          <span class="video-status-pill" :data-state="environmentState">{{ environmentLabel }}</span>
        </button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="statusLoading" @click="loadStatus">
          <ArchiveIcon name="refresh" />
          {{ statusLoading ? '检测中' : '重新检测' }}
        </button>
      </div>
    </header>

    <VideoEnvironmentDrawer
      ref="environmentPanel"
      v-model:open="envDrawerOpen"
      :status="status"
      :active-model="activeModel"
      :selected-model-id="selectedModelId"
      :selected-mode="selectedMode"
      :native-video="nativeVideo"
      :environment-state="environmentState"
      :environment-label="environmentLabel"
      :status-error="statusError"
      @choose-model="chooseModel"
    />

    <VideoDraftNotice />

    <section class="video-mode-strip studio-segments" data-fluid-glass role="group" aria-label="视频创作方式"><AnimatedSelection />
      <button
        v-for="mode in modes"
        :key="mode.id"
        class="video-mode-card"
        type="button"
        :class="{ active: selectedMode === mode.id }"
        :aria-pressed="selectedMode === mode.id"
        :aria-describedby="selectedMode === mode.id ? 'video-mode-description' : undefined"
        @click="selectedMode = mode.id"
      >
        <span class="video-mode-icon studio-control-icon"><ArchiveIcon :name="mode.icon" /></span>
        <strong class="studio-control-label">{{ mode.label }}</strong>
      </button>
    </section>
    <div class="video-mode-context">
      <p id="video-mode-description"><strong>{{ modeBadge }}</strong></p>
      <nav v-if="selectedMode !== 'shots'" class="video-jump-nav tw:p-s-1 tw:rounded-md" data-fluid-glass aria-label="视频工作区导航">
        <RouterLink v-if="selectedMode !== 'text'" :to="{ query: $route.query, hash: '#video-frames' }">准备画面</RouterLink>
        <RouterLink :to="{ query: $route.query, hash: '#video-workbench' }">提示词工作台</RouterLink>
        <RouterLink :to="{ query: $route.query, hash: '#video-brief' }">镜头描述</RouterLink>
        <RouterLink :to="{ query: $route.query, hash: '#video-settings' }">画幅与时长</RouterLink>
        <RouterLink :to="{ query: $route.query, hash: '#video-queue' }">查看成片</RouterLink>
      </nav>
    </div>
    <VideoGenerationBar v-if="selectedMode !== 'shots'" id="video-settings"
      v-model:aspect-ratio="aspectRatio" v-model:duration="duration" v-model:quality="quality"
      :aspect-options="aspectSelectOptions"
      :duration-options="durationSelectOptions"
      :quality-options="qualitySelectOptions"
      :can-generate="canGenerate" :submitting="submitting" :submit-title="submitTitle" :submit-description="submitDescription"
      @generate="submitVideo">
      <template #recovery>
        <button v-if="status && !statusLoading && (unsupportedMode || !status.online || activeModel && !activeModel.available)"
          class="btn btn-quiet btn-sm" type="button" @click="showEnvironment">查看视频环境</button>
      </template>
    </VideoGenerationBar>
    <div class="video-workspace" data-route-arrive :class="{ 'video-workspace--shots': selectedMode === 'shots' }" v-content-motion:up="selectedMode">
      <div class="video-creation-column">
        <KeepAlive><AsyncPanel v-if="selectedMode === 'shots'" :loader="loadShotListEditor" label="分镜工作台" v-slot="{ component }"><component :is="component" :status="status" /></AsyncPanel></KeepAlive>
        <template v-if="selectedMode !== 'shots'">
        <section v-if="selectedMode === 'image'" id="video-frames" class="video-panel video-first-frame-panel">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">00 · 首帧</span>
              <h2>选择首帧</h2>
            </div>
            <button v-if="hasFirstFrame" class="btn btn-ghost" type="button" @click="removeFrame($event, 'first')">移除</button>
          </div>
          <RuntimeImage v-if="videoImageUrl" :src="videoImageUrl" v-slot="{ image, loaded, failed }"><div class="video-frame-preview"><img v-if="image.src && !failed" v-bind="image" class="video-first-frame" :class="{ 'is-ready': loaded }" alt="视频首帧" /><span v-if="!loaded" role="status">{{ failed ? '首帧图片加载失败，请移除后重新选择' : '正在加载首帧图片…' }}</span></div></RuntimeImage>
          <label v-else class="video-upload-drop video-upload-drop--single" tabindex="-1" :data-busy="uploadingImage || undefined">
            <input ref="firstFrameInput" type="file" accept="image/*" aria-label="上传视频首帧" :disabled="uploadingImage" @change="handleFrameFile($event, 'first')" />
            <span class="video-upload-icon" aria-hidden="true"><ArchiveIcon name="image" /></span>
            <strong>{{ uploadingImage ? '正在准备首帧…' : '上传首帧' }}</strong>
            <span>拖入或点击选择图片</span>
          </label>
          <div v-if="driverKind" class="field">
            <label for="video-driving-file" class="field-label">{{ driverKind === 'audio' ? '角色配音' : '动作参考视频' }}</label>
            <small id="video-driving-hint" class="field-hint">{{ driverKind === 'audio' ? '选择 PCM WAV 配音（20 MiB 以内）。' : '选择 H.264 MP4 视频（20 MiB 以内），时长需覆盖所选镜头。' }}</small>
            <input id="video-driving-file" type="file" class="input" :accept="driverKind === 'audio' ? '.wav,audio/wav' : '.mp4,video/mp4'"
              aria-describedby="video-driving-hint" :disabled="driverBusy || submitting" @change="chooseDriver" />
            <span v-if="driverBusy || driver" role="status">{{ driverBusy ? '正在上传…' : driver?.label }}</span>
            <button v-if="driver" type="button" class="btn btn-quiet btn-sm" :disabled="driverBusy || submitting" @click="clearDriver">移除素材</button>
          </div>
        </section>

        <section v-else-if="selectedMode === 'first-last-frame'" id="video-frames" class="video-panel video-first-frame-panel">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">00 · 首尾帧</span>
              <h2>首尾画面</h2>
            </div>
            <span class="video-count">首尾画面衔接</span>
          </div>
          <div class="video-dual-frame-grid">
            <div class="video-frame-slot tw:grid tw:gap-s-2 tw:content-start">
              <span class="field-label">首帧</span>
              <RuntimeImage v-if="videoImageUrl" :src="videoImageUrl" v-slot="{ image, loaded, failed }"><div class="video-frame-preview"><img v-if="image.src && !failed" v-bind="image" class="video-first-frame" :class="{ 'is-ready': loaded }" alt="视频首帧" /><span v-if="!loaded" role="status">{{ failed ? '首帧图片加载失败，请移除后重新选择' : '正在加载首帧图片…' }}</span></div></RuntimeImage>
              <label v-else class="video-upload-drop" tabindex="-1" :data-busy="uploadingImage || undefined">
                <input ref="firstFrameInput" type="file" accept="image/*" aria-label="上传视频首帧" :disabled="uploadingImage" @change="handleFrameFile($event, 'first')" />
                <span class="video-upload-icon" aria-hidden="true"><ArchiveIcon name="image" /></span>
                <span>上传首帧</span>
              </label>
              <button v-if="hasFirstFrame" class="btn btn-ghost btn-block" type="button" @click="removeFrame($event, 'first')">移除首帧</button>
            </div>
            <div class="video-frame-slot tw:grid tw:gap-s-2 tw:content-start">
              <span class="field-label">尾帧</span>
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

        <section id="video-workbench" class="video-panel video-details-panel">
          <div class="video-panel-heading">
            <h2>提示词工作台</h2>
          </div>

          <VideoPromptWorkbench :key="promptMode" v-model="promptRecipe" :mode="promptMode"
            :supports-audio="supportsGeneratedAudio" :supports-dialogue-and-music="supportsDialogueAndMusic"
            :disabled="submitting" />

          <div id="video-brief" class="field video-brief">
            <div class="video-brief-heading">
              <label for="video-shot-description" class="field-label">镜头描述</label>
              <span class="video-count" :data-warning="prompt.length > 900 || undefined">{{ prompt.length }} / 4000</span>
            </div>
            <p v-if="driverKind" id="video-description-hint" class="field-hint">
              {{ videoPromptGuidance[promptMode] }}
            </p>
            <textarea id="video-shot-description" v-model="prompt" name="prompt" class="textarea video-prompt"
              maxlength="4000" rows="4" :aria-describedby="driverKind ? 'video-description-hint' : undefined"
              :placeholder="driverKind ? undefined : videoPromptGuidance[promptMode]"
              spellcheck="false" autocorrect="off" autocapitalize="off"></textarea>
          </div>

          <VideoPromptPreview :request="promptPreviewRequest" :model-label="activeModel?.label ?? ''" />

          <details class="video-advanced">
            <StudioDisclosureSummary class="video-disclosure-heading">高级设置</StudioDisclosureSummary>
            <div class="video-advanced-grid" data-disclosure-content>
              <div v-if="!driverKind && selectedMode !== 'first-last-frame'" class="field">
                <label for="video-motion" class="field-label">默认主体运动</label>
                <StudioSelect id="video-motion" v-model="motion" label="默认主体运动" :options="motionSelectOptions" />
              </div>
              <ToggleSwitch
                v-if="activeModel?.id === 'minimax-h3' && !nativeVideo"
                class="video-steps-toggle"
                :model-value="steps === 4"
                label="极速 4 步"
                @update:model-value="steps = $event ? 4 : 8"
              >
                <span>
                  <strong>极速 4 步</strong>
                  <small>关闭用 8 步</small>
                </span>
              </ToggleSwitch>
              <NativeH3RecipeFields v-if="nativeVideo && activeModel?.id === 'minimax-h3' && (activeModel.h3Dwd || activeModel.turboSteps?.length || nativeH3Steps === 2)"
                :model="activeModel" :default-steps="h3DefaultSteps" :issue="h3Issue" :disabled="submitting" v-model:choice="nativeH3Steps" v-model:light-vae="h3LightVae" />
              <div v-if="nativeVideo" class="field">
                <label for="video-attention" class="field-label">{{ activeModel?.id === 'minimax-h3' ? 'H3 生成加速' : '注意力加速' }}</label>
                <small id="video-attention-hint" class="field-hint">{{ videoAttention === 'h3-fused' ? '内置 Mystic 动作风格' : videoAttention === 'h3-sla' ? '四步权重 · 保留音轨与首尾帧' : '需兼容显卡与本地内核' }}</small>
                <StudioSelect id="video-attention" v-model="videoAttention" :label="activeModel?.id === 'minimax-h3' ? 'H3 生成加速' : '注意力加速'"
                  aria-describedby="video-attention-hint" :options="attentionOptions" />
              </div>
              <label v-if="supportsNegative" class="field">
                <span class="field-label">负向描述</span>
                <textarea
                  v-model="negative"
                  class="textarea"
                  rows="3"
                  maxlength="1000"
                  placeholder="可选。写下希望画面避开的内容。"
                  spellcheck="false"
                  autocorrect="off"
                  autocapitalize="off"
                ></textarea>
              </label>
              <label class="field">
                <span class="field-label">固定 Seed</span>
                <input v-model="seedText" class="input input-mono" inputmode="numeric" placeholder="留空则随机" spellcheck="false" autocorrect="off" />
              </label>
            </div>
          </details>
        </section>

        </template>
      </div>

      <aside class="video-side-column">
        <section id="video-queue" ref="queuePanel" class="video-panel video-queue-panel video-monitor-stage" aria-live="polite" aria-labelledby="video-queue-title" tabindex="-1">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">FILM MONITOR · 胶片监看台</span>
              <h2 id="video-queue-title">{{ jobSelectionPending && job ? '上次读取的成片' : '当前成片监看' }}</h2>
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
            <CornerFrame variant="editorial" />
            <span class="video-empty-reel" aria-hidden="true"><ArchiveIcon name="play" /></span>
            <strong role="status">{{ reconnectState === 'reading' ? '正在读取上次任务…' : reconnectState === 'failed' ? '上次任务状态待确认' : '待机中' }}</strong>
            <span v-if="reconnectState === 'idle'">生成后在此查看成片</span>
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
              <template v-if="job.execution">
                <span>推理设备 {{ job.execution.device }}</span>
                <span v-if="job.execution.attention.length">注意力 {{ job.execution.attention.join('、') }}</span>
                <span v-if="job.execution.decoder">视频解码 {{ job.execution.decoder }}<template v-if="job.execution.dwdDecodeMs !== undefined"> · {{ (job.execution.dwdDecodeMs / 1000).toFixed(2) }} 秒</template></span>
                <span>MP4 编码 {{ job.execution.encoder }}</span>
              </template>
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
import CornerFrame from '@/components/visual/CornerFrame.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
const loadShotListEditor = () => import('@/components/video/ShotListEditor.vue')
import VideoDraftNotice from '@/components/video/VideoDraftNotice.vue'
import VideoEnvironmentDrawer from '@/components/video/VideoEnvironmentDrawer.vue'
import VideoGenerationBar from '@/components/video/VideoGenerationBar.vue'
import VideoPromptWorkbench from '@/components/video/VideoPromptWorkbench.vue'
import VideoPromptPreview from '@/components/video/VideoPromptPreview.vue'
import NativeH3RecipeFields from '@/components/video/NativeH3RecipeFields.vue'
import { videoPromptGuidance } from '@/components/video/videoPromptPresets'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import TaskMediaDownload from '@/components/tasks/TaskMediaDownload.vue'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useVideoWorkspace } from "@/composables/video/useVideoWorkspace"
function openTaskCenter() { useTaskCenter().opened.value = true }
const queuePanel = ref<HTMLElement | null>(null)
const environmentPanel = ref<InstanceType<typeof VideoEnvironmentDrawer> | null>(null)
const envDrawerOpen = ref(false)
async function showEnvironment() {
  envDrawerOpen.value = true
  await nextTick()
  environmentPanel.value?.focusPanel()
}
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
chooseModel, driverKind, driver, driverBusy, chooseDriver, clearDriver,
archiveStatus,
archiveState,
nativeVideo,
statusLoading,
loadStatus,
modes,
selectedMode,
modeBadge,
unsupportedMode,
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
promptMode,
promptRecipe,
promptPreviewRequest,
supportsGeneratedAudio,
supportsDialogueAndMusic,
supportsNegative,
aspectOptions,
aspectRatio,
aspectSize,
motion,
motionOptions,
quality,
qualities,
durationOptions,
duration,
activeModel,
steps, h3Steps, h3DefaultSteps, nativeH3Steps, h3Issue,
videoAttention,
h3LightVae,
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
const qualitySelectOptions = computed(() => qualities.value.map(item => ({ value: item.id, label: item.label })))
const attentionOptions = computed(() => [
  { value: 'auto', label: '自动选择' },
  { value: 'sdpa', label: 'PyTorch SDPA' },
  { value: 'sage', label: 'SageAttention' },
  { value: 'flash2', label: 'FlashAttention 2' },
  { value: 'h3-sol', label: 'Sol-Attn · 动态稀疏' },
  { value: 'h3-sla', label: 'Turbo-SLA · 四步稀疏' },
  { value: 'h3-fused', label: 'Fused Turbo · Mystic 动作风格' },
].filter(option => option.value === videoAttention.value ||
  (activeModel.value?.attentionModes?.some(mode => mode === option.value) ?? !option.value.startsWith('h3-')))
  .map(option => ({ ...option, disabled: ['h3-sla', 'h3-fused'].includes(option.value) && h3Steps.value !== 4 })))
const motionSelectOptions = motionOptions.map(item => ({ value: item.id, label: item.label }))
</script>

<style scoped src="@/assets/css/video-studio-view.css"></style>
