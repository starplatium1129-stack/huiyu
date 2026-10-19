import type { AnimaGenerationState, AnimaOption, ComfyNodeReadiness } from '@/types/anima'
import type { AnimaStatusResponse } from './animaSessionContract'
import { nativeTeaCacheReady } from './nativeAnimaCapabilities'

const OPTIONAL_SETUP_NOTE = '当前一键准备包不包含此扩展，也没有已登记的固定安装来源。请到控制面板核对环境与准备范围。'
export function automaticMaskBlocker(state: Pick<AnimaGenerationState, 'provider' | 'automaticMaskAvailable' | 'automaticMaskStatus' | 'managedStartAvailable'>): string | null {
  if (state.automaticMaskAvailable === true) return null
  if (state.provider === 'native') return '自动识别需要完整的本地 CLIPSeg，可在控制室的「辅助模型与 LoRA」一键准备；也可选择手绘遮罩，或明确选择整图重绘（人物与背景均可能变化）。'
  const nodes = state.automaticMaskStatus
  if (state.provider === 'comfy' && state.managedStartAvailable === true && nodes?.state === 'unknown') return null
  return nodes?.state === 'missing'
    ? `文字自动蒙版缺少 ComfyUI 节点：${nodes.missing.join('、')}。${OPTIONAL_SETUP_NOTE}手绘遮罩仍可使用。`
    : '文字自动蒙版节点尚未确认，请启动所用 ComfyUI 后在控制面板重新检查；手绘遮罩仍可使用。'
}

function kreaNodeMessage(nodes: ComfyNodeReadiness | undefined, managed: boolean): string | null {
  if (!nodes || nodes.state === 'ready') return null
  return nodes.state === 'missing'
    ? `Krea 2 缺少 ComfyUI 节点：${nodes.missing.join('、')}。${OPTIONAL_SETUP_NOTE}`
    : `Krea 2 节点尚未确认。${managed ? '生成时将启动受管服务并检查节点，通过后才提交。' : '请到控制面板启动所用服务后重新检查。'}当前一键准备包不包含 Krea 扩展。`
}

/** File presence, a running server and optional-node registration are distinct evidence. */
export function backendReadiness(data: AnimaStatusResponse, model: AnimaOption | undefined, family: 'anima' | 'krea2', modelCount: number, loraCount: number): Partial<AnimaGenerationState> {
  const provider = data.provider === 'native' ? 'native' : 'comfy'
  const nodes: ComfyNodeReadiness | undefined = provider === 'comfy' && family === 'krea2'
    ? model?.nodeReadiness ?? { state: 'unknown', required: ['ConditioningKrea2Rebalance', 'ComfyUI-Krea2T-Enhancer'], missing: [] } : undefined
  const online = data.online === true && model?.available === true && (!nodes || nodes.state === 'ready')
  const managedStartAvailable = provider === 'comfy' && data.managedStartAvailable === true && model?.available === true && nodes?.state !== 'missing' && (data.online !== true || !nodes || nodes.state === 'ready')
  const familyLabel = family === 'krea2' ? 'Krea 2' : 'Anima'
  const automaticMaskStatus = provider === 'comfy' ? data.capabilities?.automaticMaskStatus : undefined
  const superRes = data.hires?.superResModel
  const autoHiresModel = superRes === null ? null : typeof superRes === 'string' && superRes.trim() ? superRes : undefined
  const nativeDetails = provider !== 'native' ? '' : family === 'anima'
    ? ` · 原生局部重绘（实验性）${data.capabilities?.automaticMask === true ? ' · 本地自动识别文件就绪' : ' · 自动识别缺少本地 CLIPSeg 文件'} · TeaCache ${nativeTeaCacheReady(model) ? '内置策略就绪' : '当前运行时未提供内置策略'} · ${model?.capabilities?.hires ? '支持高清放大' : '不支持高清修复'}`
    : ' · 原生文生图 · 支持官方风格 LoRA · 不支持角色 LoRA、局部重绘或高清修复 · 成图效果待设备验证'
  const checkMsg = kreaNodeMessage(nodes, managedStartAvailable) ?? (online
    ? `${familyLabel} ${provider === 'native' ? '文件就绪' : '在线'} · ${modelCount} 个底模 · ${loraCount} 个 LoRA${nativeDetails}`
    : managedStartAvailable ? `${familyLabel} 已准备 · 生成时自动启动受管 ComfyUI` : model?.unavailableReason || `${familyLabel} 不可用（请检查${provider === 'native' ? '原生推理服务' : 'ComfyUI'}与当前模型文件）`)
  return { online, managedStartAvailable, provider, automaticMaskAvailable: family === 'anima' && data.capabilities?.automaticMask === true, automaticMaskStatus, autoHiresModel: family === 'anima' ? autoHiresModel : null, checkMsg }
}
