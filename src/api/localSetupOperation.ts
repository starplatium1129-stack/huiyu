import { localSetupApi } from './localSetupApi'
import type { ControlActionResult } from '../types/api'

export async function waitLocalSetupOperation(result:ControlActionResult,options:{signal?:AbortSignal;timeoutMs?:number;onMessage?:(message:string)=>void}={}) {
  const id=result.operation?.id
  if(!id)throw new Error('准备操作尚未确认，请查看控制室')
  const deadline=Date.now()+(options.timeoutMs??210_000)
  try { while(Date.now()<deadline){
    options.signal?.throwIfAborted()
    const status=await localSetupApi.getOperation(options.signal)
    if(status.operation?.id!==id)throw new Error('操作状态已改变，请查看控制室')
    options.onMessage?.(status.operation.message)
    if(status.operation.status==='failed')throw new Error(status.operation.error||status.operation.message)
    if(status.operation.status==='completed')return
    await new Promise<void>(resolve=>setTimeout(resolve,500))
  } } catch(error) {
    if(options.signal?.aborted) await localSetupApi.cancelEnvironment(id).catch(()=>{})
    throw error
  }
  throw new Error('准备超过期限，请查看控制室日志')
}
