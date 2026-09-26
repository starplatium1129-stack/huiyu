import { getNativeLive2dCapabilities } from '../platform/desktop/nativeLive2d.ts'
/**
 * 后端工厂与回退逻辑。
 *
 * 选择顺序：
 * 1. 显式请求 native 且桥可用（getNativeLive2dCapabilities()）→ native
 * 2. 显式请求 native 但桥缺失 → 自动回退 browser，并标记 fallback
 * 3. 默认/浏览器请求 → browser
 *
 * 回退信息通过返回值暴露（fallbackReason），useLive2D 把它写进
 * host.dataset（E2E 可断言）并提示用户当前是浏览器渲染。
 */

import { createNativeLive2DBackend, type NativeBridgeProvider } from './nativeBackend.ts'
import { BROWSER_CAPABILITY, type Live2DBackendKind, type Live2DStageBackend } from './types.ts'

function createBrowserLive2DBackend(): Live2DStageBackend {
  return { kind: 'browser', capability: BROWSER_CAPABILITY, async connect(options) {
    const { createBrowserLive2DBackend: create } = await import('./browserBackend.ts')
    options.signal?.throwIfAborted()
    return create().connect(options)
  } }
}

export interface BackendSelection {
  backend: Live2DStageBackend
  /** 实际生效的后端 */
  effectiveKind: Live2DBackendKind
  /** 请求 native 但不可用时的回退说明；否则为 null */
  fallbackReason: string | null
}

export function selectLive2DBackend(
  requestedKind: Live2DBackendKind = 'browser',
  bridgeProvider: NativeBridgeProvider = () => {
    if (typeof window === 'undefined') return undefined
    return getNativeLive2dCapabilities()
  },
): BackendSelection {
  if (requestedKind !== 'native') {
    return { backend: createBrowserLive2DBackend(), effectiveKind: 'browser', fallbackReason: null }
  }
  const bridge = bridgeProvider()
  if (bridge) {
    return { backend: createNativeLive2DBackend(bridgeProvider), effectiveKind: 'native', fallbackReason: null }
  }
  return {
    backend: createBrowserLive2DBackend(),
    effectiveKind: 'browser',
    fallbackReason: '原生 Live2D 桥不可用，已回退到浏览器渲染',
  }
}
