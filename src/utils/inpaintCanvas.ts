const INPAINT_MAX_EDGE = 1216
const INPAINT_MAX_AREA = 1_400_000

export function inpaintCanvasSize(
  sourceWidth: number,
  sourceHeight: number
): { width: number; height: number } | null {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return null
  const edgeScale = Math.min(1, INPAINT_MAX_EDGE / Math.max(sourceWidth, sourceHeight))
  const areaScale = Math.min(1, Math.sqrt(INPAINT_MAX_AREA / (sourceWidth * sourceHeight)))
  const scale = Math.min(edgeScale, areaScale)
  const width = Math.max(512, Math.floor((sourceWidth * scale) / 16) * 16)
  const height = Math.max(512, Math.floor((sourceHeight * scale) / 16) * 16)
  return { width, height }
}
