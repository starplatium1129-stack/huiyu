import { expect, test, type Page } from '@playwright/test'

async function navigate(page: Page, path: string) {
  await page.evaluate(path => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $router: { push: (path: string) => Promise<unknown> } } } } }
    return app.__vue_app__.config.globalProperties.$router.push(path)
  }, path)
}

test('cached gallery retains its DOM and reading position across ordinary and standalone routes', async ({ page }) => {
  await page.goto('/gallery')
  await expect(page.locator('.gallery-page')).toBeVisible()
  await page.locator('.gallery-page').evaluate(element => {
    element.setAttribute('data-cache-probe', 'retained')
    const spacer = document.createElement('div')
    spacer.style.height = '2400px'
    element.append(spacer)
  })
  await page.evaluate(() => scrollTo(0, 480))
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(480)
  for (const destination of ['/style', '/control']) {
    await navigate(page, destination)
    await expect(page).toHaveURL(new RegExp(destination + '$'))
    await navigate(page, '/gallery')
    await expect(page.locator('.gallery-page')).toHaveAttribute('data-cache-probe', 'retained')
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(480)
    await expect(page.locator('.page-main > .route-view')).toHaveCount(1)
    await expect(page.locator('.page-main > .route-view')).not.toHaveAttribute('inert')
  }
})
