import { ref, watch, onActivated, onDeactivated, onUnmounted, nextTick, type Ref } from 'vue'

/**
 * 弹层焦点管理。
 *
 * 抽自 GalleryView —— 审计时 6 个弹层里只有它做对了（存取焦点、真 Tab 陷阱、
 * Escape、滚动锁），其余 5 个连 role="dialog" 都没有，Tab 能直接跑到背景内容上。
 * 破坏性最强的场景编辑器当时只有 @click.self。
 *
 * 用法：
 *   const overlay = ref<HTMLElement | null>(null)
 *   useFocusTrap(overlay, () => editing.value !== null, { onEscape: closeModal })
 */

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface ActiveTrap {
  owner: symbol
  returnFocus: Ref<HTMLElement | null>
  focus: () => void
}

const trapStack: ActiveTrap[] = []
const scrollLocks = new Set<symbol>()
let previouslyLocked = false

export interface FocusTrapOptions {
  /** Escape 键回调；不传则不处理 Escape */
  onEscape?: () => void
  /** 打开时锁 body 滚动（加 .overlay-open） */
  lockScroll?: boolean
  /** 打开后要聚焦的元素；默认第一个可聚焦元素 */
  initialFocus?: Ref<HTMLElement | null>
}

export function useFocusTrap(
  root: Ref<HTMLElement | null>,
  isOpen: () => boolean,
  options: FocusTrapOptions = {},
) {
  const { onEscape, lockScroll = true, initialFocus } = options
  /** 打开前的焦点位置，关闭后要还回去 */
  const returnFocus = ref<HTMLElement | null>(null)
  const attached = ref(true)
  const owner = Symbol('focus-trap')
  let fallbackRoot: HTMLElement | null = null
  let activeRoot: HTMLElement | null = null
  const trap: ActiveTrap = { owner, returnFocus, focus: focusInitial }

  function isActive() {
    if (!attached.value || !isOpen() || trapStack.at(-1)?.owner !== owner) return false
    // showModal 的原生顶层不在自定义栈中；让它接管焦点、Tab 和 Escape。
    // 通过当前焦点识别原生模态，保留其内部自定义弹层的键盘行为。
    const nativeModal = document.activeElement?.closest('dialog:modal')
    if (nativeModal) return !!root.value && nativeModal.contains(root.value)
    return !document.querySelector('dialog:modal')
  }

  function isAvailable(el: HTMLElement) {
    const style = getComputedStyle(el)
    return el.isConnected && !el.matches(':disabled') && !el.closest('[inert], [hidden]')
      && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && el.getClientRects().length > 0
  }

  function focusableIn(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => el.tabIndex >= 0 && isAvailable(el))
  }

  function focusRoot(container: HTMLElement) {
    if (!container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1')
      fallbackRoot = container
    }
    container.focus({ preventScroll: true })
  }

  function focusInitial() {
    const container = root.value
    if (!container || !isActive()) return
    activeRoot = container
    const preferred = initialFocus?.value
    const target = preferred && container.contains(preferred) && isAvailable(preferred)
      ? preferred : focusableIn(container)[0]
    if (target) target.focus({ preventScroll: true })
    else focusRoot(container)
  }

  function onFocusin(event: FocusEvent) {
    if (isActive() && root.value && !root.value.contains(event.target as Node)) focusInitial()
  }

  function onKeydown(event: KeyboardEvent) {
    if (!isActive() || event.defaultPrevented || event.isComposing || event.keyCode === 229) return

    if (event.key === 'Escape' && onEscape) {
      event.preventDefault()
      onEscape()
      return
    }
    if (event.key !== 'Tab') return

    const container = root.value
    if (!container) return
    const focusable = focusableIn(container)
    if (!focusable.length) { event.preventDefault(); focusRoot(container); return }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!focusable.includes(document.activeElement as HTMLElement)) {
      // 空弹层的根节点、被移除或禁用的控件都不在当前 Tab 顺序中。
      event.preventDefault(); (event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }

  document.addEventListener('keydown', onKeydown)
  document.addEventListener('focusin', onFocusin)

  function release(restoreFocus: boolean) {
    const top = trapStack.at(-1) === trap
    const index = trapStack.indexOf(trap)
    if (index >= 0) {
      // 父弹层先关闭时，仍打开的子弹层应继承它的返回点。
      const container = root.value ?? activeRoot
      for (const nested of trapStack.slice(index + 1)) {
        if (container?.contains(nested.returnFocus.value)) nested.returnFocus.value = returnFocus.value
      }
      trapStack.splice(index, 1)
    }
    if (scrollLocks.delete(owner) && !scrollLocks.size && !previouslyLocked) document.body.classList.remove('overlay-open')
    if (restoreFocus && top) {
      if (returnFocus.value && isAvailable(returnFocus.value)) returnFocus.value.focus({ preventScroll: true })
      else trapStack.at(-1)?.focus()
    }
    returnFocus.value = null
    activeRoot = null
    if (fallbackRoot) { fallbackRoot.removeAttribute('tabindex'); fallbackRoot = null }
  }

  watch(() => attached.value && isOpen(), (open, wasOpen) => {
    if (open === wasOpen) return
    if (open) {
      returnFocus.value = document.activeElement as HTMLElement | null
      trapStack.push(trap)
      if (lockScroll) {
        if (!scrollLocks.size) previouslyLocked = document.body.classList.contains('overlay-open')
        scrollLocks.add(owner)
        document.body.classList.add('overlay-open')
      }
      nextTick(focusInitial)
    } else {
      release(attached.value)
    }
  }, { immediate: true })
  onActivated(() => { attached.value = true })
  onDeactivated(() => { attached.value = false })

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeydown)
    document.removeEventListener('focusin', onFocusin)
    release(attached.value)
  })

  return { returnFocus }
}
