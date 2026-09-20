import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { textContrast } from './helpers/contrast'

const profiles = [
  { id: 'natsume', name: '四季夏目', type: 'heroine', source: '星光咖啡馆与死神之蝶', alias: ['Shiki Natsume'],
    identity: { role: '咖啡馆店员', occupation: '学生' }, tags: ['黑色长发', '温柔目光', '日常'],
    voice: '今天也来坐一会儿吧，我给你留了靠窗的位置。',
    bg_story: '午后的光落在窗边，她把刚泡好的咖啡轻轻放在桌上。比起热闹的交谈，她更习惯用细微的行动表达关心。\n'.repeat(6),
    personality: ['认真', '细腻', '温柔'], likes: ['咖啡', '阅读', '安静的午后'],
    portrait: { image: '/assets/editorial-fixture.jpg', alt: '夏目档案测试图' },
    lora: { name: '档案测试模型', trigger_words: ['fixture'], recommended_scene: ['sc9001'] } },
  { id: 'fixture-popular', name: '长名字的档案测试角色', type: 'popular', source: '测试作品', alias: ['测试别名'], tags: [], personality: [], likes: [],
    portrait: { image: '/assets/editorial-missing.jpg' } },
]
const references = { natsume: { characterId: 'natsume', outfits: ['default', 'coat'].map((outfitId, i) => ({
  outfitId, outfitName: i ? '秋日外套' : '日常服装', isDefault: !i, isNsfw: false,
  references: ['正面', '侧面', '背面', '近景'].map((name, index) => ({
    id: `${outfitId}-${index}`, name, shotType: name, lens: '50 mm', targetUsage: ['形象参考', '分镜'],
    url: index < 2 ? `/character-references/editorial/${outfitId}/${index}.jpg` : '', pending: index >= 2,
  })),
})) } }

async function fixture(page: Page, theme: string) {
  const picture = readFileSync('assets/characters/natsume-home-cg.jpg')
  await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json: { ok: true, online: false } }))
  await page.route('**/assets/editorial-fixture.jpg', route => route.fulfill({ body: picture, contentType: 'image/jpeg' }))
  await page.route('**/assets/editorial-missing.jpg', route => route.fulfill({ status: 404 }))
  await page.route('**/assets/characters/thumbs/popular-fixture-popular.webp*', route => route.fulfill({ status: 404 }))
  await page.route('**/character-references/editorial/**', route => route.fulfill({ body: picture, contentType: 'image/jpeg' }))
  await page.route(/^http:\/\/[^/]+\/data\//, route => {
    const url = new URL(route.request().url())
    if (url.searchParams.has('import')) return route.continue()
    const file = url.pathname.split('/').at(-1)!
    const data: Record<string, unknown> = {
      'characters.json': profiles, 'character-reference-view.json': references,
      'popular-characters.json': { characters: [] }, 'scene-blueprints.json': { blueprints: [] },
      'curation.json': { personaCoreSceneIds: ['sc9001'] },
      'scenes-index.json': { total: 1 },
      'scenes-natsume.json': [{ id: 'sc9001', title: '窗边的午后', story: '一起度过安静的午后。', char: 'natsume' }],
    }
    return route.fulfill({ json: data[file] || [] })
  })
  await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/character?character=natsume')
  await expect(page.locator('.character-name')).toHaveText('四季夏目')
  await expect(page.locator('.portrait-image')).toHaveJSProperty('complete', true)
  await expect(page.locator('.portrait-image')).not.toHaveJSProperty('naturalWidth', 0)
}

for (const theme of ['light', 'dark']) {
  test(`character archive actions and references ${theme}`, async ({ page }, testInfo) => {
    await fixture(page, theme)
    await expect(page.locator('.character-hero')).toHaveClass(/revealed/)
    await expect(page.getByRole('link', { name: '以她开始绘制' })).toHaveAttribute('href', '/prompt-builder?char=natsume')
    await expect(page.getByRole('link', { name: '进入她的房间' })).toHaveAttribute('href', '/chat?character=natsume')
    for (const selector of ['.character-name', '.profile-kicker', '.profile-story', '.character-alias', '.tag-chip', '.voice-block', '.portrait-source']) {
      expect(await page.locator(selector).first().evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
    }
    await page.screenshot({ path: testInfo.outputPath(`character-${theme}.png`) })
    const expand = page.getByRole('button', { name: '展开介绍' })
    await expand.click()
    await expect(page.getByRole('button', { name: '收起介绍' })).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', { name: '收起介绍' }).click()
    await page.locator('.character-production summary').click()
    await expect(page.getByRole('region', { name: '角色素材状态' })).toBeVisible()
    await expect(page.getByText('默认服装参考图 2 / 4 可读取')).toBeVisible()
    await expect(page.getByText('档案测试模型', { exact: true })).toBeVisible()
    await page.locator('.character-production summary').click()
    await page.getByRole('button', { name: '秋日外套', exact: true }).click()
    await expect(page.locator('.char-reference-section').getByRole('link')).toHaveAttribute('href', '/video-studio?mode=shots&character=natsume&outfit=coat')
    await expect(page.locator('.char-ref-card[aria-disabled="true"]')).toHaveCount(2)
    await page.locator('.char-reference-section').screenshot({ path: testInfo.outputPath(`references-${theme}.png`) })
    await page.getByRole('button', { name: '查看 正面 高清大图' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.ref-modal-copy h2')).toContainText('侧面')
    await expect(page.getByRole('button', { name: '下一视角', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.locator('.recommend-section')).toContainText('窗边的午后')
    await page.getByRole('searchbox', { name: '搜索角色或作品' }).fill('测试别名')
    await expect(page.locator('.directory-item')).toHaveCount(1)
    await page.locator('.directory-item').click()
    await expect(page.locator('.character-name')).toHaveText('长名字的档案测试角色')
    await expect(page.locator('.portrait-missing')).toBeVisible()
    await expect(page.getByRole('link', { name: '以她开始绘制' })).toHaveAttribute('href', '/prompt-builder?popular=fixture-popular')
    await expect(page.getByRole('link', { name: '进入她的房间' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`character-missing-${theme}.png`) })
  })

  test(`character archive responsive ${theme}`, async ({ page }, testInfo) => {
    await fixture(page, theme)
    for (const width of [1280, 820, 390]) {
      await page.setViewportSize({ width, height: 960 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.locator('.character-hero').scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`character-${theme}-${width}.png`) })
      await page.getByRole('link', { name: '以她开始绘制' }).scrollIntoViewIfNeeded()
      await expect(page.getByRole('link', { name: '以她开始绘制' })).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`character-details-${theme}-${width}.png`) })
    }
  })
}
