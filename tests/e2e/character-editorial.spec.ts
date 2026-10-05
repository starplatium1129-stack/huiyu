import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { textContrast } from './helpers/contrast'

const longStoryEnding = '完整故事尾声：她收好杯子，与朋友约好明天再来。'
const coreScenes = [
  { id: 'sc9001', title: '窗边的午后', char: 'natsume',
    story: '午后的阳光照进咖啡馆。夏目把温热的咖啡放到窗边的小桌上，与朋友聊起新读的书。街道上的行人慢慢走过，她们在安静的交谈中度过一段平常而温暖的时光。\n'.repeat(36) + longStoryEnding },
  { id: 'sc9002', title: '雨后散步', char: 'natsume', story: '雨停了，她沿着熟悉的小路散步，看看路边新开的花。' },
]
const profiles = [
  { id: 'natsume', name: '四季夏目', type: 'heroine', source: '星光咖啡馆与死神之蝶', alias: ['Shiki Natsume'],
    identity: { role: '咖啡馆店员', occupation: '学生' }, tags: ['黑色长发', '温柔目光', '日常'],
    voice: '今天也来坐一会儿吧，我给你留了靠窗的位置。',
    bg_story: '午后的光落在窗边，她把刚泡好的咖啡轻轻放在桌上。比起热闹的交谈，她更习惯用细微的行动表达关心。\n'.repeat(6),
    personality: ['认真', '细腻', '温柔'], likes: ['咖啡', '阅读', '安静的午后'],
    portrait: { image: '/assets/editorial-fixture.jpg', alt: '夏目档案测试图' },
    lora: { name: '档案测试模型', trigger_words: ['fixture'], recommended_scene: coreScenes.map(scene => scene.id) } },
  { id: 'fixture-popular', name: '长名字的档案测试角色', type: 'popular', source: '测试作品', alias: ['测试别名'], tags: [], personality: [], likes: [],
    portrait: { image: '/assets/editorial-missing.jpg' } },
]
async function fixture(page: Page, theme: string) {
  const picture = readFileSync('assets/characters/natsume-home-cg.jpg')
  await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json: { ok: true, online: false } }))
  await page.route('**/assets/editorial-fixture.jpg', route => route.fulfill({ body: picture, contentType: 'image/jpeg' }))
  await page.route('**/assets/editorial-missing.jpg', route => route.fulfill({ status: 404 }))
  await page.route('**/assets/characters/thumbs/popular-fixture-popular.webp*', route => route.fulfill({ status: 404 }))
  await page.route(/^http:\/\/[^/]+\/data\//, route => {
    const url = new URL(route.request().url())
    if (url.searchParams.has('import')) return route.continue()
    const file = url.pathname.split('/').at(-1)!
    const data: Record<string, unknown> = {
      'characters.json': profiles,
      'popular-characters.json': { characters: [] }, 'scene-blueprints.json': { blueprints: [] },
      'curation.json': { personaCoreSceneIds: coreScenes.map(scene => scene.id) },
      'scenes-index.json': { total: coreScenes.length },
      'scenes-natsume.json': coreScenes,
    }
    return route.fulfill({ json: data[file] || [] })
  })
  await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/character?character=natsume')
  await expect(page.locator('.character-name')).toHaveText('四季夏目')
  await page.getByRole('button', { name: '人物原画', exact: true }).click()
  await expect(page.locator('.portrait-image')).toHaveJSProperty('complete', true)
  await expect(page.locator('.portrait-image')).not.toHaveJSProperty('naturalWidth', 0)
}

for (const theme of ['light', 'dark']) {
  test(`character archive actions and model information ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 960 })
    await fixture(page, theme)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('link', { name: '以她开始绘制' }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('link', { name: '以她开始绘制' })).toBeInViewport()
    await expect(page.locator('.character-hero')).toHaveCSS('opacity', '1')
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
    await expect(page.getByText('档案测试模型', { exact: true })).toBeVisible()
    await page.locator('.character-production summary').click()
    const recommendations = page.locator('.recommend-section')
    const cards = recommendations.locator('.recommend-card')
    await expect(cards).toHaveCount(2)
    await recommendations.scrollIntoViewIfNeeded()
    const heights = await cards.evaluateAll(items => items.map(item => item.getBoundingClientRect().height))
    expect(Math.abs(heights[0] - heights[1])).toBeLessThanOrEqual(1)
    expect(Math.max(...heights)).toBeLessThan(960 / 3)
    const longCard = cards.filter({ has: page.getByRole('heading', { name: '窗边的午后', exact: true }) })
    const summary = await longCard.locator('.cg-story').evaluate(element => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight),
      clipped: element.scrollHeight > element.clientHeight,
    }))
    expect(summary.height).toBeLessThanOrEqual(summary.lineHeight * 3 + 1)
    expect(summary.clipped).toBe(true)
    await recommendations.screenshot({ path: testInfo.outputPath(`character-core-scenes-${theme}.png`) })
    const readStory = longCard.getByRole('button', { name: '阅读「窗边的午后」完整故事', exact: true })
    await readStory.click()
    const storyDialog = page.getByRole('dialog', { name: '窗边的午后', exact: true })
    await expect(storyDialog).toBeVisible()
    const storyBody = storyDialog.locator('.recommendation-story-body')
    await expect(storyBody).toHaveText(coreScenes[0].story)
    expect(await storyBody.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await storyBody.focus()
    await storyBody.press('End')
    await expect.poll(() => storyBody.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await storyBody.press('Escape')
    await expect(storyDialog).not.toBeVisible()
    await expect(readStory).toBeFocused()
    await readStory.click()
    await expect(storyDialog).toBeVisible()
    await expect.poll(() => storyBody.evaluate(element => element.scrollTop)).toBe(0)
    await storyBody.press('Escape')
    await expect(storyDialog).not.toBeVisible()
    await expect(readStory).toBeFocused()
    await page.getByRole('searchbox', { name: '搜索角色或作品' }).fill('测试别名')
    await expect(page.locator('.directory-item')).toHaveCount(1)
    await page.locator('.directory-item').click()
    await expect(page.locator('.character-name')).toHaveText('长名字的档案测试角色')
    await expect(page.locator('.portrait-missing')).toBeVisible()
    await expect(page.getByRole('link', { name: '以她开始绘制' })).toHaveAttribute('href', '/prompt-builder?popular=fixture-popular')
    await expect(page.getByRole('link', { name: '进入她的房间' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`character-missing-${theme}.png`) })
  })
}
