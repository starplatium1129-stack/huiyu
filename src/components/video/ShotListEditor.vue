<template>
  <section ref="editorRoot" class="shot-editor">
    <p v-if="pendingScenarioCount" class="video-panel" role="status">
      剧本导入待办 {{ pendingScenarioCount }} 幕。{{ scenarioImportBlocked ? '当前镜头已保留；如需导入，请先确认并清空当前镜头。' : '可继续导入或确认已保留的剧本。' }}
      <button class="btn btn-ghost btn-sm" type="button" :disabled="scenarioImportBlocked || batchActive || submitting" @click="retryScenarioImport">导入待办剧本</button>
    </p>
    <p v-if="batchError" class="video-panel" role="status">{{ batchError }}</p>
    <p v-if="batchReadError || batchRecoveryPending" class="video-panel" role="status">
      {{ batchReading ? '正在读取分镜批次…' : batchReadError || '原分镜请求尚未结束，不能重复提交。' }}
      <template v-if="batchReadRetryable">仅查询已有任务，不会重新生成。
        <button class="btn btn-ghost btn-sm" type="button" :disabled="batchReading || submitting || cancelling || retrying || concating" :aria-busy="batchReading" @click="retryBatchRead">重新读取批次</button>
      </template>
      <button v-if="requestPending" class="btn btn-ghost btn-sm" type="button" :disabled="cancelling || submitting || retrying" @click="cancelOriginalRequest">{{ cancelling ? '请求取消…' : '取消原请求' }}</button>
    </p>
    <div v-if="!h3Ready" class="video-panel shot-blocked">
      <p>{{ nativeVideo ? '原生分镜需要本机 H3 量化模型包，准备后点击「重新检测」。' : '可先编辑镜头、读取已有首帧。生成分镜短片需要 MiniMax H3 权重就绪，安装后点击「重新检测」。' }}</p>
    </div>

      <ShotStoryboardStrip v-if="shots.length" :shots="shots" @locate="locateShot" />
      <section class="video-panel">
        <div class="video-panel-heading">
          <div>
            <span class="video-step">01 · 整批方向</span>
            <h2>画幅统一，镜头自由</h2>
          </div>
        </div>

        <ShotBatchSettings v-model:aspect-ratio="aspectRatio" v-model:quality="quality" v-model:link-last-frame="linkLastFrame"
          v-model:steps="steps" v-model:identity-card="identityCard" :qualities="status?.qualities ?? []" :disabled="batchActive || submitting">
          <template v-if="nativeVideo" #recipe>
            <NativeH3RecipeFields v-if="h3Model?.turboSteps || (h3Model && nativeH3Steps === 2)" :model="h3Model" :default-steps="h3DefaultSteps" :issue="h3Issue" :disabled="batchActive || submitting"
              v-model:choice="nativeH3Steps" v-model:light-vae="h3LightVae" />
          </template>
        </ShotBatchSettings>
      </section>
      <ShotReferenceCardsPanel
        :cards="referenceCards"
        :disabled="batchActive || submitting"
        :loading-assets="loadingRefAssets"
        :loading-card-index="loadingRefCardIndex"
        :character-groups="cardCharacterGroups"
        :profile-failed="profileFailed"
        :get-char-outfits="getCharOutfits"
        :set-reference-input="setReferenceInput"
        @add-card="addReferenceCard"
        @remove-card="removeReferenceCard"
        @update-label="(cardIndex, label) => { if (referenceCards[cardIndex]) referenceCards[cardIndex].label = label }"
        @select-character="onCardCharacterSelected"
        @retry-profile="retryCardProfile"
        @switch-outfit="switchCardOutfit"
        @remove-reference="removeReference"
        @pick-reference="pickReference"
        @retry-references="retryReferences"
        @reference-picked="onReferencePicked"
      />

      <section class="video-panel">
        <div class="video-panel-heading">
          <div>
            <span class="video-step">02 · 分镜清单</span>
            <h2>{{ shots.length }} 个镜头</h2>
          </div>
        </div>
        <div class="shot-toolbar-shell">
          <div class="shot-toolbar shot-toolbar-primary tw:p-s-2 tw:rounded-lg" data-fluid-glass>
            <button class="btn btn-primary btn-sm" type="button" :disabled="batchActive || submitting" @click="addShot"><ArchiveIcon name="plus" />添加镜头</button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="!shots.length || submitting || firstFrameBusy" @click="openProjectImport"><ArchiveIcon name="folder" />转入创作项目</button>
            <StudioTooltip anchor content="写个故事梗概，AI 直接生成完整分镜表（无首帧纯文字 T2VA 也可生成）">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="scriptBusy || batchActive || submitting" @click="scriptOpen = true"><ArchiveIcon name="wand" /> AI 生成脚本</button>
            </StudioTooltip>
            <StudioTooltip anchor content="逐镜自动生成高质量首帧画面并回填；已有首帧的镜头将自动跳过，角色形象由参考卡锁定">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="firstFrameBusy || storyboardBusy || batchActive || shots.length === 0 || submitting" @click="generateFirstFrames(shots, aspectRatio)"><ArchiveIcon name="image" />{{ firstFrameBusy ? `首帧 ${firstFrameProgress}…` : '一键首帧' }}</button>
            </StudioTooltip>
            <StudioTooltip anchor content="第 1 步：逐镜把静态绘图提示词改写成视频分镜描述，并推断景别/镜头/运动/对白（复用聊天 LLM 配置）">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="aiBusy || batchActive || !shots.length || submitting" @click="runAiRewrite"><ArchiveIcon name="spark" /> AI 整理分镜</button>
            </StudioTooltip>
            <StudioDropdownMenu label="分镜编排与质检工具">
              <template #trigger>
                <button class="btn btn-ghost btn-sm shot-more-trigger" type="button" :disabled="batchActive || submitting" aria-label="更多分镜编排与质检操作">
                  <ArchiveIcon name="filter" />
                  <span>编排与质检</span>
                </button>
              </template>
              <template #default="{ run }">
                <div class="studio-dropdown-label">AI 全局编排与审查</div>
                <DropdownMenuItem
                  class="studio-dropdown-item"
                  :disabled="aiBusy || batchActive || shots.length < 2 || submitting"
                  @select.prevent="run(runAiPolish)"
                >
                  <ArchiveIcon name="filter" />
                  <span>AI 整批编排（调景别与节奏）</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="studio-dropdown-item"
                  :disabled="reviewBusy || batchActive || !shots.length || submitting"
                  @select.prevent="run(runAiReview)"
                >
                  <ArchiveIcon name="search" />
                  <span>质量检查（排查矛盾与跳接）</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="aiSnapshot"
                  class="studio-dropdown-item"
                  :disabled="aiBusy || batchActive || submitting"
                  @select.prevent="run(restoreAiSnapshot)"
                >
                  <ArchiveIcon name="refresh" />
                  <span>撤销 AI 整理</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="polishSnapshot"
                  class="studio-dropdown-item"
                  :disabled="aiBusy || batchActive || submitting"
                  @select.prevent="run(restorePolishSnapshot)"
                >
                  <ArchiveIcon name="refresh" />
                  <span>撤销 AI 编排</span>
                </DropdownMenuItem>
                <div class="studio-dropdown-separator" role="separator" />
                <DropdownMenuItem
                  class="studio-dropdown-item is-danger"
                  :disabled="shots.length === 0 || batchActive || submitting"
                  @select.prevent="run(clearShots)"
                >
                  <ArchiveIcon name="close" />
                  <span>清空全部镜头</span>
                </DropdownMenuItem>
              </template>
            </StudioDropdownMenu>
          </div>

          <details class="shot-blueprint-drawer">
            <StudioDisclosureSummary class="shot-blueprint-summary">
              <span><ArchiveIcon name="clap" />从角色场景蓝图填入镜头或生成四镜剧本</span>
            </StudioDisclosureSummary>
            <div class="shot-toolbar shot-toolbar-blueprint" data-disclosure-content>
              <StudioSelect size="sm" label="蓝图角色" v-model="blueprintCharacter" :options="blueprintCharacters" :disabled="storyboardBusy || batchActive || submitting" />
              <span v-if="directoryFailed" role="status">角色目录读取失败 <button class="btn btn-ghost btn-sm" type="button" @click="readCharacters">重试</button></span>
              <span v-if="blueprintCharacter && !blueprintReady" role="status">{{ blueprintError || '正在读取角色蓝图…' }}
                <button v-if="blueprintError" class="btn btn-ghost btn-sm" type="button" @click="retryBlueprints">重试</button>
              </span>
              <span v-else-if="blueprintCharacter && !sceneBlueprints.length" role="status">这个角色暂无蓝图</span>
              <StudioSelect size="sm" label="从场景蓝图快速填充镜头描述" v-model="sceneFillId" :options="sceneFillOptions" :disabled="!sceneBlueprints.length || batchActive || submitting" />
              <StudioSelect size="sm" label="选择场景蓝图生成四镜剧本" v-model="storyboardBlueprintId" :options="storyboardOptions" :disabled="!sceneBlueprints.length || storyboardBusy || batchActive || submitting" />
              <input
                v-model="storyboardIntent"
                class="input shot-intent-input"
                type="text"
                maxlength="120"
                :disabled="storyboardBusy || batchActive || submitting"
                placeholder="可选 · 这一幕想发生什么"
                aria-label="剧本创作意图（可选）"
              />
              <StudioTooltip anchor content="选择场景蓝图，按起承转合即时生成四镜分镜剧本（自动提取经典台词并替换当前清单）">
                <button class="btn btn-ghost btn-sm" type="button" :disabled="!storyboardBlueprintId || storyboardBusy || batchActive || submitting" @click="runStoryboard"><ArchiveIcon name="gallery" /> {{ storyboardBusy ? '生成中…' : '生成剧本' }}</button>
              </StudioTooltip>
            </div>
          </details>
        </div>
        <p v-if="aiNote" role="status" class="shot-ai-note" :data-busy="aiBusy || undefined">{{ aiNote }}</p>
        <p v-else-if="flowHint" class="shot-flow-hint">{{ flowHint }}</p>

        <ShotReviewIssues
          :issues="reviewIssues"
          :disabled="batchActive || submitting"
          @apply="applyReviewSuggestion"
        />

        <article v-for="(shot, index) in shots" :key="index" class="shot-row" :data-shot-index="index" :data-cast-character="shotCastCharacter(shot.cast)" tabindex="-1" :aria-label="`镜头 ${index + 1} 编辑`" :data-issue="shotIssueCount(index) || undefined">
          <header class="shot-row-head">
            <span class="shot-slate-badge"><ArchiveIcon name="clap" />CUT {{ String(index + 1).padStart(2, '0') }}</span>
            <span class="shot-index">镜头 {{ index + 1 }}</span>
            <span v-if="shotIssueCount(index)" class="shot-issue-badge" :data-count="shotIssueCount(index)">
              {{ shotIssueCount(index) }} 个问题
            </span>
            <span v-if="serverShot(index)" class="shot-row-status" :data-state="serverShot(index)?.status">
              {{ shotStatusLabel(serverShot(index)?.status) }}
              <template v-if="serverShot(index)?.execution?.decoder"> · {{ serverShot(index)?.execution?.decoder }}</template>
            </span>
            <div class="shot-row-actions">
              <StudioTooltip anchor content="上移镜头">
                <button type="button" :disabled="index === 0 || batchActive || submitting" aria-label="上移镜头" @click="moveShotWithFocus(index, -1)"><ArchiveIcon name="chevron-down" class="shot-move-up" /></button>
              </StudioTooltip>
              <StudioTooltip anchor content="下移镜头">
                <button type="button" :disabled="index === shots.length - 1 || batchActive || submitting" aria-label="下移镜头" @click="moveShotWithFocus(index, 1)"><ArchiveIcon name="chevron-down" /></button>
              </StudioTooltip>
              <StudioTooltip anchor content="删除镜头">
                <button type="button" :disabled="batchActive || submitting" aria-label="删除镜头" @click="removeShot(index)"><ArchiveIcon name="close" /></button>
              </StudioTooltip>
            </div>
          </header>

          <div class="shot-fields">
            <label class="field shot-field-prompt">
              <span class="shot-field-head">
                <span class="field-label">画面描述</span>
                <span class="shot-count" :data-warning="shot.prompt.length > 900 || undefined">{{ shot.prompt.length }} / 4000</span>
              </span>
              <textarea
                v-model="shot.prompt"
                class="textarea"
                rows="3"
                maxlength="4000"
                :disabled="batchActive || submitting"
                placeholder="写清：主体动作、环境、光线、镜头意图；身份细节交给角色锚点。"
                spellcheck="false"
                autocorrect="off"
                autocapitalize="off"
              ></textarea>
            </label>

            <ShotPromptComposer :key="promptWorkbenchKey(shot)" :mode="shot.imageId || shot.imageUrl || shot.imageName ? 'image' : 'text'"
              :prompt="shot.prompt" :camera="shot.camera" :motion="shot.motion" :camera-options="cameraOptions" :motion-options="motionOptions"
              :max-length="shotPromptLimit" :disabled="batchActive || submitting || aiBusy || scriptBusy || storyboardBusy"
              @apply="Object.assign(shot, $event)" />

            <label class="field shot-field-dialogue">
              <span class="field-label">对白（H3 原生语音 · 口型同步）</span>
              <div class="shot-dialogue-row">
                <input
                  v-model="shot.dialogue"
                  class="input"
                  maxlength="300"
                  :disabled="batchActive || submitting"
                  placeholder="可选。单句 ≤20 字更稳，例如：我在这站下车。"
                />
                <StudioTooltip anchor content="AI 给 3 条台词备选（或润色你写的）">
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="batchActive || dialogueBusy || submitting"
                    @click="runAiDialogue(index)"
                  ><ArchiveIcon name="chat" /> AI 台词</button>
                </StudioTooltip>
              </div>
              <div v-if="dialogueIndex === index" class="shot-dialogue-options">
                <button
                  v-for="option in dialogueOptions"
                  :key="option.text"
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="batchActive || submitting"
                  @click="applyDialogueOption(index, option.text)"
                >{{ option.label }}：{{ option.text }}</button>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  @click="dialogueIndex = -1"
                >收起</button>
              </div>
            </label>

            <div class="shot-selects">
              <label class="field">
                <span class="field-label">角色</span>
              <StudioSelect size="sm" label="本镜出场角色" hint="选择出场角色，已上传的参考图会随镜头带入" v-model="shot.cast" :options="castOptions" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">景别</span>
                <StudioSelect size="sm" label="景别" v-model="shot.shotSize" :options="shotSizeOptions" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">镜头运动</span>
                <StudioSelect size="sm" label="镜头运动" v-model="shot.camera" :options="cameraOptions" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">主体运动</span>
              <StudioSelect size="sm" label="主体运动" v-model="shot.motion" :options="motionOptions" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">时长</span>
                <StudioSelect size="sm" label="时长" v-model="shot.duration" :options="shotDurationOptions" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">Seed</span>
                <input v-model="shot.seedText" class="input input-mono" inputmode="numeric" :disabled="batchActive || submitting" placeholder="留空随机" />
              </label>
            </div>

            <div class="shot-frame-row">
              <img v-if="shot.imageUrl" class="shot-frame" :src="shot.imageUrl" alt="本镜首帧" />
              <button v-else class="btn btn-ghost" type="button" :disabled="batchActive || submitting" @click="pickFrame(index)">
                上传首帧（可选 · 锁定本镜构图）
              </button>
              <!-- F4：首帧挂载失败/恢复失效的镜头有 IndexedDB 凭据但无受控名，给精确重试入口 -->
              <button v-if="!shot.imageUrl && shot.imageId" class="btn btn-ghost" type="button" :disabled="batchActive || submitting" @click="retryShotFrame(index)">
                重试首帧挂载
              </button>
              <span v-if="!shot.imageUrl && shot.imageId" class="shot-chain-note">首帧待处理（原图在暂存库）</span>
              <button v-if="shot.imageUrl || shot.imageId" class="btn btn-ghost" type="button" :disabled="batchActive || submitting" @click="clearFrame(index)">
                移除首帧
              </button>
              <span v-if="index > 0 && linkLastFrame" class="shot-chain-note">自动衔接镜头 {{ index }} 尾帧</span>
              <input ref="frameInputs" type="file" accept="image/png,image/jpeg,image/webp" class="shot-frame-input" @change="onFramePicked(index, $event)" />
            </div>
          </div>

          <p v-if="serverShot(index)?.error" class="shot-error">{{ serverShot(index)?.error }}</p>
          <StudioMediaPlayer v-if="serverShot(index)?.resultUrl" class="shot-result" kind="video" :src="serverShot(index)?.resultUrl ?? ''" label="本镜生成结果" :transcript="(shot.dialogue || '').trim()" />
          <div v-if="serverShot(index)?.status === 'failed' || serverShot(index)?.status === 'cancelled'" class="shot-retry">
            <button class="btn btn-primary" type="button" :disabled="batchActive || batchRecoveryPending || retrying || cancelling || concating || submitting" @click="retryShotAt(index)">{{ retrying ? '正在重试…' : '重抽本镜（同 Seed）' }}</button>
          </div>
        </article>

        <p v-if="shots.length === 0" class="shot-empty">
          暂无镜头
        </p>
      </section>

      <ShotScriptDialog
        :open="scriptOpen"
        :busy="scriptBusy"
        :note="scriptNote"
        :story="scriptStory"
        :count="scriptCount"
        :total="scriptTotal"
        :count-options="scriptCountOptions"
        :total-options="scriptTotalOptions"
        :reference-labels="referenceCards.filter(card => card.label).map(card => card.label)"
        @close="scriptOpen = false"
        @submit="runAiScript"
        @update:story="scriptStory = $event"
        @update:count="scriptCount = $event"
        @update:total="scriptTotal = $event"
      />

      <section class="video-panel shot-submit-panel" :data-ready="canSubmit || undefined">
        <div>
          <strong>{{ submitTitle }}</strong>
          <p v-if="submitDescription">{{ submitDescription }}</p>
        </div>
        <div class="shot-submit-actions">
          <button v-if="batchActive" class="btn btn-danger" type="button" :disabled="batchSelectionPending || cancelling" @click="cancelBatch">
            {{ cancelling ? '正在取消…' : '取消整批' }}
          </button>
          <template v-else>
            <button
              v-if="batch && batch.shots.some((shot) => shot.status === 'failed' || shot.status === 'cancelled')"
              class="btn btn-primary"
              type="button"
              :disabled="batchRecoveryPending || retrying || concating || cancelling || submitting"
              @click="retryAllFailed"
            >{{ retrying ? '正在重试…' : '重抽失败镜头' }}</button>
            <button
              v-if="batch && canConcat"
              class="btn btn-primary"
              type="button"
              :disabled="batchRecoveryPending || concating || retrying || cancelling || submitting"
              @click="concatBatch"
            >{{ concating ? '正在拼接…' : '拼接成片' }}</button>
            <button class="btn btn-primary btn-lg" type="button" :disabled="!canSubmit" @click="submitBatch">
              {{ submitting ? '正在提交…' : '生成全部镜头' }}
            </button>
          </template>
        </div>
      </section>

      <ShotBatchProgress v-if="batch" :status-label="batchStatusLabel" :succeeded="batch.progress.succeeded" :total="batch.progress.total" :failed="batch.progress.failed" :progress-percent="progressPercent" :link-last-frame="batch.linkLastFrame" :concat-url="batch.concatUrl || ''" :transcript="concatTranscript" />
  </section>
</template>

<script setup lang="ts">
import ShotBatchSettings from './ShotBatchSettings.vue'
import ShotReferenceCardsPanel from './ShotReferenceCardsPanel.vue'
import { DropdownMenuItem } from 'reka-ui'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioDropdownMenu from '@/components/ui/StudioDropdownMenu.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import { computed, nextTick, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ShotStoryboardStrip from './ShotStoryboardStrip.vue'
import ShotReviewIssues from './ShotReviewIssues.vue'
import ShotScriptDialog from './ShotScriptDialog.vue'
import ShotBatchProgress from './ShotBatchProgress.vue'
import ShotPromptComposer from './ShotPromptComposer.vue'
import NativeH3RecipeFields from './NativeH3RecipeFields.vue'
import type { ShotDraft } from './shotListTypes'
import { characterSelectGroups, durationOptions, scriptCountOptions, scriptTotalOptions, shotSizeOptions } from './shotListEditorOptions'
import { useShotWorkspace } from "@/components/video/useShotWorkspace"
import type { VideoStatusResponse } from '@/api/videoApi'
const props = defineProps<{ status: VideoStatusResponse | null }>()
const editorRoot = ref<HTMLElement | null>(null)
function locateShot(index: number) {
  const row = editorRoot.value?.querySelector<HTMLElement>(`[data-shot-index="${index}"]`)
  row?.scrollIntoView({ block:'start', behavior:'instant' })
  row?.focus({ preventScroll:true })
}
const {
 frameInputs,openProjectImport,h3Ready, h3Model, nativeVideo, h3DefaultSteps, nativeH3Steps, h3LightVae, h3Issue, aspectRatio, quality, linkLastFrame, steps,
identityCard, loadingRefAssets, loadingRefCardIndex, referenceCards, profileFailed, retryCardProfile, pendingScenarioCount, scenarioImportBlocked, retryScenarioImport, batchActive, addReferenceCard, onCardCharacterSelected,
popularCharacters, directoryFailed, readCharacters, removeReferenceCard, getCharOutfits, switchCardOutfit, removeReference, pickReference,
        setReferenceInput, onReferencePicked, retryReferences, shots, sceneFillId, blueprintCharacter, blueprintReady, blueprintError, retryBlueprints, sceneBlueprints, addShot,
storyboardBlueprintId, storyboardIntent, storyboardBusy, runStoryboard, firstFrameBusy, generateFirstFrames,
firstFrameProgress, aiBusy, runAiRewrite, runAiPolish, scriptBusy, scriptNote, scriptOpen,
reviewBusy, runAiReview, aiSnapshot, restoreAiSnapshot, polishSnapshot, restorePolishSnapshot,
clearShots, aiNote, flowHint, reviewIssues, applyReviewSuggestion, shotIssueCount,
serverShot, shotStatusLabel, moveShot, removeShot, dialogueBusy, runAiDialogue,
dialogueIndex, dialogueOptions, applyDialogueOption, cameraOptions, motionOptions, pickFrame,
retryShotFrame, clearFrame, onFramePicked, retryShotAt, scriptStory, scriptCount,
scriptTotal, runAiScript, canSubmit, submitTitle, submitDescription, cancelling,
cancelBatch, cancelOriginalRequest, batch, retryAllFailed, canConcat, concating, concatBatch,
submitBatch, submitting, retrying, batchError, batchReadError, batchReading, batchReadRetryable, batchRecoveryPending, batchSelectionPending, requestPending, retryBatchRead, batchStatusLabel, progressPercent,
} = useShotWorkspace(props)
const shotDurationOptions = computed(() => durationOptions.map(option => ({ ...option,
  disabled: nativeVideo.value && !!h3Model.value?.durations && !h3Model.value.durations.some(duration => duration === option.value),
})))

const shotPromptLimit = computed(() => {
  const identity = identityCard.value.trim()
  return identity ? Math.max(0, 3999 - identity.length) : 4000
})
const promptWorkbenchKeys = new WeakMap<ShotDraft, symbol>()
function promptWorkbenchKey(shot: ShotDraft): symbol {
  const key = promptWorkbenchKeys.get(shot) ?? Symbol()
  promptWorkbenchKeys.set(shot, key)
  return key
}

async function moveShotWithFocus(index: number, delta: number) {
  moveShot(index, delta)
  await nextTick()
  const row = editorRoot.value?.querySelector<HTMLElement>(`[data-shot-index="${index + delta}"]`)
  const focusTarget = row?.querySelector<HTMLButtonElement>(`[aria-label="${delta < 0 ? '上移镜头' : '下移镜头'}"]:not(:disabled)`) ?? row
  row?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  focusTarget?.focus({ preventScroll: true })
}

const concatTranscript = computed(() => (batch.value?.shots ?? [])
  .map(shot => (shot.dialogue || '').trim())
  .filter(Boolean)
  .join('\n'))

// —— 原生 <select> → StudioSelect 选项构造（2026-09-22 去原生化）——
const cardCharacterGroups = computed(() => characterSelectGroups(popularCharacters.value))
const blueprintCharacters = computed(() => [{ value: '', label: '选择蓝图角色' },
  ...popularCharacters.value.map(character => ({ value: character.id, label: character.displayName }))])

const sceneFillOptions = computed<StudioSelectOption[]>(() => [
  { value: '', label: '场景蓝图 → 填入空镜头' },
  ...sceneBlueprints.value.map(b => ({ value: b.id, label: b.title })),
])

const storyboardOptions = computed<StudioSelectOption[]>(() => [
  { value: '', label: '蓝图一键剧本 · 起承转合四镜' },
  ...sceneBlueprints.value.map(b => ({ value: b.id, label: b.title })),
])

const castOptions = computed<StudioSelectOption[]>(() => {
  const options: StudioSelectOption[] = [{ value: '', label: '无指定角色' }]
  referenceCards.value.forEach((card, cardIdx) => {
    options.push({ value: String(cardIdx + 1), label: `角色 ${cardIdx + 1}${card.label ? ' · ' + card.label : ''}` })
  })
  if (referenceCards.value.length >= 2) options.push({ value: '12', label: '双人（角色 1 + 2）' })
  if (referenceCards.value.length >= 3) options.push({ value: '123', label: '三人（角色 1 + 2 + 3）' })
  options.push({ value: 'all', label: '全员出场' })
  return options
})

function shotCastCharacter(cast: string): string {
  const firstIndex = cast === 'all' ? 0 : (Number(cast?.[0]) || 1) - 1
  const card = referenceCards.value[firstIndex] || referenceCards.value[0]
  const id = (card?.characterId || '').toLowerCase()
  const label = (card?.label || '').toLowerCase()
  if (id === 'nene' || label.includes('宁宁') || label.includes('nene')) return 'nene'
  if (id === 'natsume' || label.includes('夏目') || label.includes('natsume')) return 'natsume'
  return ''
}
</script>

<style scoped src="@/assets/css/shot-list-editor.css"></style>
