import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'

const maintenanceCss = readFileSync('src/assets/css/maintenance-workspace.css', 'utf8')
const inspectorSelectors: string[] = []
postcss.parse(maintenanceCss).walkRules(rule => {
  inspectorSelectors.push(...rule.selectors.filter(selector => /\.inspector-[\w-]+/.test(selector)))
})

afterEach(() => { document.body.innerHTML = '' })

describe('maintenance stylesheet isolation', () => {
  it('does not style the drawing inspector after the maintenance route has loaded', () => {
    document.body.innerHTML = `
      <article class="pb">
        <header class="inspector-header"><h2>绘制参数</h2></header>
        <nav class="inspector-tabs"><button aria-pressed="true">生成</button><span>就绪</span></nav>
        <div class="inspector-body">
          <section class="inspector-section"><h3>引擎与输出</h3></section>
          <section class="inspector-section"><h3>画幅</h3></section>
        </div>
      </article>`
    expect(inspectorSelectors.length).toBeGreaterThan(20)
    const leaks = inspectorSelectors.filter(selector => document.querySelector(selector))
    expect(leaks).toEqual([])
  })

  it('keeps the same inspector controls styled inside the maintenance workspace', () => {
    document.body.innerHTML = `
      <div class="manager-workspace">
        <nav class="inspector-tabs"><button aria-pressed="true">内容</button></nav>
        <div class="inspector-body">
          <section class="inspector-section"><h3>故事</h3></section>
          <section class="inspector-section"><h3>提示词</h3></section>
        </div>
      </div>`
    for (const className of ['inspector-tabs', 'inspector-body', 'inspector-section']) {
      const target = document.querySelector(`.${className}:last-child`) || document.querySelector(`.${className}`)
      expect(inspectorSelectors.some(selector => target?.matches(selector)), className).toBe(true)
    }
  })
})
