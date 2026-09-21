import { test, expect } from '@playwright/test'
import { SCENARIOS, SCENARIO_RES_MAP } from '../../src/config/scenarios'
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
        // Current managed Anima catalog offers 832x1216/1024x1024/1216x832.
        // Wide CG therefore retains landscape intent via the existing supported-size policy.
        const [width, height] = (act.res === 'Wide CG' ? '1216×832' : SCENARIO_RES_MAP[act.res].dim).split('×').map(Number)
        expect([body.width, body.height]).toEqual([width, height])
        await expect(page.locator('img.result-image')).toBeVisible({ timeout: 30000 })
        await testInfo.attach(`${scenario.id}-request`, { body: JSON.stringify(body), contentType: 'application/json' })
        await page.screenshot({ path: testInfo.outputPath(`${scenario.id}-${character}-${theme}.png`) })
        await page.goBack()
        await expect(page.locator('.scenario-page')).toBeVisible()
      }
    })
  }
}

for (const theme of ['dark', 'light']) test(`popular context leaves no identity in scenario and model handoffs ${theme}`, async ({ page }, testInfo) => {
  test.setTimeout(90000)
  await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
  for (const [origin, target] of [['popular=furina', 'scenario'], ['popular=furina', 'lora'], ['scene=sc006', 'scenario']]) {
    await page.goto('/prompt-builder?' + origin)
    await expect(page.locator('article.pb')).toHaveAttribute('data-character', origin.startsWith('popular') ? 'furina' : 'nene')
    if (origin.startsWith('scene')) await expect(page.locator('.atelier-context')).toContainText('平安夜')
    await page.locator('[aria-controls="material-story"]').click()
    await page.locator('.story-input').fill('neutral existing draft')
    await page.evaluate(path => {
      const app = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $router: { push: (path: string) => Promise<unknown> } } } } }
      return app.__vue_app__.config.globalProperties.$router.push(path)
    }, '/' + target)
    if (target === 'scenario') {
      await page.getByRole('button', { name: '夏目', exact: true }).click()
      await page.getByRole('link', { name: '前往工作台绘制' }).click()
    } else await page.locator('a[href="/prompt-builder?char=natsume"]').click()
    await expect(page.locator('article.pb')).toHaveAttribute('data-subject', 'studio')
    await expect(page.locator('article.pb')).toHaveAttribute('data-character', 'natsume')
    if (target === 'scenario') await expect(page.locator('.atelier-context')).not.toContainText('平安夜')
    await page.locator('[aria-controls="material-story"]').click()
    if (target === 'lora') await expect(page.locator('.story-input')).toHaveValue('neutral existing draft')
    const submitted = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/api/anima/jobs')
    await page.getByTestId('anima-generate').click()
    const body = (await submitted).postDataJSON()
    expect(body.character).toBe('natsume')
    expect(body.loraId).toBe('L_NAT_V21_ANIMA')
    expect(body.prompt).toMatch(/shiki_natsume|Shiki Natsume/i)
    expect(body.prompt).not.toMatch(/furina/i)
    await expect(page.locator('img.result-image')).toBeVisible({ timeout: 30000 })
    await testInfo.attach(`${origin}-${target}-request`, { body: JSON.stringify(body), contentType: 'application/json' })
  }
})
