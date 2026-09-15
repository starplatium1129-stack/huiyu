// Multi-position click test + flicker burst check.
const { chromium }: typeof import('playwright') = require('playwright')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  let page = null
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('/companion')) page = p
    }
  }
  if (!page) { console.log('NO_PAGE'); await browser.close(); return }

  await page.evaluate(() => document.documentElement.classList.remove('companion-ui-hidden'))
  await page.waitForTimeout(500)
  const stage = await page.evaluate(() => {
    const r = document.querySelector('.portrait-stage').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })

  const taps = [
    { name: 'head', fx: 0.5, fy: 0.12 },
    { name: 'hand', fx: 0.42, fy: 0.22 },
    { name: 'skirt', fx: 0.5, fy: 0.48 },
    { name: 'leg', fx: 0.48, fy: 0.62 },
  ]
  for (const t of taps) {
    await page.mouse.click(stage.x + stage.w * t.fx, stage.y + stage.h * t.fy)
    await page.waitForTimeout(1100)
    const hint = await page.evaluate(() => {
      const el = document.querySelector('.live2d-interaction-hint')
      return el ? el.textContent : null
    })
    console.log(`TAP ${t.name} -> ${hint}`)
    await page.waitForTimeout(1500)
  }
  await browser.close()
}

main().catch((e: any) => { console.error('ERR:', e); process.exit(1) })
