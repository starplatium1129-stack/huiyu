<template>
  <section id="control-inference" class="panel-card inference-settings" aria-labelledby="inference-settings-title">
    <div class="inference-heading">
      <div><span class="panel-kicker">本机推理</span><h2 id="inference-settings-title" class="panel-heading">绘图引擎设置</h2></div>
      <button v-if="isLocal" class="btn btn-ghost btn-sm" type="button" :disabled="loading || saving || setupBusy" @click="refresh">{{ loading ? '检查中…' : '检查配置与文件' }}</button>
    </div>
    <p v-if="!isLocal">请在运行绘遇的本机打开此页，查看和修改推理路径。</p>
    <template v-else>
      <p>选择 Anima 的推理后端。独立引擎直接使用本地 Python 与模型；保存设置不会安装依赖或下载模型。</p>
      <p v-if="error" role="alert" class="inference-error">{{ error }}。输入仍保留，可修改后重试。</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="snapshot">
        <p class="inference-active">当前运行：{{ engineLabel(snapshot.active.engine) }}<span v-if="snapshot.restartRequired"> · 已保存的设置需重启运行时生效</span></p>
        <p v-if="snapshot.environmentOverrides.length">启动环境变量覆盖：{{ snapshot.environmentOverrides.join('、') }}。冲突设置无法保存，请先修改启动配置。</p>
        <form class="inference-form" @submit.prevent="save">
          <div class="inference-field">
            <label for="inference-engine">Anima 绘图引擎</label>
            <StudioSelect id="inference-engine" v-model="draft.engine" label="Anima 绘图引擎" :options="engineOptions" :disabled="saving || loading || setupBusy" />
          </div>
          <p class="inference-scope">以下为独立引擎路径，均填写运行绘遇的电脑上的绝对路径。模型根目录下以模型 ID 建立完整 Diffusers 模型目录，包含模型索引、transformer、文本编码器、VAE 与 tokenizer 等组件。</p>
          <div v-for="field in pathFields" :key="field.key" class="inference-field">
            <label :for="`inference-${field.key}`">{{ field.label }}</label>
            <input :id="`inference-${field.key}`" v-model="draft[field.key]" type="text" :disabled="saving || loading || setupBusy" spellcheck="false" autocomplete="off" required :aria-describedby="`inference-${field.key}-hint`" />
            <small :id="`inference-${field.key}-hint`">{{ field.hint }}</small>
          </div>
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
            <p>已实现：Anima 文生图、无遮罩图生图、本地兼容 LoRA（transformer / text_conditioner）。实际模型兼容性仍需设备验收。原始 MiaoMiao 权重仍需转换为完整 Diffusers 模型目录，尚未完成转换验收。</p>
            <p>实验候选：手绘或本地 CLIPSeg 蒙版重绘与合成；TeaCache 默认关闭，需要所选模型目录内的 teacache-profile.json 校准档，文件存在仅表示可尝试加载。模型、LoRA 与本次采样的匹配由 Worker 核验，速度与画质尚未验收。</p>
            <p>暂不支持：高清修复与放大器、RCAS、Krea、SDXL、DoRA 及不兼容的 LoRA 格式。请为这些功能使用对应的其他后端。</p>
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
const { isLocal, draft, snapshot, diagnostics, loading, saving, error, notice, dirty, refresh, save, probe, probing, probeError, diagnose } = useInferenceSettings()
const setupBusy = ref(false)
function fillPreparedPaths(paths: PreparedInferencePaths) {
  Object.assign(draft, paths)
  notice.value = '已填入路径草稿。请确认引擎选择后保存，再重启运行时；当前运行与已保存配置未改变。'
}
const engineOptions = [{ value: 'comfy', label: 'ComfyUI' }, { value: 'native', label: '独立引擎（Native Anima）' }]
const engineLabel = (engine: string) => engine === 'native' ? '独立引擎（Native Anima）' : 'ComfyUI'
const pathFields = [
  { key: 'modelsRoot', label: '模型根目录', hint: '目录格式：模型根目录 / 模型 ID / 完整 Diffusers 组件；不是 ComfyUI 的原始权重目录。' },
  { key: 'lorasRoot', label: 'LoRA 目录', hint: '独立的 LoRA 文件目录；兼容性由实际加载校验。' },
  { key: 'python', label: 'Python 可执行文件', hint: '已准备推理依赖的 Python 绝对路径。' },
  { key: 'worker', label: '推理 Worker 文件', hint: '绘遇独立推理 Worker 脚本的绝对路径。' },
] as const
onMounted(refresh)
</script>

<style scoped>
.inference-settings { margin-bottom: var(--s-5); color: var(--text-primary); }
.inference-heading, .inference-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-3); }
.inference-settings p, .inference-settings li { color: var(--text-secondary); line-height: var(--lh-loose); overflow-wrap: anywhere; }
.inference-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); }
.inference-field { display: grid; align-content: start; gap: var(--s-2); min-width: 0; }
.inference-field label { color: var(--text-primary); }
.inference-field input { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: var(--s-3); background: var(--bg-surface); color: var(--text-primary); font: inherit; }
.inference-field input:focus-visible, .inference-capabilities summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.inference-field input:disabled { color: var(--text-disabled); }
.inference-field small { color: var(--text-secondary); line-height: var(--lh-body); }
.inference-scope, .inference-actions { grid-column: 1 / -1; }
.inference-actions { justify-content: flex-start; color: var(--text-secondary); }
.inference-diagnostics, .inference-capabilities { margin-top: var(--s-5); padding-top: var(--s-4); border-top: 1px solid var(--border-soft); }
.inference-capabilities summary { cursor: pointer; min-height: 44px; align-content: center; }
.inference-settings .inference-error { color: var(--text-primary); padding: var(--s-3); border: 1px solid var(--border-soft); }
@media (max-width: 760px) { .inference-form { grid-template-columns: minmax(0, 1fr); } }
</style>
