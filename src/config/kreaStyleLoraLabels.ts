/** Krea 2 官方风格 LoRA 中文显示名映射（保留英文 ID 作为稳定接口标识）。 */
export const KREA_STYLE_LORA_LABELS: Readonly<Record<string, string>> = Object.freeze({
  bartstyle: '蔚蓝档案画风',
  darkbrush: '水墨笔触',
  dotmatrix: '点阵点绘',
  flatcelanime: '平涂赛璐璐动漫',
  kidsdrawing: '童趣手绘',
  neondrip: '霓虹滴彩抽象',
  rainywindow: '雨窗氛围',
  retroanime: '紫调复古动画',
  softwatercolor: '柔和水彩',
  sunsetblur: '落日柔焦模糊',
  vintagetarot: '复古塔罗',
})

export function kreaStyleLoraLabel(id: string | null | undefined, label?: string | null): string {
  if (!id) return ''
  return KREA_STYLE_LORA_LABELS[id] || label?.trim() || id.replace(/^krea2\//, '').replace(/\.safetensors$/i, '')
}
