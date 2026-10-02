import { afterEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'

afterEach(() => { document.body.innerHTML = '' })

it.each([
  {
    name: 'gallery viewer', css: 'src/assets/css/gallery-viewer.css', selector: /./,
    foreign: '<dialog class="showcase-viewer"><div class="viewer-copy"><h2 class="viewer-title"></h2><div class="viewer-meta"></div><p class="viewer-story"></p><div class="viewer-actions"><span class="viewer-position"></span></div></div></dialog>',
    owned: '<div class="art-viewer"><span class="viewer-position"></span><div class="viewer-meta"></div></div>',
    controls: ['viewer-position', 'viewer-meta'],
  },
  {
    name: 'maintenance inspector', css: 'src/assets/css/maintenance-workspace.css', selector: /\.inspector-[\w-]+/,
    foreign: '<article class="pb"><header class="inspector-header"><h2></h2></header><nav class="inspector-tabs"><button aria-pressed="true"></button><span></span></nav><div class="inspector-body"><section class="inspector-section"><h3></h3></section><section class="inspector-section"><h3></h3></section></div></article>',
    owned: '<div class="manager-workspace"><nav class="inspector-tabs"><button aria-pressed="true"></button></nav><div class="inspector-body"><section class="inspector-section"><h3></h3></section><section class="inspector-section"><h3></h3></section></div></div>',
    controls: ['inspector-tabs', 'inspector-body', 'inspector-section'],
  },
])('$name styles match owned controls without leaking into another workspace', fixture => {
  const selectors: string[] = []
  postcss.parse(readFileSync(fixture.css, 'utf8')).walkRules(rule => {
    selectors.push(...rule.selectors.filter(selector => fixture.selector.test(selector)))
  })
  document.body.innerHTML = fixture.foreign
  expect(selectors.filter(selector => document.querySelector(selector))).toEqual([])
  document.body.innerHTML = fixture.owned
  for (const className of fixture.controls) {
    const target = document.querySelector(`.${className}:last-child`) || document.querySelector(`.${className}`)!
    expect(selectors.some(selector => target.matches(selector)), className).toBe(true)
  }
})
