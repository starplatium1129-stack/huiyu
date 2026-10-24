import { useFluidSurface, type SurfaceLayers } from './useFluidSurface'
export const VIEWER_IMAGE_SELECTOR = '.zoomable-img, .image-compare-slider .after-img, .pswp__item[aria-hidden="false"] .pswp__img:not(.pswp__img--placeholder)'

interface ImageOrigin {
  enter(image: HTMLImageElement, host: HTMLElement): void | Promise<void>
  leave(image: HTMLImageElement, host: HTMLElement, source?: HTMLImageElement | null): void | Promise<void>
  cancel(): void
}

/** Viewer-only choreography stays outside ordinary form/popover dependencies.
 * The surface owns every effect, including partial setup and interrupted exits. */
const animateLayers: SurfaceLayers = (el, opacity, timing, target, add) => {
  for (const part of el.querySelectorAll<HTMLElement>('.viewer-info,.viewer-close,.viewer-nav,.viewer-mode-switch,.viewer-info-toggle,.viewer-compare-toggle,.viewer-position,.zoom-toolbar,.gallery-orbit-caption,[data-viewer-chrome]')) {
    const base = getComputedStyle(part).transform
    const frames = opacity.map(({ opacity: value }) => {
      const progress = Math.max(0, Math.min(1, (value - .24) / .76))
      // The narrow information drawer keeps owning its horizontal transform.
      return { opacity: progress, ...(part.matches('.viewer-info') ? {} : {
        transform: `${base === 'none' ? '' : base} translateY(${(1 - progress) * 10}px)`,
      }) }
    })
    add(part.animate(frames, timing))
  }
  // Neighbor covers leave with the scrim. A missing return origin keeps a plain
  // image fade; the source-to-image proxy itself remains opaque during flight.
  const returning = target === 0 && el.querySelector('[data-image-origin-direction="leave"]')
  const pictures = '.gallery-orbit-card:not(.is-current)' + (returning ? '' : ',.zoom-viewport,.image-compare-slider,.pswp__scroll-wrap')
    + (target === 0 && !returning ? ',[data-image-origin-proxy]' : '')
  for (const part of el.querySelectorAll<HTMLElement>(pictures)) add(part.animate(opacity, timing))
}

export function useArtworkViewerSurface(imageOrigin: ImageOrigin, source?: () => HTMLImageElement | null) {
  const surface = useFluidSurface(undefined, { layers: animateLayers })
  return {
    ...surface,
    enter(el: Element, done: () => void) {
      surface.enter(el, done)
      const image = el.querySelector<HTMLImageElement>(VIEWER_IMAGE_SELECTOR)
      if (image) void imageOrigin.enter(image, el as HTMLElement)
    },
    leave(el: Element, done: () => void) {
      // Native focus closes now; only the inert exit picture flies back.
      const image = el.querySelector<HTMLImageElement>(VIEWER_IMAGE_SELECTOR)
      if (image) void imageOrigin.leave(image, el as HTMLElement, source?.())
      surface.leave(el, () => { imageOrigin.cancel(); done() })
    },
  }
}
