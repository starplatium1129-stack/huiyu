import type { Live2DStageSession } from '@/live2d/types'
import { selectLive2DBackend } from '@/live2d/createBackend'
import { live2DTextureScale } from '@/live2d/quality'
import type { Live2DCtx } from '@/composables/live2d/context'
import type { Live2DModelInfo } from '@/composables/live2d/catalog'
import { errorMessage } from './lifecycleUtils'

interface ConnectOptions {
  ctx: Live2DCtx
  char: string
  info: Live2DModelInfo
  signal: AbortSignal
  preferOptimizedBrowserModel: boolean
}

/** Starts one backend connection without adding an extra promise hop. */
export function connectSession(options: ConnectOptions): Promise<Live2DStageSession> {
  const { ctx, char, info, signal, preferOptimizedBrowserModel } = options
  if (!ctx.backend) throw new Error('Live2D backend is not initialized')
  return ctx.backend.connect({
    signal,
    selector: ctx.hostSelector,
    modelUrl: preferOptimizedBrowserModel && ctx.quality.value !== 'original'
      ? `/api/live2d-model/${char}/${ctx.quality.value}`
      : info.modelUrl,
    textureScale: live2DTextureScale(ctx.quality.value),
    canvasWidth: info.canvas?.width || 420,
    canvasHeight: info.canvas?.height || 610,
    character: char,
    adapter: ctx.adapter || undefined,
  })
}

interface BrowserFallbackOptions extends ConnectOptions {
  error: unknown
  isCurrent: () => boolean
  selectAdapter: (char: string, backendKind?: 'browser' | 'native') => boolean
  fallback: (text: string, detail: string) => void
}

/** Performs the one authoritative native→browser retry after a native connect failure. */
export async function recoverBrowserAfterNativeFailure(options: BrowserFallbackOptions): Promise<Live2DStageSession | null> {
  const { ctx, char, error, isCurrent, selectAdapter, fallback } = options
  if (!isCurrent()) return null
  const message = errorMessage(error)
  if (ctx.backendKind.value !== 'native' || ctx.backend?.kind !== 'native') {
    fallback('Live2D 初始化失败', message)
    return null
  }

  const selection = selectLive2DBackend('browser')
  ctx.backend = selection.backend
  ctx.backendKind.value = 'browser'
  if (!selectAdapter(char, 'browser')) {
    fallback('Live2D 适配失败', '当前 Profile 不支持原生回退后的浏览器后端')
    return null
  }
  ctx.backendFallback.value = `原生 Live2D 初始化失败，已回退到浏览器渲染：${message}`
  if (ctx.hostEl) ctx.hostEl.dataset.backend = 'browser-fallback'
  console.warn('[live2d]', ctx.backendFallback.value)

  try {
    return await connectSession({ ...options, preferOptimizedBrowserModel: true })
  } catch (browserError) {
    if (isCurrent()) fallback('Live2D 初始化失败', errorMessage(browserError))
    return null
  }
}
