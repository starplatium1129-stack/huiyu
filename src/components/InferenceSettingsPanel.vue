<template>
  <details id="control-inference" class="panel-card inference-settings">
    <StudioDisclosureSummary><span id="inference-settings-title">其他绘图引擎 · 原生 Anima</span>
      <span v-if="snapshot" class="inference-active">当前引擎 · {{ engineLabel(snapshot.active.engine) }}</span>
    </StudioDisclosureSummary>
    <div data-disclosure-content>
    <p v-if="!isLocal">请在运行绘遇的电脑上修改引擎设置。</p>
    <template v-else>
      <p v-if="error" role="alert" class="inference-error">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="snapshot">
        <p v-if="snapshot.restartRequired" role="status">新设置将在重启后生效。</p>
        <p v-if="snapshot.environmentOverrides.length">{{ snapshot.environmentOverrides.join('、') }} 由启动配置指定，请在启动配置中修改。</p>
        <p v-if="dirty">请先保存引擎设置的修改，再继续原生准备。</p>
        <InferenceSetupPanel :configured="snapshot.configured" :blocked="loading || saving || dirty" @prepared="fillPreparedPaths" @busy="setupBusy = $event" @activated="refresh" />
        <details class="inference-advanced" :open="dirty || advancedPathsOpen">
          <StudioDisclosureSummary>已有资源与高级设置</StudioDisclosureSummary>
          <button class="btn btn-quiet btn-sm" type="button" :disabled="loading || saving || setupBusy" @click="refresh">重新检查已有资源</button>
        <div v-if="discovery" class="inference-reuse" aria-labelledby="inference-reuse-title">
          <h3 id="inference-reuse-title">复用本机资源</h3>
          <p>{{ discovery.modelCount }} 个 Anima 底模 · {{ discovery.loraCount }} 个角色 LoRA</p>
          <p v-if="discovery.missing.length">尚缺：{{ discovery.missing.join('、') }}</p>
          <div class="inference-actions">
            <button class="btn btn-primary btn-sm" type="button" :disabled="loading || saving || setupBusy || dirty || !discovery.canAdopt || !adoptionChanges" @click="adopt">{{ saving ? '保存中…' : !discovery.canAdopt ? '资源待补齐' : adoptionChanges ? '采用并启用' : '已采用' }}</button>
            <span v-if="dirty">请先保存当前修改</span>
          </div>
          <details class="inference-selected-paths">
            <summary>资源路径</summary>
            <dl><template v-for="field in pathFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ discovery.suggested[field.key] }}</dd></template></dl>
            <p v-if="discovery.runtimeReceipt">运行库安装记录：{{ discovery.runtimeReceipt }}</p>
          </details>
        </div>
        <form class="inference-form" @submit.prevent="save">
          <div class="inference-field">
            <label for="inference-engine">Anima 绘图引擎</label>
            <StudioSelect id="inference-engine" v-model="draft.engine" label="Anima 绘图引擎" :options="engineOptions" :disabled="saving || loading || setupBusy" />
          </div>
          <div class="inference-field">
            <label for="inference-acceleration">独立引擎加速模式</label>
            <StudioSelect id="inference-acceleration" v-model="draft.acceleration" label="独立引擎加速模式" :options="accelerationOptions" :disabled="saving || loading || setupBusy" />
            <small v-if="draft.acceleration !== 'native'">需要 SageAttention 运行库。</small>
          </div>
          <div class="inference-field">
            <label for="inference-memory">独立引擎显存策略</label>
            <StudioSelect id="inference-memory" v-model="draft.memoryPolicy" label="独立引擎显存策略" :options="memoryOptions" :disabled="saving || loading || setupBusy" />
            <small>{{ draft.memoryPolicy === 'offload' ? '减少显存占用，生成时需要在内存与显卡间传输模型。' : '模型保留在显卡中，适合连续生成。' }}</small>
          </div>
          <details class="inference-paths" :open="advancedPathsOpen">
            <summary>高级路径设置</summary>
            <p>填写运行绘遇的电脑上的绝对路径。</p>
            <div class="inference-path-grid">
              <div v-for="field in pathFields" :key="field.key" class="inference-field">
                <label :for="`inference-${field.key}`">{{ field.label }}</label>
                <input :id="`inference-${field.key}`" v-model="draft[field.key]" type="text" :disabled="saving || loading || setupBusy || snapshot.environmentOverrides.includes(field.key)" spellcheck="false" autocomplete="off" :aria-describedby="`inference-${field.key}-hint`" />
                <small :id="`inference-${field.key}-hint`">{{ field.hint }}</small>
              </div>
            </div>
          </details>
          <div class="inference-actions">
            <button class="btn btn-primary btn-sm" type="submit" :disabled="saving || loading || setupBusy || !dirty">{{ saving ? '保存中…' : '保存设置' }}</button>
            <span v-if="dirty">保存后重启绘遇生效</span>
          </div>
        </form>
        <details class="inference-diagnostics" :open="diagnostics?.configuration === 'invalid' || !!probeError">
          <summary>检查结果</summary>
          <template v-if="diagnostics">
            <p>已保存的路径{{ dirty ? '（不含未保存修改）' : '' }}</p>
            <p v-if="diagnostics.configuration !== 'valid'" role="alert">{{ diagnostics.message }}</p>
            <ul><li v-for="field in pathFields" :key="field.key">{{ field.label }}：{{ diagnostics.files[field.key] ? '已找到' : '未找到' }}</li></ul>
          </template>
          <p v-else>设置已更新，请重新检查。</p>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="probing" @click="diagnose">{{ probing ? '检查中…' : '检查依赖与设备' }}</button>
          <p v-if="probeError" role="alert">{{ probeError }}</p>
          <div v-if="probe" role="status">
            <p>当前运行环境 · {{ probe.probe.cudaAvailable ? `CUDA 可用：${probe.probe.deviceName || '设备名称未知'}` : 'CUDA 不可用' }}</p>
            <ul><li v-for="(version, name) in probe.probe.dependencies" :key="name">{{ name }}：{{ version }}</li></ul>
          </div>
        </details>
        <details class="inference-capabilities">
          <summary>支持范围</summary>
          <div>
            <p>支持 Anima 绘图、图生图、蒙版重绘、高清修复与放大。模型需使用完整 Diffusers 目录。</p>
            <p>Krea、SDXL 与 DoRA 请使用对应的其他后端。</p>
          </div>
        </details>
        </details>
      </template>
      <p v-else-if="loading" role="status">正在读取已保存的推理设置…</p>
    </template>
    </div>
  </details>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onMounted, ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
const InferenceSetupPanel = defineAsyncComponent(() => import('./InferenceSetupPanel.vue'))
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
const engineLabel = (engine: string) => engine === 'native' ? '原生' : 'ComfyUI'
const pathFields = [
  { key: 'modelsRoot', label: '模型根目录', hint: '可以沿用已有模型根目录，不搬移文件。目录格式：模型根目录 / 模型 ID / 完整 Diffusers 组件；不是原始单文件权重目录。' },
  { key: 'lorasRoot', label: 'LoRA 目录', hint: '可以直接使用现有 LoRA 目录（包括 ComfyUI），不复制或搬移；兼容性由实际加载校验。' },
  { key: 'python', label: 'Python 可执行文件', hint: '已准备推理依赖的 Python 绝对路径。' },
  { key: 'worker', label: '推理 Worker 文件', hint: '绘遇独立推理 Worker 脚本的绝对路径。' },
] as const
onMounted(refresh)
</script>

<style scoped>
.inference-settings { margin-bottom: var(--s-5); color: var(--text-primary); }
.inference-active { font-size: var(--fs-label-sm); color: var(--text-secondary); }
.inference-advanced { margin-top: var(--s-4); border-top: 1px solid var(--border-soft); padding-top: var(--s-2); }
.inference-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-3); }
.inference-settings p, .inference-settings li { color: var(--text-secondary); line-height: var(--lh-loose); overflow-wrap: anywhere; }
.inference-form, .inference-path-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); }
.inference-field { display: grid; align-content: start; gap: var(--s-2); min-width: 0; }
.inference-field label { color: var(--text-primary); }
.inference-field input { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: var(--s-3); background: var(--bg-surface); color: var(--text-primary); font: inherit; }
.inference-field input:focus-visible, summary:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.inference-field input:disabled { color: var(--text-disabled); }
.inference-field small { color: var(--text-secondary); line-height: var(--lh-body); }
.inference-paths, .inference-actions { grid-column: 1 / -1; }
.inference-actions { justify-content: flex-start; color: var(--text-secondary); }
.inference-diagnostics, .inference-capabilities { margin-top: var(--s-5); padding-top: var(--s-4); border-top: 1px solid var(--border-soft); }
summary { cursor: pointer; min-height: 44px; align-content: center; color: var(--text-primary); }
.inference-reuse { border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: var(--s-4); margin: var(--s-4) 0; }
.inference-reuse h3 { margin: 0; }
.inference-settings .btn { flex-shrink: 0; white-space: nowrap; }
.inference-selected-paths dd { margin: 0 0 var(--s-3); overflow-wrap: anywhere; color: var(--text-secondary); }
.inference-selected-paths dt { color: var(--text-primary); }
.inference-settings .inference-error { color: var(--text-primary); padding: var(--s-3); border: 1px solid var(--border-soft); }
@media (max-width: 760px) { .inference-form, .inference-path-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
