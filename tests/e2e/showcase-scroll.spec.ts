import { expect, test } from '@playwright/test'
import { installShowcaseFixture } from './helpers/showcase'
// One native-focus regression and one normal keyboard/narrow-screen path.
const cases = [
  { theme: 'light', close: 'button', nativeReset: true },
  { theme: 'dark', close: 'escape', nativeReset: false },
] as const
for (const { theme, close, nativeReset } of cases) {
  test(`reference preview keeps reading position ${theme} ${close} native-reset=${nativeReset}`,async({page})=>{
    await page.setViewportSize({width:close==='button'?1440:390,height:1000})
    await page.emulateMedia({reducedMotion:'no-preference'})
    await page.addInitScript(theme=>localStorage.setItem('aics_theme',theme),theme)
    await page.route('**/scene-showcase/manifest.json',route=>route.fulfill({json:{entries:Array.from({length:48},(_,i)=>({id:'scroll-'+i,title:'滚动检查 '+i,char:'nene',rating:'All',type:'scene',width:832,height:1216,thumb:`thumbs/ui-${i%8}.jpg`,image:`images/ui-${i%8}.jpg`}))}}))
    await page.goto('/showcase')
    const opener=page.locator('.sample-visual').nth(20)
    await opener.scrollIntoViewIfNeeded()
    const y=await page.evaluate(()=>scrollY)
    expect(y).toBeGreaterThan(1000)
    await opener.click()
    const dialog=page.locator('dialog.showcase-viewer')
    await expect(dialog).toBeVisible()
    await dialog.evaluate((el,reset)=>{
      // Model the WebView native focus task that can reset the document during close.
      // Observe every frame: a correct final coordinate alone misses the visible jump.
      if(reset) el.addEventListener('close',()=>window.scrollTo({top:0,behavior:'instant'}),{once:true,capture:true})
      const state=window as unknown as { closeFrames:number[];trackClose:boolean }
      state.closeFrames=[];state.trackClose=true
      const frame=()=>{if(!state.trackClose)return;state.closeFrames.push(scrollY);requestAnimationFrame(frame)}
      requestAnimationFrame(frame)
    },nativeReset)
    if(close==='button') await page.getByRole('button',{name:'关闭大图',exact:true}).click()
    else await page.keyboard.press('Escape')
    await expect(dialog).not.toHaveAttribute('open','')
    const positions=await page.evaluate(()=>new Promise<number[]>(resolve=>{
      const state=window as unknown as { closeFrames:number[];trackClose:boolean };let frames=0
      const sample=()=>{if(++frames<40){requestAnimationFrame(sample);return}state.trackClose=false;resolve(state.closeFrames)}
      requestAnimationFrame(sample)
    }))
    expect(Math.max(...positions.map(position=>Math.abs(position-y)))).toBeLessThanOrEqual(1)
    await expect(opener).toBeFocused()
    expect(await page.evaluate(()=>scrollY)).toBe(y)
    if(!nativeReset){
      await opener.click()
      await page.getByRole('link',{name:'在工作台打开',exact:true}).click()
      await expect(page).toHaveURL(/\/prompt-builder\?/)
      await expect(page.locator('.pb')).toBeVisible()
      await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0)
    }
  })
}

for (const theme of ['light', 'dark']) {
  test(`preview keeps its image throughout dismissal and can reopen ${theme}`, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await installShowcaseFixture(page)
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/showcase')
    const opener = page.locator('.sample-visual').first()
    const dialog = page.locator('dialog.showcase-viewer')
    for (let attempt = 0; attempt < 2; attempt++) {
      const opening = await opener.evaluate(button => new Promise<number[]>(resolve => {
        const opacities: number[] = []
        ;(button as HTMLElement).focus({ preventScroll: true })
        ;(button as HTMLElement).click()
        const sample = () => {
          const dialog = document.querySelector<HTMLDialogElement>('dialog.showcase-viewer')!
          if (dialog.open) {
            const opacity = Number(getComputedStyle(dialog).opacity)
            opacities.push(opacity)
            if (opacity === 1) { resolve(opacities); return }
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }))
      expect(opening.some(value => value > .15 && value < .85)).toBe(true)
      await expect(dialog.locator('.zoomable-img')).toHaveClass(/is-ready/)
      await expect(dialog).toHaveCSS('opacity', '1')
      await dialog.getByRole('link', { name: '在工作台打开', exact: true }).hover()
      await expect(dialog.locator('.studio-tooltip')).toBeVisible()
      await page.screenshot({ path: info.outputPath(`preview-${theme}-${attempt}.png`) })
      const result = await dialog.evaluate(el => new Promise<{ frames: number; blank: number; backdrops: number[]; scales: number[]; opacities: number[] }>(resolve => {
        let frames = 0, blank = 0
        const backdrops: number[] = [], scales: number[] = [], opacities: number[] = []
        const image = el.querySelector('.zoomable-img')
        const sample = () => {
          if (!(el as HTMLDialogElement).open) { resolve({ frames, blank, backdrops, scales, opacities }); return }
          frames++
          opacities.push(Number(getComputedStyle(el).opacity))
          backdrops.push(Number(getComputedStyle(el, '::backdrop').opacity))
          const panel = el.querySelector('.viewer-layout')
          if (panel) scales.push(new DOMMatrixReadOnly(getComputedStyle(panel).transform).a)
          if (Number(getComputedStyle(el).opacity) > .05 && (!image?.isConnected || !el.querySelector('.viewer-layout'))) blank++
          requestAnimationFrame(sample)
        }
        ;(el.querySelector('#viewerClose') as HTMLButtonElement).click()
        requestAnimationFrame(sample)
      }))
      expect(result.frames).toBeGreaterThan(0)
      expect(result.blank).toBe(0)
      expect(result.opacities.some(value => value > .15 && value < .85)).toBe(true)
      expect(result.backdrops.some(value => value > .15 && value < .85)).toBe(true)
      expect(result.scales.every(value => value === 1)).toBe(true)
      await expect(opener).toBeFocused()
      await expect(dialog.locator('.viewer-layout')).toHaveCount(0)
    }
    expect(errors).toEqual([])
  })
}

for (const theme of ['light', 'dark']) {
  for (const motion of ['no-preference', 'reduce'] as const) {
    test(`sticky artbook search stays in place across preview ${theme} ${motion}`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.emulateMedia({ reducedMotion: motion })
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      await installShowcaseFixture(page)
      await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: {
        entries: Array.from({ length: 48 }, (_, i) => ({ id: 'sticky-' + i, title: '吸顶检查 ' + i, char: 'nene', rating: 'All', type: 'scene', width: 832, height: 1216 })),
      } }))
      await page.goto('/showcase')
      const toolbar = page.locator('.toolbar-shell')
      const opener = page.locator('.sample-visual').nth(20)
      await opener.scrollIntoViewIfNeeded()
      await expect(toolbar).toHaveCSS('opacity', '1')
      await expect(toolbar).toHaveCSS('transform', 'none')
      const top = await toolbar.evaluate(el => el.getBoundingClientRect().top)
      const y = await page.evaluate(() => scrollY)
      expect(y).toBeGreaterThan(1000)
      expect(top).toBeGreaterThan(0)
      expect(top).toBeLessThan(100)
      const dialog = page.locator('dialog.showcase-viewer')
      // Sample the real pointer activation position: Playwright may scroll a
      // partially covered card into view before dispatching the click.
      await opener.evaluate(el => el.addEventListener('click', () => {
        el.setAttribute('data-opening-scroll-y', String(scrollY))
      }, { capture: true, once: true }))
      await opener.click()
      const openingY = Number(await opener.getAttribute('data-opening-scroll-y'))
      await expect(dialog).toHaveCSS('opacity', '1')
      expect(await toolbar.evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(top, 0)
      const frames = await dialog.evaluate(el => new Promise<Array<{ top: number; y: number; opacity: number }>>(resolve => {
        const samples: Array<{ top: number; y: number; opacity: number }> = []
        const toolbar = document.querySelector('.toolbar-shell')!
        let closedFrames = 0
        const sample = () => {
          samples.push({ top: toolbar.getBoundingClientRect().top, y: scrollY, opacity: Number(getComputedStyle(toolbar).opacity) })
          if (!(el as HTMLDialogElement).open && ++closedFrames === 3) { resolve(samples); return }
          requestAnimationFrame(sample)
        }
        ;(el.querySelector('#viewerClose') as HTMLButtonElement).click()
        requestAnimationFrame(sample)
      }))
      await info.attach('sticky-frames', { body: JSON.stringify({ y, openingY, top, frames }), contentType: 'application/json' })
      expect(Math.max(...frames.map(frame => Math.abs(frame.top - top)))).toBeLessThanOrEqual(1)
      expect(Math.max(...frames.map(frame => Math.abs(frame.y - openingY)))).toBeLessThanOrEqual(1)
      expect(frames.every(frame => frame.opacity === 1)).toBe(true)
      await expect(opener).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath(`sticky-search-${theme}-${motion}.png`) })
    })
  }
}

for (const theme of ['light', 'dark']) {
  test(`artbook image expands from its thumbnail and returns ${theme}`, async ({ page }, info) => {
    await installShowcaseFixture(page)
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/showcase')
    const opener = page.locator('.sample-visual').first()
    await opener.scrollIntoViewIfNeeded()
    await expect(opener.locator('img')).toHaveClass(/sample-image-ready/)
    await expect(page.locator('.showcase-grid')).toHaveCSS('transform', 'none')
    const source = await opener.locator('img').boundingBox()
    const flight = await opener.evaluate(button => new Promise<Array<{ x: number; y: number; w: number; h: number }>>(resolve => {
      const samples: Array<{ x: number; y: number; w: number; h: number }> = []
      ;(button as HTMLElement).focus({ preventScroll: true }); (button as HTMLElement).click()
      let frames = 0
      const sample = () => {
        const proxy = document.querySelector('[data-image-origin-proxy]')
        if (proxy) { const r = proxy.getBoundingClientRect(); samples.push({ x: r.x, y: r.y, w: r.width, h: r.height }) }
        if (++frames > 50) { resolve(samples); return }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }))
    expect(flight.length).toBeGreaterThan(3)
    expect(Math.abs(flight[0].w - source!.width)).toBeLessThan(60)
    const dialog = page.locator('.showcase-viewer')
    await expect(dialog.locator('[data-image-origin-proxy]')).toHaveCount(0)
    const target = await dialog.locator('.zoomable-img').boundingBox()
    expect(Math.abs(flight.at(-1)!.w - target!.width)).toBeLessThan(4)
    await page.screenshot({ path: info.outputPath(`image-origin-open-${theme}.png`) })
    const returning = await dialog.evaluate(el => new Promise<Array<{ x: number; y: number; w: number; h: number }>>(resolve => {
      const samples: Array<{ x: number; y: number; w: number; h: number }> = []
      const sample = () => {
        const proxy = el.querySelector('[data-image-origin-proxy]')
        if (proxy) { const r = proxy.getBoundingClientRect(); samples.push({ x: r.x, y: r.y, w: r.width, h: r.height }) }
        if (!(el as HTMLDialogElement).open) { resolve(samples); return }
        requestAnimationFrame(sample)
      }
      ;(el.querySelector('#viewerClose') as HTMLButtonElement).click()
      requestAnimationFrame(sample)
    }))
    expect(returning.length).toBeGreaterThan(3)
    const last = returning.at(-1)!
    expect(Math.abs(last.x - source!.x)).toBeLessThan(2)
    expect(Math.abs(last.y - source!.y)).toBeLessThan(2)
    expect(Math.abs(last.w - source!.width)).toBeLessThan(2)
    await expect(page.locator('[data-image-origin-proxy]')).toHaveCount(0)
    await expect(opener).toBeFocused()
    await page.screenshot({ path: info.outputPath(`image-origin-return-${theme}.png`) })
    await page.setViewportSize({ width: 390, height: 844 })
    await opener.click()
    await expect(dialog.locator('.zoomable-img')).toHaveClass(/is-ready/)
    await expect(dialog).toHaveCSS('opacity', '1')
    const bounds = await dialog.locator('.zoomable-img').evaluate(img => {
      const picture = img.getBoundingClientRect(), canvas = img.closest('.zoomable-image-viewer')!.getBoundingClientRect()
      return { clipped: picture.top < canvas.top - 1 || picture.bottom > canvas.bottom + 1 || picture.left < canvas.left - 1 || picture.right > canvas.right + 1 }
    })
    expect(bounds.clipped).toBe(false)
    await page.screenshot({ path: info.outputPath(`image-origin-phone-${theme}.png`) })
    await page.getByRole('button', { name: '放大图片', exact: true }).click()
    await expect(dialog.locator('.zoomable-image-viewer')).toHaveClass(/is-zoomed/)
    await page.getByRole('button', { name: '关闭大图', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-image-origin-proxy]')).toHaveCount(0)
  })
}

for (const theme of ['light', 'dark']) {
  test(`cold artbook preview keeps the clicked photo until its original decodes ${theme}`, async ({ page }, info) => {
    await installShowcaseFixture(page)
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    let releaseOriginal!: () => void
    const gate = new Promise<void>(resolve => { releaseOriginal = resolve })
    const originalUrls: string[] = []
    await page.route(/\/scene-showcase\/images\/[^?]+/, async route => {
      originalUrls.push(route.request().url())
      await gate
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1216"><rect width="832" height="1216" fill="#746687"/><text x="80" y="160" fill="white" font-size="48">ORIGINAL READY</text></svg>' })
    })
    await page.goto('/showcase')
    const opener = page.locator('.sample-visual').first()
    await opener.scrollIntoViewIfNeeded()
    await expect(opener.locator('img')).toHaveClass(/sample-image-ready/)
    const thumb = await opener.locator('img').evaluate((img: HTMLImageElement) => img.currentSrc)
    await opener.click()
    const dialog = page.locator('.showcase-viewer'), picture = dialog.locator('.zoomable-img')
    await expect.poll(() => originalUrls.length).toBe(1)
    await expect(dialog).toHaveCSS('opacity', '1')
    await expect(picture).toHaveClass(/is-ready/)
    expect(await picture.evaluate((img: HTMLImageElement) => img.currentSrc)).toBe(thumb)
    expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await expect(dialog.locator('.skeleton-placeholder')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`cold-photo-${theme}.png`) })
    const frames = page.evaluate(() => new Promise<Array<{ width: number; opacity: number; skeleton: boolean }>>(resolve => {
      const samples: Array<{ width: number; opacity: number; skeleton: boolean }> = []
      const sample = () => {
        const img = document.querySelector<HTMLImageElement>('.showcase-viewer .zoomable-img')!
        samples.push({ width: img.naturalWidth, opacity: Number(getComputedStyle(img).opacity), skeleton: !!document.querySelector('.showcase-viewer .skeleton-placeholder') })
        if (samples.length === 30) { resolve(samples); return }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }))
    releaseOriginal()
    await expect(picture).toHaveAttribute('src', /\/images\//)
    expect((await frames).every(frame => frame.width > 0 && frame.opacity === 1 && !frame.skeleton)).toBe(true)
    await page.getByRole('button', { name: '关闭大图', exact: true }).click()
    await expect(dialog).toBeHidden()
    await opener.click()
    await expect(dialog.locator('.zoomable-preload')).toHaveCount(0)
    await expect(picture).toHaveAttribute('src', /\/images\//)
    expect(new Set(originalUrls).size).toBe(1)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
}
