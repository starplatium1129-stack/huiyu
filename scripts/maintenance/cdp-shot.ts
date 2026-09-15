// CDP-based window-level capture + DOM state dump for the companion WebView.
// Usage: node cdp-shot.js
const { chromium }: typeof import('playwright') = require('playwright')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const contexts = browser.contexts()
  let page = null
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if (p.url().includes('/companion')) page = p
    }
  }
  if (!page) {
    console.log('NO_COMPANION_PAGE')
    await browser.close()
    return
  }
  console.log('PAGE_URL:', page.url())
  console.log('VIEWPORT:', JSON.stringify(page.viewportSize()))

  const state = await page.evaluate(() => {
    const host: any = document.querySelector('#live2dHost')
    const stage: any = document.querySelector('.portrait-stage')
    const main = document.querySelector('.portrait-main')
    const cvs = host ? host.querySelector('canvas') : null
    const before = stage ? getComputedStyle(stage, '::before') : null
    const after = stage ? getComputedStyle(stage, '::after') : null
    const hostStyle = host ? getComputedStyle(host) : null
    return {
      href: location.href,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      hostBackend: host ? host.dataset.backend : null,
      hostState: host ? host.dataset.state : null,
      hostError: host ? host.dataset.error : null,
      hostRetryable: host ? host.dataset.retryable : null,
      stageClass: stage ? stage.className : null,
      stageDataChar: stage ? stage.dataset.character : null,
      stageRect: stage ? (() => { const r = stage.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })() : null,
      hostRect: host ? (() => { const r = host.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })() : null,
      canvasPresent: !!cvs,
      canvasRect: cvs ? (() => { const r = cvs.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })() : null,
      canvasCssSize: cvs ? cvs.style.width + 'x' + cvs.style.height : null,
      portraitMainOpacity: main ? getComputedStyle(main).opacity : null,
      stageBeforeDisplay: before ? before.display : null,
      stageAfterDisplay: after ? after.display : null,
      stageBeforeBg: before ? before.backgroundImage : null,
      hostOpacity: hostStyle ? hostStyle.opacity : null,
      hostFilter: hostStyle ? hostStyle.filter : null,
      companionDesktop: document.documentElement.classList.contains('companion-desktop'),
      companionUiHidden: document.documentElement.classList.contains('companion-ui-hidden'),
      live2dEnabledHint: document.querySelector('.avatar-status') ? document.querySelector!('.avatar-status').textContent : null,
      interactionHint: document.querySelector('.live2d-interaction-hint') ? document.querySelector!('.live2d-interaction-hint').textContent : null,
    }
  })
  console.log('DOM_STATE:', JSON.stringify(state, null, 2))

  const shot = 'C:\\Users\\Administrator\\Desktop\\_cdp_window.png'
  await page.screenshot({ path: shot })
  console.log('SHOT_SAVED:', shot)
  await browser.close()
}

main().catch((e: any) => {
  console.error('ERR:', e)
  process.exit(1)
})
