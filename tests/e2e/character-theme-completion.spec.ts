import { expect, test, type Page, type Locator } from '@playwright/test'
import { textContrast } from './helpers/contrast'

/**
 * G6 · 八位角色主题补齐 · 双主题定向回归
 *
 * 覆盖真实选角、标准表面与实际控件对比度；复用已构建产物，不调用生成模型。
 *
 * 覆盖：audit:coverage 报告的 8 位角色。accent 期望值由运行时主题目录与
 * data/characters.json 的声明共同解析；krista_lenz 保留历史调校值和旧别名
 * 兼容语义，但不再生成角色级 CSS 选择器。
 *
 * 流程约束：角色一律经真实路由 `?popular=<id>`（usePromptDeepLink 与点击
 * 选择同路径）或界面点击进入，由应用自行写入 data-character；用例不直接
 * 修改 DOM 数据属性来伪造选择流程。对比度探针仅追加测量用 span（theme-audit
 * 既有模式），测完即移除。
 */

const THEMES = ['dark', 'light'] as const

const EXPECTED = [
  { id: 'ereshkigal_fate', name: '埃列什基伽勒', accent: '#60a5fa' },
  { id: 'ishtar_fate', name: '伊什塔尔', accent: '#eab308' },
  { id: 'kasumigaoka_utaha', name: '霞之丘诗羽', accent: '#ef4444' },
  { id: 'kochou_shinobu', name: '蝴蝶忍', accent: '#a78bfa' },
  { id: 'krista_lenz', name: '希斯特里亚', accent: '#eab308' },
  { id: 'ling_arknights', name: '令', accent: '#d4a83c' },
  { id: 'shinomiya_kaguya', name: '四宫辉夜', accent: '#e11d48' },
  { id: 'shokuhou_misaki', name: '食蜂操祈', accent: '#fbbf24' },
] as const

/** 在 .pb 内追加临时探针，读取同一浏览器序列化下的颜色字符串。 */
function readProbeColor(page: Page, color: string): Promise<string> {
  return page.evaluate(([value]) => {
    const host = document.querySelector('.pb')
    if (!host) return ''
    const probe = document.createElement('span')
    host.append(probe)
    probe.style.color = value
    const resolved = getComputedStyle(probe).color
    probe.remove()
    return resolved
  }, [color])
}

/** Sample the real gradient-backed control with only its text temporarily hidden. */
async function controlContrast(page: Page, control: Locator) {
  await expect(control).toBeVisible()
  await control.evaluate(async element => {
    const animations: Animation[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      animations.push(...node.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity))
    }
    await Promise.all(animations.map(a => a.finished.catch(() => undefined)))
  })
  const original = await control.evaluate(element => {
    const node = element as HTMLElement
    let opacity = 1
    for (let parent: Element | null = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity)
    const result = { style: node.getAttribute('style'), color: getComputedStyle(node).color, opacity }
    node.style.setProperty('color', 'transparent', 'important')
    return result
  })
  let pixels: number[]
  try { pixels = [...await control.screenshot({ animations: 'disabled' })] }
  finally {
    await control.evaluate((element, style) => {
      if (style === null) element.removeAttribute('style')
      else element.setAttribute('style', style)
    }, original.style)
  }
  expect(original.opacity, '测量前应结束过渡，不能把透明组当不透明文字').toBeCloseTo(1, 3)
  return page.evaluate(async ({ pixels, color }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(pixels)], { type: 'image/png' }))
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(bitmap, 0, 0); bitmap.close()
    const row = context.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data
    context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
    const foreground = [...context.getImageData(0, 0, 1, 1).data]
    const luminance = (rgb: number[]) => rgb.map(v => {
      const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
    }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0)
    const ratios = []
    for (let x = Math.ceil(canvas.width * .15); x < canvas.width * .85; x += 1) {
      const background = [...row.slice(x * 4, x * 4 + 3)]
      const alpha = foreground[3] / 255
      const ink = background.map((v, i) => foreground[i] * alpha + v * (1 - alpha))
      const a = luminance(ink), b = luminance(background)
      ratios.push((Math.max(a, b) + .05) / (Math.min(a, b) + .05))
    }
    return Math.min(...ratios)
  }, { pixels, color: original.color })
}

for (const theme of THEMES) {
  for (const { id, name, accent } of EXPECTED) {
    test(`[${theme}] ${name}（${id}）强调色生效且文字可读`, async ({ page }, info) => {
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      // 真实路由：与「开始绘制」热门选角同一动作路径；data-character 由应用写入。
      await page.goto(`/prompt-builder?popular=${id}`)
      const pb = page.locator('.pb')
      await expect(pb).toHaveAttribute('data-character', id)
      if (!await page.locator('.character-browse-trigger').isVisible()) {
        await page.locator('[aria-controls="material-character"]').click()
      }
      await expect(page.locator('.character-browse-trigger')).toBeVisible()

      // 身份由角色卡展示；造型手帖保留唯一选中的服装。
      await expect(page.locator('.character-browse-trigger strong')).toHaveText(name)
      await expect(page.locator('.popular-outfits-head strong')).toHaveText('造型手帖')
      await expect(page.locator('.outfit-chip.active')).toHaveCount(1)

      // 实际强调色生效：--character-accent 的解析色与期望声明值一致。
      // 角色切换有 560ms @property 过渡，用 expect.poll 等待收敛而非固定延时。
      await expect.poll(async () => {
        const actual = await readProbeColor(page, 'var(--character-accent)')
        const expected = await readProbeColor(page, accent)
        return actual === expected
      }, { timeout: 10_000 }).toBe(true)

      // 标准表面的浏览器解析值与真实控件的渐变背景分开核验。
      await page.evaluate(() => {
        const host = document.querySelector('.pb')
        if (!host) return
        const probe = document.createElement('span')
        probe.id = 'g6-accent-probe'
        probe.style.color = 'var(--accent)'
        probe.style.backgroundColor = 'var(--bg-surface)'
        probe.textContent = '强调色可读性探针'
        host.append(probe)
      })
      const ratio = await page.locator('#g6-accent-probe').evaluate(textContrast)
      await page.evaluate(() => document.getElementById('g6-accent-probe')?.remove())
      expect(ratio, `${id} 在 ${theme} 主题的强调色对比度应达 AA`).toBeGreaterThanOrEqual(4.5)
      const actualRatio = await controlContrast(page, page.locator('.char-source-btn.active'))
      expect(actualRatio, `${id} 的当前来源按钮在实际背景上应达 AA`).toBeGreaterThanOrEqual(4.5)
      const themedRatio = await controlContrast(page, page.locator('.character-browse-all'))
      expect(themedRatio, `${id} 的角色强调色按钮在实际背景上应达 AA`).toBeGreaterThanOrEqual(4.5)
      await info.attach('contrast.json', { body: JSON.stringify({ id, theme, standardSurfaceRatio: ratio, sampledControlRatio: actualRatio, sampledThemedControlRatio: themedRatio }), contentType: 'application/json' })

      // 深浅主题分别留证，供主任务逐角色视觉验收比对。
      await page.screenshot({ path: info.outputPath(`g6-${id}-${theme}.png`) })
    })
  }
}

test('[dark] canonical character themes use the runtime resolver without per-character CSS rules', async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('aics_theme', value), 'dark')
  await page.goto('/prompt-builder?popular=krista_lenz')
  await expect(page.locator('.pb')).toHaveAttribute('data-character', 'krista_lenz')

  // 主题值来自运行时 inline custom properties；入口 CSS 不再为每个角色生成选择器。
  const hasCharacterSpecificRule = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList
      try { rules = sheet.cssRules } catch { continue }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue
        const selector = rule.selectorText
        if (selector?.includes('data-character="krista_lenz"')
          || selector?.includes('data-character="historia_reiss"')) return true
      }
    }
    return false
  })
  expect(hasCharacterSpecificRule, '角色主题不应回到逐角色 CSS 选择器').toBe(false)
  await expect.poll(async () => page.locator('.pb').evaluate(element =>
    element instanceof HTMLElement ? element.style.getPropertyValue('--character-accent') : ''))
    .toBe('#eab308')

  // 保留旧别名的主题目录兼容值：canonical accent 语义仍为 #eab308。
  await expect.poll(async () => {
    const actual = await readProbeColor(page, 'var(--character-accent)')
    const expected = await readProbeColor(page, '#eab308')
    return actual === expected
  }, { timeout: 10_000 }).toBe(true)
})

test('[dark] 角色面板点击选择食蜂操祈后主题即时切换', async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('aics_theme', value), 'dark')
  await page.goto('/prompt-builder')
  const pb = page.locator('.pb')

  // 界面真实选择路径：打开角色面板 → 切热门来源 → 浏览全部 → 搜索 → 点击角色。
  await page.locator('[aria-controls="material-character"]').click()
  await page.getByRole('button', { name: /热门角色/ }).click()
  await page.locator('.character-browse-trigger').click()
  const dialog = page.locator('.character-browser-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('searchbox', { name: '搜索角色或作品' }).fill('食蜂操祈')
  await dialog.locator('.directory-item[data-character="shokuhou_misaki"]').click()

  await expect(pb).toHaveAttribute('data-character', 'shokuhou_misaki')
  await expect(page.locator('.character-browse-trigger strong')).toHaveText('食蜂操祈')
  await expect.poll(async () => {
    const actual = await readProbeColor(page, 'var(--character-accent)')
    const expected = await readProbeColor(page, '#fbbf24')
    return actual === expected
  }, { timeout: 10_000 }).toBe(true)
})
