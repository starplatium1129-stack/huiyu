<template>
  <div class="setup-automation">
    <h3>准备模型与环境</h3>
    <p v-if="automation.externalEnvironment.value" class="setup-device" role="status">保留现有环境，仅准备模型文件。请沿用原入口启动，并核对模型目录。</p>
    <p v-if="automation.drawing.value && !automation.externalEnvironment.value && snapshot.comfy.connection === 'online' && (snapshot.nodes.state !== 'checked' || snapshot.nodes.missing.length > 0)" class="setup-device" role="status" data-testid="setup-node-restart-guidance">节点待确认；补装前请结束生成并停止 ComfyUI，完成后重新启动检查。</p>
    <p class="setup-device">自动安装适用于 Windows + NVIDIA。</p>
    <div class="setup-fields">
      <label><input v-model="automation.drawing.value" type="checkbox" :disabled="automation.busy.value">准备 Anima 绘图</label>
      <div v-if="automation.drawing.value">
        <label for="setup-image-model">绘图底模</label>
        <StudioSelect id="setup-image-model" v-model="automation.modelId.value" label="绘图底模" :disabled="automation.busy.value" :options="imageOptions" />
        <p>{{ selectedImage?.purpose }}</p>
        <label><input v-model="automation.loras.value" type="checkbox" :disabled="automation.busy.value">同时准备宁宁与夏目 LoRA</label>
        <p v-if="!automation.loras.value">绘制宁宁与夏目需要对应 LoRA。</p>
      </div>
      <details class="setup-chat">
        <StudioDisclosureSummary>本地聊天（可选）</StudioDisclosureSummary>
        <div data-disclosure-content class="setup-chat-options">
        <p class="setup-device"><strong>{{ automation.recommendation.value.label }}</strong> · {{ automation.recommendation.value.note }}</p>
        <label for="setup-chat-model">聊天方式</label>
        <StudioSelect id="setup-chat-model" v-model="automation.chatId.value" label="聊天方式" :disabled="automation.busy.value" :options="chatOptions" />
        <p v-if="selectedChat">{{ selectedChat.purpose }}</p>
        <RouterLink v-if="!automation.chatId.value" to="/chat" class="btn btn-ghost btn-sm">配置聊天 API</RouterLink>
        </div>
      </details>
    </div>
    <p v-if="!automation.hasSelection.value" role="status">请选择绘图或聊天模型。</p>
    <details v-if="!automation.busy.value"><StudioDisclosureSummary>运行方式与下载清单</StudioDisclosureSummary><div data-disclosure-content class="setup-runtime-details">
      <template v-if="automation.drawing.value && !automation.externalEnvironment.value && snapshot.comfy.layout !== 'venv'">
        <label for="setup-comfy-runtime">{{ snapshot.comfy.installation === 'present' ? '已有 Portable 版本' : '绘图环境' }}</label>
        <StudioSelect id="setup-comfy-runtime" v-model="automation.environment.value" label="绘图环境" placeholder="选择运行包" :options="[{value:'comfy-nvidia',label:'NVIDIA RTX · CUDA 13.0 Portable'},{value:'comfy-cu126',label:'较旧 NVIDIA · CUDA 12.6 Portable'}]" />
      </template>
      <p v-if="automation.drawing.value && snapshot.comfy.installation === 'present' && snapshot.comfy.layout === 'venv'">沿用现有 venv，仅准备节点依赖与模型。</p>
      <p v-if="automation.drawing.value && snapshot.comfy.installation === 'present' && snapshot.comfy.layout === 'portable'">选择与现有环境一致的版本，保留已安装的 Python 与 CUDA。</p>
      <template v-if="automation.chatId.value">
        <label for="setup-llama-runtime">聊天运行环境</label>
        <StudioSelect id="setup-llama-runtime" v-model="automation.llamaEnvironment.value" label="聊天运行环境" :options="[{value:'llama-cuda',label:'NVIDIA · CUDA'},{value:'llama-vulkan',label:'Vulkan · 进阶候选'}]" />
      </template>
      <ul><li v-for="model in automation.plan.value" :key="model.id"><strong>{{ model.label }}</strong> · {{ formatBytes(model.preparation!.expectedBytes) }}<br><a :href="model.preparation!.modelCardUrl" target="_blank" rel="noopener noreferrer">来源说明</a> · <a :href="model.preparation!.licenseUrl" target="_blank" rel="noopener noreferrer">使用条件</a></li></ul>
    </div></details>
    <p class="setup-download-size">预计下载 {{ formatBytes(automation.downloadBytes.value) }}；解压需要额外空间。</p>
    <label class="setup-review"><input v-model="automation.reviewed.value" type="checkbox" :disabled="automation.busy.value">已确认磁盘空间、下载清单与使用条件，同意下载并准备</label>
    <p v-if="automation.environmentRequired.value" role="status">请先选择与已有环境一致的运行包，或启动现有环境检查。</p>
    <p v-if="workspaceBlocked" role="status">请先确认工作区；更换目录后需重启绘遇。</p>
    <p v-if="statusConfirmed === false && !workspaceBlocked && !automation.busy.value" role="status">请先重新检查，再开始准备。</p>
    <div class="setup-buttons">
      <button class="btn btn-primary" type="button" :disabled="automation.busy.value||statusConfirmed===false||workspaceBlocked||automation.environmentRequired.value||!automation.reviewed.value||!automation.hasSelection.value" @click="automation.run"><ArchiveIcon name="download" />{{ automation.busy.value?'正在准备…':automation.error.value?'重试准备':'开始准备' }}</button>
      <button v-if="automation.canStartExisting.value" class="btn btn-ghost" type="button" :disabled="automation.busy.value||statusConfirmed===false||workspaceBlocked" @click="automation.startExisting">启动现有环境</button>
      <button v-if="automation.busy.value" class="btn btn-ghost" type="button" :disabled="automation.recoveryPending.value||automation.cancelState.value==='pending'||automation.cancelState.value==='accepted'" @click="automation.cancel">{{ automation.cancelState.value==='pending'?'取消中…':automation.cancelState.value==='accepted'?'等待步骤结束…':automation.cancelState.value==='failed'?'重试取消':'取消准备' }}</button>
      <button v-if="automation.operationUncertain.value" class="btn btn-ghost" type="button" @click="automation.retryOperation">重新检查状态</button>
    </div>
    <p v-if="automation.busy.value && automation.stage.value" class="setup-stage" role="status">当前步骤：{{ stageLabels[automation.stage.value] }}</p>
    <p v-if="automation.message.value" role="status" aria-live="polite">{{ automation.message.value }}</p>
    <p v-if="automation.download.activeId.value" role="status">{{ formatBytes(automation.download.bytesRead.value) }} / {{ formatBytes(automation.download.expectedBytes.value) }}</p>
    <p v-if="automation.error.value" class="setup-error" role="alert">{{ automation.error.value }}</p>
    <div v-if="automation.completed.value" class="setup-buttons"><RouterLink v-if="automation.drawing.value" class="btn btn-primary" :to="{path:'/prompt-builder',query:{preparedModel:automation.modelId.value}}">生成第一张图片</RouterLink><RouterLink v-if="automation.chatId.value" class="btn btn-ghost" to="/chat">进入角色房间</RouterLink></div>
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
const stageLabels={environment:'1 / 4 · 准备运行环境',models:'2 / 4 · 下载并校验模型',service:'3 / 4 · 启动绘图服务',validation:'4 / 4 · 确认可生成的基础条件'}
const props=defineProps<{snapshot:LocalSetupResponse;workspaceBlocked:boolean;statusConfirmed:boolean}>()
const emit=defineEmits<{refresh:[];'download-result':[result:LocalSetupDownloadResult];'model-selected':[modelId:string]}>()
const automation=useLocalSetupAutomation(toRef(props,'snapshot'),toRef(props,'workspaceBlocked'),result=>emit('download-result',result),()=>emit('refresh'),computed(()=>props.statusConfirmed!==false))
watch(automation.modelId,model=>emit('model-selected',model),{immediate:true})
const imageOptions=computed(()=>automation.imageModels.value.map(model=>({value:model.id,label:model.label})).sort((a,b)=>rank(a.value)-rank(b.value)))
const rank=(id:string)=>id==='anima-miaomiao-v1.6'?0:id==='anima-base-v1.0'?1:id==='anima-aesthetic-v1.1'?2:3
const selectedImage=computed(()=>automation.imageModels.value.find(model=>model.id===automation.modelId.value))
const selectedChat=computed(()=>automation.chatModels.value.find(model=>model.id===automation.chatId.value))
const chatOptions=computed(()=>[{value:'',label:'暂不准备本地聊天'},...automation.chatModels.value.map(model=>({value:model.id,label:model.label+' · '+formatBytes(model.preparation!.expectedBytes)}))])
</script>
<style scoped>
.setup-automation{display:grid;gap:var(--s-3);margin-block:var(--s-4)}
.setup-automation h3,.setup-automation p{margin:0}
.setup-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s-4)}
.setup-fields>label{grid-column:1/-1}
.setup-fields>div,.setup-chat-options{display:grid;gap:var(--s-2);align-content:start;min-width:0}
.setup-chat{min-width:0;align-content:start}
.setup-fields label,.setup-review{display:flex;gap:var(--s-2);align-items:flex-start;line-height:var(--lh-body)}
.setup-fields label input,.setup-review input{flex-shrink:0;margin-top:.3em}
.setup-automation details{display:grid;gap:var(--s-2)}
.setup-runtime-details{display:grid;gap:var(--s-2)}
.setup-buttons{display:flex;flex-wrap:wrap;gap:var(--s-2)}
.setup-buttons .btn{flex-shrink:0;white-space:nowrap}
.setup-error{color:var(--danger-text)}
.setup-device,.setup-download-size{color:var(--text-secondary);line-height:var(--lh-body)}
.setup-stage{color:var(--text-primary);font-weight:600}
.setup-automation button:disabled{color:var(--text-disabled);opacity:1;cursor:not-allowed}
.setup-automation :is(button,input,a,summary):focus-visible{outline:2px solid var(--text-primary);outline-offset:3px}
@media(max-width:900px){.setup-fields{grid-template-columns:1fr}}
</style>
