/*!
 * Adapted from Magic UI RippleButton to Vue and the atelier motion contract.
 * Source: https://github.com/magicuidesign/magicui/blob/85f97fd27b053339af74ba9dd4ca428ee25989fb/apps/www/registry/magicui/ripple-button.tsx
 * MIT License
 *
 * Copyright (c) Magic UI
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { onActivated, onDeactivated, onMounted, onScopeDispose } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'

/** Visual feedback only. Native click, disabled state and keyboard activation stay with the button. */
export function usePressRipple(enabled: () => boolean = () => true) {
  const active = new Map<HTMLElement, { layer: HTMLElement; animation: Animation }>()
  let release: (() => void) | undefined

  function remove(button: HTMLElement) {
    const ripple = active.get(button)
    if (!ripple) return
    active.delete(button)
    ripple.animation.onfinish = ripple.animation.oncancel = null
    ripple.animation.cancel()
    ripple.layer.remove()
  }
  function clear() { for (const button of active.keys()) remove(button) }
  function preference() { if (document.hidden || prefersReducedMotion()) clear() }
  function start() { release ??= listenMotionChanges(preference) }
  function stop() { clear(); release?.(); release = undefined }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)

  return (event: MouseEvent) => {
    const button = event.currentTarget
    if (!(button instanceof HTMLButtonElement) || !enabled() || button.disabled
      || button.getAttribute('aria-disabled') === 'true' || event.detail === 0 || event.button !== 0
      || document.hidden || prefersReducedMotion() || typeof button.animate !== 'function') return
    remove(button)
    const rect = button.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    // Convert the pressed, scaled rect back to local CSS coordinates.
    const x = (event.clientX - rect.left) * button.offsetWidth / rect.width - button.clientLeft
    const y = (event.clientY - rect.top) * button.offsetHeight / rect.height - button.clientTop
    const size = Math.hypot(button.clientWidth, button.clientHeight) * 2
    const layer = document.createElement('span')
    layer.className = 'studio-press-ripple-surface'
    layer.setAttribute('aria-hidden', 'true')
    const dot = document.createElement('span')
    dot.className = 'studio-press-ripple-dot'
    Object.assign(dot.style, { width: `${size}px`, height: `${size}px`, left: `${x - size / 2}px`, top: `${y - size / 2}px` })
    layer.append(dot)
    button.append(layer)
    const style = getComputedStyle(button)
    const animation = dot.animate([
      { transform: 'scale(.1)', opacity: .08 },
      { transform: 'scale(1)', opacity: 0 },
    ], {
      duration: cssTimeToMilliseconds(style.getPropertyValue('--motion-control')),
      easing: style.getPropertyValue('--ease-out').trim(),
    })
    active.set(button, { layer, animation })
    animation.onfinish = animation.oncancel = () => remove(button)
  }
}
