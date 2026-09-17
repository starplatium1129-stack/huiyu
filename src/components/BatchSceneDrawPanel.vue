<template>
  <Teleport to="body">
    <FluidTransition>
    <div v-if="open" class="batch-overlay" @click.self="emit('close')">
      <section ref="panel" class="batch-panel" role="dialog" aria-modal="true" aria-label="批量出图">
        <header class="batch-head">
          <div>
            <span class="batch-step">BATCH · {{ batchMode === 'scene' ? 'SCENES' : 'CHARACTERS' }}</span>
            <h2>批量出图 · {{ batchMode === 'scene' ? '多场景蓝图' : '多角色漫游' }}</h2>
            <p>{{ phase === 'config'
              ? (batchMode === 'scene'
                  ? '按蓝图绑定的角色、服装、镜头与尺寸逐张出图；成功成片自动入册。'
                  : '使用当前词条，一次性勾选多位角色批量出图，成片自动归入各角色画廊。')
              : '逐张串行生成，可关闭面板留在当前页；点缩略图看大图，失败项可单独重跑。' }}</p>
          </div>
          <button class="btn btn-ghost" type="button" aria-label="关闭" @click="emit('close')"><ArchiveIcon name="close" /></button>
        </header>

        <!-- ── 配置态 ── -->
        <template v-if="phase === 'config'">
          <div class="batch-config-row">
            <div class="batch-field">
              <span class="field-label">模式</span>
              <div class="batch-seg" role="group" aria-label="选择批量模式">
                <button type="button" :class="{ active: batchMode === 'scene' }" @click="batchMode = 'scene'">按场景蓝图</button>
                <button type="button" :class="{ active: batchMode === 'character' }" @click="batchMode = 'character'">按多角色漫游</button>
              </div>
            </div>
            <div class="batch-field">
              <span class="field-label">引擎</span>
              <div class="batch-seg" role="group" aria-label="选择批量出图引擎">
                <button type="button" :class="{ active: batchEngine === 'sd' }" :disabled="!sdAvailable"
                  :title="!sdAvailable ? 'SD WebUI 当前离线' : undefined"
                  @click="batchEngine = 'sd'">SD</button>
                <button type="button" :class="{ active: batchEngine === 'anima' }" :disabled="!animaAvailable"
                  :title="!animaAvailable ? 'ComfyUI 当前离线' : undefined"
                  @click="batchEngine = 'anima'">{{ props.deps.animaState.value.family === 'krea2' ? 'Krea 2' : 'Anima' }}</button>
              </div>
            </div>
            <div class="batch-field">
              <span class="field-label">每项张数</span>
              <div class="batch-seg" role="group" aria-label="每项出几张">
                <button type="button" :class="{ active: count === 1 }" @click="count = 1">1 张</button>
                <button type="button" :class="{ active: count === 3 }" @click="count = 3">3 张候选</button>
              </div>
            </div>
          </div>

          <!-- 场景蓝图选择视图 -->
          <template v-if="batchMode === 'scene'">
            <div class="batch-scene-toolbar">
              <input v-model="filter" class="input" type="search" aria-label="搜索批量场景" placeholder="搜索场景 / 角色 / 地点…" />
              <select v-model="categoryFilter" class="select" aria-label="按分类过滤">
                <option value="">全部分类</option>
                <option v-for="name in categories" :key="name" :value="name">{{ name }}</option>
              </select>
              <button class="btn btn-ghost btn-sm" type="button" @click="toggleAllScenes">{{ allFilteredScenesSelected ? '取消全选' : '全选匹配项' }}</button>
              <button class="btn btn-ghost btn-sm" type="button" @click="clearSceneSelection">清空</button>
            </div>

            <div class="batch-scene-grid">
              <button
                v-for="scene in filteredScenes.slice(0, sceneLimit)"
                :key="scene.id"
                type="button"
                class="batch-scene-card"
                :class="{ selected: selectedSceneSet.has(scene.id) }"
                :aria-pressed="selectedSceneSet.has(scene.id)"
                @click="toggleScene(scene.id)"
              >
                <span class="batch-scene-check" aria-hidden="true"><ArchiveIcon name="success" /></span>
                <strong class="batch-scene-title">{{ scene.title }}</strong>
                <small class="batch-scene-meta">
                  {{ props.deps.pb.popularCharacters.find(character => character.id === scene.characterId)?.displayName }} · {{ scene.category }}<template v-if="scene.location"> · {{ scene.location }}</template>
                  <ArchiveIcon v-if="scene.adult" name="lock" class="batch-scene-adult" title="成人场景" />
                </small>
              </button>
              <p v-if="!filteredScenes.length" class="batch-empty">
                没有匹配的场景{{ props.scenes.length ? '（换个关键词或分类试试）' : '（场景蓝图为空）' }}。
              </p>
            </div>
            <button v-if="filteredScenes.length > sceneLimit" class="btn btn-ghost" type="button" @click="sceneLimit += 30">再显示 30 个场景（共 {{ filteredScenes.length }} 个匹配）</button>
          </template>

          <!-- 多角色漫游选择视图 -->
          <template v-else>
            <!-- 实时提示词预览与说明 -->
            <div class="batch-prompt-preview-card">
              <div class="batch-prompt-preview-head">
                <span class="batch-prompt-preview-title">
                  <ArchiveIcon name="spark" /> 当前应用于各角色的提示词基底
                </span>
                <span class="batch-prompt-preview-badge">自动剔除原角色特征，动态注入选中角色 DNA</span>
              </div>
              <p class="batch-prompt-preview-text">
                {{ currentPromptPreview || '（当前提示词为空，请先在工作台输入故事、选择场景或添加标签）' }}
              </p>
            </div>

            <div class="batch-scene-toolbar">
              <input v-model="charFilter" class="input" type="search" aria-label="搜索批量角色" placeholder="搜索角色名 / 原作…" />
              <select v-model="franchiseFilter" class="select" aria-label="按作品过滤">
                <option value="">全部作品</option>
                <option v-for="name in franchises" :key="name" :value="name">{{ name }}</option>
              </select>
              <button class="btn btn-ghost btn-sm" type="button" @click="toggleAllCharacters">{{ allFilteredCharsSelected ? '取消全选' : '全选匹配项' }}</button>
              <button class="btn btn-ghost btn-sm" type="button" @click="clearCharSelection">清空</button>
            </div>

            <div class="batch-char-grid">
              <button
                v-for="char in filteredCharacters.slice(0, charLimit)"
                :key="char.id"
                type="button"
                class="batch-char-card"
                :class="{ selected: selectedCharSet.has(char.id) }"
                :aria-pressed="selectedCharSet.has(char.id)"
                @click="toggleChar(char.id)"
              >
                <div class="batch-char-avatar-wrap">
                  <img :src="char.avatarUrl" :alt="char.displayName" class="batch-char-avatar" loading="lazy" decoding="async" />
                  <span class="batch-char-check" aria-hidden="true"><ArchiveIcon name="success" /></span>
                </div>
                <div class="batch-char-info">
                  <strong class="batch-char-name">{{ char.displayName }}</strong>
                  <small class="batch-char-franchise">{{ char.franchise }}</small>
                </div>
              </button>
              <p v-if="!filteredCharacters.length" class="batch-empty">
                没有匹配的角色（换个关键词试试）。
              </p>
            </div>
            <button v-if="filteredCharacters.length > charLimit" class="btn btn-ghost" type="button" @click="charLimit += 30">再显示 30 位角色（共 {{ filteredCharacters.length }} 位匹配）</button>
          </template>

          <footer class="batch-foot">
            <span class="batch-hint">
              <template v-if="batchMode === 'scene'">
                已选 {{ selectedSceneCount }} 个场景 × {{ count }} 张 = {{ selectedSceneCount * count }} 张 · 串行执行
              </template>
              <template v-else>
                已选 {{ selectedCharCount }} 位角色 × {{ count }} 张 = {{ selectedCharCount * count }} 张 · 串行漫游
              </template>
            </span>
            <button
              class="btn btn-primary"
              type="button"
              :disabled="isRunning || !engineReady || (batchMode === 'scene' ? !selectedSceneCount : !selectedCharCount)"
              @click="submit"
            >
              <ArchiveIcon name="spark" /> {{ engineReady ? '开始批量出图' : '请选择可用的 Anima / Krea 2 引擎' }}
            </button>
          </footer>
        </template>

        <!-- ── 结果态（进行中与完成后统一，完成后不自动弹回配置）── -->
        <template v-else>
          <div class="batch-progress-head">
            <strong>{{ isRunning ? (batchDraw.cancelRequested.value ? '当前张完成后停止…' : '正在逐张出图…') : (progress.cancelled ? '本批已停止' : '本批完成') }}</strong>
            <span class="batch-count-label">
              {{ progress.succeeded }} / {{ progress.total }} 张成功<template v-if="progress.failed"> · {{ progress.failed }} 失败</template><template v-if="progress.cancelled"> · {{ progress.cancelled }} 未执行</template>
            </span>
          </div>
          <div class="batch-progress"><i :style="{ '--progress': progressPercent + '%' }"></i></div>

          <div class="batch-result-grid">
            <figure v-for="job in jobs" :key="job.id" class="batch-card" :data-state="job.status">
              <button
                v-if="job.resultUrl"
                type="button"
                class="batch-thumb-btn"
                :aria-label="`查看大图：${job.sceneTitle}`"
                :title="`查看大图：${job.sceneTitle}`"
                @click="previewJob = job"
              >
                <img class="batch-thumb" :src="job.resultUrl" :alt="job.sceneTitle" loading="lazy" decoding="async" />
              </button>
              <div v-else class="batch-thumb batch-thumb-placeholder" :data-state="job.status">
                <ArchiveIcon :name="job.status === 'failed' ? 'warning' : 'spark'" />
                <span>{{ placeholderText(job) }}</span>
              </div>
              <figcaption class="batch-card-caption">
                <div class="batch-card-header-line">
                  <img v-if="job.avatarUrl" :src="job.avatarUrl" :alt="job.sceneTitle" class="batch-card-avatar" />
                  <span class="batch-card-title">{{ job.sceneTitle }}<em v-if="job.variant > 0"> · {{ job.variant + 1 }}</em></span>
                </div>
                <span class="batch-card-seed">{{ job.subtitle ? job.subtitle + ' · ' : '' }}{{ job.seed >= 0 ? 'seed ' + job.seed : '随机' }}</span>
              <p v-if="job.error" class="batch-card-error">{{ job.error }}</p>
              </figcaption>
            </figure>
          </div>

          <footer class="batch-foot">
            <template v-if="isRunning">
              <span class="batch-hint">关闭面板可继续；离开页面会停止后续任务</span>
              <button class="btn btn-danger" type="button" :disabled="batchDraw.cancelRequested.value" @click="batchDraw.cancel">停止（当前张完成后停）</button>
            </template>
            <template v-else>
              <span class="batch-hint">成功成片已自动入册历史，可在历史里「加入分镜」攒片</span>
              <div class="batch-foot-actions">
                <RouterLink v-if="comparisonIds.length >= 2" class="btn btn-primary" :to="`/gallery?compare=${comparisonIds.join(',')}`" @click="emit('close')">{{ progress.succeeded > 4 ? '对比前 4 张' : '对比本批候选' }}</RouterLink>
                <button v-if="retryableCount" class="btn btn-ghost" type="button" @click="onRetryFailed">
                  <ArchiveIcon name="spark" /> 重试失败 / 未执行 {{ retryableCount }} 张
                </button>
                <button class="btn btn-ghost" type="button" @click="resetToConfig">再来一批</button>
                <button class="btn btn-primary" type="button" @click="emit('close')">完成</button>
              </div>
            </template>
          </footer>
        </template>

        <!-- 大图预览 -->
        <Transition name="layer-fade">
        <div v-if="previewJob?.resultUrl" class="batch-lightbox" @click.self="previewJob = null">
          <img :src="previewJob.resultUrl" :alt="previewJob.sceneTitle" />
          <p class="batch-lightbox-caption">
            {{ previewJob.sceneTitle }}<em v-if="previewJob.variant > 0"> · 候选 {{ previewJob.variant + 1 }}</em>
            · {{ previewJob.seed >= 0 ? 'seed ' + previewJob.seed : '随机 seed' }}
          </p>
          <button class="btn btn-ghost btn-sm batch-lightbox-close" type="button" aria-label="关闭大图" @click="previewJob = null">
            <ArchiveIcon name="close" />
          </button>
        </div>
        </Transition>
      </section>
    </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { computed, reactive, ref, watch, onUnmounted } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { usePromptBatchRunners, type PromptBatchRunnersDeps } from '@/composables/prompt/usePromptBatchRunners'
import type { BatchDrawJob } from '@/composables/generation/useBatchDraw'
import type { SceneBlueprint } from '@/utils/popularContent'

/**
 * 批量出图面板（支持「多场景蓝图」与「多角色漫游」双模）。
 */
const props = defineProps<{
  open: boolean
  scenes: SceneBlueprint[]
  sdAvailable: boolean
  animaAvailable: boolean
  deps: PromptBatchRunnersDeps
}>()

const emit = defineEmits<{
  close: []
  'running-change': [running: boolean]
}>()

const panel = ref<HTMLElement | null>(null)
useFocusTrap(panel, () => props.open, { onEscape: () => previewJob.value ? previewJob.value = null : emit('close') })
const batchMode = ref<'scene' | 'character'>('scene')
const count = ref<1 | 3>(1)
const phase = ref<'config' | 'results'>('config')
const previewJob = ref<BatchDrawJob | null>(null)

// ── 场景选择态 ──
const sceneLimit = ref(30), charLimit = ref(30)
const filter = ref('')
const categoryFilter = ref('')
const selectedSceneSet = reactive(new Set<string>())

// ── 角色选择态 ──
const charFilter = ref('')
const franchiseFilter = ref('')
const selectedCharSet = reactive(new Set<string>())

const { batchEngine, batchDraw, onBatchStart, onBatchStartCharacters, onRetryFailed } = usePromptBatchRunners(props.deps)

const currentPromptPreview = computed(() => {
  return props.deps.currentLivePrompt?.() || props.deps.currentBasePrompt?.() || props.deps.pb.story || props.deps.pb.visualDescription || ''
})

const engineReady = computed(() => batchEngine.value === 'sd' ? props.sdAvailable && batchMode.value === 'character' && [...selectedCharSet].every(id => ['nene', 'natsume'].includes(id)) : props.animaAvailable)
const isRunning = computed(() => batchDraw.running.value)
const jobs = computed(() => batchDraw.jobs.value)
const comparisonIds = computed(() => jobs.value.filter(job => job.historyId != null).slice(0, 4).map(job => encodeURIComponent(String(job.historyId))))
const progress = computed(() => batchDraw.progress.value)
const retryableCount = computed(() =>
  jobs.value.filter(job => job.status === 'failed' || job.status === 'cancelled').length)
const progressPercent = computed(() => {
  if (!progress.value.total) return 0
  return Math.min(100, Math.round((progress.value.done / progress.value.total) * 100))
})

// ── 场景蓝图筛选 ──
const categories = computed(() =>
  [...new Set(props.scenes.map(scene => scene.category).filter(Boolean))].sort())
const filteredScenes = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  return props.scenes.filter(scene => {
    if (scene.adult && !props.deps.pb.showMatureScenes) return false
    if (categoryFilter.value && scene.category !== categoryFilter.value) return false
    if (!keyword) return true
    const owner = props.deps.pb.popularCharacters.find(character => character.id === scene.characterId)
    return [scene.title, scene.location, scene.category, owner?.displayName]
      .some(text => String(text || '').toLowerCase().includes(keyword))
  })
})
const selectedSceneCount = computed(() => selectedSceneSet.size)
const allFilteredScenesSelected = computed(() =>
  filteredScenes.value.length > 0 && filteredScenes.value.every(scene => selectedSceneSet.has(scene.id)))

function toggleScene(id: string) {
  if (selectedSceneSet.has(id)) selectedSceneSet.delete(id)
  else selectedSceneSet.add(id)
}
function toggleAllScenes() {
  const clear = allFilteredScenesSelected.value
  filteredScenes.value.forEach(scene => {
    if (clear) selectedSceneSet.delete(scene.id)
    else selectedSceneSet.add(scene.id)
  })
}
function clearSceneSelection() {
  selectedSceneSet.clear()
  filter.value = ''
  categoryFilter.value = ''
}

// ── 多角色列表构建与筛选 ──
interface CharacterOption {
  id: string
  displayName: string
  franchise: string
  avatarUrl: string
}

const allCharacters = computed<CharacterOption[]>(() => {
  const populars = props.deps.popularCharacters?.() || props.deps.pb.popularCharacters || []
  const list: CharacterOption[] = [
    { id: 'nene', displayName: '绫地宁宁', franchise: '星光咖啡馆与死神之蝶', avatarUrl: '/assets/characters/thumbs/popular-nene.webp' },
    { id: 'natsume', displayName: '四季夏目', franchise: '星光咖啡馆与死神之蝶', avatarUrl: '/assets/characters/thumbs/popular-natsume.webp' },
  ]
  populars.forEach(pop => {
    if (pop.id !== 'nene' && pop.id !== 'natsume') {
      list.push({
        id: pop.id,
        displayName: pop.displayName,
        franchise: pop.franchise || '其他',
        avatarUrl: popularPortraitSrc(pop.id),
      })
    }
  })
  return list
})

const franchises = computed(() =>
  [...new Set(allCharacters.value.map(c => c.franchise).filter(Boolean))].sort())

const filteredCharacters = computed(() => {
  const keyword = charFilter.value.trim().toLowerCase()
  return allCharacters.value.filter(char => {
    if (franchiseFilter.value && char.franchise !== franchiseFilter.value) return false
    if (!keyword) return true
    return [char.displayName, char.franchise, char.id]
      .some(text => String(text || '').toLowerCase().includes(keyword))
  })
})
const selectedCharCount = computed(() => selectedCharSet.size)
const allFilteredCharsSelected = computed(() =>
  filteredCharacters.value.length > 0 && filteredCharacters.value.every(char => selectedCharSet.has(char.id)))

function toggleChar(id: string) {
  if (selectedCharSet.has(id)) selectedCharSet.delete(id)
  else selectedCharSet.add(id)
}
function toggleAllCharacters() {
  const clear = allFilteredCharsSelected.value
  filteredCharacters.value.forEach(char => {
    if (clear) selectedCharSet.delete(char.id)
    else selectedCharSet.add(char.id)
  })
}
function clearCharSelection() {
  selectedCharSet.clear()
  charFilter.value = ''
  franchiseFilter.value = ''
}

async function submit() {
  if (isRunning.value || !engineReady.value) return
  if (batchMode.value === 'scene') {
    const sceneIds = props.scenes.map(s => s.id).filter(id => selectedSceneSet.has(id))
    if (!sceneIds.length) return
    await onBatchStart({ sceneIds, count: count.value })
  } else {
    const characterIds = allCharacters.value.map(c => c.id).filter(id => selectedCharSet.has(id))
    if (!characterIds.length) return
    await onBatchStartCharacters({ characterIds, count: count.value })
  }
  if (jobs.value.length) phase.value = 'results'
}

function resetToConfig() {
  batchDraw.reset()
  previewJob.value = null
  phase.value = 'config'
}

function placeholderText(job: BatchDrawJob): string {
  if (job.status === 'failed') return job.error || '生成失败'
  if (job.status === 'running') return job.message || '生成中…'
  if (job.status === 'pending') return '排队中'
  if (job.status === 'cancelled') return '未执行（已停止）'
  return '已入册'
}

watch([filter, categoryFilter], () => { sceneLimit.value = 30 })
watch([charFilter, franchiseFilter], () => { charLimit.value = 30 })
watch(() => props.open, (open) => {
  if (open) {
    filter.value = ''
    categoryFilter.value = ''
    charFilter.value = ''
    franchiseFilter.value = ''
    if (!isRunning.value && !engineReady.value) batchEngine.value = props.animaAvailable ? 'anima' : 'sd'
  }
})

watch(isRunning, running => { if (running) phase.value = 'results'; emit('running-change', running) }, { immediate: true })
onUnmounted(() => batchDraw.dispose())
</script>

<style scoped src="@/assets/css/batch-scene-draw-panel.css"></style>
