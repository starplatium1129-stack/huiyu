import { test, expect } from '@playwright/test'
import { SCENARIOS } from '../../src/config/scenarios'
import MOCK_PORTS from '../../scripts/lib/e2e-ports.js'

for (const theme of ['dark', 'light']) {
  for (const character of ['nene', 'natsume']) {
    test(`scenario handoff preserves all stories and mock request ${theme} ${character}`, async ({ page, request }, testInfo) => {
      test.setTimeout(120000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      const comfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
      await request.post(`${comfy}/__mock/reset`)
      await request.post(`${comfy}/__mock/fault`, { data: { renderMs: 10 } })
      for (const scenario of SCENARIOS) {
        await page.goto('/scenario')
        await page.getByRole('button', { name: character === 'nene' ? '宁宁' : '夏目', exact: true }).click()
        await page.locator('.scenario-card').filter({ hasText: scenario.name }).click()
        await page.getByRole('link', { name: '前往工作台绘制' }).click()
        await expect(page.locator('article.pb')).toHaveAttribute('data-character', character)
        await page.locator('[aria-controls="material-story"]').click()
        const act = scenario.acts[0]
        await expect(page.locator('.story-input')).toHaveValue(`${scenario.name} · ${act.title}：${act.desc}`)
        const submitted = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/api/anima/jobs')
        await page.getByTestId('anima-generate').click()
        const body = (await submitted).postDataJSON()
        expect(body.character).toBe(character)
        expect(body.loraId).toBe(character === 'nene' ? 'L_NENE_V21_ANIMA' : 'L_NAT_V21_ANIMA')
        await expect(page.locator('img.result-image')).toBeVisible({ timeout: 30000 })
        await testInfo.attach(`${scenario.id}-request`, { body: JSON.stringify(body), contentType: 'application/json' })
        await page.screenshot({ path: testInfo.outputPath(`${scenario.id}-${character}-${theme}.png`) })
        await page.goBack()
        await expect(page.locator('.scenario-page')).toBeVisible()
      }
    })
  }
}
