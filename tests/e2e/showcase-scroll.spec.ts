import { expect, test } from '@playwright/test'
// One native-focus regression and one normal keyboard/narrow-screen path.
const cases = [
  { theme: 'light', close: 'button', nativeReset: true },
  { theme: 'dark', close: 'escape', nativeReset: false },
] as const
for (const { theme, close, nativeReset } of cases) {
  test(`reference preview keeps reading position ${theme} ${close} native-reset=${nativeReset}`,async({page})=>{
    await page.setViewportSize({width:close==='button'?1440:390,height:1000})
    await page.emulateMedia({reducedMotion:'no-preference'})
    await page.addInitScript(theme=>localStorage.setItem('aics_theme',theme),theme)
    await page.route('**/scene-showcase/manifest.json',route=>route.fulfill({json:{entries:Array.from({length:48},(_,i)=>({id:'scroll-'+i,title:'滚动检查 '+i,char:'nene',rating:'All',type:'scene',width:832,height:1216,thumb:`thumbs/ui-${i%8}.jpg`,image:`images/ui-${i%8}.jpg`}))}}))
    await page.goto('/showcase')
    const opener=page.locator('.sample-visual').nth(20)
    await opener.scrollIntoViewIfNeeded()
    const y=await page.evaluate(()=>scrollY)
    expect(y).toBeGreaterThan(1000)
    await opener.click()
    const dialog=page.locator('dialog.showcase-viewer')
    await expect(dialog).toBeVisible()
    await dialog.evaluate((el,reset)=>{
      // Model the WebView native focus task that can reset the document during close.
      // Observe every frame: a correct final coordinate alone misses the visible jump.
      if(reset) el.addEventListener('close',()=>window.scrollTo({top:0,behavior:'instant'}),{once:true,capture:true})
      const state=window as unknown as { closeFrames:number[];trackClose:boolean }
      state.closeFrames=[];state.trackClose=true
      const frame=()=>{if(!state.trackClose)return;state.closeFrames.push(scrollY);requestAnimationFrame(frame)}
      requestAnimationFrame(frame)
    },nativeReset)
    if(close==='button') await page.getByRole('button',{name:'关闭大图',exact:true}).click()
    else await page.keyboard.press('Escape')
    await expect(dialog).not.toHaveAttribute('open','')
    const positions=await page.evaluate(()=>new Promise<number[]>(resolve=>{
      const state=window as unknown as { closeFrames:number[];trackClose:boolean };let frames=0
      const sample=()=>{if(++frames<40){requestAnimationFrame(sample);return}state.trackClose=false;resolve(state.closeFrames)}
      requestAnimationFrame(sample)
    }))
    expect(Math.max(...positions.map(position=>Math.abs(position-y)))).toBeLessThanOrEqual(1)
    await expect(opener).toBeFocused()
    expect(await page.evaluate(()=>scrollY)).toBe(y)
    if(!nativeReset){
      await opener.click()
      await page.getByRole('link',{name:'在工作台打开',exact:true}).click()
      await expect(page).toHaveURL(/\/prompt-builder\?/)
      await expect(page.locator('.pb')).toBeVisible()
      await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0)
    }
  })
}
