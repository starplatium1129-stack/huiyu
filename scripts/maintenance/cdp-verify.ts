// Post-fix verification: CDP DOM state + correct-coordinate overlay capture.
// Requires the companion running with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
const { chromium }: typeof import('playwright') = require('playwright')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  let page = null
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('/companion')) page = p
    }
  }
  if (!page) { console.log('NO_COMPANION_PAGE'); await browser.close(); return }

  const state = await page.evaluate(() => {
    const host = document.querySelector('#live2dHost')
    const stage: any = document.querySelector('.portrait-stage')
    const r = stage.getBoundingClientRect()
    return {
      backend: host ? host.dataset.backend : null,
      state: host ? host.dataset.state : null,
      character: stage ? stage.dataset.character : null,
      stageRect: { x: r.x, y: r.y, w: r.width, h: r.height },
      dpr: window.devicePixelRatio,
      uiHidden: document.documentElement.classList.contains('companion-ui-hidden'),
    }
  })
  console.log('DOM:', JSON.stringify(state))
  // Force UI visible for a stable capture
  await page.evaluate(() => document.documentElement.classList.remove('companion-ui-hidden'))
  await page.waitForTimeout(600)
  const s2 = await page.evaluate(() => {
    const r = document.querySelector('.portrait-stage').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  console.log('STAGE_AFTER_UNHIDE:', JSON.stringify(s2))
  await browser.close()
}

main().catch((e: any) => { console.error('ERR:', e); process.exit(1) })
