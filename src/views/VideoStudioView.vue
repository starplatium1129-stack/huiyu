<template>
  <article class="video-studio page">
    <WorkspaceArchiveBar
      chapter="14"
      title="故事短片"
      subtitle="让这一幕，继续发生"
      :status="archiveStatus"
      :state="archiveState"
      shape="frame"
    />

    <header class="video-header">
      <div>
        <div class="page-kicker">画室 / 故事短片</div>
        <h1 class="page-title">故事短片</h1>
        <p class="page-subtitle">
          从一张画面或一段描述开始，让角色的故事继续。选择创作方式，再准备镜头与首帧。
        </p>
      </div>
      <button class="btn btn-ghost" type="button" :disabled="statusLoading" @click="loadStatus">
        <ArchiveIcon name="refresh" />
        {{ statusLoading ? '检测中' : '重新检测' }}
      </button>
    </header>

    <section class="video-mode-strip" aria-label="视频创作方式">
      <button
        v-for="mode in modes"
        :key="mode.id"
        class="video-mode-card"
        type="button"
        :class="{ active: selectedMode === mode.id }"
        :aria-pressed="selectedMode === mode.id"
        :disabled="!modeReady(mode.id)"
        @click="selectedMode = mode.id"
      >
        <span class="video-mode-icon"><ArchiveIcon :name="mode.icon" /></span>
        <span>
          <strong>{{ mode.label }}</strong>
          <small>{{ mode.description }}</small>
        </span>
        <em>{{ modeBadge(mode.id) }}</em>
      </button>
    </section>

    <nav v-if="selectedMode !== 'shots'" class="video-jump-nav" aria-label="视频工作区导航"><a v-if="selectedMode !== 'text'" href="#video-frames">准备画面</a><a href="#video-brief">01 镜头描述</a><a href="#video-settings">02 画幅与时长</a><a href="#video-queue">03 查看成片</a></nav>
    <div class="video-workspace">
      <div class="video-creation-column">
        <ShotListEditor v-if="selectedMode === 'shots'" :status="status" />
        <template v-else>
        <section v-if="selectedMode === 'image'" id="video-frames" class="video-panel video-first-frame-panel">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">00 · 首帧</span>
              <h2>视频从这里开始</h2>
            </div>
            <button v-if="videoImageUrl" class="btn btn-ghost" type="button" @click="clearFirstFrame">移除</button>
          </div>
          <img v-if="videoImageUrl" class="video-first-frame" :src="videoImageUrl" alt="视频首帧" />
          <label v-else class="video-upload-drop video-upload-drop--single" :data-busy="uploadingImage || undefined">
            <input type="file" accept="image/*" aria-label="上传视频首帧" :disabled="uploadingImage" @change="handleFrameFile($event, 'first')" />
            <ArchiveIcon name="image" />
            <strong>{{ uploadingImage ? '正在准备首帧…' : '选一张画，让故事开始' }}</strong>
            <span>点击上传首帧，或在绘制台点击「生成短片」带入作品。</span>
          </label>
          <p v-if="videoImageUrl" class="video-install-note">
            输入首帧 · 这张图是故事的起点，生成的短片将在「当前成片」中展示。选择「跟随原图」可保留画面比例。
          </p>
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
            <div class="video-frame-slot">
              <span class="field-label">A · 故事开始 / 输入首帧</span>
              <img v-if="videoImageUrl" class="video-first-frame" :src="videoImageUrl" alt="视频首帧" />
              <label v-else class="video-upload-drop" :data-busy="uploadingImage || undefined">
                <input type="file" accept="image/*" aria-label="上传视频首帧" :disabled="uploadingImage" @change="handleFrameFile($event, 'first')" />
                <ArchiveIcon name="image" />
                <span>上传首帧，或从工作台「生成短片」带入</span>
              </label>
              <button v-if="videoImageUrl" class="btn btn-ghost btn-block" type="button" @click="clearFirstFrame">移除首帧</button>
            </div>
            <div class="video-frame-slot">
              <span class="field-label">B · 故事落点 / 输入尾帧</span>
              <img v-if="lastFrameUrl" class="video-first-frame" :src="lastFrameUrl" alt="视频尾帧" />
              <label v-else class="video-upload-drop" :data-busy="uploadingImage || undefined">
                <input type="file" accept="image/*" aria-label="上传视频尾帧" :disabled="uploadingImage" @change="handleFrameFile($event, 'last')" />
                <ArchiveIcon name="image" />
                <span>上传尾帧</span>
              </label>
              <button v-if="lastFrameUrl" class="btn btn-ghost btn-block" type="button" @click="clearLastFrame">移除尾帧</button>
            </div>
          </div>
          <p class="video-install-note">
            两张图都是输入画面。在下方描述它们之间发生的动作，生成后再检查实际过渡；选择「跟随原图」可沿用首帧比例。
          </p>
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
          <p class="video-brief-note">{{ selectedMode === 'text' ? '先写人物与地点，再写一个动作。短镜头更适合一件清楚的小事。' : selectedMode === 'image' ? '画面已经交代人物与场景，重点写动作、风与光的变化，以及镜头如何移动。' : '写清两幅画面之间的动作与镜头变化，首尾画面相近时更容易保持连贯。' }}</p>
          <textarea
            v-model="prompt"
            aria-label="镜头描述"
            class="textarea video-prompt"
            maxlength="4000"
            rows="7"
            placeholder="例如：黄昏的电车站，少女回头看向镜头，风吹起发丝和裙摆，镜头缓慢推进，暖色逆光，动作自然连续。"
          ></textarea>
          <div class="video-prompt-guidance">
            <span>建议写清：主体</span>
            <span>动作</span>
            <span>环境</span>
            <span>光线</span>
            <span>镜头</span>
          </div>
        </section>

        <section id="video-settings" class="video-panel">
          <div class="video-panel-heading">
            <div>
              <span class="video-step">02 · 成片方向</span>
              <h2>画幅与节奏</h2>
            </div>
          </div>

          <div class="video-choice-group">
            <span class="field-label">画幅</span>
            <div class="video-choice-grid video-choice-grid--three" role="group" aria-label="选择视频画幅">
              <button
                v-for="item in aspectOptions"
                :key="item.id"
                type="button"
                :class="{ active: aspectRatio === item.id }"
                :aria-pressed="aspectRatio === item.id"
                @click="aspectRatio = item.id"
              >
                <span class="aspect-glyph" :data-aspect="item.id"></span>
                <strong>{{ item.label }}</strong>
                <small>{{ aspectSize(item.id) }}</small>
              </button>
            </div>
          </div>

          <div class="video-choice-pair">
            <label class="field">
              <span class="field-label">镜头运动</span>
              <select v-model="camera" class="select">
                <option v-for="item in cameraOptions" :key="item.id" :value="item.id">{{ item.label }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">主体运动</span>
              <select v-model="motion" class="select">
                <option v-for="item in motionOptions" :key="item.id" :value="item.id">{{ item.label }}</option>
              </select>
            </label>
          </div>

          <div class="video-quality-row">
            <span class="field-label">画质档位</span>
            <div class="video-quality-grid" role="group" aria-label="选择视频画质档位">
              <button
                v-for="item in status?.qualities || []"
                :key="item.id"
                type="button"
                :class="{ active: quality === item.id }"
                :aria-pressed="quality === item.id"
                @click="quality = item.id"
              >
                <strong>{{ item.label }}</strong>
                <small>{{ item.summary }}</small>
                <em>{{ item.sizes[aspectRatio] }}</em>
              </button>
            </div>
            <p class="video-duration-note">
              快速档适合试镜找方向；标准档用于日常创作；精细档保留更多细节，也需要更长时间。
            </p>
          </div>

          <div class="video-duration-row">
            <span class="field-label">时长</span>
            <div class="video-segmented" role="group" aria-label="选择视频时长">
              <button
                v-for="seconds in durationOptions"
                :key="seconds"
                type="button"
                :class="{ active: duration === seconds }"
                :aria-pressed="duration === seconds"
                @click="duration = seconds"
              >{{ seconds }} 秒</button>
            </div>
            <span class="video-duration-note">首次测试建议 3 秒，确认方向后再生成 5 秒。</span>
          </div>

          <details class="video-advanced">
            <summary>高级设置</summary>
            <div class="video-advanced-grid">
              <ToggleSwitch
                v-if="activeModel?.id === 'minimax-h3'"
                class="video-steps-toggle"
                :model-value="steps === 4"
                label="极速 4 步"
                @update:model-value="steps = $event ? 4 : 8"
              >
                <span>
                  <strong>极速 4 步</strong>
                  <small>Turbo 蒸馏 4 步采样，约快一倍（实测 fast 5s 130s → 80s），质量略降，适合试镜与长片。</small>
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
                <span class="field-hint">复现同一构思时再填写，不建议为找偶然好片反复抽 seed。</span>
              </label>
            </div>
          </details>
        </section>

        <section class="video-submit-panel" :data-ready="canGenerate || undefined">
          <div>
            <strong>{{ submitTitle }}</strong>
            <p>{{ submitDescription }}</p>
          </div>
          <button class="btn btn-primary btn-lg" type="button" :disabled="!canGenerate" @click="submitVideo">
            <ArchiveIcon name="play" />
            {{ submitting ? '正在提交…' : '生成视频' }}
          </button>
        </section>
        </template>
      </div>

      <aside class="video-side-column">
        <section id="video-queue" class="video-panel video-queue-panel" aria-live="polite">
          <div class="video-panel-heading video-panel-heading--compact">
            <div>
              <span class="video-step">任务队列</span>
              <h2>当前成片</h2>
            </div>
            <span v-if="t8State" class="video-t8-badge" :data-state="t8State.available ? 'fast' : 'slow'">
              <ArchiveIcon :name="t8State.available ? 'lightning' : 'warning'" />
              <span>{{ t8State.available ? 'T8 双时钟加速' : '原生采样（慢）' }}</span>
            </span>
          </div>
          <div v-if="!job" class="video-queue-empty">
            <ArchiveIcon name="play" />
            <span><strong>短片会在这里与你见面</strong>准备镜头与画面后开始生成。这里会显示进度、失败原因和完成的短片。</span>
          </div>
          <template v-else>
            <div class="video-job-head">
              <span class="video-job-state" :data-state="job.status">{{ jobStatusLabel }}</span>
              <time>{{ formatTime(job.createdAt) }}</time>
            </div>
            <div class="video-job-meta">
              <span>{{ job.width }} × {{ job.height }}</span>
              <span>{{ job.duration }} 秒</span>
              <span>Seed {{ job.seed }}</span>
            </div>
            <video v-if="job.status === 'succeeded' && job.resultUrl" :key="job.resultUrl" class="video-player video-player--queue" :src="job.resultUrl" aria-label="生成的视频成片" controls playsinline preload="metadata"></video>
            <a v-if="job.status === 'succeeded' && job.resultUrl" class="btn btn-ghost btn-block" :href="job.resultUrl" download>下载这段故事 · MP4</a>
            <p v-if="job.status === 'cancelled'" class="video-install-note">任务已取消。镜头描述和输入画面仍在，可以调整后重新生成。</p>
            <p v-if="job.status === 'queued'" class="video-install-note">镜头已进入队列，等待本机开始处理。</p>
            <p v-if="job.status === 'cancelling'" class="video-install-note">正在等待本机停止任务，完成后可以重新生成。</p>
            <div v-if="job.status === 'queued' || job.status === 'running' || job.status === 'cancelling'" class="video-progress">
              <i :style="{ '--progress': progressPercent + '%' }"></i>
            </div>
            <p v-if="job.status === 'running' && job.estimatedSeconds" class="video-job-eta">
              {{ progressPercent }}% · 已 {{ formatSeconds(job.elapsedSeconds) }} / 预估 {{ formatSeconds(job.estimatedSeconds) }}
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
                <summary>技术细节</summary>
                <code>{{ jobErrorReport.details }}</code>
              </details>
            </div>
            <button
              v-if="job.status === 'queued' || job.status === 'running'"
              class="btn btn-danger btn-block"
              type="button"
              :disabled="cancelling"
              @click="cancelJob"
            >{{ cancelling ? '正在取消…' : '取消任务' }}</button>
          </template>
          <details v-if="t8State" class="video-advanced">
            <summary>生成速度与加速状态</summary>
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
              <summary>需要安装 {{ activeModel.missing.length }} 项资源 · 查看详情</summary>
              <ul class="video-missing-list"><li v-for="file in activeModel.missing" :key="file"><code>{{ file }}</code></li></ul>
            </details>
            <p v-if="activeModel.missing.length && activeModel.executable" class="video-install-note">
              ComfyUI 节点已支持；安装所列资源后即可启用生成按钮。
            </p>
            <p v-else-if="activeModel.missing.length" class="video-install-note">
              所列资源是该路线的最小模型组合；应用配方与真实 GPU 验证完成前保持不可生成。
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
          <summary>更换生成模型 <span>{{ activeModel?.label || '等待环境检测' }}</span></summary>
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
              <strong>{{ model.label }}</strong>
              <small>{{ model.summary }}</small>
            </span>
            <em :data-state="model.available ? 'ready' : (model.executable ? 'missing' : 'planned')">
              {{ model.available ? '已就绪' : (model.executable ? '待安装' : '待适配') }}
            </em>
          </button>
        </details>


      </aside>
    </div>

    <section v-if="job?.status === 'succeeded' && job.resultUrl" class="video-result-panel">
      <div class="video-result-heading">
        <div>
          <span class="video-step">03 · 成片预览</span>
          <h2>检查连贯性，再决定是否加长</h2>
        </div>
        <a class="btn btn-ghost" :href="job.resultUrl" download>下载 MP4</a>
      </div>
      <a class="btn btn-ghost" href="#video-queue">回到成片播放器</a>
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
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import WorkspaceArchiveBar from '@/components/visual/WorkspaceArchiveBar.vue'
import ShotListEditor from '@/components/video/ShotListEditor.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { useVideoWorkspace } from "@/composables/video/useVideoWorkspace"
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
cancelJob
} = useVideoWorkspace()
</script>

<style scoped src="@/assets/css/video-studio-view.css"></style>
