<template>
  <section id="control-inference" class="panel-card inference-settings" aria-labelledby="inference-settings-title">
    <div class="inference-heading">
      <div><span class="panel-kicker">本机推理</span><h2 id="inference-settings-title" class="panel-heading">绘图引擎设置</h2></div>
      <button v-if="isLocal" class="btn btn-ghost btn-sm" type="button" :disabled="loading || saving || setupBusy" @click="refresh">{{ loading ? '检查中…' : '检查配置与文件' }}</button>
    </div>
    <p v-if="!isLocal">请在运行绘遇的本机打开此页，查看和修改推理路径。</p>
    <template v-else>
      <p>已有的运行库、Anima 模型和角色 LoRA 可以直接复用。选择引擎后保存，重启绘遇生效。</p>
      <p v-if="error" role="alert" class="inference-error">{{ error }}。输入仍保留，可修改后重试。</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="snapshot">
        <p class="inference-active">当前运行：{{ engineLabel(snapshot.active.engine) }}<span v-if="snapshot.restartRequired"> · 已保存的设置需重启运行时生效</span></p>
        <p v-if="snapshot.environmentOverrides.length">启动环境变量覆盖：{{ snapshot.environmentOverrides.join('、') }}。冲突设置无法保存，请先修改启动配置。</p>
        <div v-if="discovery" class="inference-reuse" aria-labelledby="inference-reuse-title">
          <h3 id="inference-reuse-title">复用本机资源</h3>
          <p>发现 {{ discovery.modelCount }} 个已转换的 Anima 底模、{{ discovery.loraCount }} 个角色 LoRA。</p>
          <p v-if="discovery.missing.length">尚缺：{{ discovery.missing.join('、') }}。可展开下方高级路径或离线准备入口补齐。</p>
          <p v-else>现有文件可以直接采用，无需重新安装或复制模型。</p>
          <div class="inference-actions">
            <button class="btn btn-primary btn-sm" type="button" :disabled="loading || saving || setupBusy || dirty || !discovery.canAdopt || !adoptionChanges" @click="adopt">{{ saving ? '保存中…' : !discovery.canAdopt ? '等待资源就绪' : adoptionChanges ? '复用并启用独立引擎' : '已采用当前资源' }}</button>
            <span v-if="dirty">请先保存手动修改，再采用资源。</span>
          </div>
          <details class="inference-selected-paths">
            <summary>查看将采用的路径</summary>
            <dl><template v-for="field in pathFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ discovery.suggested[field.key] }}</dd></template></dl>
            <p v-if="discovery.runtimeReceipt">运行库安装记录：{{ discovery.runtimeReceipt }}</p>
            <p v-if="discovery.preservesSavedSettings">保留已保存的路径与性能选项；需要更换时可在高级设置中修改。</p>
          </details>
          <p class="inference-discovery-note">此处检查本地文件与安装记录；当前依赖和设备可在下方检查。</p>
        </div>
        <form class="inference-form" @submit.prevent="save">
          <div class="inference-field">
            <label for="inference-engine">Anima 绘图引擎</label>
            <StudioSelect id="inference-engine" v-model="draft.engine" label="Anima 绘图引擎" :options="engineOptions" :disabled="saving || loading || setupBusy" />
          </div>
          <div class="inference-field">
            <label for="inference-acceleration">独立引擎加速模式</label>
            <StudioSelect id="inference-acceleration" v-model="draft.acceleration" label="独立引擎加速模式" :options="accelerationOptions" :disabled="saving || loading || setupBusy" />
            <small>Sage 模式需匹配本机运行库与显卡；连续生成可使用编译与 LoRA 融合。</small>
          </div>
          <div class="inference-field">
            <label for="inference-memory">独立引擎显存策略</label>
            <StudioSelect id="inference-memory" v-model="draft.memoryPolicy" label="独立引擎显存策略" :options="memoryOptions" :disabled="saving || loading || setupBusy" />
            <small>分阶段将暂不用的模型移到内存，减少同时占用的显存；会增加传输时间，也不保证任意尺寸均能运行。保存后重启生效。</small>
          </div>
          <details class="inference-paths" :open="advancedPathsOpen">
            <summary>高级设置：手动指定路径</summary>
            <p>填写运行绘遇的电脑上的绝对路径；已有配置和启动环境覆盖始终优先。</p>
            <div class="inference-path-grid">
              <div v-for="field in pathFields" :key="field.key" class="inference-field">
                <label :for="`inference-${field.key}`">{{ field.label }}</label>
                <input :id="`inference-${field.key}`" v-model="draft[field.key]" type="text" :disabled="saving || loading || setupBusy || snapshot.environmentOverrides.includes(field.key)" spellcheck="false" autocomplete="off" :aria-describedby="`inference-${field.key}-hint`" />
                <small :id="`inference-${field.key}-hint`">{{ field.hint }}</small>
              </div>
            </div>
          </details>
          <div class="inference-actions">
            <button class="btn btn-primary btn-sm" type="submit" :disabled="saving || loading || setupBusy || !dirty">{{ saving ? '保存中…' : '保存引擎设置' }}</button>
            <span v-if="dirty">有未保存的修改</span>
          </div>
        </form>
        <InferenceSetupPanel :configured="snapshot.configured" :blocked="loading || saving" @prepared="fillPreparedPaths" @busy="setupBusy = $event" />
        <div class="inference-diagnostics" aria-label="独立引擎诊断">
          <h3>准备状态</h3>
          <template v-if="diagnostics">
            <p>检查对象：已保存、下次启动使用的路径{{ dirty ? '（不含未保存修改）' : '' }}。</p>
            <p>配置：{{ diagnostics.configuration === 'valid' ? '格式有效' : '无效，请修正' }}。{{ diagnostics.message }}</p>
            <ul><li v-for="field in pathFields" :key="field.key">{{ field.label }}：{{ diagnostics.files[field.key] ? '文件或目录存在' : '未找到' }}</li></ul>
          </template>
          <p v-else>设置已更新，请点击“检查配置与文件”刷新路径证据。</p>
          <p>文件存在不代表依赖可用、模型完整或能够生成。</p>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="probing" @click="diagnose">{{ probing ? '检查依赖中…' : '检查当前运行时依赖与设备' }}</button>
          <p>使用当前运行时的 Python 和 Worker，仅导入依赖与检查 CUDA；不加载模型、不生成图片。</p>
          <p v-if="probeError" role="alert">{{ probeError }}</p>
          <div v-if="probe" role="status">
            <p>依赖检查通过 · {{ probe.probe.cudaAvailable ? `CUDA 可用：${probe.probe.deviceName || '设备名称未知'}` : 'CUDA 不可用' }} · 真实出图未验证</p>
            <ul><li v-for="(version, name) in probe.probe.dependencies" :key="name">{{ name }}：{{ version }}</li></ul>
          </div>
          <p v-else>依赖{{ probing ? '检查中' : '尚未确认' }} · GPU 与真实出图未验证。</p>
        </div>
        <details class="inference-capabilities">
          <summary>独立引擎支持范围与限制</summary>
          <div>
            <p>已实现：Anima 文生图、图生图、本地兼容 LoRA、手绘或 CLIPSeg 蒙版重绘、高清修复、Remacri 放大与 RCAS。原始权重需转换为完整 Diffusers 模型目录。</p>
            <p>TeaCache 默认使用内置 Anima 策略（阈值 0.1），无需为每个模型或角色另行准备校准档；可在生成参数中关闭。速度与画面仍以实际生成结果为准。</p>
            <p>暂不支持：Krea、SDXL、DoRA 及不兼容的 LoRA 格式。请为这些功能使用对应的其他后端。</p>
          </div>
        </details>
      </template>
      <p v-else-if="loading" role="status">正在读取已保存的推理设置…</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import InferenceSetupPanel from './InferenceSetupPanel.vue'
import type { PreparedInferencePaths } from '@/api/inferenceSetupApi'
import { useInferenceSettings } from '@/composables/useInferenceSettings'
const { isLocal, draft, snapshot, diagnostics, discovery, adoptionChanges, adopt, loading, saving, error, notice, dirty, refresh, save, probe, probing, probeError, diagnose } = useInferenceSettings()
const setupBusy = ref(false)
const advancedPathsOpen = ref(false)
function fillPreparedPaths(paths: PreparedInferencePaths) {
  for (const key of ['python', 'worker', 'modelsRoot', 'lorasRoot'] as const) draft[key] = paths[key]
  advancedPathsOpen.value = true
  notice.value = '已填入路径草稿。请确认引擎选择后保存，再重启运行时；当前运行与已保存配置未改变。'
}
const engineOptions = [{ value: 'comfy', label: 'ComfyUI' }, { value: 'native', label: '独立引擎（Native Anima）' }]
const accelerationOptions = [{ value: 'native', label: '原生计算' }, { value: 'sage', label: 'SageAttention' }, { value: 'compiled-sage', label: '编译 + SageAttention' }, { value: 'compiled-fused-sage', label: '编译 + SageAttention + LoRA 融合' }]
const memoryOptions = [{ value: 'resident', label: '模型常驻显卡（连续生成优先）' }, { value: 'offload', label: '分阶段加载（减少显存占用）' }]
const engineLabel = (engine: string) => engine === 'native' ? '独立引擎（Native Anima）' : 'ComfyUI'
const pathFields = [
  { key: 'modelsRoot', label: '模型根目录', hint: '目录格式：模型根目录 / 模型 ID / 完整 Diffusers 组件；不是 ComfyUI 的原始权重目录。' },
  { key: 'lorasRoot', label: 'LoRA 目录', hint: '可以直接使用现有 ComfyUI 的 LoRA 目录，无需复制；兼容性由实际加载校验。' },
  { key: 'python', label: 'Python 可执行文件', hint: '已准备推理依赖的 Python 绝对路径。' },
  { key: 'worker', label: '推理 Worker 文件', hint: '绘遇独立推理 Worker 脚本的绝对路径。' },
] as const
onMounted(refresh)
</script>

<style scoped>
.inference-settings { margin-bottom: var(--s-5); color: var(--text-primary); }
.inference-heading, .inference-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-3); }
.inference-settings p, .inference-settings li { color: var(--text-secondary); line-height: var(--lh-loose); overflow-wrap: anywhere; }
.inference-form, .inference-path-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); }
.inference-field { display: grid; align-content: start; gap: var(--s-2); min-width: 0; }
.inference-field label { color: var(--text-primary); }
.inference-field input { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: var(--s-3); background: var(--bg-surface); color: var(--text-primary); font: inherit; }
.inference-field input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.inference-field input:disabled { color: var(--text-disabled); }
.inference-field small { color: var(--text-secondary); line-height: var(--lh-body); }
.inference-paths, .inference-actions { grid-column: 1 / -1; }
.inference-actions { justify-content: flex-start; color: var(--text-secondary); }
.inference-diagnostics, .inference-capabilities { margin-top: var(--s-5); padding-top: var(--s-4); border-top: 1px solid var(--border-soft); }
summary { cursor: pointer; min-height: 44px; align-content: center; color: var(--text-primary); }
.inference-reuse { border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: var(--s-4); margin: var(--s-4) 0; }
.inference-reuse h3 { margin: 0; }
.inference-reuse .inference-discovery-note { font-size: var(--fs-body-sm); }
.inference-selected-paths dd { margin: 0 0 var(--s-3); overflow-wrap: anywhere; color: var(--text-secondary); }
.inference-selected-paths dt { color: var(--text-primary); }
.inference-settings .inference-error { color: var(--text-primary); padding: var(--s-3); border: 1px solid var(--border-soft); }
@media (max-width: 760px) { .inference-form, .inference-path-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
