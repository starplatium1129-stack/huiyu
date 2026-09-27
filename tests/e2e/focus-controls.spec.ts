import { expect, test } from '@playwright/test'
test('search focus remains visible with Windows forced colors',async({page})=>{
  await page.emulateMedia({forcedColors:'active'})
  await page.goto('/gallery')
  const input=page.getByRole('searchbox',{name:'搜索作品',exact:true})
  await input.focus();await input.press('ArrowLeft')
  expect(await input.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('none')
  expect(await page.locator('.studio-search').evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid')
})
for (const theme of ['light','dark']) {
  test(`focus owners and standalone controls ${theme}`, async ({page}, info) => {
    await page.addInitScript(theme=>localStorage.setItem('aics_theme',theme),theme)
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.route(/^http:\/\/[^/]+\/api\//,route=>route.fulfill({status:503,json:{ok:false,error:'Isolated focus review'}}))
    await page.route('**/api/maintenance/scenes-state',route=>route.fulfill({json:{ok:true,version:1,nextSceneId:'sc002',sceneCount:1,retiredCount:0,snapshot:{
      scenes:[{id:'sc001',title:'焦点检查',category:'日常',char:'nene',rating:'All',mature:false,story:'界面测试记录',storyJa:'',lora:'',emotion:'',season:'',time:'',timeOfDay:'',location:'',weather:'',camera:'',lighting:'',tags:[],usage:[],prompt:'fixture',negative:'fixture',animaCaption:'fixture',recommendedSize:'832x1216'}],tags:[],curation:{},blueprints:[],
    }}}))
    await page.route('**/api/maintenance/home-hero',route=>route.fulfill({json:{ok:true,version:1,entries:{}}}))
    // Composite fields own focus on their surrounding surface.
    await page.goto('/scene-manager')
    const catalog=page.getByRole('searchbox',{name:'搜索管理场景',exact:true})
    await catalog.focus();await catalog.press('ArrowLeft')
    expect(await catalog.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('none')
    expect(await page.locator('.catalog-search:visible').evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid')
    await page.locator('.catalog-search:visible').screenshot({path:info.outputPath(`catalog-focus-${theme}.png`)})
    await page.goto('/showcase')
    await page.locator('.showcase-filters > summary').press('Enter')
    const select=page.getByRole('combobox',{name:'筛选作品类型',exact:true})
    await select.focus();await select.press('ArrowLeft')
    expect(await select.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid')
    await select.press('Enter');await expect(page.getByRole('listbox')).toBeVisible()
    await page.keyboard.press('Escape');await expect(select).toBeFocused()
    await page.getByRole('button',{name:'搜索页面、场景与作品',exact:true}).click()
    const global=page.getByRole('combobox',{name:'搜索场景、作品或页面',exact:true})
    await expect(global).toBeFocused()
    expect(await global.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('none')
    expect(await page.locator('.gs-input-row').evaluate(el=>getComputedStyle(el).boxShadow)).not.toBe('none')
    await page.getByRole('dialog',{name:'全局搜索',exact:true}).screenshot({path:info.outputPath(`global-focus-${theme}.png`)})
    await page.keyboard.press('Escape')
    // Standalone fields still retain a visible keyboard indicator after removing the page override.
    for(const [route,selector] of [['scene-explorer','#sceneSearch'],['lora','input[type="search"]'],['control','.control-page input:not([type="checkbox"]):not([type="file"])']]){
      await page.goto('/'+route)
      const input=page.locator(selector).filter({visible:true}).first()
      await input.focus();await input.press('ArrowLeft')
      expect(await input.evaluate(el=>{const s=getComputedStyle(el);return s.outlineStyle!=='none'||s.boxShadow!=='none'})).toBe(true)
    }
  })
}
