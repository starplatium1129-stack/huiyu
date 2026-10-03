import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'
for (const theme of ['light','dark']) for (const width of [1440]) {
  test(`home, bookshelf and navigation finish ${theme} ${width}`,async({page},info)=>{
    await page.setViewportSize({width,height:1000})
    await page.route(/^http:\/\/[^/]+\/api\//,route=>route.fulfill({status:503,json:{ok:false,error:'Isolated UI test'}}))
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('aics_guest_guide_dismissed', '1')
    }, theme)
    await page.emulateMedia({reducedMotion:'reduce'})
    // Seed the browser-local repository and its real thumbnails before Home mounts.
    await page.route('**/__home-finish-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Home fixture</title>'}))
    await page.goto('/__home-finish-fixture')
    await page.evaluate(() => new Promise<void>((resolve,reject) => {
      const request=indexedDB.open('aics_kv_store',1)
      request.onupgradeneeded=()=>request.result.createObjectStore('kv',{keyPath:'key'})
      request.onerror=()=>reject(request.error)
      request.onsuccess=()=>{
        const db=request.result,tx=db.transaction('kv','readwrite'),store=tx.objectStore('kv')
        store.put({key:'aics_pb_history',value:[
          {id:'ux-saved',timestamp:1700000000001,character:'nene',sceneTitle:'已保存的雨夜',image_id:'home-wide',width:1200,height:600},
          // No stored dimensions: still decode the actual portrait thumbnail.
          {id:'ux-portrait',timestamp:1700000000000,character:'natsume',sceneTitle:'窗边的片刻',image_id:'home-tall'},
        ]})
        for(const [id,w,h] of [['home-wide',560,280],['home-tall',280,560]] as const){
          const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#746687"/><circle cx="${w*.7}" cy="${h*.25}" r="${w*.12}" fill="#eee5ce"/><path d="M0 ${h*.7}L${w*.4} ${h*.4}L${w} ${h*.75}V${h}H0Z" fill="#4e737e"/></svg>`
          store.put({key:`thumb:${id}`,value:'data:image/svg+xml,'+encodeURIComponent(svg)})
        }
        tx.oncomplete=()=>{db.close();resolve()}
        tx.onerror=tx.onabort=()=>{db.close();reject(tx.error)}
      }
    }))
    await page.goto('/')
    const recent = page.locator('.recent-card')
    await expect(recent).toHaveCount(2)
    await expect(recent.first()).toHaveAttribute('href', '/prompt-builder?regen=ux-saved')
    await expect(page.locator('#continueCta')).toHaveText('继续最近作品')
    await expect(page.locator('#continueCta')).toHaveAttribute('href','/prompt-builder?regen=ux-saved')
    await expect(page.locator('.recent-empty')).toHaveCount(0)
    for(const [id,w,h] of [['home-wide',560,280],['home-tall',280,560]] as const){
      const cover=page.locator(`.recent-cover[data-image-id="${id}"]`),image=cover.locator('img')
      await image.scrollIntoViewIfNeeded()
      await expect(image).toHaveJSProperty('complete',true)
      await expect(image).toHaveJSProperty('naturalWidth',w)
      await expect(image).toHaveJSProperty('naturalHeight',h)
      await expect.poll(async()=>{
        const bounds=(await cover.boundingBox())!
        return Math.abs(bounds.width/bounds.height-4/3)
      }).toBeLessThan(.02)
    }
    const shortcuts=page.locator('.home-bento')
    await expect(shortcuts.getByRole('link')).toHaveCount(5)
    for(const selector of ['.hero-sub','.continue-hint','#continueCta']){
      expect(await page.locator(selector).evaluate(textContrast),selector).toBeGreaterThanOrEqual(4.5)
    }
    expect(await shortcuts.getByRole('link').first().evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1)
    await page.locator('.home-hero').scrollIntoViewIfNeeded()
    await page.screenshot({path:info.outputPath(`home-opening-${theme}-${width}.png`)})
    await page.evaluate(()=>localStorage.setItem('aics_pb_last_draft',JSON.stringify({
      updatedAt:Date.now(),subject:'studio',char:'natsume',story:'还没完成的窗边咖啡画面',directorMode:'basic',
    })))
    await page.reload()
    await expect(recent).toHaveCount(2)
    await expect(page.locator('#continueCta')).toHaveText('继续上次创作')
    await expect(page.locator('#continueCta')).toHaveAttribute('href','/prompt-builder?resume=1')
    await expect(page.locator('.continue-hint')).toContainText('还没完成的窗边咖啡画面')
    await page.setViewportSize({width:1024,height:800})
    await page.locator('#continueCta').scrollIntoViewIfNeeded()
    await expect(page.locator('#continueCta')).toBeInViewport({ratio:1})
    await shortcuts.getByRole('link').first().click({trial:true})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({path:info.outputPath(`home-opening-${theme}-1024.png`)})
    await page.setViewportSize({width,height:1000})
    await page.getByRole('button',{name:'更多',exact:true}).click()
    const menu=page.getByRole('dialog',{name:'更多页面',exact:true})
    await expect(menu).toContainText('画室导航')
    await menu.getByRole('button',{name:'关闭更多页面',exact:true}).click()
    await expect(menu).toBeHidden()
    await page.goto('/character')
    const flip=page.getByRole('button',{name:/^下一张封面：/}).first()
    await expect(flip).toBeVisible()
    const group=flip.locator('xpath=ancestor::article[1]')
    const before=await group.locator('.bookshelf-flip-row > span').innerText()
    await flip.click()
    await expect(group.locator('.bookshelf-flip-row > span')).not.toHaveText(before)
    await expect(page.locator('.bookshelf-grid')).toBeVisible()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({path:info.outputPath(`bookshelf-flip-${theme}-${width}.png`)})
  })
}
