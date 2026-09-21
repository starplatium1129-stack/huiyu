import { createBrowserLive2DBackend } from './browserBackend'
import { normalizeModelPath, type ModelInspection } from './modelInspector'
import type { Live2DModelHandle, Live2DStageSession } from './types'

export const MODEL_PREVIEW_LIMITS = Object.freeze({ dependencyBytes: 96 * 1024 * 1024, encodedBytes: 128 * 1024 * 1024 })

function dataUrl(file: File, type: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const finish = (error?: Error, result?: string) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      reader.onload = reader.onerror = reader.onabort = null
      if (error) reject(error); else resolve(result!)
    }
    const abort = () => { reader.abort(); finish(new Error('预览已取消')) }
    const timer = setTimeout(() => { reader.abort(); finish(new Error('预览资源读取超时')) }, 10000)
    reader.onload = () => typeof reader.result === 'string' ? finish(undefined, reader.result) : finish(new Error('预览资源读取失败'))
    reader.onerror = () => finish(new Error('预览资源读取失败'))
    reader.onabort = () => finish(new Error('预览已取消'))
    signal.addEventListener('abort', abort, { once: true })
    try { reader.readAsDataURL(new Blob([file], { type })) } catch { finish(new Error('预览资源读取失败')) }
  })
}

/** Only the manifest uses an owned blob URL. data: dependencies survive legacy URL resolution. */
export async function createModelPreviewUrls(inspection: ModelInspection, signal = new AbortController().signal) {
  if (!inspection.valid || !inspection.modelJson) throw new Error('请先通过文件检查')
  signal.throwIfAborted()
  const files = new Map(inspection.entries.map(entry => [entry.path, entry.file]))
  if (!normalizeModelPath(inspection.entryPath) || !files.has(inspection.entryPath)) throw new Error('模型入口不在文件清单中')
  const model = structuredClone(inspection.modelJson)
  const base = inspection.entryPath.slice(0, inspection.entryPath.lastIndexOf('/') + 1)
  const slots: { target: Record<string, unknown> | unknown[]; key: string | number; path: string; type: string }[] = []
  const dependencies = new Map<string, File>()
  let encodedBytes = files.get(inspection.entryPath)!.size
  const include = (target: Record<string, unknown> | unknown[], key: string | number) => {
    const reference = (target as Record<string | number, unknown>)[key]
    if (typeof reference !== 'string' || !normalizeModelPath(reference)) throw new Error('无效模型引用')
    const path = base + reference, file = files.get(path)
    if (!file) throw new Error(`缺少引用：${reference}`)
    const extension = path.split('.').at(-1)!.toLowerCase()
    const type = ({ json: 'application/json', moc3: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[extension]
    if (!type) throw new Error('预览引用了不支持的文件类型')
    dependencies.set(path, file)
    encodedBytes += Math.ceil(file.size / 3) * 4 + type.length + 32
    if (encodedBytes > MODEL_PREVIEW_LIMITS.encodedBytes) throw new Error('预览编码超过 128 MiB 限制，请精简模型资源')
    slots.push({ target, key, path, type })
  }
  const refs = model.FileReferences as Record<string, unknown>
  for (const key of ['Moc', 'Physics', 'Pose', 'DisplayInfo', 'UserData']) if (refs[key]) include(refs, key)
  for (let index = 0; index < (refs.Textures as unknown[]).length; index++) include(refs.Textures as unknown[], index)
  for (const entry of (refs.Expressions || []) as Record<string, unknown>[]) include(entry, 'File')
  for (const group of Object.values(refs.Motions || {}) as Record<string, unknown>[][]) {
    for (const entry of group) { include(entry, 'File'); delete entry.Sound }
  }
  if ([...dependencies.values()].reduce((total, file) => total + file.size, 0) > MODEL_PREVIEW_LIMITS.dependencyBytes) throw new Error('浏览器预览仅支持最多 96 MiB 的模型依赖，请精简资源')
  delete model.Controllers; delete model.Options
  const encoded = new Map<string, string>()
  for (const slot of slots) {
    if (!encoded.has(slot.path)) encoded.set(slot.path, await dataUrl(dependencies.get(slot.path)!, slot.type, signal))
    ;(slot.target as Record<string | number, unknown>)[slot.key] = encoded.get(slot.path)!
  }
  signal.throwIfAborted()
  const json = JSON.stringify(model)
  if (json.length > MODEL_PREVIEW_LIMITS.encodedBytes) throw new Error('预览配置超过内存限制')
  const modelUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  let released = false
  const release = () => {
    if (released) return
    released = true; signal.removeEventListener('abort', release); URL.revokeObjectURL(modelUrl)
  }
  signal.addEventListener('abort', release, { once: true })
  return { modelUrl, release }
}

export async function connectModelPreview(selector: string, modelUrl: string, signal: AbortSignal,
  loaded: (model: Live2DModelHandle) => void, failed: (error: Error) => void): Promise<Live2DStageSession> {
  const host = document.querySelector<HTMLElement>(selector)
  const dimensions = () => ({ width: host?.clientWidth || 440, height: host?.clientHeight || 480 })
  const initialSize = dimensions()
  const session = await createBrowserLive2DBackend().connect({ selector, modelUrl,
    character: 'preview', canvasWidth: initialSize.width, canvasHeight: initialSize.height, signal })
  if (signal.aborted) { session.destroy(); throw new Error('预览已取消') }
  let disposed = false
  let currentModel: Live2DModelHandle | null = null
  let observer: ResizeObserver | null = null
  const destroy = () => {
    if (disposed) return
    disposed = true; currentModel = null; observer?.disconnect(); signal.removeEventListener('abort', destroy); session.destroy()
  }
  const fail = (error: Error) => {
    if (disposed || signal.aborted) return
    try { failed(error) } finally { destroy() }
  }
  signal.addEventListener('abort', destroy, { once: true })
  const fit = () => {
    if (disposed || !currentModel) return
    const size = currentModel.getNaturalSize(), canvas = dimensions()
    if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('模型尺寸无效')
    session.resizeCanvas?.(canvas.width, canvas.height)
    const scale = Math.min(Math.max(1, canvas.width - 40) / size.width, Math.max(1, canvas.height - 40) / size.height)
    // Pixi Live2DModel defaults to top-left anchor (0, 0), matching layoutFit.ts.
    currentModel.applyFit(scale, (canvas.width - size.width * scale) / 2, (canvas.height - size.height * scale) / 2)
  }
  try {
    session.setMaxFps(30)
    session.onModelError(fail)
    session.onModelLoaded(model => {
      if (disposed || signal.aborted) return
      try {
        currentModel = model; fit()
        loaded(model)
      } catch (error) { fail(error instanceof Error ? error : new Error('预览初始化失败')) }
    })
    if (!disposed && host && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        try { fit() } catch (error) { fail(error instanceof Error ? error : new Error('预览尺寸更新失败')) }
      })
      observer.observe(host)
    }
    return { ...session, destroy }
  } catch (error) { destroy(); throw error }
}
