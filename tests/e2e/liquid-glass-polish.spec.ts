import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

// A deterministic material fixture, not a substitute for full-workspace visual review.
const css = ['design-system', 'light-theme', 'fluid-glass', 'glass-material-base', 'glass-materials']
  .map(name => readFileSync(resolve('src/assets/css', `${name}.css`), 'utf8')).join('\n')

async function materialFixture(page: Page, theme: string) {
  await page.setContent(`<html data-theme="${theme}" data-glass-material="liquid"><body>
    <section class="optics-stage"><div data-fluid-glass class="material-probe">
      <span class="primary">绘遇 HUIYU</span><span class="secondary">创作工作台</span>
      <span class="muted">场景与作品</span><button disabled>暂不可用</button>
    </div></section><article class="reading-probe">正文保持实体表面</article>
  </body></html>`)
  await page.addStyleTag({ content: css })
  await page.addStyleTag({ content: `
    body { margin:0; padding:24px; background:var(--bg-base); }
    .optics-stage { padding:32px 16px; background:linear-gradient(90deg, #000 50%, #fff 50%); }
    .material-probe { position:relative; display:flex; flex-wrap:wrap; align-items:center; gap:16px;
      min-height:72px; padding:20px 24px; border:1px solid; border-radius:24px; }
    .material-probe > * { font-size:14px; background:none; margin:0; }
    .primary { color:var(--text-primary); } .secondary { color:var(--text-secondary); }
    .muted { color:var(--text-muted); } .material-probe button { color:var(--text-disabled); border:0; }
    .reading-probe { margin-top:24px; padding:24px; background:var(--bg-surface); color:var(--text-primary); }
  ` })
}

for (const theme of ['light', 'dark']) {
  test(`native material keeps text readable without filtering foreground: ${theme}`, async ({ page }, testInfo) => {
    await materialFixture(page, theme)
    const glass = page.locator('.material-probe')
    await expect(glass).toHaveCSS('backdrop-filter', /blur\(14px\)/)
    await expect(glass).toHaveCSS('filter', 'none')
    await expect(page.locator('.reading-probe')).toHaveCSS('backdrop-filter', 'none')
    for (const child of await glass.locator(':scope > *').all()) {
      await expect(child).toHaveCSS('opacity', '1')
      await expect(child).toHaveCSS('filter', 'none')
    }
    // Resolve the native material and each control's own surface against worst-case backdrops.
    const ratios = await glass.evaluate(element => {
      const context = document.createElement('canvas').getContext('2d')!
      context.canvas.width = context.canvas.height = 1
      const color = (value: string) => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
      }
      const fill = color(getComputedStyle(element).backgroundColor)
      const composite = (foreground: number[], background: number[]) => foreground.slice(0, 3)
        .map((value, i) => value * foreground[3] / 255 + background[i] * (1 - foreground[3] / 255))
      const luminance = (rgb: number[]) => rgb.slice(0, 3).reduce((sum, value, i) => {
        const c = value / 255
        return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i]
      }, 0)
      return [0, 255].flatMap(backdrop => {
        const material = composite(fill, [backdrop, backdrop, backdrop])
        return [...element.children].map(child => {
          const background = luminance(composite(color(getComputedStyle(child).backgroundColor), material))
          const text = luminance(color(getComputedStyle(child).color))
          return (Math.max(text, background) + .05) / (Math.min(text, background) + .05)
        })
      })
    })
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: testInfo.outputPath(`liquid-reading-plane-${theme}.png`) })
  })

  test(`lightweight and reduced effects release the liquid surface: ${theme}`, async ({ page }) => {
    await materialFixture(page, theme)
    const glass = page.locator('.material-probe')
    for (const attribute of ['data-reduced-glass', 'data-fluid-effects']) {
      await page.locator('html').evaluate((root, attribute) => root.setAttribute(attribute, attribute === 'data-fluid-effects' ? 'low' : 'true'), attribute)
      await expect(glass).toHaveCSS('backdrop-filter', 'none')
      await expect(glass).toHaveCSS('background-image', 'none')
      await expect(glass).toHaveCSS('box-shadow', 'none')
      await page.locator('html').evaluate((root, attribute) => root.removeAttribute(attribute), attribute)
      await expect(glass).toHaveCSS('backdrop-filter', /blur/)
    }
    await page.locator('html').evaluate(root => root.setAttribute('data-glass-material', 'light'))
    await expect(glass).toHaveCSS('backdrop-filter', 'none')
  })

  test(`increased contrast and forced colors override liquid decoration: ${theme}`, async ({ page }) => {
    await materialFixture(page, theme)
    const glass = page.locator('.material-probe')
    await page.emulateMedia({ contrast: 'more' })
    await expect(glass).toHaveCSS('backdrop-filter', 'none')
    await expect(glass).toHaveCSS('background-image', 'none')
    await expect(glass).toHaveCSS('box-shadow', 'none')
    await expect(glass).toHaveCSS('border-top-width', '1px')
    await page.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' })
    await expect(glass).toHaveCSS('backdrop-filter', 'none')
    await expect(glass).toHaveCSS('background-image', 'none')
    await expect(glass).toHaveCSS('box-shadow', 'none')
  })
}
