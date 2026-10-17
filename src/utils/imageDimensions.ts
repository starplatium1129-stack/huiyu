import { resolveRuntimeUrl, runtimeResourceIdentity } from '@/platform/runtimeUrl'

export interface ImageDimensions {
  readonly width: number
  readonly height: number
}

const dimensions = new Map<string, ImageDimensions>()
let identity: string | undefined
function imageKey(src: string | null | undefined): string {
  const current = runtimeResourceIdentity()
  if (identity !== current) { identity = current; dimensions.clear() }
  const url = resolveRuntimeUrl(src)
  // Inline image bytes must not become a cache key; only numeric geometry is retained.
  return url.startsWith('data:') ? '' : url
}

export function cachedImageDimensions(src: string | null | undefined): ImageDimensions | undefined {
  const key = imageKey(src), entry = dimensions.get(key)
  if (entry) { dimensions.delete(key); dimensions.set(key, entry) }
  return entry
}

export function rememberImageDimensions(src: string | null | undefined, width: number, height: number): ImageDimensions | undefined {
  const key = imageKey(src)
  if (!key || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  const entry = Object.freeze({ width, height })
  dimensions.delete(key); dimensions.set(key, entry)
  while (dimensions.size > 512) dimensions.delete(dimensions.keys().next().value!)
  return entry
}
