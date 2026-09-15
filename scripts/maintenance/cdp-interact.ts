// Click interaction + character switch verification via CDP.
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

  // 1. unhide UI so the stage rect is stable
  await page.evaluate(() => document.documentElement.classList.remove('companion-ui-hidden'))
  await page.waitForTimeout(500)
  const stage = await page.evaluate(() => {
    const r = document.querySelector('.portrait-stage').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  console.log('STAGE:', JSON.stringify(stage))

  // 2. click the character body (stage-local 50%, 55% - torso area)
  const cx = stage.x + stage.w * 0.5
  const cy = stage.y + stage.h * 0.55
  await page.mouse.click(cx, cy)
  await page.waitForTimeout(1200)
  const hint = await page.evaluate(() => {
    const el = document.querySelector('.live2d-interaction-hint')
    return el ? el.textContent : null
  })
  console.log('HINT_AFTER_TAP:', hint)

  // 3. switch to nene via the top bar char switch
  const switched = await page.evaluate(() => {
    const btn = document.querySelector('.companion-char-switch button[title*="绫地宁宁"], .companion-char-switch button:not(.active)')
    if (!btn) return 'NO_SWITCH_BTN'
    btn.click()
    return 'clicked'
  })
  console.log('SWITCH:', switched)
  await page.waitForTimeout(4000)
  const after = await page.evaluate(() => {
    const stage = document.querySelector('.portrait-stage')
    const host = document.querySelector('#live2dHost')
    return {
      character: stage ? stage.dataset.character : null,
      backend: host ? host.dataset.backend : null,
      state: host ? host.dataset.state : null,
      ready: stage ? stage.classList.contains('live2d-ready') : false,
    }
  })
  console.log('AFTER_SWITCH_NENE:', JSON.stringify(after))

  // 4. switch back to natsume
  await page.evaluate(() => {
    const btn = document.querySelector('.companion-char-switch button[title*="四季夏目"]')
    if (btn) btn.click()
  })
  await page.waitForTimeout(4000)
  const back = await page.evaluate(() => {
    const stage = document.querySelector('.portrait-stage')
    return { character: stage ? stage.dataset.character : null, ready: stage ? stage.classList.contains('live2d-ready') : false }
  })
  console.log('BACK_TO_NATSUME:', JSON.stringify(back))
  await browser.close()
}

main().catch((e: any) => { console.error('ERR:', e); process.exit(1) })
