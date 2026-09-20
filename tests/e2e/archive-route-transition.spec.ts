import { expect, test } from '@playwright/test'

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

