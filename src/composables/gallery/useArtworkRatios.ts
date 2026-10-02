import { reactive } from 'vue'
import { jpegThumbDataUrl } from '@/utils/imageThumb'
import type { ArtworkRecord } from '@/types/artwork'

/**
 * 脏数据兜底比例：元数据缺失或非有限/非正时统一落到 3:4。
 *
 * 注意：真实比例一律原样透传，绝不做区间钳制——钳制会让画框和原图对不上，
 * object-fit:contain 会留出白边，比例失真。等高行算法对任意正比例都安全：
 * 行高由「整行比例和」决定、末行有 targetHeight 保底，不会因极端比例撑爆，
 * 因此无需再设 RATIO_MIN/MAX 这种「合理区间」。
 */
const RATIO_FALLBACK = 0.75
/**
 * 比例回填的更新阈值：实测值与已记录值差异小于它就不回填。
 * 缩略图与 HD 图是同源降采样，比例理论上一致、只差整数像素舍入（< 0.1%）；
 * 不设阈值的话，img src 从缩略图切到 HD 时还会再触发一次回填，进而重排整墙。
 * 0.1% 既足够过滤这类重复回填，又不会拦掉元数据失准的首次纠正
 * （先与当前有效比例比较，准确元数据无需因每次 load 再重排整墙）。
 */
const RATIO_UPDATE_EPSILON = 0.001

export interface ArtworkRatioDeps {
  /** 缩略图去重集合，与 HD 加载路径共用，同一张图并发只生成一次 */
  pending: Set<string>
  /** 该作品是否已有缩略图 */
  hasThumb: (item: ArtworkRecord) => boolean
  /** 缩略图落盘并写回运行时缓存；imageId 由调用方保证非空 */
  saveThumb: (item: ArtworkRecord, dataUrl: string, imageId: string) => Promise<void>
}

/**
 * 作品画幅（宽高比）的实测与纠正。
 *
 * 等高行展墙完全依赖准确的宽高比：比例错了，画框和图片就会对不上，行也排不齐。
 * 而 `size` 字段记的是保存快照那一刻下拉框里的值，不是真实像素——中途切场景
 * 把尺寸改成横图再保存，竖图就会套上横构图的框。所以真正解码出来的
 * naturalWidth/Height 优先，元数据只在还没解码时兜底。
 */
export function useArtworkRatios(deps: ArtworkRatioDeps) {
  /** 图片解码后回填的真实比例，reactive 以便排版 computed 自动重排 */
  const measuredRatios = reactive<Record<string, number>>({})

  /** 只挡脏数据（非有限/非正），合法真实比例原样透传 */
  function sanitizeRatio(r: number): number {
    return Number.isFinite(r) && r > 0 ? r : RATIO_FALLBACK
  }

  function ratioOf(item: ArtworkRecord): number {
    const measured = measuredRatios[item.id]
    if (measured) return sanitizeRatio(measured)
    let w = Number(item.width || item.image_width || item.actual?.width)
    let h = Number(item.height || item.image_height || item.actual?.height)
    if (!(w > 0 && h > 0)) {
      const m = String(item.size || '').match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i)
      if (m) { w = Number(m[1]); h = Number(m[2]) }
    }
    return sanitizeRatio(w > 0 && h > 0 ? w / h : RATIO_FALLBACK)
  }

  /** 高清图解码成功后顺手回填缩略图缓存，用已解码的 img 绘制，零额外解码 */
  async function backfillThumb(item: ArtworkRecord, img: HTMLImageElement) {
    const imageId = item.image_id
    if (!imageId || deps.pending.has(imageId) || deps.hasThumb(item)) return
    deps.pending.add(imageId)
    try {
      const dataUrl = jpegThumbDataUrl(img)
      if (dataUrl) await deps.saveThumb(item, dataUrl, imageId)
    } catch { /* 缩略图只是缓存，失败不影响展示 */ }
    finally { deps.pending.delete(imageId) }
  }

  /** 图片解码完成后用真实像素纠正画框 */
  function measure(item: ArtworkRecord, e: Event) {
    const img = e.target as HTMLImageElement
    if (!img.naturalWidth || !img.naturalHeight) return
    const r = img.naturalWidth / img.naturalHeight
    if (Math.abs(ratioOf(item) - r) > RATIO_UPDATE_EPSILON) measuredRatios[item.id] = r
    if (img.naturalWidth >= 700) void backfillThumb(item, img)
  }

  /** 作品被删除后丢掉它的实测值 */
  function forgetRatio(id: string | number) { delete measuredRatios[id] }

  return { measuredRatios, ratioOf, measure, forgetRatio }
}
