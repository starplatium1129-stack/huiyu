import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

async function appliedTheme(page,theme){
  const initial=await page.locator('html').getAttribute('data-theme');
  if(initial!==theme)await page.locator('.app-theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await page.evaluate(()=>document.fonts.ready);
  const style=await page.evaluate(()=>{
    const html=getComputedStyle(document.documentElement),body=getComputedStyle(document.body);
    return {attribute:document.documentElement.dataset.theme,backgroundToken:html.getPropertyValue('--bg-deep').trim(),bodyBackground:body.backgroundColor,textColor:body.color,colorScheme:html.colorScheme};
  });
  expect(style.attribute).toBe(theme);expect(style.backgroundToken).not.toBe('');
  return {initial,...style};
}

async function verifyControl(page,server,theme,outputDirectory){
  try{
    await page.goto(`${server.origin}/control`);
    const style=await appliedTheme(page,theme);
    const save=page.getByRole('button',{name:'保存全部并检测',exact:true});
    await expect(save).toBeEnabled({timeout:15000});
    const beforeResponse=await page.request.get(`${server.origin}/api/status`);
    expect(beforeResponse.status()).toBe(200);const before=await beforeResponse.json();
    for(const [id,key] of [['sd-host','sdHost'],['comfy-host','comfyHost'],['tts-host','ttsHost']])await expect(page.locator(`#${id}`)).toHaveValue(before[key]);
    await page.locator('.voice-config > summary').click();
    const reference=`C:\\fixtures\\neutral-reference-${theme}.wav`,prompt='こんにちは。今日は静かな一日です。';
    await page.getByLabel('宁宁参考音频路径',{exact:true}).fill(reference);
    await page.getByLabel('宁宁提示文本（日文）',{exact:true}).fill(prompt);
    const savedResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/config'&&response.request().method()==='POST');
    await save.click();const response=await savedResponse;
    expect(response.status()).toBe(200);const saved=await response.json(),submitted=response.request().postDataJSON();
    for(const key of ['sdHost','comfyHost','ttsHost']){expect(submitted[key]).toBe(before[key]);expect(saved[key]).toBe(before[key]);}
    expect(saved.restartRequired).toBe(true);expect(saved.message).toContain('重新启动');
    expect(saved.savedConfig.voices.nene.refAudioPath).toBe(reference);expect(saved.savedConfig.voices.nene.promptText).toBe(prompt);
    await expect(page.locator('.overview-heading h2')).toHaveText('配置已保存，重新启动应用后生效');
    await expect(page.getByText('当前连接仍使用原设置；重新启动后会使用下方已保存的配置。',{exact:true})).toBeVisible();
    const statusResponse=await page.request.get(`${server.origin}/api/status`);expect(statusResponse.status()).toBe(200);const after=await statusResponse.json();
    expect(after.restartRequired).toBe(true);expect(after.voices).toEqual(before.voices);
    for(const key of ['sdHost','comfyHost','ttsHost','ollamaHost'])expect(after[key]).toBe(before[key]);
    // Reload proves polling/bootstrap retains the saved target without claiming
    // it became the active voice profile. No prepare or synthesis is requested.
    await page.reload();await appliedTheme(page,theme);await expect(save).toBeEnabled({timeout:15000});
    await page.locator('.voice-config > summary').click();
    await expect(page.getByLabel('宁宁参考音频路径',{exact:true})).toHaveValue(reference);
    await expect(page.locator('.overview-heading h2')).toContainText('重新启动应用后生效');
    const screenshot=path.join(outputDirectory,`rust-control-${theme}.png`);
    await page.screenshot({path:screenshot,fullPage:true});
    return {style,screenshot,restartRequired:saved.restartRequired,feedback:saved.message,hostsUnchanged:true,effectiveVoicesUnchanged:true,savedReference:reference,reloadedSavedTarget:true};
  }catch(error){
    await page.screenshot({path:path.join(outputDirectory,`failed-control-${theme}.png`),fullPage:true});
    fs.writeFileSync(path.join(outputDirectory,`failed-control-${theme}.json`),JSON.stringify({error:String(error),text:await page.locator('body').innerText()},null,2));throw error;
  }
}

/** Only the native shell bootstrap is a fixture. All application assets and
 * workspace HTTP requests are served by the real Rust candidate. */
export async function verifyBrowser(server, sourceProfileId, outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const results = [];
  try {
    for (const theme of ['dark', 'light']) {
      const headers = { origin: server.origin, 'x-aics-workspace-session': server.session.token, 'content-type': 'application/json' };
      const current = await fetch(`${server.origin}/api/workspace/profile/settings`, { headers }).then(response => response.json());
      const record = current.result.records.find(record => record.key === 'aics_theme');
      const changed = await fetch(`${server.origin}/api/workspace/profile/settings`, { method: 'PUT', headers,
        body: JSON.stringify({ protocolVersion: 1, workspaceId: server.session.workspaceId, operationId: `ui-theme-${theme}`, key: 'aics_theme', value: theme, expectedRevision: record?.revision ?? null }) });
      expect(changed.status).toBe(200);
      const verifiedSetting = await fetch(`${server.origin}/api/workspace/profile/settings`, { headers }).then(response => response.json());
      expect(verifiedSetting.result.records.find(record => record.key === 'aics_theme')?.value).toBe(theme);
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const page = await context.newPage();
      const forbiddenRequests=[];
      await page.route('**/*',async route=>{
        const pathname=new URL(route.request().url()).pathname;
        if(/^\/(?:sdapi\/|api\/(?:start$|service\/|mode$|tts(?:$|\/)|voice\/prepare|translate$|chat$|generate|generation\/|anima\/generate|video-ai\/generate|interrogate))/.test(pathname)){
          forbiddenRequests.push(`${route.request().method()} ${pathname}`);await route.abort('blockedbyclient');return;
        }await route.continue();
      });
      const workspaceFailures = [];
      const responses = [];
      page.on('response', response => {
        if (response.url().includes('/api/workspace/')) {
          responses.push({ path: new URL(response.url()).pathname, status: response.status() });
          if (response.status() >= 400) workspaceFailures.push(`${response.status()} ${response.url()}`);
        }
      });
      await page.addInitScript(({ origin, session, sourceProfileId, theme }) => {
        localStorage.setItem('aics_theme', theme);
        window.__TAURI__ = {
          core: { invoke: async command => {
            if (command === 'desktop_bootstrap') return {
              protocolVersion: 1, windowRole: 'atelier', windowId: 'atelier', sourceProfileId, sourceOrigin: origin,
              bundledUiAvailable: true, connection: 'ready', runtime: { origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: session.runtimeEpoch, workspace: session },
            };
            if (command === 'window_zoom_get') return 1;
            if (command === 'get_window_state') return { maximized: false, focused: true };
            return undefined;
          } },
          event: { listen: async () => () => {} },
          window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },
        };
      }, { origin: server.origin, session: server.session, sourceProfileId, theme });
      await page.goto(`${server.origin}/gallery`);
      await expect(page.locator('html')).toHaveClass(/aics-desktop-shell/);
      const galleryStyle=await appliedTheme(page,theme);
      await expect.poll(() => responses.filter(response => response.path === '/api/workspace/artworks').length).toBeGreaterThan(0);
      // The existing client rejects multi-page reads when startup maintenance
      // advances the global revision. Exercise its explicit recovery action.
      const retry = page.getByRole('button', { name: '重新读取', exact: true });
      let retried = false;
      try {
        await expect.poll(async () => {
          if (await retry.isVisible()) { await retry.click(); retried = true; }
          return page.locator('img').evaluateAll(images => images.filter(image => image.complete && image.naturalWidth === 64).length);
        }, { timeout: 15000 }).toBeGreaterThan(0);
      } catch (error) {
        await page.screenshot({ path: path.join(outputDirectory, `failed-${theme}.png`) });
        fs.writeFileSync(path.join(outputDirectory, `failed-${theme}.json`), JSON.stringify({ responses, text: await page.locator('body').innerText(), images: await page.locator('img').evaluateAll(images => images.map(image => ({ src: image.src.slice(0, 160), width: image.naturalWidth }))) }, null, 2));
        throw error;
      }
      expect(workspaceFailures).toEqual([]);
      const screenshot = path.join(outputDirectory, `rust-gallery-${theme}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      const control=await verifyControl(page,server,theme,outputDirectory);
      expect(forbiddenRequests).toEqual([]);expect(workspaceFailures).toEqual([]);
      results.push({ theme, initialTheme:galleryStyle.initial, galleryStyle,screenshot,control,forbiddenRequests,workspaceResponses: responses.length, workspaceFailures, retriedConsistentRead: retried });
      await context.close();
    }
    expect(results[0].galleryStyle.backgroundToken).not.toBe(results[1].galleryStyle.backgroundToken);
    expect(results[0].control.style.backgroundToken).not.toBe(results[1].control.style.backgroundToken);
  } finally { await browser.close(); }
  return results;
}
