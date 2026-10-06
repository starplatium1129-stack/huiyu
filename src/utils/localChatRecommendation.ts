import type { LocalSetupResponse } from '../../types/local-setup'

/** Product recommendations are candidates; total VRAM is not a measured runtime peak. */
export function localChatRecommendation(hardware: LocalSetupResponse['hardware']) {
  const device = hardware.devices.filter(device=>device.type==='cuda').sort((a,b)=>(b.vramBytes??0)-(a.vramBytes??0))[0]
  const gib=(device?.vramBytes??0)/1024**3
  if (gib<6) return {modelId:'',label:'优先使用 API',note:'显存较少或设备尚未确认，填写服务商密钥即可聊天。'}
  if (gib<10) return {modelId:'chat-qwen-4b',label:'轻量 · Qwen3.5 4B',note:'6–8 GB 档候选，优先保留运行余量。'}
  if (gib<16) return {modelId:'chat-qwen-9b',label:'平衡 · Qwen3.5 9B',note:'10–12 GB 档候选；绘图时释放聊天模型。'}
  if (gib<24) return {modelId:'chat-qwen-27b-iq3',label:'性能 · Qwen3.8 27B IQ3',note:'16 GB 档候选；较紧张时可改选 9B。'}
  return {modelId:'chat-qwen-27b-q4',label:'高精度 · Qwen3.8 27B Q4',note:'24 GB 及以上候选；实际余量、上下文和速度仍以本机为准。'}
}
