import { expect, test, type Page } from '@playwright/test'

async function returnedPositions(page: Page, selector: string, returnSelector: string) {
  return page.evaluate(async ({ selector, returnSelector }) => {
    const positions: number[] = []
    if (returnSelector) document.querySelector<HTMLButtonElement>(returnSelector)!.click()
    else history.back()
    for (let frame = 0; frame < 30; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const element = document.querySelector<HTMLElement>(selector)
      if (element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().height) positions.push(scrollY)
    }
    return positions
  }, { selector, returnSelector })
}

for (const theme of ['dark', 'light']) {
  test(`a loaded character portrait connects the card and archive in both directions ${theme}`, async ({ page }, info) => {
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto('/character')
    await page.getByRole('button', { name: '全部角色', exact: true }).click()
    const card = page.locator('.bookshelf-character[data-character="nene"]')
    await expect.poll(() => card.locator('img').evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
    await card.scrollIntoViewIfNeeded()
    await page.evaluate(() => {
      const original = Element.prototype.animate
      const flights: Keyframe[][] = []
      ;(window as unknown as { portraitFlights: Keyframe[][] }).portraitFlights = flights
      Element.prototype.animate = function (frames, options) {
        if (this.hasAttribute('data-archive-portrait-flight')) flights.push(frames as Keyframe[])
        return original.call(this, frames, options)
      }
    })
    await card.click()
    await expect(page.getByRole('button', { name: '人物原画', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(() => (window as unknown as { portraitFlights: Keyframe[][] }).portraitFlights.length)).toBe(1)
    await expect(page.locator('[data-archive-portrait-flight]')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`portrait-connected-${theme}.png`) })
    await page.goBack()
    await expect(card).toBeFocused()
    await expect.poll(() => page.evaluate(() => (window as unknown as { portraitFlights: Keyframe[][] }).portraitFlights.length)).toBe(2)
    await expect(page.locator('[data-archive-portrait-flight]')).toHaveCount(0)
    await expect(card.locator('img')).not.toHaveCSS('opacity', '0')
    const flights = await page.evaluate(() => (window as unknown as { portraitFlights: Keyframe[][] }).portraitFlights)
    expect(flights.every(frames => frames[0].transform !== frames[1].transform)).toBe(true)
  })

  test(`returning from a work restores the bookshelf before its first frame ${theme}`, async ({ page }, info) => {
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto('/character')
    const work = page.locator('.bookshelf-open').nth(12)
    await work.scrollIntoViewIfNeeded()
    const before = await page.evaluate(() => scrollY)
    expect(before).toBeGreaterThan(200)
    await work.click()
    await expect(page.locator('.bookshelf-results-heading')).toBeVisible()
    const positions = await returnedPositions(page, '.bookshelf-grid', '.bookshelf-back')
    expect(positions.length).toBeGreaterThan(5)
    expect(Math.max(...positions.map(top => Math.abs(top - before)))).toBeLessThanOrEqual(2)
    await page.screenshot({ path: info.outputPath(`bookshelf-return-${theme}.png`) })
  })

  for (const back of ['button', 'history']) {
    test(`returning from a profile restores the selected row without scrolling ${theme} ${back}`, async ({ page }, info) => {
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      await page.goto('/character')
      await page.getByRole('button', { name: '全部角色', exact: true }).click()
      const character = page.locator('.bookshelf-character').nth(18)
      await character.scrollIntoViewIfNeeded()
      const id = await character.getAttribute('data-character')
      const before = await page.evaluate(() => scrollY)
      expect(before).toBeGreaterThan(200)
      await character.click()
      await expect(page.locator('.character-name')).toBeVisible()
      const positions = await returnedPositions(page, '.character-bookshelf', back === 'button' ? '.archive-header-actions button' : '')
      expect(positions.length).toBeGreaterThan(5)
      expect(Math.max(...positions.map(top => Math.abs(top - before)))).toBeLessThanOrEqual(2)
      await expect(page.locator(`.bookshelf-character[data-character="${id}"]`)).toBeFocused()
      await page.screenshot({ path: info.outputPath(`profile-return-${theme}-${back}.png`) })
    })
  }
}

for (const theme of ['dark', 'light']) {
  test(`scene to archive transition is visible, interruptible and cleans up ${theme}`, async ({ page }, info) => {
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto('/popular-scenes?character=sakurajima_mai')
    await expect(page.getByRole('link', { name: '查看角色档案' })).toBeVisible()
    await expect(page.getByRole('link', { name: '查看角色档案' })).toHaveAttribute('href', '/character?character=sakurajima_mai')
    await page.evaluate(() => {
      const original = Element.prototype.animate
      const motions: Array<{ path: string; frames: Keyframe[] }> = []
      ;(window as unknown as { archiveMotions: typeof motions }).archiveMotions = motions
      Element.prototype.animate = function (frames, options) {
        const path = this.getAttribute('data-route-path')
        if (path) motions.push({ path, frames: frames as Keyframe[] })
        return original.call(this, frames, options)
      }
    })
    await page.getByRole('link', { name: '查看角色档案' }).click()
    await expect(page).toHaveURL(/\/character\?character=sakurajima_mai/)
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      archiveMotions: Array<{ path: string; frames: Keyframe[] }>
    }).archiveMotions.some(m => m.path.startsWith('/character') && m.frames[0].opacity === 0 && m.frames[0].transform === 'translateX(16px)'))).toBe(true)
    // Return immediately: the incoming page must accept input during its animation.
    await page.locator('.character-page .library-header').getByRole('link', { name: '浏览角色场景' }).click()
    await expect(page).toHaveURL(/\/popular-scenes/)
    await expect(page.locator('.page-main > .route-view')).toHaveCount(1)
    await expect(page.locator('.page-main > .route-view')).not.toHaveAttribute('inert')
    await page.getByRole('link', { name: '查看角色档案' }).click()
    const archive = page.locator('.character-page')
    await expect(archive.locator('.particle-theatre .has-portrait')).toBeVisible()
    await expect(page.locator('.page-main > .route-view')).toHaveCount(1)
    await expect.poll(() => archive.evaluate(e => e.getAnimations().filter(a => a.playState === 'running').length)).toBe(0)
    expect(await archive.evaluate(e => getComputedStyle(e).transform)).toBe('none')
    expect(await archive.evaluate(e => getComputedStyle(e).opacity)).toBe('1')
    await page.screenshot({ path: info.outputPath(`archive-route-${theme}.png`) })
  })
}

test('archive navigation stays immediate with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/popular-scenes?character=sakurajima_mai')
  await page.getByRole('link', { name: '查看角色档案' }).click()
  const archive = page.locator('.character-page')
  await expect(archive).toBeVisible()
  expect(await archive.evaluate(e => e.getAnimations().length)).toBe(0)
  await expect(archive).not.toHaveAttribute('inert')
})
