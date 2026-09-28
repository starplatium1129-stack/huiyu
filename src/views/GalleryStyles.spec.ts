import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'

const gallerySelectors: string[] = []
postcss.parse(readFileSync('src/assets/css/gallery-viewer.css', 'utf8')).walkRules(rule => {
  gallerySelectors.push(...rule.selectors)
})

afterEach(() => { document.body.innerHTML = '' })

describe('gallery viewer stylesheet isolation', () => {
  it('does not move showcase metadata when the gallery stylesheet remains loaded', () => {
    document.body.innerHTML = `
      <dialog class="showcase-viewer" open>
        <div class="viewer-copy">
          <h2 class="viewer-title">参考样张</h2>
          <div class="viewer-meta">画幅</div><p class="viewer-story">故事</p>
          <div class="viewer-actions"><span class="viewer-position">1 / 3</span></div>
        </div>
      </dialog>`
    expect(gallerySelectors.length).toBeGreaterThan(50)
    expect(gallerySelectors.filter(selector => document.querySelector(selector))).toEqual([])
  })

  it('retains the gallery position indicator and metadata styling', () => {
    document.body.innerHTML = `<div class="art-viewer"><span class="viewer-position">1 / 3</span><div class="viewer-meta">画幅</div></div>`
    for (const className of ['viewer-position', 'viewer-meta']) {
      const target = document.querySelector(`.${className}`)
      expect(gallerySelectors.some(selector => target?.matches(selector)), className).toBe(true)
    }
  })
})
