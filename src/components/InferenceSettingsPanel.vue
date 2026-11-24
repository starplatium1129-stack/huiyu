<template>
  <section id="control-inference" class="panel-card inference-settings" aria-labelledby="inference-settings-title">
    <header class="inference-heading">
      <div><h2 id="inference-settings-title" tabindex="-1">{{ videoSetupRequested ? '视频引擎设置' : '原生绘图' }}</h2></div>
      <span v-if="snapshot" class="inference-active">当前使用 · {{ engineLabel(videoSetupRequested ? snapshot.active.videoEngine : snapshot.active.engine) }}</span>
    </header>
    <p v-if="!isLocal">请在运行绘遇的电脑上修改引擎设置。</p>
    <template v-else>
      <p v-if="error" role="alert" class="inference-error">{{ error }}</p>
      <button v-if="error && !snapshot" class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="retrySettings">重新读取推理设置</button>
      <p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="snapshot">
        <MuseRelayConnection v-if="snapshot.museRelayUrl" :key="snapshot.museRelayUrl" :url="snapshot.museRelayUrl" />
        <section v-if="snapshot.active.remoteServe" class="inference-connection" aria-label="本机远程绘图">
          <div v-if="snapshot.remoteAddress" class="inference-actions">
            <div class="inference-address">
              <span class="inference-active">本机远程绘图地址</span>
              <code>{{ snapshot.remoteAddress }}</code>
            </div>
            <StudioCopyButton class="btn btn-ghost btn-sm" label="复制地址"
              :content-key="snapshot.remoteAddress" :action="() => copyText(snapshot?.remoteAddress ?? '')" />
            <StudioCopyButton class="btn btn-quiet btn-sm" label="复制连接密钥"
              :content-key="snapshot.active.remoteKey" :action="() => copyText(snapshot?.active.remoteKey ?? '')" />
          </div>
          <template v-else>
            <p role="status">
              {{ !snapshot.remoteListening ? '远程绘图未能监听，请检查端口是否被占用。'
                : loading ? '正在读取远程绘图地址…'
                : snapshot.remoteAddress === undefined ? '当前网关暂未提供远程绘图地址。'
                : `本机端口 ${snapshot.active.remotePort} 已监听。配置 Tailscale 转发后刷新地址。` }}
            </p>
            <div v-if="snapshot.remoteListening && snapshot.remoteAddress === null" class="inference-actions">
              <StudioCopyButton class="btn btn-ghost btn-sm" label="复制转发命令"
                :content-key="remoteForwardCommand" :action="() => copyText(remoteForwardCommand)" />
              <button class="btn btn-quiet btn-sm" type="button" :disabled="loading || saving" @click="refresh">刷新地址</button>
            </div>
          </template>
        </section>
        <AvailableDrawingModels v-if="showAvailableModels" :key="snapshot.active.engine" :provider="snapshot.active.engine" @local="showLocalPreparation = true" />
        <AsyncPanel v-if="localPreparationVisited" v-show="showLocalSetup" :loader="loadInferenceSetup" label="原生引擎准备" v-slot="{ component }"><component :is="component" :configured="snapshot.configured" :blocked="blocked || loading || saving || dirty || restarting" @prepared="fillPreparedPaths" @busy="setupBusy = $event" @working="setupWorking = $event" @activated="activated" /></AsyncPanel>
        <details class="inference-advanced" :open="videoSetupRequested">
          <StudioDisclosureSummary>视频引擎</StudioDisclosureSummary>
          <form class="inference-form" data-disclosure-content @submit.prevent="saveSettings">
            <div class="inference-field">
              <label for="inference-video-engine">故事短片使用的引擎</label>
              <StudioSelect id="inference-video-engine" v-model="draft.videoEngine" label="故事短片使用的引擎" :options="videoEngineOptions"
                :disabled="blocked || loading || saving || setupBusy || restarting" />
            </div>
            <p v-if="videoSetupRequested">导出 MP4 需本机已安装 ffmpeg。</p>
            <div class="inference-actions">
              <button class="btn btn-primary btn-sm" type="submit" :disabled="blocked || loading || saving || setupBusy || restarting || !dirty">{{ saving ? '保存中…' : '保存设置' }}</button>
              <button v-if="videoRestart && desktop?.restartForSetup" class="btn btn-ghost btn-sm" type="button"
                :disabled="blocked || loading || saving || setupBusy || restarting || dirty" @click="restartSetup">{{ restarting ? '正在重启…' : '重启并应用视频引擎' }}</button>
              <button v-if="videoSetupRequested" class="btn btn-quiet btn-sm" type="button" :disabled="blocked || loading || saving || setupBusy" @click="openVideoPaths">复用已有环境与模型</button>
              <RouterLink v-if="videoSetupRequested" class="btn btn-quiet btn-sm" :to="videoReturnTarget">返回故事短片</RouterLink>
            </div>
          </form>
        </details>
        <p v-if="snapshot.restartRequired" role="status">新设置将在重启后生效。</p>
        <p v-if="snapshot.environmentOverrides.length">{{ snapshot.environmentOverrides.join('、') }} 由启动配置指定，请在启动配置中修改。</p>
        <p v-if="blocked" role="status">模型准备正在处理，完成后可配置原生引擎。</p><p v-if="dirty && draft.engine !== 'remote'">请先保存引擎设置的修改，再继续本机准备。</p>
        <details id="control-remote" ref="remoteDetails" class="inference-remote">
          <StudioDisclosureSummary><span>绘图引擎与远程连接</span></StudioDisclosureSummary>
          <form class="inference-form" aria-label="绘图引擎与远程连接" data-disclosure-content @submit.prevent="saveSettings">
            <div class="inference-field">
              <label for="inference-engine">绘图引擎</label>
              <StudioSelect id="inference-engine" v-model="draft.engine" label="绘图引擎" :options="engineOptions" :disabled="blocked || saving || loading || setupBusy || snapshot.environmentOverrides.includes('engine')" />
            </div>
            <div v-if="draft.engine === 'remote'" class="inference-field">
              <label for="inference-remote-url">远程绘遇地址</label>
              <input id="inference-remote-url" v-model.trim="draft.remoteUrl" class="input input-mono" type="url" name="remoteUrl" required placeholder="http://100.x.x.x:3211" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="blocked || saving || loading || setupBusy || restarting" />
            </div>
            <label v-if="draft.engine === 'native'" class="inference-remote-toggle"><input v-model="draft.remoteServe" type="checkbox" :disabled="blocked || saving || loading || setupBusy" />允许其他绘遇连接本机绘图</label>
            <div v-if="draft.engine === 'native' && draft.remoteServe" class="inference-field">
              <label for="inference-remote-port">本机监听端口</label>
              <input id="inference-remote-port" v-model.number="draft.remotePort" class="input input-mono" type="number" min="1" max="65535" :disabled="blocked || saving || loading || setupBusy" />
            </div>
            <div v-if="draft.engine === 'remote' || draft.remoteServe" class="inference-field inference-paths">
              <label for="inference-remote-key">连接密钥（64 位十六进制）</label>
              <input id="inference-remote-key" v-model.trim="draft.remoteKey" class="input input-mono" :type="showRemoteKey ? 'text' : 'password'" name="remoteKey" required minlength="64" maxlength="64" pattern="[0-9A-Fa-f]{64}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="inference-remote-key-hint" :disabled="blocked || saving || loading || setupBusy || restarting" />
              <small id="inference-remote-key-hint">两端共用 · 建议经 Tailscale 等私网连接</small>
              <div class="inference-actions"><button class="btn btn-quiet btn-sm" type="button" @click="showRemoteKey = !showRemoteKey">{{ showRemoteKey ? '隐藏密钥' : '显示密钥' }}</button><button v-if="draft.remoteServe" class="btn btn-quiet btn-sm" type="button" :disabled="blocked || saving || loading || setupBusy" @click="generateRemoteKey">生成密钥</button></div>
            </div>
            <p v-if="draft.engine === 'remote'" class="inference-paths">远端出图 · 成图存回本机</p>
            <div class="inference-actions">
              <button v-if="remoteRestart && desktop?.restartForSetup && !dirty" class="btn btn-primary btn-sm" type="button" :disabled="blocked || loading || setupBusy || restarting" @click="restartSetup">{{ restarting ? '正在重启…' : '重启并检查远端' }}</button>
              <button v-else class="btn btn-primary btn-sm" type="submit" :disabled="blocked || saving || loading || setupBusy || restarting || !dirty">{{ saving ? '保存中…' : draft.engine === 'remote' ? '保存远程连接' : '保存设置' }}</button>
              <span v-if="dirty">保存后重启生效</span>
              <button v-if="draft.engine === 'remote' && !showLocalPreparation" class="btn btn-quiet btn-sm" type="button" :disabled="saving || restarting" @click="openLocalPreparation">准备本机模型</button>
            </div>
          </form>
        </details>
        <details class="inference-advanced" :open="advancedOpen" @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open">
          <StudioDisclosureSummary><span>复用已有资源与高级设置</span></StudioDisclosureSummary>
          <div data-disclosure-content>
          <button class="btn btn-quiet btn-sm" type="button" :disabled="blocked || loading || saving || setupBusy" @click="refresh">重新检查已有资源</button>
        <div v-if="discovery" class="inference-reuse" aria-labelledby="inference-reuse-title">
          <h3 id="inference-reuse-title">复用本机资源</h3>
          <p>{{ discovery.modelCount }} 个图像底模 · {{ discovery.loraCount }} 个 LoRA</p>
          <p v-if="discovery.missing.length">尚缺：{{ discovery.missing.join('、') }}</p>
          <div class="inference-actions">
            <button class="btn btn-primary btn-sm" type="button" :disabled="blocked || loading || saving || setupBusy || dirty || !discovery.canAdopt || !adoptionChanges" @click="adoptSettings">{{ saving ? '保存中…' : !discovery.canAdopt ? '资源待补齐' : adoptionChanges ? '采用并启用' : '已采用' }}</button>
            <span v-if="dirty">请先保存当前修改</span>
          </div>
          <details class="inference-selected-paths">
            <StudioDisclosureSummary>资源路径</StudioDisclosureSummary>
            <div data-disclosure-content>
            <dl><template v-for="field in pathFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ discovery.suggested[field.key] }}</dd></template></dl>
            <p v-if="discovery.runtimeReceipt">运行库安装记录：{{ discovery.runtimeReceipt }}</p>
            </div>
          </details>
        </div>
        <form class="inference-form" @submit.prevent="saveSettings">
          <div class="inference-field">
            <label for="inference-acceleration">Anima 加速模式</label>
            <StudioSelect id="inference-acceleration" v-model="draft.acceleration" label="Anima 加速模式" :options="accelerationOptions" :disabled="blocked || saving || loading || setupBusy || snapshot.environmentOverrides.includes('acceleration')" />
            <small v-if="draft.acceleration !== 'native'">需要 SageAttention 运行库。</small>
          </div>
          <div class="inference-field">
            <label for="inference-memory">Anima 显存策略</label>
            <StudioSelect id="inference-memory" v-model="draft.memoryPolicy" label="Anima 显存策略" :options="animaMemoryOptions" :disabled="blocked || saving || loading || setupBusy || snapshot.environmentOverrides.includes('memoryPolicy')" aria-describedby="inference-memory-hint" />
            <small id="inference-memory-hint">{{ memoryHints[draft.memoryPolicy] }}</small>
          </div>
          <div class="inference-field">
            <label for="inference-adapter-memory">其他模型显存策略</label>
            <StudioSelect id="inference-adapter-memory" v-model="draft.adapterMemoryPolicy" label="其他原生模型显存策略" :options="memoryOptions" :disabled="blocked || saving || loading || setupBusy || snapshot.environmentOverrides.includes('adapterMemoryPolicy')" aria-describedby="inference-adapter-memory-hint" />
            <small id="inference-adapter-memory-hint">Krea · Qwen · MOSS · 视频模型</small>
          </div>
          <details class="inference-paths" :open="advancedPathsOpen" @toggle="advancedPathsOpen = ($event.target as HTMLDetailsElement).open">
            <StudioDisclosureSummary id="inference-paths-summary">高级路径设置（本机绝对路径）</StudioDisclosureSummary>
            <div data-disclosure-content>
            <div class="inference-path-grid">
              <div v-for="field in pathFields" :key="field.key" class="inference-field">
                <label :for="`inference-${field.key}`">{{ field.label }}</label>
                <input :id="`inference-${field.key}`" v-model="draft[field.key]" class="input" type="text" :disabled="blocked || saving || loading || setupBusy || snapshot.environmentOverrides.includes(field.key)" spellcheck="false" autocomplete="off" :aria-describedby="`inference-${field.key}-hint`" />
                <small :id="`inference-${field.key}-hint`">{{ field.hint }}</small>
              </div>
            <div class="inference-field inference-paths">
              <label for="inference-adapter-python">适配器 Python（可选）</label>
              <input id="inference-adapter-python" v-model="draft.adapterPython" class="input" type="text" :disabled="blocked || saving || loading || setupBusy || snapshot.environmentOverrides.includes('adapterPython')" spellcheck="false" autocomplete="off" aria-describedby="inference-adapter-python-hint" />
              <small id="inference-adapter-python-hint">含图像/视频适配器依赖的独立解释器</small>
            </div>
            </div>
            </div>
          </details>
          <div class="inference-actions">
            <button class="btn btn-primary btn-sm" type="submit" :disabled="blocked || saving || loading || setupBusy || !dirty">{{ saving ? '保存中…' : '保存设置' }}</button>
            <span v-if="dirty">保存后重启生效</span>
          </div>
        </form>
        <details class="inference-diagnostics" :open="diagnosticsOpen" @toggle="diagnosticsOpen = ($event.target as HTMLDetailsElement).open">
          <StudioDisclosureSummary>检查结果</StudioDisclosureSummary>
          <div data-disclosure-content>
          <template v-if="diagnostics">
            <p>已保存的路径{{ dirty ? '（不含未保存修改）' : '' }}</p>
            <p v-if="diagnostics.configuration !== 'valid'" role="alert">{{ diagnostics.message }}</p>
            <ul><li v-for="field in pathFields" :key="field.key">{{ field.label }}：{{ diagnostics.files[field.key] ? '已找到' : '未找到' }}</li></ul>
          </template>
          <p v-else>设置已更新，请重新检查。</p>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="probing" @click="diagnose">{{ probing ? '检查中…' : '检查 Anima 依赖与设备' }}</button>
          <p v-if="probeError" role="alert">{{ probeError }}</p>
          <div v-if="probe" role="status">
            <p>当前运行环境 · {{ deviceLabel }}</p>
            <ul><li v-for="(version, name) in probe.probe.dependencies" :key="name">{{ name }}：{{ version }}</li></ul>
          </div>
          </div>
        </details>
        <details class="inference-capabilities">
          <StudioDisclosureSummary>支持范围</StudioDisclosureSummary>
          <div data-disclosure-content>
            <ul>
              <li>Anima：文生图 · 图生图 · 局部重绘 · 高清修复 · 放大（需完整 Diffusers 目录）</li>
              <li>Krea 2 / Qwen：独立原生运行库与完整目录</li>
              <li>暂未接入：SDXL · DoRA</li>
            </ul>
          </div>
        </details>
        </div>
        </details>
      </template>
      <p v-else-if="loading" role="status">正在读取已保存的推理设置…</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { videoReturnLocation } from '@/utils/videoNavigation'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import AvailableDrawingModels from '@/components/control/AvailableDrawingModels.vue'
import MuseRelayConnection from '@/components/control/MuseRelayConnection.vue'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { copyText } from '@/utils/clipboard'
const loadInferenceSetup = () => import('./InferenceSetupPanel.vue')
import type { PreparedInferencePaths } from '@/api/inferenceSetupApi'
import { useInferenceSettings } from '@/composables/useInferenceSettings'
const { isLocal, draft, snapshot, diagnostics, discovery, adoptionChanges, adopt, loading, saving, error, notice, dirty, refresh, save, probe, probing, probeError, diagnose } = useInferenceSettings()
const props = defineProps<{ blocked: boolean; settingsRevision: number }>()
const route = useRoute()
const videoSetupRequested = computed(() => route.query.videoSetup === '1')
const videoReturnTarget = computed(() => videoReturnLocation(route.query))
const emit = defineEmits<{ busy: [value: boolean]; configured: []; ready: [] }>()
const setupBusy = ref(false), setupWorking = ref(false)
const remoteDetails = ref<HTMLDetailsElement | null>(null)
const desktop = getDesktopCapabilities()
const showLocalPreparation = ref(route.hash === '#control-inference'), restarting = ref(false)
const remoteRestart = computed(() => snapshot.value?.restartRequired && snapshot.value.configured.engine === 'remote')
const videoRestart = computed(() => snapshot.value?.active.videoEngine !== snapshot.value?.configured.videoEngine)
const showLocalSetup = computed(() => !!snapshot.value && (videoSetupRequested.value || draft.engine !== 'remote' || showLocalPreparation.value))
const showAvailableModels = computed(() => {
  const current = snapshot.value
  if (!current || current.restartRequired || dirty.value || videoSetupRequested.value) return false
  return current.active.engine === 'native' || current.active.engine === 'remote' && !showLocalPreparation.value
})
const localPreparationVisited = ref(false)
watch(showLocalSetup, visible => { if (visible) localPreparationVisited.value = true }, { immediate: true })
const remoteForwardCommand = computed(() => {
  const port = snapshot.value?.active.remotePort
  return port ? `tailscale serve --bg --tcp=${port} tcp://127.0.0.1:${port}` : ''
})
watch([setupWorking, saving, restarting], values => emit('busy', values.some(Boolean)), { immediate: true })
let openedRemote = ''
watch([() => route.hash, remoteDetails, snapshot], ([hash, details, settings]) => {
  if (hash !== '#control-remote') {
    openedRemote = ''
    if (hash === '#control-inference') showLocalPreparation.value = true
    return
  }
  if (!details || !settings || openedRemote === route.fullPath) return
  openedRemote = route.fullPath
  details.open = true
  showLocalPreparation.value = false
  if (!dirty.value && !setupWorking.value && !settings.environmentOverrides.includes('engine')) {
    if (settings.configured.remoteServe) draft.remoteKey = ''
    draft.engine = 'remote'
  }
}, { immediate: true })
watch([remoteDetails, remoteRestart], ([details, pending]) => { if (details && pending) details.open = true })
function openLocalPreparation() {
  const configured = snapshot.value?.configured
  if (configured && draft.engine === 'remote' && configured.engine !== 'remote' && !remoteRestart.value) {
    Object.assign(draft, { engine: configured.engine, remoteServe: configured.remoteServe, remoteUrl: configured.remoteUrl, remoteKey: configured.remoteKey })
  }
  showLocalPreparation.value = true
}
async function restartSetup() {
  if (!desktop?.restartForSetup || props.blocked || setupBusy.value || restarting.value || !(remoteRestart.value || videoRestart.value) || dirty.value) return
  restarting.value = true; error.value = ''
  try {
    await flushProfileWrites()
    await desktop.restartForSetup()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '重启未完成，请退出后重新打开绘遇'
  } finally { restarting.value = false }
}
watch(() => props.settingsRevision, () => { void refresh() })
async function saveSettings() {
  if (props.blocked || setupBusy.value) return
  await save()
  if (!error.value) emit('configured')
}
async function adoptSettings() {
  if (props.blocked || setupBusy.value) return
  await adopt()
  if (!error.value) emit('configured')
}
function activated() { void refresh(); emit('configured') }
const advancedOpen = ref(false)
const advancedPathsOpen = ref(false)
const diagnosticsOpen = ref(false)
async function openVideoPaths() {
  advancedOpen.value = true
  advancedPathsOpen.value = true
  await nextTick()
  const field = document.querySelector<HTMLElement>('#inference-modelsRoot:not(:disabled), #inference-adapter-python:not(:disabled)')
    || document.getElementById('inference-paths-summary')
  field?.scrollIntoView({ block: 'center', behavior: 'instant' })
  field?.focus({ preventScroll: true })
}
const localSettingsDirty = computed(() => !!snapshot.value && (['acceleration', 'memoryPolicy', 'adapterMemoryPolicy', 'modelsRoot', 'lorasRoot', 'python', 'adapterPython', 'worker'] as const).some(key => draft[key] !== snapshot.value!.configured[key]))
// Request state may reveal an issue, but must not close a surface the user opened.
watch([localSettingsDirty, advancedPathsOpen], ([changed, pathsOpen]) => { if (changed || pathsOpen) advancedOpen.value = true })
watch([() => diagnostics.value?.configuration === 'invalid', probeError], ([invalid, failure]) => {
  if (invalid || failure) diagnosticsOpen.value = true
})
function retrySettings(event: MouseEvent) {
  // The initial error button disappears while reading; retain a visible focus stop.
  (event.currentTarget as HTMLElement).closest('section')?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  void refresh()
}
function fillPreparedPaths(paths: PreparedInferencePaths) {
  for (const key of ['python', 'worker', 'modelsRoot', 'lorasRoot'] as const) draft[key] = paths[key]
  advancedPathsOpen.value = true
  advancedOpen.value = true
  notice.value = '已填入路径草稿。请确认引擎选择后保存，再重启运行时；当前运行与已保存配置未改变。'
}
const showRemoteKey = ref(false)
function generateRemoteKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  draft.remoteKey = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  showRemoteKey.value = true
}
watch(() => draft.engine, engine => { if (engine !== 'native') draft.remoteServe = false })
const engineOptions = [{ value: 'native', label: '本机原生引擎' }, { value: 'remote', label: '远程绘遇原生引擎' }, { value: 'comfy', label: 'ComfyUI（兼容已有环境）' }]
const videoEngineOptions = [{ value: 'native', label: '本机原生引擎' }, { value: 'comfy', label: 'ComfyUI' }]
const accelerationOptions = [{ value: 'native', label: '原生计算' }, { value: 'sage', label: 'SageAttention' }, { value: 'compiled-sage', label: '编译 + SageAttention' }, { value: 'compiled-fused-sage', label: '编译 + SageAttention + LoRA 融合' }]
const memoryOptions = [{ value: 'resident', label: '模型常驻显卡（连续生成优先）' }, { value: 'offload', label: '分阶段加载（减少显存占用）' }]
const animaMemoryOptions = [{ value: 'auto', label: '自动（按设备选择）' }, ...memoryOptions]
const memoryHints = {
  auto: '共享显存、Intel XPU 和可用显存较少的 AMD 设备优先分阶段加载。',
  offload: '减少显存占用，在内存与显卡间调度。',
  resident: '模型驻留显卡，连续生成优先。',
}
const deviceLabel = computed(() => {
  const value = probe.value?.probe
  const backend = value?.backend ?? (value?.cudaAvailable ? 'cuda' : undefined)
  if (!backend) return '未发现可用显卡'
  const label = { cuda: 'NVIDIA CUDA', rocm: 'AMD ROCm', xpu: 'Intel XPU' }[backend]
  return `${label} · ${value?.deviceName || '设备名称未知'}`
})
const engineLabel = (engine: string) => engine === 'native' ? '本机原生' : engine === 'remote' ? '远程原生' : 'ComfyUI'
const pathFields = [
  { key: 'modelsRoot', label: '模型根目录', hint: '可以沿用已有模型根目录，不搬移文件。目录格式：模型根目录 / 模型 ID / 完整 Diffusers 组件；不是原始单文件权重目录。' },
  { key: 'lorasRoot', label: 'LoRA 目录', hint: '可以直接使用现有 LoRA 目录（包括 ComfyUI），不复制或搬移；兼容性由实际加载校验。' },
  { key: 'python', label: 'Python 可执行文件', hint: '已准备推理依赖的 Python 绝对路径。' },
  { key: 'worker', label: '推理 Worker 文件', hint: '绘遇独立推理 Worker 脚本的绝对路径。' },
] as const
onMounted(async () => { await refresh(); emit('ready') })
</script>

<style scoped>
.inference-settings { color: var(--text-primary); container-type: inline-size; }
.inference-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-3); padding-bottom:var(--s-4); border-bottom:1px solid var(--border-soft); }
.inference-heading h2 { margin:0; font-size:var(--fs-title-sm); }
.inference-disclosure-hint { display:block; margin-top:var(--s-1); color:var(--text-secondary); font-size:var(--fs-label-xs); font-weight:400; }
.inference-active { font-size: var(--fs-label-sm); color: var(--text-secondary); }
.inference-connection { margin-block-start:var(--s-3); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); }
.inference-connection p { margin:0; }
.inference-connection p + .inference-actions { margin-block-start:var(--s-2); }
.inference-address { display:grid; gap:var(--s-1); min-inline-size:0; }
.inference-address code { color:var(--text-primary); font-family:var(--font-mono); overflow-wrap:anywhere; }
.inference-video-help { margin-top:var(--s-4); padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-md); }
.inference-video-help h3 { margin:0; }
.inference-advanced { margin-top: var(--s-4); border-top: 1px solid var(--border-soft); padding-top: var(--s-2); }
.inference-remote { margin-top: var(--s-4); border-top: 1px solid var(--border-soft); padding-top: var(--s-2); }
.inference-remote-toggle { display:flex; align-items:center; gap:var(--s-2); color:var(--text-primary); }
.inference-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-3); }
.inference-settings p, .inference-settings li { color: var(--text-secondary); line-height: var(--lh-loose); overflow-wrap: anywhere; }
.inference-form, .inference-path-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); }
.inference-field { display: grid; align-content: start; gap: var(--s-2); min-width: 0; }
.inference-field label { color: var(--text-primary); }
.inference-field input { width:100%; min-width:0; }
.inference-field small { color: var(--text-secondary); line-height: var(--lh-body); }
.inference-paths, .inference-actions { grid-column: 1 / -1; }
.inference-actions { justify-content: flex-start; color: var(--text-secondary); }
.inference-diagnostics, .inference-capabilities { margin-top: var(--s-5); padding-top: var(--s-4); border-top: 1px solid var(--border-soft); }
summary { cursor: pointer; min-height: 44px; align-content: center; color: var(--text-primary); }
.inference-reuse { border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: var(--s-4); margin: var(--s-4) 0; }
.inference-reuse h3 { margin: 0; }
.inference-settings .btn { flex-shrink: 0; white-space: nowrap; }
.inference-selected-paths dd { margin: 0 0 var(--s-3); overflow-wrap: anywhere; color: var(--text-secondary); }
.inference-selected-paths dt { color: var(--text-primary); }
.inference-settings .inference-error { color: var(--text-primary); padding: var(--s-3); border: 1px solid var(--border-soft); }
@container (max-width: 640px) { .inference-form, .inference-path-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
