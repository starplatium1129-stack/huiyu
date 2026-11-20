export interface MossCanvasSize { width: number; height: number }
export type MossLayoutSide = 'left' | 'right'
type Box = [number, number, number, number]

export interface MossLayoutItem {
  label: 'character' | 'object' | 'text'
  caption: string
  bbox: Box
  text?: string
}

const centered = 'abs_centralized'
const modelOrder = 'yxyx'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isMossLayoutInput(value: string) {
  return /^(?:\{|```(?:json)?\s*\{)/i.test(value.trimStart())
}

function readBox(value: unknown, index: number): Box {
  if (!Array.isArray(value) || value.length !== 4
    || !value.every(n => typeof n === 'number' && Number.isFinite(n))
    || !(value[0] < value[2] && value[1] < value[3])) {
    throw new Error(`第 ${index + 1} 项的 bbox 需要四个有效坐标，且结束位置须大于起始位置`)
  }
  return value as Box
}

function inBounds([top, left, bottom, right]: Box, size: MossCanvasSize) {
  return top >= -size.height / 2 && bottom <= size.height / 2
    && left >= -size.width / 2 && right <= size.width / 2
}

export function compileMossLayout(source: string, size?: MossCanvasSize) {
  const json = source.trim().replace(/^```(?:json)?\s*([\s\S]+?)\s*```$/i, '$1')
  let layout: unknown
  try { layout = JSON.parse(json) }
  catch (cause) { throw new Error('布局 JSON 无法解析，请检查引号、逗号和括号', { cause }) }
  if (!record(layout) || !record(layout.summary) || !nonempty(layout.summary.caption)) {
    throw new Error('布局需要填写 summary.caption 来描述整体画面')
  }
  const canvasKind = layout.summary.canvas
  if (canvasKind !== undefined && !['single', 'multi_panel', 'collage'].some(canvas => canvas === canvasKind)) {
    throw new Error('summary.canvas 支持 single、multi_panel 或 collage')
  }
  if (!Array.isArray(layout.items) || !layout.items.length) {
    throw new Error('布局的 items 至少需要一个画面元素')
  }

  const draft = layout.bbox_coord_space === 'abs' && layout.bbox_format === 'xyxy'
  if (!draft && (layout.bbox_coord_space !== centered || layout.bbox_format !== modelOrder)) {
    throw new Error('布局坐标须为 abs_centralized / yxyx，或使用 abs / xyxy 草稿')
  }
  const { width, height } = layout
  if (draft && Object.keys(layout).some(key => !['width', 'height', 'summary', 'items', 'bbox_coord_space', 'bbox_format'].includes(key))) {
    throw new Error('像素草稿包含无法编译的顶层字段，请保留画幅、summary、items 和坐标声明')
  }
  if (draft && (typeof width !== 'number' || typeof height !== 'number'
    || ![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n % 16 === 0))) {
    throw new Error('像素草稿的 width 和 height 须为正的 16 倍数')
  }
  if (draft && size && (width !== size.width || height !== size.height)) {
    throw new Error(`布局草稿为 ${width}×${height}，请将画幅与草稿尺寸对齐`)
  }
  const canvas = draft ? { width: width as number, height: height as number } : size
  let hasText = false
  const items = layout.items.map((item: unknown, index: number) => {
    if (!record(item) || !['character', 'object', 'text'].some(label => label === item.label)
      || !nonempty(item.caption)) {
      throw new Error(`第 ${index + 1} 项需要有效的 label 和 caption`)
    }
    if (item.label === 'text' && !nonempty(item.text)) {
      throw new Error(`第 ${index + 1} 项须在 text 中填写画面文字原文`)
    }
    hasText ||= nonempty(item.text)
    const box = readBox(item.bbox, index)
    const bbox: Box = draft && canvas ? [
      Math.floor(box[1]) - canvas.height / 2, Math.floor(box[0]) - canvas.width / 2,
      Math.ceil(box[3]) - canvas.height / 2, Math.ceil(box[2]) - canvas.width / 2,
    ] : box
    if (canvas && !inBounds(bbox, canvas)) {
      throw new Error(`第 ${index + 1} 项的 bbox 超出 ${canvas.width}×${canvas.height} 画幅`)
    }
    return { ...item, bbox }
  })
  // Native input keeps its exact wording and pixel coordinates.
  const prompt = draft
    ? JSON.stringify({ summary: layout.summary, items, bbox_coord_space: centered, bbox_format: modelOrder }, null, 2)
    : json
  return { prompt, hasText, caption: layout.summary.caption }
}

export function mossSubjectBox({ width, height }: MossCanvasSize, placement?: MossLayoutSide | 'center'): Box {
  const left = placement === 'right' ? 0.44 : placement === 'center' ? 0.16 : 0
  const right = placement === 'left' ? 0.56 : placement === 'center' ? 0.84 : 1
  return [-height / 2, Math.floor(left * width) - width / 2, height / 2, Math.ceil(right * width) - width / 2]
}

export function mossTriptychBox({ width, height }: MossCanvasSize, index: number): Box {
  const edge = (column: number) => Math.round(column * width / 3) - width / 2
  return [-height / 2, edge(index), height / 2, edge(index + 1)]
}

export function mossTextBox(size: MossCanvasSize, placement: string): Box {
  const horizontal = placement.match(/\b(?:left|right|center)\b|左|右|居中/i)?.[0].toLowerCase()
  const side = horizontal === 'left' || horizontal === '左' ? 'left'
    : horizontal === 'right' || horizontal === '右' ? 'right'
    : horizontal === 'center' || horizontal === '居中' ? 'center' : undefined
  const box = mossSubjectBox(size, side)
  const vertical = placement.match(/\b(?:top|upper|bottom|lower)\b|上|下|顶|底/i)?.[0] ?? ''
  if (/^(?:top|upper|上|顶)$/i.test(vertical)) box[2] = -Math.floor(size.height / 6)
  if (/^(?:bottom|lower|下|底)$/i.test(vertical)) box[0] = Math.floor(size.height / 6)
  return box
}

export function mossLayoutJson(caption: string, items: MossLayoutItem[], multiPanel: boolean) {
  return JSON.stringify({
    summary: { canvas: multiPanel ? 'multi_panel' : 'single', caption },
    items,
    bbox_coord_space: centered,
    bbox_format: modelOrder,
  }, null, 2)
}
