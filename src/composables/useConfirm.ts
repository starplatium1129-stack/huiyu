import { ref } from 'vue'

/**
 * 全局确认弹窗（2026-08-29 UX 审计 P1：原生 confirm() 收编）。
 * 与 useToast 同构的模块级单例：App.vue 挂载一次 <ConfirmDialog/>，
 * 任意视图/composable 调 confirmAction() 拿 Promise<boolean>。
 * 不做 isCompanion 隔离——陪伴页里的清空对话等破坏性操作同样需要它。
 */

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 破坏性操作红样式；调用点迁移时默认 true，明确无害的恢复/重置类传 false */
  danger?: boolean
  signal?: AbortSignal
}

export interface ConfirmDialogState {
  visible: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
}

const state = ref<ConfirmDialogState>({
  visible: false,
  title: '',
  message: '',
  confirmLabel: '确认',
  cancelLabel: '取消',
  danger: true,
})

let resolver: ((ok: boolean) => void) | null = null

/**
 * 替代原生 confirm()。同一时刻只保留一个弹窗：新调用会让前一等待方收到 false
 * （与原生串行阻塞语义最接近的等价物，避免无限排队）。
 */
export function confirmAction(options: ConfirmOptions | string): Promise<boolean> {
  // 无 DOM 环境（node 单测）无法渲染弹窗：fail-closed 直接拒绝，
  // 避免宿主 await 一个永远悬置的 Promise。
  if (typeof document === 'undefined') return Promise.resolve(false)
  const opts = typeof options === 'string' ? { title: options } : options
  if (opts.signal?.aborted) return Promise.resolve(false)
  if (resolver) resolver(false)
  state.value = {
    visible: true,
    title: opts.title,
    message: opts.message ?? '',
    confirmLabel: opts.confirmLabel ?? '确认',
    cancelLabel: opts.cancelLabel ?? '取消',
    danger: opts.danger ?? true,
  }
  return new Promise<boolean>((resolve) => {
    const abort = () => finish(false)
    const finish = (ok: boolean) => {
      opts.signal?.removeEventListener('abort', abort)
      if (resolver === finish) { state.value.visible = false; resolver = null }
      resolve(ok)
    }
    resolver = finish
    opts.signal?.addEventListener('abort', abort, { once: true })
  })
}

/** 仅供 ConfirmDialog 宿主组件调用 */
export function resolveConfirm(ok: boolean) {
  if (state.value.visible) state.value.visible = false
  resolver?.(ok)
  resolver = null
}

/** 仅供 ConfirmDialog 宿主组件读取 */
export function useConfirmState() {
  return state
}
