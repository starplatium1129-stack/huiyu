import { expect, test } from '@playwright/test'
import sharp from 'sharp'

// This suite deliberately has no route mocks. Supply an isolated, writable Rust
// runtime through the full application URL; never point it at an operator profile.
const appUrl = process.env.AICS_NATIVE_ACCEPTANCE_URL
const isolated = process.env.AICS_NATIVE_ACCEPTANCE_ISOLATED === '1'
const characterId = 'raiden_shogun'
test.describe('desktop maintenance with real isolated runtime', () => {
  test.skip(!appUrl || !isolated, 'Requires AICS_NATIVE_ACCEPTANCE_URL and AICS_NATIVE_ACCEPTANCE_ISOLATED=1')
  test.beforeEach(async ({ page }) => {
    expect(new URL(appUrl!).hostname).toBe('127.0.0.1')
    await page.addInitScript(() => {
      localStorage.setItem('aics_guest_guide_dismissed', '1')
      localStorage.setItem('aics_theme', 'dark')
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('portrait draft survives section changes, updates live particles, persists and resets', async ({ page }, info) => {
    const url = `${appUrl}/scene-manager?tab=portraits&character=${characterId}`
    await page.goto(url)
    const manager = page.locator('.character-art-manager')
    await expect(manager.getByRole('button', { name: '选择图片', exact: true })).toBeEnabled()
    await expect(manager.getByRole('button', { name: '恢复内置形象' })).toBeDisabled()
    const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240"><circle cx="80" cy="42" r="30" fill="#52babd"/><path d="M45 80 L115 80 L145 220 L15 220 Z" fill="#52babd"/></svg>')).png().toBuffer()
    await manager.locator('input[type=file]').setInputFiles({ name: 'isolated-portrait.png', mimeType: 'image/png', buffer: image })
    await expect(manager.getByAltText('准备替换的新立绘')).toBeVisible()
    await page.getByRole('navigation', { name: '维护分区' }).getByRole('button', { name: /^场景库/ }).click()
    await page.getByRole('navigation', { name: '维护分区' }).getByRole('button', { name: /^角色图片/ }).click()
    await expect(manager.getByAltText('准备替换的新立绘')).toBeVisible()
    await manager.getByRole('button', { name: '查看当前粒子形象' }).click()
    const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/maintenance/character-art') && response.request().method() === 'POST')
    await manager.getByRole('button', { name: '应用立绘并同步粒子' }).click()
    const saved = await (await savedResponse).json()
    expect(saved.ok).toBe(true)
    const entry = saved.entries[characterId]
    await expect(manager.locator('img[alt$="当前立绘"]')).toHaveAttribute('src', new RegExp(entry.revision))
    await expect(manager.locator('.semantic-particle-field')).toHaveClass(/has-portrait/)
    expect((await page.request.get(`${appUrl}${entry.thumbnailUrl}`)).ok()).toBe(true)
    expect((await page.request.get(`${appUrl}${entry.particleUrl}`)).ok()).toBe(true)
    await page.goto(`${appUrl}/character?character=${characterId}`)
    await page.getByRole('button', { name: '人物原画', exact: true }).click()
    await expect(page.locator('.portrait-image')).toHaveAttribute('src', new RegExp(entry.revision))
    await page.screenshot({ path: info.outputPath('character-custom.png') })
    await page.goto(`${appUrl}/`)
    await expect(page.locator(`.pop-strip a[href*="${characterId}"] img`)).toHaveAttribute('src', new RegExp(entry.revision))
    await page.locator('.pop-strip').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('home-custom.png') })
    await page.goto(url)
    await expect(manager.locator('img[alt$="当前立绘"]')).toHaveAttribute('src', new RegExp(entry.revision))
    await manager.getByRole('button', { name: '恢复内置形象', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '恢复内置', exact: true }).click()
    await expect(manager.getByText('已恢复内置立绘、缩略图与粒子形象', { exact: true })).toBeVisible()
    await expect(manager.locator('img[alt$="当前立绘"]')).not.toHaveAttribute('src', /\/api\/character-art\//)
    const manifest = await (await page.request.get(`${appUrl}/api/maintenance/character-art`)).json()
    expect(manifest.entries[characterId]).toBeUndefined()
  })

  test('generated Krea blueprint metadata edit preserves the exact source recipe', async ({ page }) => {
    const blueprintId = process.env.AICS_NATIVE_ACCEPTANCE_BLUEPRINT_ID
    test.skip(!blueprintId, 'Requires an isolated generated Krea blueprint ID')
    const initial = await (await page.request.get(`${appUrl}/api/maintenance/scenes-state`)).json()
    const record = initial.snapshot.blueprints.find((item: { id: string }) => item.id === blueprintId)
    expect(record?.generatedRecipe.engine).toBe('krea2')
    await page.goto(`${appUrl}/scene-manager?created=${encodeURIComponent(blueprintId!)}`)
    await page.getByRole('searchbox', { name: '搜索管理蓝图' }).fill(blueprintId!)
    await page.locator('.maintenance-catalog:visible .catalog-record').first().click()
    await page.locator('.maintenance-catalog:visible').getByRole('button', { name: '编辑', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Krea 散文 promptProse')).toBeDisabled()
    await dialog.getByLabel('标题 *', { exact: true }).fill(`${record.title} · metadata checked`)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const response = page.waitForResponse(item => item.url().endsWith('/api/maintenance/scenes/changes') && item.request().method() === 'POST')
    await page.getByRole('button', { name: '保存到项目', exact: true }).click()
    const saved = await (await response).json()
    expect(saved.ok).toBe(true)
    const actual = saved.snapshot.blueprints.find((item: { id: string }) => item.id === blueprintId)
    expect(actual.generatedRecipe).toEqual(record.generatedRecipe)
    expect(actual.promptProse).toBe(record.promptProse)
    expect(actual.promptTokens).toEqual(record.promptTokens)
    expect(actual.negativeTokens).toEqual(record.negativeTokens)
    expect(actual.title).toBe(`${record.title} · metadata checked`)
  })
})
