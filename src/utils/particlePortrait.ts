import { runtimeFetch, runtimeResourceIdentity } from '../platform/runtimeUrl.ts'
import { characterArtEntry, characterArtRevision } from '../platform/characterArtState.ts'
import type { ParticlePoint } from './particleShapes.ts'
import { isPopularPortraitPending } from './popularPortraitSource.ts'

/** Prepare once per portrait: richer chroma on paper, preserving neutrals and hue. */
export function lightPortraitColor(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return hex
  const channels = [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16))
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  let saturation = 1.14
  // Stop at the gamut boundary rather than clipping channels and shifting hue.
  for (const value of channels) {
    const delta = value - luminance
    if (delta > 0) saturation = Math.min(saturation, (255 - luminance) / delta)
    else if (delta < 0) saturation = Math.min(saturation, -luminance / delta)
  }
  return `#${channels.map(value => Math.round(Math.max(0, Math.min(255,
    luminance + (value - luminance) * saturation))).toString(16).padStart(2, '0')).join('')}`
}

/** Original dark-theme luminance floor, shared without changing the palette. */
export function legibleParticleColor(hex: string): string {
  const value = hex.trim()
  const match = /^#?([0-9a-f]{6})$/i.exec(value)
  if (!match) return value
  const full = match[1]
  let r = parseInt(full.slice(0, 2), 16) / 255
  let g = parseInt(full.slice(2, 4), 16) / 255
  let b = parseInt(full.slice(4, 6), 16) / 255
  const MIN = 0.34
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (lum < MIN) {
    const lift = (MIN - lum) / Math.max(1e-6, 1 - lum)
    r += (1 - r) * lift
    g += (1 - g) * lift
    b += (1 - b) * lift
  }
  const to255 = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255)
  return `#${[to255(r), to255(g), to255(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * 角色形象粒子（2026-08-16）：粒子直接重组为「这个角色的剪影」，形状与
 * 配色都来自立绘本身。离线脚本（scripts/maintenance/build-particle-portraits.py，
 * 整图量化 + 原图透明度）预生成覆盖网格到 `assets/particles/p_<角色id>.json`。
 *
 * 前端在运行时按场域实际尺寸把覆盖网格重建成**等距点阵**（明日方舟官网式
 * 点阵成像）：点距恒定均匀、人物明暗由网点大小/颜色表达——非均匀的加权
 * 采样会产生疏密空洞，已废弃。
 */
export interface PortraitCloud {
  id: string
  /** Hash of the portrait used by the offline point-cloud build. */
  sourceSha256?: string
  /** 图片宽高比（w/h）。 */
  aspect: number
  /** k-means 主色（按占比降序，最多 36 色支持 base36 索引）。 */
  palette: string[]
  /** 覆盖网格：'.'=透明，其余为 base36 调色板序号（0-9a-v），按行拼接。 */
  grid: {
    w: number
    h: number
    cells: string
  }
}

/** 点阵采样结果：粒子目标点 + 内容盒尺寸 + 网点间距（像素）。 */
export interface PortraitSample {
  points: ParticlePoint[]
  /** 内容盒在场域归一化坐标中的宽/高（0..1）。 */
  boxW: number
  boxH: number
  /** 点阵间距（场域 CSS 像素）——网点半径按它与明暗调制。 */
  spacing: number
}

const cloudCache = new Map<string, PortraitCloud | null>()
const pendingLoads = new Map<string, Promise<PortraitCloud | null>>()

/**
 * 极亮色是否需要深色轮廓描边（2026-08-16 用户反馈：浅色主题下亮色点阵看不清，
 * 修复后要求颜色还原原图——由 1.8× 半径大衬点改为 1.25× 细轮廓描边）：
 * 亮度 >0.72 的白/近白点在浅色背景上「隐形」，绘制时沿点外圈描一圈细深灰
 * 轮廓恢复辨识度；点本体保持原色不透明，颜色不失真。0.62-0.72 的中亮色裸奔
 * （与浅底仍有 0.25 左右对比；0.62 阈值时白发等密集亮色区连成灰雾、颜色失真）。
 * 判定输入应为**实际绘制色**（浅色主题=原始 palette，深色主题=提亮后）。
 */
export function shouldUnderlay(hex: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return false
  const r = parseInt(match[1].slice(0, 2), 16) / 255
  const g = parseInt(match[1].slice(2, 4), 16) / 255
  const b = parseInt(match[1].slice(4, 6), 16) / 255
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.72
}

export function portraitCloudUrl(id: string): string {
  return characterArtEntry(id)?.particleUrl || `/assets/particles/p_${encodeURIComponent(id)}.json`
}
export function portraitCloudIdentity(id: string): string { return `${runtimeResourceIdentity()}:${id}:${characterArtRevision(id)}` }

/** 懒加载角色点云；不存在（404）或失败返回 null，结果缓存（含失败，避免反复 404）。 */
export function loadPortraitCloud(id: string): Promise<PortraitCloud | null> {
  if (!id || isPopularPortraitPending(id)) return Promise.resolve(null)
  const key = portraitCloudIdentity(id)
  const cached = cloudCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = pendingLoads.get(key)
  if (pending) return pending
  const task = runtimeFetch(portraitCloudUrl(id), { signal: AbortSignal.timeout(10_000) })
    .then(async res => {
      const cloud = res.ok ? await res.json() as PortraitCloud : null
      const usable = cloud
        && Array.isArray(cloud.palette) && cloud.palette.length > 0
        && cloud.grid && cloud.grid.w > 4 && cloud.grid.h > 4
        && typeof cloud.grid.cells === 'string'
        && cloud.grid.cells.length >= cloud.grid.w * cloud.grid.h * 0.9
      if (key !== portraitCloudIdentity(id)) return null
      if (cloudCache.size >= 80) cloudCache.delete(cloudCache.keys().next().value!)
      cloudCache.set(key, usable ? cloud : null)
      return cloudCache.get(key) ?? null
    })
    .catch(() => {
      if (key === portraitCloudIdentity(id)) {
        if (cloudCache.size >= 80) cloudCache.delete(cloudCache.keys().next().value!)
        cloudCache.set(key, null)
      }
      return null
    })
    .finally(() => { pendingLoads.delete(key) })
  pendingLoads.set(key, task)
  return task
}

/**
 * 在场域内重建等距点阵：
 * 1. 内容盒——人物按宽高比等比放进场域（最长边 0.96，居中，不变形）；
 * 2. 网格——以「boxW·width × boxH·height 像素 / 目标粒子数」求正方形单元边长，
 *    得到 cols×rows 的均匀点阵（屏幕上点距处处相等，无各向异性）；
 * 3. 采样——每个点阵单元中心映射到覆盖网格最近格，仅 '.' 透明格跳过、数字取色调；
 * 4. 输出按行带排序（形变动画按行过渡更稳）。
 */
export function samplePortraitPoints(
  cloud: PortraitCloud,
  count: number,
  fieldWidth: number,
  fieldHeight: number,
): PortraitSample {
  if (!cloud.grid || count < 8 || fieldWidth < 2 || fieldHeight < 2) {
    return { points: [], boxW: 1, boxH: 1, spacing: 1 }
  }
  const fieldAspect = fieldWidth / fieldHeight
  const charAspect = cloud.aspect > 0 ? cloud.aspect : 1
  // 2026-08-16：内容盒 0.96 → 1.02（配合前端剪影模式 4% 边距，实际占屏约 94%，
  // 比原来的 80% 大 ~16%）——角色页留白过多、人物显小的问题来自双 8% 边距叠乘。
  let boxW: number
  let boxH: number
  if (charAspect >= fieldAspect) {
    boxW = 1.02
    boxH = 1.02 * (fieldAspect / charAspect)
  } else {
    boxH = 1.02
    boxW = 1.02 * (charAspect / fieldAspect)
  }

  const boxPxW = Math.max(8, boxW * fieldWidth)
  const boxPxH = Math.max(8, boxH * fieldHeight)
  const { w: gw, h: gh, cells } = cloud.grid
  // Only explicit transparency removes cells. Border colors can also occur on faces or clothing.
  const coverage = estimateCoverage(cloud)
  const spacing = Math.sqrt(boxPxW * boxPxH * coverage / count)
  const cols = Math.max(2, Math.round(boxPxW / spacing))
  const rows = Math.max(2, Math.round(boxPxH / spacing))

  const points: ParticlePoint[] = []
  for (let row = 0; row < rows; row += 1) {
    const yNorm = (row + 0.5) / rows
    const gy = Math.min(gh - 1, Math.floor(yNorm * gh))
    const rowBase = gy * gw
    for (let col = 0; col < cols; col += 1) {
      const xNorm = (col + 0.5) / cols
      const gx = Math.min(gw - 1, Math.floor(xNorm * gw))
      const cell = cells[rowBase + gx]
      if (cell === '.') continue
      const paint = parseInt(cell, 36)
      if (Number.isNaN(paint) || paint >= cloud.palette.length) continue
      points.push({
        x: 0.5 + (xNorm - 0.5) * boxW,
        y: 0.5 + (yNorm - 0.5) * boxH,
        tone: 0,
        paint,
      })
    }
  }

  points.sort((a, b) => {
    const rowA = Math.round(a.y * 18)
    const rowB = Math.round(b.y * 18)
    return rowA === rowB ? a.x - b.x : rowA - rowB
  })
  return { points, boxW, boxH, spacing }
}

function estimateCoverage(cloud: PortraitCloud): number {
  const { cells } = cloud.grid
  let filled = 0
  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index] === '.') continue
    filled += 1
  }
  const ratio = filled / Math.max(1, cells.length)
  return Math.min(0.98, Math.max(0.25, ratio))
}

/** WCAG luminance comparison for the actual point color and its local canvas surface. */
export function particleNeedsOutline(color: string, surface: string): boolean {
  const luminance = (hex: string) => {
    const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
    if (!match) return null
    const values = [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722
  }
  const a = luminance(color), b = luminance(surface)
  if (a === null || b === null) return true
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) < 3
}
