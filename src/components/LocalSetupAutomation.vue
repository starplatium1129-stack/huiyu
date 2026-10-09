<template>
  <div class="setup-automation">
    <h3>让绘遇为你准备</h3>
    <p>选好能力与磁盘后，一次准备运行环境、模型和角色 LoRA。已有文件会校验复用。</p>
    <p class="setup-device"><strong>{{ automation.recommendation.value.label }}</strong> · {{ automation.recommendation.value.note }}</p>
    <p v-for="device in snapshot.hardware.devices" :key="device.name">{{ device.name }} · {{ device.vramBytes===null?'显存未知':formatBytes(device.vramBytes) }} 标称显存</p>
    <div class="setup-fields">
      <label><input v-model="automation.drawing.value" type="checkbox" :disabled="automation.busy.value">准备 Anima 绘图</label>
      <div v-if="automation.drawing.value">
        <label for="setup-image-model">绘图底模</label>
        <StudioSelect id="setup-image-model" v-model="automation.modelId.value" label="绘图底模" :disabled="automation.busy.value" :options="imageOptions" />
        <p>{{ selectedImage?.purpose }}</p>
        <label><input v-model="automation.loras.value" type="checkbox" :disabled="automation.busy.value">同时准备宁宁与夏目 LoRA · 由绘遇作者亲自训练</label>
      </div>
      <div>
        <label for="setup-chat-model">聊天方式</label>
        <StudioSelect id="setup-chat-model" v-model="automation.chatId.value" label="聊天方式" :disabled="automation.busy.value" :options="chatOptions" />
        <p v-if="selectedChat">{{ selectedChat.purpose }}</p>
        <p>显存较少可使用 API。候选分档不是最低运行要求；绘图与聊天会按需释放显存。</p>
        <RouterLink v-if="!automation.chatId.value" to="/chat" class="btn btn-ghost btn-sm">在角色房间填写 API Key</RouterLink>
      </div>
    </div>
    <details v-if="!automation.busy.value"><StudioDisclosureSummary>运行方式与下载清单</StudioDisclosureSummary><div data-disclosure-content class="setup-runtime-details">
      <label for="setup-comfy-runtime">绘图环境</label>
      <StudioSelect id="setup-comfy-runtime" v-model="automation.environment.value" label="绘图环境" :options="[{value:'comfy-nvidia',label:'NVIDIA RTX · CUDA 13.0 Portable'},{value:'comfy-cu126',label:'较旧 NVIDIA · CUDA 12.6 Portable'}]" />
      <label for="setup-llama-runtime">聊天运行环境</label>
      <StudioSelect id="setup-llama-runtime" v-model="automation.llamaEnvironment.value" label="聊天运行环境" :options="[{value:'llama-cuda',label:'NVIDIA · CUDA'},{value:'llama-vulkan',label:'Vulkan · 进阶候选'}]" />
      <ul><li v-for="model in automation.plan.value" :key="model.id"><strong>{{ model.label }}</strong> · {{ formatBytes(model.preparation!.expectedBytes) }}<br><a :href="model.preparation!.modelCardUrl" target="_blank" rel="noopener noreferrer">来源说明</a> · <a :href="model.preparation!.licenseUrl" target="_blank" rel="noopener noreferrer">使用条件</a></li></ul>
      <p>驱动、系统授权／重启和网站登录仍可能需要你操作。外部管理的已有环境保留，不能运行时会提示具体缺项。</p>
    </div></details>
    <p class="setup-download-size">待下载约 {{ formatBytes(automation.downloadBytes.value) }}，解压与作品还需要额外磁盘空间。</p>
    <label class="setup-review"><input v-model="automation.reviewed.value" type="checkbox" :disabled="automation.busy.value">我已确认当前磁盘、推荐组合与使用条件，同意绘遇下载并准备所选能力</label>
    <p v-if="workspaceBlocked" role="status">工作区尚未生效或未确认，请先选择磁盘并按提示重启绘遇。</p>
    <div class="setup-buttons">
      <button class="btn btn-primary" type="button" :disabled="automation.busy.value||workspaceBlocked||!automation.reviewed.value" @click="automation.run"><ArchiveIcon name="download" />{{ automation.busy.value?'正在准备…':'一键准备所选能力' }}</button>
      <button v-if="automation.busy.value" class="btn btn-ghost" type="button" :disabled="automation.cancelState.value==='pending'||automation.cancelState.value==='accepted'" @click="automation.cancel">{{ automation.cancelState.value==='pending'?'正在请求取消…':automation.cancelState.value==='accepted'?'等待当前步骤结束…':automation.cancelState.value==='failed'?'重试取消':'取消准备' }}</button>
      <button v-if="automation.operationUncertain.value" class="btn btn-ghost" type="button" @click="automation.retryOperation">重新检查状态</button>
    </div>
    <p v-if="automation.message.value" role="status" aria-live="polite">{{ automation.message.value }}</p>
    <p v-if="automation.download.activeId.value" role="status">{{ formatBytes(automation.download.bytesRead.value) }} / {{ formatBytes(automation.download.expectedBytes.value) }}</p>
    <p v-if="automation.error.value" class="setup-error" role="alert">{{ automation.error.value }}</p>
    <div v-if="automation.completed.value" class="setup-buttons"><RouterLink v-if="automation.drawing.value" class="btn btn-primary" to="/prompt-builder">生成第一张图片</RouterLink><RouterLink class="btn btn-ghost" to="/chat">进入角色房间</RouterLink></div>
  </div>
</template>
<script setup lang="ts">
import { computed, toRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { LocalSetupResponse,LocalSetupDownloadResult } from '../../types/local-setup'
import StudioSelect from './ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { useLocalSetupAutomation } from '../composables/useLocalSetupAutomation'
import { formatSetupBytes as formatBytes } from '../utils/localSetupPreparation'
const props=defineProps<{snapshot:LocalSetupResponse;workspaceBlocked:boolean}>()
const emit=defineEmits<{refresh:[];'download-result':[result:LocalSetupDownloadResult];'model-selected':[modelId:string]}>()
const automation=useLocalSetupAutomation(toRef(props,'snapshot'),toRef(props,'workspaceBlocked'),result=>emit('download-result',result),()=>emit('refresh'))
watch(automation.modelId,model=>emit('model-selected',model))
const imageOptions=computed(()=>automation.imageModels.value.map(model=>({value:model.id,label:model.label})).sort((a,b)=>rank(a.value)-rank(b.value)))
const rank=(id:string)=>id==='anima-miaomiao-v1.6'?0:id==='anima-base-v1.0'?1:id==='anima-aesthetic-v1.1'?2:3
const selectedImage=computed(()=>automation.imageModels.value.find(model=>model.id===automation.modelId.value))
const selectedChat=computed(()=>automation.chatModels.value.find(model=>model.id===automation.chatId.value))
const chatOptions=computed(()=>[{value:'',label:'API 聊天 · 不下载本地权重'},...automation.chatModels.value.map(model=>({value:model.id,label:model.label+' · '+formatBytes(model.preparation!.expectedBytes)}))])
</script>
<style scoped>
.setup-automation{display:grid;gap:var(--s-3);margin-block:var(--s-4)}
.setup-automation h3,.setup-automation p{margin:0}
.setup-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s-4)}
.setup-fields>label{grid-column:1/-1}
.setup-fields>div{display:grid;gap:var(--s-2);align-content:start;min-width:0}
.setup-fields label,.setup-review{display:flex;gap:var(--s-2);align-items:center}
.setup-automation details{display:grid;gap:var(--s-2)}
.setup-runtime-details{display:grid;gap:var(--s-2)}
.setup-buttons{display:flex;flex-wrap:wrap;gap:var(--s-2)}
.setup-error{color:var(--danger-text)}
@media(max-width:900px){.setup-fields{grid-template-columns:1fr}}
</style>
