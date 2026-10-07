import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import type { LocalSetupModel, LocalSetupResponse, LocalSetupDownloadResult } from '../../types/local-setup'
import type { ControlActionResult } from '../types/api'
import { localSetupApi } from '../api/localSetupApi'
import { controlApi } from '../api/controlApi'
import { waitLocalSetupOperation } from '../api/localSetupOperation'
import { useLocalSetupDownload } from './useLocalSetupDownload'
import { localChatRecommendation } from '../utils/localChatRecommendation'
import { modelPreparationState } from '../utils/localSetupPreparation'
import { useChatStorage } from './chat/useChatStorage'
import { settingsRepository, DRAW_ENGINE_SETTING, STARTER_MODEL_SETTING } from '../storage/settingsRepository'

export function useLocalSetupAutomation(snapshot: Ref<LocalSetupResponse>, blocked: Ref<boolean>, onResult:(result:LocalSetupDownloadResult)=>void, refresh:()=>void) {
  const modelId=ref(snapshot.value.recommendedModel??snapshot.value.models.find(model=>model.required&&model.id.startsWith('anima-'))?.id??'anima-miaomiao-v1.6'),chatId=ref(''), drawing=ref(true), loras=ref(true), reviewed=ref(false)
  const environment=ref('comfy-nvidia'),llamaEnvironment=ref('llama-cuda')
  const busy=ref(false),message=ref(''),error=ref(''),completed=ref(false)
  const recommendation=computed(()=>localChatRecommendation(snapshot.value.hardware))
  const imageModels=computed(()=>snapshot.value.models.filter(model=>model.id.startsWith('anima-')&&model.preparation))
  const chatModels=computed(()=>snapshot.value.models.filter(model=>model.kind==='chat'))
  const workspace=computed(()=>snapshot.value.workspace.path)
  const ready=computed(()=>reviewed.value&&!blocked.value)
  const download=useLocalSetupDownload(workspace,ready,onResult)
  const chatStorage=useChatStorage(cause=>{error.value=cause})
  const hasComfy=computed(()=>snapshot.value.comfy.installation==='present')
  let disposed=false,cancelled=false,activeOperation='',operationKind=''
  let cancelRequest:Promise<unknown>|null=null
  let initialized=false
  watch(recommendation,value=>{if(!initialized){
    chatId.value=value.modelId
    if(!hasComfy.value&&!snapshot.value.hardware.devices.some(device=>device.type==='cuda'&&/nvidia|geforce/i.test(device.name)))drawing.value=false
    initialized=true
  }}, {immediate:true})
  watch([modelId,chatId,drawing,loras,environment,llamaEnvironment,workspace],()=>{reviewed.value=false;completed.value=false})
  const needsComfyPreparation=computed(()=>!hasComfy.value||snapshot.value.nodes.state!=='checked'||snapshot.value.nodes.missing.length>0)
  function requireModel(id:string):LocalSetupModel {
    const model=snapshot.value.models.find(model=>model.id===id&&model.preparation)
    if(!model) throw new Error('准备清单缺少 '+id+'，请重新检查')
    return model
  }
  const runtimeIds=computed(()=>{
    const ids:string[]=[]
    if(drawing.value&&needsComfyPreparation.value){
      if(!hasComfy.value) ids.push('runtime-'+environment.value)
      ids.push('runtime-kjnodes','runtime-anima-teacache')
    }
    if(chatId.value&&!snapshot.value.chat?.runtimePresent){
      ids.push('runtime-'+llamaEnvironment.value)
      if(llamaEnvironment.value==='llama-cuda')ids.push('runtime-llama-cudart')
    }
    return ids
  })
  const weightIds=computed(()=>[
    ...(drawing.value?[modelId.value,'qwen-encoder','qwen-vae']:[]),
    ...(drawing.value&&loras.value?['L_NENE_V21_ANIMA','L_NAT_V21_ANIMA']:[]),
    ...(chatId.value?[chatId.value]:[]),
  ])
  const plan=computed(()=>[...runtimeIds.value,...weightIds.value].map(id=>requireModel(id)))
  const downloadBytes=computed(()=>plan.value.filter(model=>modelPreparationState(model)!=='bytes-match').reduce((sum,model)=>sum+(model.preparation?.expectedBytes??0),0))
  function checkpoint(){if(disposed||cancelled)throw new Error('准备已停止；已完成文件保留')}
  async function fetchFile(id:string){
    checkpoint()
    const model=requireModel(id)
    message.value='正在准备 '+model.label
    await download.download(model)
    checkpoint()
    if(download.failed.value[id])throw new Error(download.notices.value[id]||'下载未完成')
  }
  async function waitOperation(result:ControlActionResult,kind:string){
    const id=result.operation?.id
    if(!id)throw new Error('准备操作尚未确认，请重新检查控制室')
    activeOperation=id;operationKind=kind
    try{
      // Cancellation can precede the server acknowledgement that gives us an operation ID.
      if(cancelled)await cancel()
      checkpoint()
      await waitLocalSetupOperation(result,{timeoutMs:60*60*1000,onMessage:value=>{checkpoint();message.value=value}})
      checkpoint()
    }finally{activeOperation='';operationKind=''}
  }
  async function run(){
    if(busy.value||!ready.value||(!drawing.value&&!chatId.value))return
    busy.value=true;cancelled=false;cancelRequest=null;completed.value=false;error.value=''
    const runtime=[...runtimeIds.value],weights=[...weightIds.value],prepareComfy=drawing.value&&needsComfyPreparation.value
    const prepareLlama=!!chatId.value&&!snapshot.value.chat?.runtimePresent,selectedChat=chatId.value,confirmedWorkspace=workspace.value
    try{
      for(const id of runtime)await fetchFile(id)
      if(prepareComfy)await waitOperation(await localSetupApi.prepareEnvironment(environment.value,confirmedWorkspace),'environment')
      if(prepareLlama)await waitOperation(await localSetupApi.prepareEnvironment(llamaEnvironment.value,confirmedWorkspace),'environment')
      for(const id of weights)await fetchFile(id)
      if(drawing.value){
        await waitOperation(await controlApi.serviceAction('comfy','start'),'service')
        const checked=await localSetupApi.getStatus({modelId:modelId.value})
        checkpoint()
        if(checked.nodes.state!=='checked'||checked.nodes.missing.length)throw new Error('绘图节点仍有缺项：'+(checked.nodes.missing.join('、')||'尚未确认，请重新检查'))
        settingsRepository.set(DRAW_ENGINE_SETTING,'anima')
        settingsRepository.set(STARTER_MODEL_SETTING,modelId.value)
      }
      if(selectedChat){
        checkpoint()
        const result=await localSetupApi.startLlama(selectedChat,confirmedWorkspace)
        await waitOperation(result,'llama')
        checkpoint()
        await chatStorage.load()
        checkpoint()
        await chatStorage.setApiSettings({baseUrl:result.baseUrl,model:result.model,apiKey:''})
        checkpoint()
        chatStorage.setProvider('api')
      }
      checkpoint()
      completed.value=true
      message.value='环境与文件已准备。接下来生成一张全龄图片或发送一条短消息，确认本机实际效果。'
      refresh()
    }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'准备未完成，请重试'}
    finally{if(!disposed)busy.value=false}
  }
  async function cancel(){
    cancelled=true;download.cancel()
    if(activeOperation&&!cancelRequest){
      if(operationKind==='environment'||operationKind==='service')cancelRequest=localSetupApi.cancelEnvironment(activeOperation)
      if(operationKind==='llama')cancelRequest=localSetupApi.stopLlama()
    }
    await cancelRequest
  }
  onUnmounted(()=>{disposed=true;download.cancel()})
  return {modelId,chatId,drawing,loras,reviewed,environment,llamaEnvironment,busy,message,error,completed,recommendation,imageModels,chatModels,plan,downloadBytes,download,run,cancel}
}
