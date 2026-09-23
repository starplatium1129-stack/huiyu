<template>
  <section ref="editorRoot" class="shot-editor">
    <p v-if="batchError" class="video-panel" role="status">{{ batchError }}</p>
    <div v-if="!h3Ready" class="video-panel shot-blocked">
      <p>分镜短片模式需要 MiniMax H3 权重就绪（支持首尾帧衔接与原生对白）。安装完成后点击「重新检测」即可使用。</p>
    </div>

    <template v-else>
      <ShotStoryboardStrip v-if="shots.length" :shots="shots" @locate="locateShot" />
      <section class="video-panel">
        <div class="video-panel-heading">
          <div>
            <span class="video-step">01 · 整批方向</span>
            <h2>画幅统一，镜头自由</h2>
          </div>
        </div>

        <div class="video-choice-group">
          <span class="field-label">画幅（整批统一，拼接成片需要）</span>
          <div class="video-segmented" role="group" aria-label="选择分镜画幅">
            <button
              v-for="item in aspectOptions"
              :key="item.id"
              type="button"
              :class="{ active: aspectRatio === item.id }"
              :aria-pressed="aspectRatio === item.id"
              :disabled="batchActive || submitting"
              @click="aspectRatio = item.id"
            >{{ item.label }}</button>
          </div>
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
              :disabled="batchActive || submitting"
              @click="quality = item.id"
            >
              <strong>{{ item.label }}</strong>
              <small>{{ item.summary }}</small>
              <em>{{ item.sizes[aspectRatio] }}</em>
            </button>
          </div>
        </div>

        <ToggleSwitch
          class="shot-toggle"
          :model-value="linkLastFrame"
          :disabled="batchActive || submitting"
          label="自动衔接上一镜尾帧"
          @update:model-value="linkLastFrame = $event"
        >
          <span>
            <strong>自动衔接上一镜尾帧</strong>
            <small>本镜有首帧时作为尾帧（FL2VA 桥接），无首帧时续接为开头（I2VA 续接），跨镜动作与空间更连续。</small>
          </span>
        </ToggleSwitch>

        <ToggleSwitch
          class="shot-toggle"
          :model-value="steps === 4"
          :disabled="batchActive || submitting"
          label="极速 4 步（整批）"
          @update:model-value="steps = $event ? 4 : 8"
        >
          <span>
            <strong>极速 4 步（整批）</strong>
            <small>采用 Turbo 蒸馏采样，耗时减少约 40%，画质微降，适合快速试镜与连贯长片。</small>
          </span>
        </ToggleSwitch>

        <label class="field shot-identity-field">
          <span class="field-label">角色身份锚点（逐镜注入提示词开头，跨镜一致性关键）</span>
          <textarea
            v-model="identityCard"
            :disabled="batchActive || submitting"
            class="textarea"
            rows="2"
            maxlength="600"
            placeholder="英文身份锚点：a girl with long silver hair and red eyes, wearing a dark coat …"
          ></textarea>
        </label>

        <div class="shot-reference-section">
          <div class="shot-reference-header-row">
            <div class="shot-reference-title-group">
              <span class="field-label">角色参考卡（跨镜锁定形象 · 支持多角色 4 视角装配）</span>
              <span v-if="loadingRefCardIndex !== null" class="shot-ref-loading">
                <ArchiveIcon name="spark" /> 正在为角色 {{ (loadingRefCardIndex ?? 0) + 1 }} 自动装配 4 视角基准图...
              </span>
            </div>
            <button
              v-if="referenceCards.length < 4"
              class="btn btn-ghost btn-xs"
              type="button"
              :disabled="batchActive || submitting"
              @click="addReferenceCard"
            >＋ 添加出场角色（最多 4 位）</button>
          </div>
          <div class="shot-reference-grid">
            <div v-for="(card, cardIndex) in referenceCards" :key="cardIndex" class="shot-reference-card">
              <div class="shot-reference-head">
                <strong>角色 {{ cardIndex + 1 }}</strong>
                <input
                  v-model="card.label"
                  :disabled="batchActive || submitting"
                  :aria-label="`角色 ${cardIndex + 1} 名称`"
                  class="input input-tight"
                  maxlength="20"
                  placeholder="角色名（如 宁宁 / 夏目）"
                />
                <StudioSelect class="shot-card-quick-select" size="sm" label="一键预设装配此角色" :groups="cardCharacterGroups" :model-value="card.characterId || ''" :disabled="batchActive || submitting" @update:model-value="(value) => selectCardCharacter(cardIndex, String(value))" />
                <button
                  v-if="referenceCards.length > 1"
                  class="btn btn-ghost btn-xs shot-card-remove-btn"
                  type="button"
                  :disabled="batchActive || submitting"
                  title="移除此角色卡"
                  :aria-label="`移除角色 ${cardIndex + 1} 参考卡`"
                  @click="removeReferenceCard(cardIndex)"
                ><ArchiveIcon name="close" /></button>
              </div>

              <!-- 服装形态药丸选择器 (Outfit Pills) -->
              <div v-if="getCharOutfits(card.characterId).length > 1" class="shot-card-outfit-pills">
                <button
                  v-for="outfit in getCharOutfits(card.characterId)"
                  :key="outfit.outfitId"
                  type="button"
                  class="shot-card-outfit-pill"
                  :class="{ active: (card.outfitId || 'default') === outfit.outfitId || (!card.outfitId && outfit.isDefault), 'pill-nsfw': outfit.isNsfw }"
                  :aria-pressed="(card.outfitId || 'default') === outfit.outfitId || (!card.outfitId && outfit.isDefault)"
                  :disabled="batchActive || submitting"
                  @click="switchCardOutfit(cardIndex, outfit.outfitId)"
                >
                  <ArchiveIcon :name="outfit.isNsfw ? 'lock' : 'wardrobe'" />
                  <span>{{ outfit.outfitName }}</span>
                </button>
              </div>

              <div class="shot-reference-images">
                <button v-for="(image, imageIndex) in card.images" :key="image.name"
                  type="button" class="shot-reference-remove" :disabled="batchActive || submitting"
                  :aria-label="`移除角色 ${cardIndex + 1} 的第 ${imageIndex + 1} 张参考图`"
                  title="移除参考图" @click="removeReferenceWithFocus(cardIndex, imageIndex, $event)">
                  <img class="shot-reference-thumb" :src="image.url" :alt="image.name" loading="lazy" />
                </button>
                <button
                  v-if="card.images.length < 4"
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="batchActive || submitting"
                  @click="pickReference(cardIndex)"
                >＋ 本地上传</button>
              </div>
              <p v-if="card.images.length" class="shot-reference-hint">已装配 {{ card.images.length }}/4 张参考图 · 点击缩略图可移除</p>
              <input
                :ref="(el) => setReferenceInput(el, cardIndex)"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                class="shot-frame-input"
                @change="onReferencePicked(cardIndex, $event)"
              />
            </div>
          </div>
        </div>
      </section>

      <section class="video-panel">
        <div class="video-panel-heading">
          <div>
            <span class="video-step">02 · 分镜清单</span>
            <h2>{{ shots.length }} 个镜头 · 建议 1–2 分钟片拆 8–15 镜</h2>
          </div>
        </div>
        <div class="shot-toolbar">
          <StudioSelect size="sm" label="从场景蓝图快速填充镜头描述" v-model="sceneFillId" :options="sceneFillOptions" :disabled="batchActive || submitting" />
          <button class="btn btn-ghost" type="button" :disabled="batchActive || submitting" @click="addShot">＋ 添加镜头</button>
          <StudioSelect size="sm" label="选择场景蓝图生成四镜剧本" v-model="storyboardBlueprintId" :options="storyboardOptions" :disabled="storyboardBusy || batchActive || submitting" />
          <input
            v-model="storyboardIntent"
            class="input shot-intent-input"
            type="text"
            maxlength="120"
            :disabled="storyboardBusy || batchActive || submitting"
            placeholder="可选 · 这一幕想发生什么"
            aria-label="剧本创作意图（可选）"
          />
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="!storyboardBlueprintId || storyboardBusy || batchActive || submitting"
            title="选择场景蓝图，按起承转合即时生成四镜分镜剧本（自动提取经典台词并替换当前清单）"
            @click="runStoryboard"
          ><ArchiveIcon name="gallery" /> {{ storyboardBusy ? '生成中…' : '生成剧本' }}</button>
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="firstFrameBusy || storyboardBusy || batchActive || shots.length === 0 || submitting"
            title="逐镜自动生成高质量首帧画面并回填；已有首帧的镜头将自动跳过，角色形象由参考卡锁定"
            @click="generateFirstFrames(shots, aspectRatio)"
          >{{ firstFrameBusy ? `首帧 ${firstFrameProgress}…` : '一键首帧' }}</button>
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="aiBusy || batchActive || !shots.length || submitting"
            title="第 1 步：逐镜把静态绘图提示词改写成视频分镜描述，并推断景别/镜头/运动/对白（复用聊天 LLM 配置）"
            @click="runAiRewrite"
          ><ArchiveIcon name="spark" /> AI 整理分镜</button>
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="aiBusy || batchActive || shots.length < 2 || submitting"
            title="第 2 步：用全局视角审整批镜头：调整景别/镜头运动/对白分布，让全片有节奏（不改描述本身）"
            @click="runAiPolish"
          ><ArchiveIcon name="filter" /> AI 整批编排</button>
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="scriptBusy || batchActive || submitting"
            title="写个故事梗概，AI 直接生成完整分镜表（无首帧纯文字 T2VA 也可生成）"
            @click="scriptOpen = true"
          ><ArchiveIcon name="wand" /> AI 生成脚本</button>
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="reviewBusy || batchActive || !shots.length || submitting"
            title="AI 审查整批镜头：描述不合格/字段矛盾/对白问题/衔接跳跃，生成前把关"
            @click="runAiReview"
          ><ArchiveIcon name="search" /> 质量检查</button>
          <button
            v-if="aiSnapshot"
            class="btn btn-ghost"
            type="button"
            :disabled="aiBusy || batchActive || submitting"
            title="恢复 AI 整理前的全部镜头内容"
            @click="restoreAiSnapshot"
          >撤销整理</button>
          <button
            v-if="polishSnapshot"
            class="btn btn-ghost"
            type="button"
            :disabled="aiBusy || batchActive || submitting"
            title="恢复 AI 整批编排前的全部镜头内容"
            @click="restorePolishSnapshot"
          >撤销编排</button>
          <button class="btn btn-ghost" type="button" :disabled="shots.length === 0 || batchActive || submitting" @click="clearShots">清空</button>
        </div>
        <p v-if="aiNote" role="status" class="shot-ai-note" :data-busy="aiBusy || undefined">{{ aiNote }}</p>
        <p v-else-if="flowHint" class="shot-flow-hint">{{ flowHint }}</p>

        <div v-if="reviewIssues.length" class="shot-review-list" aria-live="polite">
          <div
            v-for="(issue, issueIndex) in reviewIssues"
            :key="issueIndex"
            class="shot-review-item"
            :data-severity="issue.severity"
          >
            <span class="shot-review-tag">{{ issue.severity === 'error' ? '必须修' : '建议' }}</span>
            <span class="shot-review-copy">
              镜头 {{ issue.index + 1 }} · {{ issue.message }}
              <em v-if="issue.suggestion">→ {{ issue.suggestion }}</em>
            </span>
            <button
              v-if="issue.suggestion"
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="batchActive || submitting"
              @click="applyReviewSuggestion(issue)"
            >应用建议</button>
          </div>
        </div>

        <article v-for="(shot, index) in shots" :key="index" class="shot-row" :data-shot-index="index" tabindex="-1" :aria-label="`镜头 ${index + 1} 编辑`" :data-issue="shotIssueCount(index) || undefined">
          <header class="shot-row-head">
            <span class="shot-index">镜头 {{ index + 1 }}</span>
            <span v-if="shotIssueCount(index)" class="shot-issue-badge" :data-count="shotIssueCount(index)">
              {{ shotIssueCount(index) }} 个问题
            </span>
            <span v-if="serverShot(index)" class="shot-row-status" :data-state="serverShot(index)?.status">
              {{ shotStatusLabel(serverShot(index)?.status) }}
            </span>
            <div class="shot-row-actions">
              <button type="button" :disabled="index === 0 || batchActive || submitting" title="上移" @click="moveShot(index, -1)">↑</button>
              <button type="button" :disabled="index === shots.length - 1 || batchActive || submitting" title="下移" @click="moveShot(index, 1)">↓</button>
              <button type="button" :disabled="batchActive || submitting" aria-label="删除镜头" title="删除镜头" @click="removeShot(index)"><ArchiveIcon name="close" /></button>
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
              ></textarea>
            </label>

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
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="batchActive || dialogueBusy || submitting"
                  title="AI 给 3 条台词备选（或润色你写的）"
                  @click="runAiDialogue(index)"
                ><ArchiveIcon name="chat" /> AI 台词</button>
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
              <StudioSelect size="sm" label="本镜出场角色" title="本镜出场角色（对应顶部角色参考卡，生成时自动带参考图）" v-model="shot.cast" :options="castOptions" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">景别</span>
                <StudioSelect size="sm" label="景别" v-model="shot.shotSize" :options="shotSizeOptions" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">镜头运动</span>
                <StudioSelect size="sm" label="镜头运动" v-model="shot.camera" :options="cameraOptions.map(item => ({ value: item.id, label: item.label }))" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">主体运动</span>
              <StudioSelect size="sm" label="主体运动" v-model="shot.motion" :options="motionOptions.map(item => ({ value: item.id, label: item.label }))" :disabled="batchActive || submitting" />
              </label>
              <label class="field">
                <span class="field-label">时长</span>
                <StudioSelect size="sm" label="时长" v-model="shot.duration" :options="durationOptions" :disabled="batchActive || submitting" />
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
              <button v-if="shot.imageUrl" class="btn btn-ghost" type="button" :disabled="batchActive || submitting" @click="clearFrame(index)">
                移除首帧
              </button>
              <span v-if="index > 0 && linkLastFrame" class="shot-chain-note">自动衔接镜头 {{ index }} 尾帧</span>
              <input ref="frameInputs" type="file" accept="image/png,image/jpeg,image/webp" class="shot-frame-input" @change="onFramePicked(index, $event)" />
            </div>
          </div>

          <p v-if="serverShot(index)?.error" class="shot-error">{{ serverShot(index)?.error }}</p>
          <StudioMediaPlayer v-if="serverShot(index)?.resultUrl" class="shot-result" kind="video" :src="serverShot(index)?.resultUrl ?? ''" label="本镜生成结果" />
          <div v-if="serverShot(index)?.status === 'failed'" class="shot-retry">
            <button class="btn btn-primary" type="button" :disabled="retrying || cancelling || concating || submitting" @click="retryShotAt(index)">{{ retrying ? '正在重试…' : '重抽本镜（同 Seed）' }}</button>
          </div>
        </article>

        <p v-if="shots.length === 0" class="shot-empty">
          还没有镜头。添加镜头后用「场景蓝图」快速填充，或直接逐镜写描述。
        </p>
      </section>

      <Teleport to="body">
        <FluidTransition>
        <div v-if="scriptOpen" class="shot-script-overlay" @click.self="scriptOpen = false">
          <section ref="scriptDialog" class="shot-script-panel" role="dialog" aria-modal="true" aria-label="AI 生成分镜脚本">
            <header class="shot-script-head">
              <div>
                <span class="video-step"><ArchiveIcon name="wand" /> AI 生成脚本</span>
                <h2>故事梗概 → 完整分镜表</h2>
                <p>AI 按叙事节奏切镜（景别/镜头/运动/台词/时长全自动），无首帧也可纯文字生成（T2VA）。</p>
              </div>
              <button class="btn btn-ghost" type="button" aria-label="关闭" @click="scriptOpen = false"><ArchiveIcon name="close" /></button>
            </header>
            <label class="field">
              <span class="field-label">故事梗概（中文即可）</span>
              <textarea
                ref="scriptStoryInput"
                v-model="scriptStory"
                class="textarea"
                rows="5"
                maxlength="2000"
                placeholder="例如：宁宁在咖啡店值夜班，打烊前收到一封旧信，读完决定去找写信的人……"
              ></textarea>
            </label>
            <div class="shot-script-row">
              <label class="field">
                <span class="field-label">镜头数</span>
                <StudioSelect size="sm" label="镜头数" :model-value="scriptCount ?? ''" :options="scriptCountOptions" @update:model-value="value => (scriptCount = value === '' ? null : Number(value))" />
              </label>
              <label class="field">
                <span class="field-label">总时长（秒）</span>
                <StudioSelect size="sm" label="总时长（秒）" :model-value="scriptTotal ?? ''" :options="scriptTotalOptions" @update:model-value="value => (scriptTotal = value === '' ? null : Number(value))" />
              </label>
            </div>
            <footer class="shot-script-foot">
              <span v-if="referenceCards.some(card => card.label)" class="shot-script-hint">
                参考卡角色将作为 &lt;Picture N&gt; 注入：{{ referenceCards.filter(card => card.label).map(card => card.label).join('、') }}
              </span>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="scriptBusy || !scriptStory.trim()"
                @click="runAiScript"
              >{{ scriptBusy ? '生成中…' : '生成分镜表' }}</button>
            </footer>
          </section>
        </div>
        </FluidTransition>
      </Teleport>

      <section class="video-panel shot-submit-panel" :data-ready="canSubmit || undefined">
        <div>
          <strong>{{ submitTitle }}</strong>
          <p>{{ submitDescription }}</p>
        </div>
        <div class="shot-submit-actions">
          <button v-if="batchActive" class="btn btn-danger" type="button" :disabled="cancelling" @click="cancelBatch">
            {{ cancelling ? '正在取消…' : '取消整批' }}
          </button>
          <template v-else>
            <button
              v-if="batch && batch.shots.some((shot) => shot.status === 'failed')"
              class="btn btn-primary"
              type="button"
              :disabled="retrying || concating || cancelling || submitting"
              @click="retryAllFailed"
            >{{ retrying ? '正在重试…' : '重抽失败镜头' }}</button>
            <button
              v-if="batch && canConcat"
              class="btn btn-primary"
              type="button"
              :disabled="concating || retrying || cancelling || submitting"
              @click="concatBatch"
            >{{ concating ? '正在拼接…' : '拼接成片' }}</button>
            <button class="btn btn-primary btn-lg" type="button" :disabled="!canSubmit" @click="submitBatch">
              {{ submitting ? '正在提交…' : '生成全部镜头' }}
            </button>
          </template>
        </div>
      </section>

      <section v-if="batch" class="video-panel shot-progress-panel" aria-live="polite">
        <div class="video-panel-heading">
          <div>
            <span class="video-step">03 · 批量进度</span>
            <h2>{{ batchStatusLabel }}</h2>
          </div>
          <span class="shot-progress-stats">{{ batch.progress.succeeded }} / {{ batch.progress.total }} 镜成功 · {{ batch.progress.failed }} 失败</span>
        </div>
        <div class="video-progress"><i :style="{ '--progress': progressPercent + '%' }"></i></div>
        <p class="video-install-note">
          {{ batch.linkLastFrame ? '镜头间已自动衔接上一镜尾帧；' : '已关闭尾帧衔接；' }}
          单镜约 2.5–6 分钟（standard 档），可离开页面，任务在后台继续。
        </p>
        <template v-if="batch.concatUrl">
          <div class="shot-concat-heading">
            <strong>整片预览</strong>
            <a class="btn btn-ghost" :href="batch.concatUrl" download>下载整片 MP4</a>
          </div>
          <StudioMediaPlayer class="shot-concat-player" kind="video" :src="batch.concatUrl" label="整片预览" />
        </template>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import type { StudioSelectOption, StudioSelectGroup } from '@/components/ui/StudioSelect.vue'
import { computed, nextTick, ref } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ShotStoryboardStrip from './ShotStoryboardStrip.vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { useShotWorkspace } from "@/components/video/useShotWorkspace"
import type { VideoStatusResponse } from '@/api/videoApi'
const props = defineProps<{ status: VideoStatusResponse | null }>()
const editorRoot = ref<HTMLElement | null>(null)
function locateShot(index: number) {
  const row = editorRoot.value?.querySelector<HTMLElement>(`[data-shot-index="${index}"]`)
  row?.scrollIntoView({ block:'start', behavior:prefersReducedMotion() ? 'instant' : 'smooth' })
  row?.focus({ preventScroll:true })
}
const {
 frameInputs,h3Ready, aspectOptions, aspectRatio, quality, linkLastFrame, steps,
identityCard, loadingRefCardIndex, referenceCards, batchActive, addReferenceCard, onCardCharacterSelected,
popularCharacters, removeReferenceCard, getCharOutfits, switchCardOutfit, removeReference, pickReference,
setReferenceInput, onReferencePicked, shots, sceneFillId, sceneBlueprints, addShot,
storyboardBlueprintId, storyboardIntent, storyboardBusy, runStoryboard, firstFrameBusy, generateFirstFrames,
firstFrameProgress, aiBusy, runAiRewrite, runAiPolish, scriptBusy, scriptOpen,
reviewBusy, runAiReview, aiSnapshot, restoreAiSnapshot, polishSnapshot, restorePolishSnapshot,
clearShots, aiNote, flowHint, reviewIssues, applyReviewSuggestion, shotIssueCount,
serverShot, shotStatusLabel, moveShot, removeShot, dialogueBusy, runAiDialogue,
dialogueIndex, dialogueOptions, applyDialogueOption, cameraOptions, motionOptions, pickFrame,
retryShotFrame, clearFrame, onFramePicked, retryShotAt, scriptStory, scriptCount,
scriptTotal, runAiScript, canSubmit, submitTitle, submitDescription, cancelling,
cancelBatch, batch, retryAllFailed, canConcat, concating, concatBatch,
submitBatch, submitting, retrying, batchError, batchStatusLabel, progressPercent,
} = useShotWorkspace(props)

// —— 原生 <select> → StudioSelect 选项构造（2026-09-22 去原生化）——
const cardCharacterGroups = computed<StudioSelectGroup[]>(() => [
  { label: '角色预设', options: [{ value: '', label: '选择角色预设...' }] },
  { label: '专属角色', options: [
    { value: 'nene', label: '绫地宁宁' },
    { value: 'natsume', label: '四季夏目' },
  ] },
  { label: '热门角色', options: popularCharacters.value.map(c => ({ value: c.id, label: c.displayName })) },
])

const sceneFillOptions = computed<StudioSelectOption[]>(() => [
  { value: '', label: '场景蓝图 → 填入空镜头' },
  ...sceneBlueprints.value.map(b => ({ value: b.id, label: b.title })),
])

const storyboardOptions = computed<StudioSelectOption[]>(() => [
  { value: '', label: '蓝图一键剧本 · 起承转合四镜' },
  ...sceneBlueprints.value.map(b => ({ value: b.id, label: b.title })),
])

// 镜头级参数与剧本档位的选项：原先内联在 <option> 里，抽出来让模板保持单行。
const shotSizeOptions: StudioSelectOption[] = [
  { value: '', label: '默认' },
  { value: 'wide', label: '全景' },
  { value: 'medium', label: '中景' },
  { value: 'closeup', label: '特写' },
]
// 时长是数字值：shot.duration 为 number，保持类型不要字符串化。
const durationOptions: StudioSelectOption[] = [
  { value: 3, label: '3 秒' },
  { value: 5, label: '5 秒（推荐）' },
  { value: 10, label: '10 秒 · 长镜' },
  { value: 15, label: '15 秒 · 长镜' },
]
const scriptCountOptions: StudioSelectOption[] = [
  { value: '', label: '自动' },
  { value: 8, label: '8 镜' },
  { value: 10, label: '10 镜' },
  { value: 12, label: '12 镜' },
]
const scriptTotalOptions: StudioSelectOption[] = [
  { value: '', label: '自动' },
  { value: 40, label: '约 40s' },
  { value: 60, label: '约 60s' },
  { value: 90, label: '约 90s' },
]

const castOptions = computed<StudioSelectOption[]>(() => {
  const options: StudioSelectOption[] = [{ value: '', label: '无参考' }]
  referenceCards.value.forEach((card, cardIdx) => {
    options.push({ value: String(cardIdx + 1), label: `角色 ${cardIdx + 1}${card.label ? ' · ' + card.label : ''}` })
  })
  if (referenceCards.value.length >= 2) options.push({ value: '12', label: '双人（角色 1 + 2）' })
  if (referenceCards.value.length >= 3) options.push({ value: '123', label: '三人（角色 1 + 2 + 3）' })
  options.push({ value: 'all', label: '全员出场' })
  return options
})

// onCardCharacterSelected 已按新签名收 string（见 useReferenceCards），直接透传。
function selectCardCharacter(cardIndex: number, value: string | number) {
  onCardCharacterSelected(cardIndex, String(value))
}

async function removeReferenceWithFocus(cardIndex: number, imageIndex: number, event: MouseEvent) {
  const group = (event.currentTarget as HTMLElement).closest('.shot-reference-images')
  removeReference(cardIndex, imageIndex)
  await nextTick()
  const buttons = group?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
  buttons?.[Math.min(imageIndex, buttons.length - 1)]?.focus({ preventScroll: true })
}
const scriptDialog = ref<HTMLElement | null>(null)
const scriptStoryInput = ref<HTMLElement | null>(null)
useFocusTrap(scriptDialog, () => scriptOpen.value, { onEscape: () => { scriptOpen.value = false }, initialFocus: scriptStoryInput })
</script>

<style scoped src="@/assets/css/shot-list-editor.css"></style>
