import { expect, test } from '@playwright/test'
for (const theme of ['light','dark']) for (const width of [1440]) {
  test(`collection search owns a single focus ring ${theme} ${width}`, async ({page}, info) => {
    await page.setViewportSize({width,height:1000})
    await page.route(/^http:\/\/[^/]+\/api\//, route=>route.fulfill({status:503,json:{ok:false,error:'Isolated UI fixture'}}))
    await page.addInitScript(theme=>{
      localStorage.setItem('aics_theme',theme)
      localStorage.setItem('aics_guest_guide_dismissed','1')
    },theme)
    await page.emulateMedia({reducedMotion:'reduce'})
    for (const [route,label] of [['gallery','搜索作品'],['showcase','搜索画册'],['character','搜索角色、别名或作品'],['popular-scenes','搜索场景']]) {
      await page.goto('/'+route+(route==='popular-scenes'?'?character=furina':''))
      const input=page.getByRole('searchbox',{name:label,exact:true})
      await input.focus(); await input.press('ArrowLeft')
      await expect(input).toBeFocused()
      const styles=await input.evaluate(el=>{
        const style=getComputedStyle(el), shell=getComputedStyle(el.parentElement!)
        return {outline:style.outlineStyle,border:style.borderTopWidth,shadow:style.boxShadow,wrapperOutline:shell.outlineStyle,wrapperOutlineWidth:shell.outlineWidth}
      })
      expect(styles.outline).toBe('none'); expect(styles.border).toBe('0px'); expect(styles.shadow).toBe('none')
      expect(styles.wrapperOutline).toBe('solid'); expect(styles.wrapperOutlineWidth).toBe('2px')
      await page.locator('.studio-search').screenshot({path:info.outputPath(`${route}-focus-${theme}-${width}.png`)})
      await input.fill('宁宁')
      await page.getByRole('button',{name:'清空搜索',exact:true}).click()
      await expect(input).toHaveValue(''); await expect(input).toBeFocused()
    }
  })
}
