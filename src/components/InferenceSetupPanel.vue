<template>
  <details class="inference-setup" :open="!!operation || !!error">
    <summary>离线准备独立运行库与导入模型</summary>
    <div class="setup-content">
      <p>所有路径均指运行绘遇的电脑。此入口仅使用已有可信 Python、本地 wheelhouse 与完整模型目录，不联网下载。离开此页不会取消后台操作。</p>
      <section aria-labelledby="native-runtime-title">
        <h3 id="native-runtime-title">1. 准备离线运行库</h3>
        <p>在当前 AI 工作区的 inference 目录创建新的独立环境，不覆盖已有环境。请先准备与本机系统、Python 和设备匹配的全部离线 wheel；安装失败的文件保留供核对。</p>
        <div class="setup-fields">
          <div class="setup-field">
            <label for="native-base-python">可信基础 Python 可执行文件</label>
            <input id="native-base-python" v-model="basePython" :disabled="locked" type="text" spellcheck="false" autocomplete="off" />
          </div>
          <div class="setup-field">
            <label for="native-wheelhouse">可信离线 wheelhouse 目录</label>
            <input id="native-wheelhouse" v-model="wheelhouse" :disabled="locked" type="text" spellcheck="false" autocomplete="off" />
          </div>
          <div class="setup-field">
            <label for="native-workspace">当前 AI 工作区绝对路径</label>
            <input id="native-workspace" v-model="workspacePath" :disabled="locked" type="text" spellcheck="false" autocomplete="off" aria-describedby="native-workspace-hint" />
            <small id="native-workspace-hint">需与当前运行时的 AI 工作区一致，可在下方路径与详细检查中查看；目标固定为该目录下的 inference。</small>
          </div>
        </div>
        <label class="setup-consent"><input v-model="runtimeReviewed" type="checkbox" :disabled="locked" />我信任所填 Python 与本地 wheel 来源，已核对其许可，同意执行 Python 并离线安装到新的独立环境。</label>
        <div class="setup-actions">
          <button class="btn btn-primary btn-sm" type="button" :disabled="!canPrepare" @click="prepare">准备离线运行库</button>
          <button v-if="preparedPaths" class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="fillSettings">填入设置</button>
        </div>
        <p v-if="preparedPaths">运行库已准备。点“填入设置”仅更新上方路径草稿；请选择所需引擎，再保存并重启运行时。</p>
      </section>
      <section aria-labelledby="native-import-title">
        <h3 id="native-import-title">2. 导入完整 Anima 模型目录</h3>
        <p>使用已保存的 Python 与模型根目录：{{ configured.modelsRoot }}。上方未保存的路径不参与检查；准备新运行库后请先填入并保存设置。</p>
        <p>仅接收包含 model_index.json、transformer、文本编码器、VAE 和 tokenizer 等配套的完整 Diffusers 目录。单个原始 .safetensors 文件需按<a href="/docs/guides/independent-inference.md" target="_blank" rel="noopener noreferrer">离线转换指南（新窗口）</a>先核验架构并转换；此入口不执行转换。</p>
        <div class="setup-fields">
          <div class="setup-field">
            <label for="native-import-model">模型对应的 Anima 型号</label>
            <StudioSelect id="native-import-model" v-model="modelId" label="模型对应的 Anima 型号" :options="inferenceImportModels" :disabled="locked" />
          </div>
          <div class="setup-field">
            <label for="native-import-source">完整 Diffusers 来源目录</label>
            <input id="native-import-source" v-model="sourceDir" :disabled="locked" type="text" spellcheck="false" autocomplete="off" />
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="!canInspect" @click="inspect">{{ inspecting ? '检查目录中…' : '只读检查复制计划' }}</button>
        <div v-if="inspection" class="setup-plan" aria-label="模型复制计划">
          <p>来源：{{ inspection.sourceDir }}</p><p>目标：{{ inspection.targetDir }}</p>
          <p>{{ inspection.fileCount }} 个文件 · {{ formatSetupBytes(inspection.totalBytes) }}。将复制到全新目标，不移动来源、不覆盖已有目录。复制前会重新检查。</p>
          <p>检查范围仅为目录布局（layout-only），未加载权重，未验证模型兼容性、GPU 或真实出图。</p>
          <label class="setup-consent"><input v-model="importReviewed" type="checkbox" :disabled="locked" />我已核对来源、模型许可、目标和磁盘空间，同意复制这份完整模型目录。</label>
          <button class="btn btn-primary btn-sm" type="button" :disabled="!canImport" @click="importModel">复制模型目录</button>
        </div>
      </section>
      <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
      <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
      <div class="setup-actions">
        <button v-if="operation?.status === 'running'" class="btn btn-ghost btn-sm" type="button" :disabled="!canCancel" @click="cancel">{{ cancelState === 'pending' ? '正在请求取消…' : cancelState === 'accepted' ? '等待取消结果…' : '取消当前操作' }}</button>
        <button v-if="operationUncertain" class="btn btn-ghost btn-sm" type="button" :disabled="checking" @click="reconcile">{{ checking ? '核对状态中…' : '重新核对后台状态' }}</button>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { useInferenceSetup } from '@/composables/useInferenceSetup'
import { inferenceImportModels, type PreparedInferencePaths } from '@/api/inferenceSetupApi'
import type { InferenceSettings } from '@/api/inferenceSettingsApi'
import { formatSetupBytes } from '@/utils/localSetupPreparation'
const props = defineProps<{ configured: InferenceSettings; blocked: boolean }>()
const emit = defineEmits<{ prepared: [paths: PreparedInferencePaths]; busy: [value: boolean] }>()
const { basePython, wheelhouse, workspacePath, runtimeReviewed, modelId, sourceDir, importReviewed, inspection, inspecting, preparedPaths,
  operation, busy, checking, locked, canPrepare, canInspect, canImport, canCancel, message, error, cancelState, operationUncertain,
  prepare, inspect, importModel, cancel, reconcile } = useInferenceSetup(computed(() => props.configured), computed(() => props.blocked))
function fillSettings() { if (preparedPaths.value && !locked.value) emit('prepared', { ...preparedPaths.value }) }
watch([busy, checking, inspecting, operationUncertain], () => emit('busy', busy.value || checking.value || inspecting.value || operationUncertain.value), { immediate: true })
onMounted(reconcile)
</script>

<style scoped>
.inference-setup { margin-top: var(--s-5); border-top: 1px solid var(--border-soft); padding-top: var(--s-4); }
summary { min-height: 44px; align-content: center; cursor: pointer; color: var(--text-primary); }
.setup-content { display: grid; gap: var(--s-4); }
.setup-content p, .setup-field small { color: var(--text-secondary); line-height: var(--lh-loose); overflow-wrap: anywhere; }
.setup-content h3, .setup-field label, .setup-consent { color: var(--text-primary); }
.setup-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); margin-bottom: var(--s-3); }
.setup-field { display: grid; align-content: start; gap: var(--s-2); min-width: 0; }
.setup-field input { box-sizing: border-box; width: 100%; min-width: 0; padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text-primary); font: inherit; }
input:disabled, button:disabled { color: var(--text-disabled); }
input:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.setup-consent { display: flex; align-items: flex-start; gap: var(--s-2); margin: var(--s-3) 0; line-height: var(--lh-loose); }
.setup-consent input { flex-shrink: 0; margin-top: var(--s-2); accent-color: var(--accent); }
.setup-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-3); }
.setup-plan, .setup-error { padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--radius-md); }
.setup-content .setup-error { color: var(--text-primary); }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 760px) { .setup-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
