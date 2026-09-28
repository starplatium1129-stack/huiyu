import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'

for (const theme of ['light', 'dark']) for (const width of [1440]) {
  test(`result shelf previews without changing the live recipe ${theme} ${width}`, async ({page}, info) => {
    await page.setViewportSize({width,height:960})
    await page.route(/^http:\/\/[^/]+\/api\//, route=>route.fulfill({status:503,json:{ok:false,error:'Isolated offline fixture'}}))
    await page.route('**/assets/shelf-fixture-*', route=> {
      if(route.request().url().endsWith('missing')) return route.fulfill({status:404,body:'missing'})
      return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#507b85"/><circle cx="400" cy="230" r="130" fill="#f7dcb1"/></svg>'})
    })
    await page.addInitScript(theme=>{
      localStorage.setItem('aics_theme',theme)
      localStorage.setItem('aics_guest_guide_dismissed','1')
      localStorage.setItem('aics_pb_history',JSON.stringify([
        {id:'shelf-one',sceneTitle:'选片验收作品一',character:'natsume',prompt:'fixture-one',image_url:'/assets/shelf-fixture-one',timestamp:3},
        {id:'shelf-two',sceneTitle:'选片验收作品二',character:'nene',prompt:'fixture-two',image_url:'/assets/shelf-fixture-two',timestamp:2},
        {id:'shelf-missing',sceneTitle:'缺图验收',character:'nene',image_url:'/assets/shelf-fixture-missing',timestamp:1},
      ]))
    },theme)
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.goto('/gallery')
    await expect(page.locator('.gallery-wall .artwork')).toHaveCount(3)
    await page.goto('/prompt-builder')
    const studio=page.locator('.pb')
    await expect(page.getByRole('button',{name:'最近作品',exact:true})).toBeVisible()
    const character=await studio.getAttribute('data-character')
    const context=await page.locator('.atelier-context').innerText()
    await page.getByRole('button',{name:'最近作品',exact:true}).click()
    await page.getByRole('button',{name:'预览：选片验收作品一',exact:true}).click()
    await expect(page.locator('.shelf-preview .zoomable-img')).toBeVisible()
    await expect(page.locator('.shelf-preview h3')).toHaveText('选片验收作品一')
    await expect(studio).toHaveAttribute('data-character',character!)
    await expect(page.locator('.atelier-context')).toHaveText(context)
    await page.getByRole('button',{name:'预览：选片验收作品二',exact:true}).click()
    await expect(page.locator('.shelf-preview h3')).toHaveText('选片验收作品二')
    expect(await page.locator('.shelf-preview h3').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    expect(await page.locator('.shelf-note').first().evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({path:info.outputPath(`shelf-${theme}-${width}.png`)})
    await page.keyboard.press('Escape')
    await expect(page.locator('.shelf-preview')).toHaveCount(0)
    await expect(page.getByRole('button',{name:'当前画布',exact:true})).toBeFocused()
    await page.getByRole('button',{name:'预览：缺图验收',exact:true}).click()
    await expect(page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'预览：选片验收作品一',exact:true}).click()
    await expect(page.locator('.shelf-preview .zoomable-img')).toBeVisible()
    await page.getByRole('button',{name:'候选成片',exact:true}).click()
    await expect(page.locator('.shelf-preview')).toHaveCount(0)
    await expect(studio).toHaveAttribute('data-character',character!)
  })
}
