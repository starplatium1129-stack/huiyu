import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { LocalSetupModel, LocalSetupResponse, LocalSetupDownloadResult } from '../../types/local-setup'
import type { ControlActionResult } from '../types/api'
import { localSetupApi } from '../api/localSetupApi'
import { controlApi } from '../api/controlApi'
import { inferenceSettingsApi } from '../api/inferenceSettingsApi'
import { waitLocalSetupOperation } from '../api/localSetupOperation'
import { useLocalSetupDownload } from './useLocalSetupDownload'
import { LOCAL_SETUP_DRAFT_SETTING, clearSetupOperation, readSetupDraft, setupOperationKind, type SetupDraft } from '../utils/localSetupDraft'
import { localChatRecommendation } from '../utils/localChatRecommendation'
import { modelPreparationState, drawingSetupReadiness } from '../utils/localSetupPreparation'
import { useChatStorage } from './chat/useChatStorage'
import { settingsRepository, DRAW_ENGINE_SETTING, STARTER_MODEL_SETTING } from '../storage/settingsRepository'

export function useLocalSetupAutomation(snapshot: Ref<LocalSetupResponse>, blocked: Ref<boolean>, onResult:(result:LocalSetupDownloadResult)=>void, refresh:()=>void, statusConfirmed:Ref<boolean>, onConfigured:()=>void) {
  const draft=readSetupDraft(snapshot.value.workspace.path)
  const savedModel=draft&&snapshot.value.models.some(model=>model.id===draft.modelId&&model.id.startsWith('anima-')&&model.preparation)?draft.modelId:undefined
  const modelId=ref(savedModel??snapshot.value.recommendedModel??snapshot.value.models.find(model=>model.required&&model.id.startsWith('anima-'))?.id??'anima-miaomiao-v1.6'),chatId=ref(draft&&snapshot.value.models.some(model=>model.id===draft.chatId&&model.kind==='chat')?draft.chatId:''), drawing=ref(draft?.drawing??true), loras=ref(draft?.loras??true), reviewed=ref(false)
  const installed=snapshot.value.comfy.managedEnvironment
  // Initialize from verified installation evidence once; later refreshes must preserve the user's choice.
  const environment=ref(installed?.state==='verified'?installed.environment:draft?.environment??(snapshot.value.comfy.installation==='missing'?'comfy-nvidia':'')),llamaEnvironment=ref(draft?.llamaEnvironment??'llama-cuda')
  const recoveryPending=ref(!!draft?.operation)
  const busy=ref(!!draft?.operation),message=ref(''),error=ref(''),completed=ref(false)
  const engineRestartRequired=ref(false)
  const cancelState=ref<'idle'|'pending'|'accepted'|'failed'>('idle'),operationUncertain=ref(false)
  const recommendation=computed(()=>localChatRecommendation(snapshot.value.hardware))
  const imageModels=computed(()=>snapshot.value.models.filter(model=>model.id.startsWith('anima-')&&model.preparation))
  const chatModels=computed(()=>snapshot.value.models.filter(model=>model.kind==='chat'))
  const workspace=computed(()=>snapshot.value.workspace.path)
  const hasSelection=computed(()=>drawing.value||!!chatId.value)
  const ready=computed(()=>reviewed.value&&!blocked.value&&hasSelection.value)
  const download=useLocalSetupDownload(workspace,ready,onResult)
  const chatStorage=useChatStorage(cause=>{error.value=cause})
  const hasComfy=computed(()=>snapshot.value.comfy.installation==='present')
  const rebuildComfy=ref(false)
  let disposed=false,cancelled=false
  let activeOperation:ControlActionResult|null=null
  let operationWorkspace=''
  let recoveryRequest=false
  let cancelRequest:Promise<void>|null=null
  // Hardware may be unknown until the service is started; absence of a report is not a negative GPU check.
  const unmanagedPortable=computed(()=>hasComfy.value&&snapshot.value.comfy.layout==='portable'&&snapshot.value.comfy.managedEnvironment?.state!=='verified')
  const externalEnvironment=computed(()=>!rebuildComfy.value&&hasComfy.value&&(!['portable','venv'].includes(snapshot.value.comfy.layout)||unmanagedPortable.value))
  const stage=ref<'environment'|'models'|'service'|'validation'|null>(null)
  let restoringDraft=false
  function saveDraft(operation=readSetupDraft(workspace.value)?.operation) {
    const value:SetupDraft={workspace:workspace.value,modelId:modelId.value,chatId:chatId.value,drawing:drawing.value,loras:loras.value,
      environment:environment.value,llamaEnvironment:llamaEnvironment.value,...(operation?{operation}:{})}
    return settingsRepository.set(LOCAL_SETUP_DRAFT_SETTING,disposed?{...(readSetupDraft(workspace.value)??value),...(operation?{operation}:{})}:value)
  }
  watch([modelId,chatId,drawing,loras,environment,llamaEnvironment,rebuildComfy],()=>{reviewed.value=false;completed.value=false;if(!restoringDraft)saveDraft()},{flush:'sync'})
  watch(workspace,()=>{
    reviewed.value=false;completed.value=false;restoringDraft=true;rebuildComfy.value=false
    const saved=readSetupDraft(workspace.value),value=snapshot.value,receipt=value.comfy.managedEnvironment
    modelId.value=saved&&value.models.some(model=>model.id===saved.modelId&&model.id.startsWith('anima-')&&model.preparation)?saved.modelId:value.recommendedModel??value.models.find(model=>model.required&&model.id.startsWith('anima-'))?.id??'anima-miaomiao-v1.6'
    chatId.value=saved&&value.models.some(model=>model.id===saved.chatId&&model.kind==='chat')?saved.chatId:''
    drawing.value=saved?.drawing??true;loras.value=saved?.loras??true
    environment.value=receipt?.state==='verified'?receipt.environment:saved?.environment??(value.comfy.installation==='missing'?'comfy-nvidia':'')
    llamaEnvironment.value=saved?.llamaEnvironment??'llama-cuda';restoringDraft=false
  },{flush:'sync'})
  const needsComfyPreparation=computed(()=>!externalEnvironment.value&&(rebuildComfy.value||!hasComfy.value))
  const serviceMustStop=computed(()=>drawing.value&&needsComfyPreparation.value&&snapshot.value.comfy.connection==='online')
  const canStartExisting=computed(()=>drawing.value&&!chatId.value&&hasComfy.value&&!rebuildComfy.value&&!externalEnvironment.value&&!serviceMustStop.value)
  const environmentRequired=computed(()=>drawing.value&&needsComfyPreparation.value&&!environment.value)
  function requireModel(id:string):LocalSetupModel {
    const model=snapshot.value.models.find(model=>model.id===id&&model.preparation)
    if(!model) throw new Error('准备清单缺少 '+id+'，请重新检查')
    return model
  }
  const runtimeIds=computed(()=>{
    const ids:string[]=[]
    if(drawing.value&&needsComfyPreparation.value){
      if(environment.value) ids.push('runtime-'+environment.value)
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
  async function waitOperation(result:ControlActionResult,confirmedWorkspace=workspace.value){
    const id=result.operation?.id
    if(!id)throw new Error('准备操作尚未确认，请重新检查控制室')
    const kind=result.operation?.kind
    operationWorkspace=confirmedWorkspace
    const lateCancellation=cancelled&&!activeOperation
    activeOperation=result;operationUncertain.value=true
    if(setupOperationKind(kind)&&confirmedWorkspace===workspace.value){
      if (!await saveDraft({id,kind})) throw new Error('准备操作已开始，恢复编号尚未保存；请先重试保存设置。')
      if(disposed)window.dispatchEvent(new Event('huiyu:setup-operation'))
    }
    if(disposed)checkpoint()
    operationUncertain.value=false
    try{
      // Cancellation can precede the server acknowledgement that gives us an operation ID.
      if(lateCancellation)void cancel()
      await waitLocalSetupOperation(result,{timeoutMs:60*60*1000,onOperation:operation=>{
        if(disposed)checkpoint()
        if(operation?.id!==id||operation.status==='failed'||operation.status==='completed'){
          activeOperation=null;clearSetupOperation(confirmedWorkspace,id)
        }
      },onMessage:value=>{
        if(disposed)checkpoint()
        message.value=cancelState.value==='accepted'&&activeOperation?'已请求取消，等待当前步骤结束：'+value:value
      }})
      if(cancelled)throw new Error('当前步骤已完成；后续准备已停止，已完成文件保留')
    }catch(cause){
      if(!disposed&&activeOperation){
        operationUncertain.value=true
        throw new Error('当前准备状态尚未确认，请重新检查状态；后台操作可能仍在运行。'+(cause instanceof Error?cause.message:''))
      }
      throw cause
    }finally{
      // A late cancellation receipt must settle before another preparation can start.
      if(!activeOperation)await cancelRequest
    }
  }
  async function checkDrawing(confirmedWorkspace:string,selectedModel:string,externalDrawing=false){
    stage.value='validation'
    message.value='正在检查所选模型、服务连接与工作流节点…'
    const checked=await localSetupApi.getStatus({modelId:selectedModel})
    checkpoint()
    if(blocked.value||checked.workspace.path!==confirmedWorkspace)throw new Error('AI 工作区尚未确认或已改变，请重新检查后继续准备。')
    if(externalDrawing&&checked.comfy.connection!=='online')throw new Error('模型文件已保留。此环境由外部管理，请从原入口启动，再回到绘遇重新检查；不会另装或接管该环境。')
    const readiness=drawingSetupReadiness(checked,selectedModel)
    if(!readiness.complete)throw new Error('绘图准备尚未完成：'+readiness.nextStep)
    const engine=await inferenceSettingsApi.getStatus()
    checkpoint()
    if(engine.environmentOverrides.includes('engine')&&engine.active.engine!=='comfy')throw new Error('启动配置锁定了原生引擎，请在「原生绘图」的高级设置中核对启动配置，再启用 ComfyUI。模型文件已保留。')
    const activated=engine.configured.engine==='comfy'?engine:await inferenceSettingsApi.save({...engine.configured,engine:'comfy'})
    checkpoint()
    engineRestartRequired.value=activated.active.engine!=='comfy'||activated.restartRequired
    const saved = await Promise.all([settingsRepository.set(DRAW_ENGINE_SETTING,'anima'), settingsRepository.set(STARTER_MODEL_SETTING,selectedModel)])
    if (saved.some(ok => !ok)) throw new Error('模型已准备，绘图偏好尚未保存，请重试保存设置。')
    onConfigured()
  }
  function beginRun(){
    busy.value=true;cancelled=false;cancelState.value='idle';operationUncertain.value=false;completed.value=false;engineRestartRequired.value=false;error.value=''
  }
  async function startExisting(){
    if(busy.value||!statusConfirmed.value||blocked.value||!canStartExisting.value)return
    beginRun()
    const confirmedWorkspace=workspace.value,selectedModel=modelId.value
    try{
      stage.value='service';message.value='正在启动现有环境，不下载或切换运行包…'
      await waitOperation(await controlApi.serviceAction('comfy','start'),confirmedWorkspace)
      await checkDrawing(confirmedWorkspace,selectedModel)
      completed.value=true;message.value='现有绘图服务已连接，基础检查完成；可生成第一张图片验证实际效果。'
    }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'启动未完成，请重试'}
    finally{if(!disposed){busy.value=!!activeOperation;if(!activeOperation&&!cancelled)refresh()}}
  }
  async function run(){
    if(busy.value||!statusConfirmed.value||environmentRequired.value||serviceMustStop.value||!ready.value||(!drawing.value&&!chatId.value))return
    beginRun()
    const runtime=[...runtimeIds.value],weights=[...weightIds.value],prepareComfy=drawing.value&&needsComfyPreparation.value
    const prepareLlama=!!chatId.value&&!snapshot.value.chat?.runtimePresent,selectedChat=chatId.value,confirmedWorkspace=workspace.value
    const prepareDrawing=drawing.value,selectedModel=modelId.value,externalDrawing=externalEnvironment.value
    const selectedEnvironment=environment.value
    try{
      stage.value='environment'
      for(const id of runtime)await fetchFile(id)
      if(prepareComfy)await waitOperation(await localSetupApi.prepareEnvironment(selectedEnvironment,confirmedWorkspace),confirmedWorkspace)
      if(prepareLlama)await waitOperation(await localSetupApi.prepareEnvironment(llamaEnvironment.value,confirmedWorkspace),confirmedWorkspace)
      stage.value='models'
      for(const id of weights)await fetchFile(id)
      if(prepareDrawing){
        stage.value='service'
        if(!externalDrawing)await waitOperation(await controlApi.serviceAction('comfy','start'),confirmedWorkspace)
        await checkDrawing(confirmedWorkspace,selectedModel,externalDrawing)
      }
      if(selectedChat){
        stage.value='service'
        checkpoint()
        const result=await localSetupApi.startLlama(selectedChat,confirmedWorkspace)
        await waitOperation(result,confirmedWorkspace)
        checkpoint()
        await chatStorage.load()
        checkpoint()
        await chatStorage.setApiSettings({baseUrl:result.baseUrl,model:result.model,apiKey:''})
        checkpoint()
        chatStorage.setProvider('api')
      }
      stage.value='validation'
      checkpoint()
      completed.value=true
      message.value=prepareDrawing
        ? '绘图服务已连接，所选模型与节点检查已完成。前往绘图画室生成第一张图片，确认实际效果。'
        : '聊天环境与文件已准备。进入角色房间发送一条短消息，确认本机实际效果。'
      refresh()
    }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'准备未完成，请重试'}
    finally{if(!disposed)busy.value=!!activeOperation}
  }
  async function cancel(){
    if(disposed||!busy.value||recoveryPending.value)return
    cancelled=true;download.cancel()
    if(cancelRequest)return cancelRequest
    const operation=activeOperation,id=operation?.operation?.id
    if(!id||operationWorkspace!==workspace.value||cancelState.value==='accepted')return
    cancelState.value='pending'
    cancelRequest=(async()=>{
      try{
        await localSetupApi.cancelEnvironment(id)
        if(!disposed&&activeOperation===operation){cancelState.value='accepted';error.value='';message.value='已请求取消，等待当前步骤结束…'}
      }catch{
        if(!disposed&&activeOperation===operation){cancelState.value='failed';error.value='取消结果尚未确认，后台操作可能仍在运行；请重试取消。'}
      }finally{cancelRequest=null}
    })()
    await cancelRequest
  }
  async function recoverOperation(){
    if(disposed||recoveryRequest||activeOperation)return
    const saved=readSetupDraft(workspace.value),owned=saved?.operation
    if(!owned){recoveryPending.value=false;return}
    const confirmedWorkspace=workspace.value
    recoveryRequest=true;recoveryPending.value=true;busy.value=true;operationUncertain.value=false;error.value=''
    message.value='正在核对上次准备步骤…'
    try{
      const result=await localSetupApi.getOperation(undefined,owned.id)
      if(disposed)return
      if(workspace.value!==confirmedWorkspace){recoveryPending.value=false;return}
      if(result.operation?.id!==owned.id||result.operation.kind!==owned.kind){
        clearSetupOperation(confirmedWorkspace,owned.id)
        message.value='上次步骤已结束或改变，请确认当前检查与清单后继续。'
        recoveryPending.value=false
        return
      }
      recoveryPending.value=false
      stage.value=owned.kind==='prepare-environment'?'environment':'service'
      await waitOperation(result,confirmedWorkspace)
      message.value='上次步骤已完成，正在重新检查环境；后续准备需重新确认清单。'
    }catch(cause){
      if(!disposed){operationUncertain.value=recoveryPending.value||!!activeOperation;error.value=cause instanceof Error?cause.message:'准备状态尚未确认'}
    }finally{
      recoveryRequest=false
      if(!disposed){busy.value=recoveryPending.value||!!activeOperation;if(!busy.value)refresh()}
    }
  }
  async function retryOperation(){
    if(recoveryPending.value){await recoverOperation();return}

    if(disposed||!operationUncertain.value||!activeOperation)return
    error.value=''
    try{await waitOperation(activeOperation);message.value='当前步骤已完成，请重新检查后继续准备。'}
    catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'准备状态尚未确认'}
    finally{if(!disposed){busy.value=!!activeOperation;if(!busy.value)refresh()}}
  }
  function recoverLateOperation(){if(!busy.value)void recoverOperation()}
  onMounted(()=>{window.addEventListener('huiyu:setup-operation',recoverLateOperation);void recoverOperation()})
  onUnmounted(()=>{disposed=true;download.cancel();window.removeEventListener('huiyu:setup-operation',recoverLateOperation)})
  return {modelId,chatId,drawing,loras,reviewed,environment,llamaEnvironment,rebuildComfy,busy,message,error,completed,engineRestartRequired,recommendation,imageModels,chatModels,plan,downloadBytes,download,hasSelection,externalEnvironment,canStartExisting,environmentRequired,serviceMustStop,stage,startExisting,run,cancel,cancelState,operationUncertain,recoveryPending,retryOperation}
}
