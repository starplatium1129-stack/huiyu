import { expect, test } from '@playwright/test'
import { installDesktopHostFixture } from './helpers/desktopHost'
import { collectRuntimeErrors } from './helpers/runtimeErrors'

// Uses actual bundled model assets; run only when the corresponding asset/device environment is available.
test('desktop companion keeps a character-first surface and opens the separate chat window', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const live2dAssetRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/assets/live2d-current/')) live2dAssetRequests.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'nene',
      histories: {
        nene: [{ role: 'assistant', content: '今天也在这里陪着你。', mid: 'companion-seed' }],
        natsume: [],
      },
      settings: {
        model: 'local-model',
        provider: 'api',
        apiBaseUrl: 'https://local.example/v1',
        apiModel: 'local-model',
        apiKey: 'local-key',
        webSearchEnabled: false,
        live2dEnabled: false,
        live2dOutfit: 'school',
        autoVoice: false,
        volume: 70,
        drafts: { nene: '', natsume: '' },
      },
    }));
  });
  await page.setViewportSize({ width: 520, height: 720 });
  await page.goto('/companion');

  // —— 浏览器模式（无桥）先验证基础布局 ——
  await expect(page.locator('.companion-page')).toBeVisible();
  await expect(page.locator('.page-root')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '与绫地宁宁相伴', level: 1 })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '切换陪伴角色', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '切换陪伴角色', exact: true }).click();
  await expect(page.locator('.companion-picker-option[data-value="nene"], .companion-picker-option[data-value="natsume"]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.live2d-enable-cta')).toContainText('加载绫地宁宁动态立绘');
  // 完整房间入口已收敛进设置弹层（2026-08-15 布局改造）；浏览器模式为链接
  await page.locator('.companion-settings-btn').click();
  await expect(page.locator('.companion-settings-popover')).toBeVisible();
  const roomLink = page.locator('.companion-settings-popover a', { hasText: '完整房间' });
  await expect(roomLink).toHaveAttribute('href', '/chat?character=nene');
  await page.keyboard.press('Escape');
  await expect(page.locator('.companion-settings-popover')).toHaveCount(0);
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
  expect(live2dAssetRequests).toEqual([]);

  // 环境问候按时间片入队：固定为白天非安静时段，避免深夜跑 E2E 时
  // 安静时段（23:00-8:00）抑制问候导致用例失败。Date.now 从固定起点
  // 随时间真实前进（穿透恢复的 400ms 抑制窗口依赖时间流逝）。
  await page.addInitScript(() => {
    const RealDate = Date;
    const fixedBase = new RealDate('2026-08-03T10:00:00').getTime();
    const realStart = RealDate.now();
    (window as any).Date = class extends RealDate {
      constructor(...args: any[]) {
        if (args.length) {
          super(...(args as ConstructorParameters<typeof RealDate>));
        } else {
          super(new RealDate(fixedBase + (RealDate.now() - realStart)));
        }
      }
      static now() { return fixedBase + (RealDate.now() - realStart); }
    };
  });

  await page.addInitScript(() => {
    (window as any).__ignoreMouseCalls = [];
    (window as any).__openChatCalls = [];
    (window as any).__relayedCommands = [];
    window.desktopCapabilitiesFixture = {
        isDesktop: true,
        hide: () => {},
        quit: () => {},
        openAtelier: () => {},
        openChat: async () => { (window as any).__openChatCalls.push(1); },
        toggleChat: async () => {},
        chatRelay: async (payload: Record<string, unknown>) => { (window as any).__relayedCommands.push(payload); },
        onChatCommand: () => 1,
        offChatCommand: () => {},
        setIgnoreMouseEvents: (value: boolean) => (window as any).__ignoreMouseCalls.push(value),
        setLive2dEnabled: () => {},
        getState: async () => ({
          alwaysOnTop: false,
          ignoreMouseEvents: false,
          visible: true,
          onBatteryPower: false,
          live2dEnabled: null,
        }),
        toggleAlwaysOnTop: async () => false,
        getSettings: async () => ({ openAtLogin: false }),
        setAutostart: async () => false,
        pickFiles: async () => [],
        openWorkspace: async () => false,
        openRuntime: async () => false,
        notify: () => {},
        onResume: () => 1,
        offResume: () => {},
        onShown: () => 1,
        offShown: () => {},
        onVisibilityChanged: () => 1,
        offVisibilityChanged: () => {},
        onPowerModeChanged: () => 1,
        offPowerModeChanged: () => {},
        onInteractionModeChanged: () => 1,
        offInteractionModeChanged: () => {},
        onClipboardImage: () => 1,
        offClipboardImage: () => {},
        onClipboardText: () => 1,
        offClipboardText: () => {},
        onGlobalMouse: () => 1,
        offGlobalMouse: () => {},
        minimizeWindow: () => {},
        toggleMaximizeWindow: () => {},
        closeWindow: () => {},
        getWindowState: async () => ({ maximized: false, focused: true }),
        onMaximizedChanged: () => 1,
        offMaximizedChanged: () => {},
        setProgress: () => {},
        saveImage: async () => ({ saved: false }),
        getWorkspace: async () => ({ root: '', exists: false, activeRoot: '', restartRequired: false }),
        setWorkspace: async () => ({ root: '', exists: false, activeRoot: '', restartRequired: false }),
      };
  });
  await page.reload();
  const companionCsp = await page.evaluate(async () => {
    const response = await fetch('/companion', { cache: 'no-store' });
    return response.headers.get('content-security-policy') || '';
  });
  if (companionCsp.includes("'unsafe-eval'")) {
    await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 25_000 });
    await expect(page.locator('.live2d-host canvas')).toHaveCount(1);
  } else {
    await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'fallback', { timeout: 25_000 });
    await expect(page.locator('.live2d-host')).toHaveAttribute('data-error', /unsafe-eval/);
  }
  await expect(page.locator('.live2d-enable-cta')).toHaveCount(0);
  // —— 桌面模式（桥模拟）：角色窗是"只装角色"的表面，聊天在独立窗 ——
  await expect(page.locator('.companion-input')).toBeHidden();
  await expect(page.locator('.companion-conversation')).toBeHidden();
  // 原生桌宠默认仅展示角色；双击角色打开独立聊天窗。
  await expect(page.locator('.companion-chat-chip')).toBeHidden();
  await page.locator('.portrait-stage').dblclick();
  await expect.poll(() => page.evaluate(() => (window as any).__openChatCalls.length)).toBeGreaterThan(0);
  // 环境问候转瞬态浮层：挂载时按时间片入队一条问候气泡
  await expect(page.locator('.companion-float-reminder')).toHaveCount(1);
  await expect(page.locator('.companion-float-reminder p')).toHaveText(/。/);
  await page.locator('.companion-float-reminder button').click();
  await expect(page.locator('.companion-float-reminder')).toHaveCount(0);
  const dndButton = page.locator('.companion-settings-popover button[aria-pressed]', { hasText: '勿扰' });
  await page.keyboard.press('Shift+F10');
  await page.locator('.companion-settings-btn').click();
  await expect(page.locator('.companion-settings-popover')).toBeVisible();
  await expect(dndButton).toHaveCount(1);
  await expect(dndButton).toHaveAttribute('aria-pressed', 'false');
  await dndButton.click();
  await expect(dndButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.companion-float-reminder')).toHaveCount(0);
  await dndButton.click();
  await expect(dndButton).toHaveAttribute('aria-pressed', 'false');
  await expect(dndButton).toBeVisible();
  // 穿透模式下悬停可交互元素会自动请求恢复交互（避免"点不到恢复按钮"卡死）；
  // 悬停穿透切换按钮本身不恢复（避免刚穿透又立刻恢复的死循环）
  const mouseToggleButton = page.locator('.companion-settings-popover button', { hasText: /鼠标穿透|恢复窗口交互/ });
  await mouseToggleButton.click();
  await expect(mouseToggleButton).toHaveAttribute('aria-pressed', 'true');
  await expect(mouseToggleButton).toHaveText('恢复窗口交互');
  const mouseCallsBefore = await page.evaluate(() => (window as any).__ignoreMouseCalls.length);
  await page.waitForTimeout(500); // 越过点击后的 400ms 抑制窗口
  // 悬停"置顶窗口"按钮（穿透切换按钮以外的可交互元素）→ 触发自动恢复
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('.companion-settings-popover button'))
      .find(el => el.textContent?.includes('置顶窗口')) as HTMLElement;
    const rect = button.getBoundingClientRect();
    const event = new PointerEvent('pointermove', {
      bubbles: true,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    });
    window.dispatchEvent(event);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__ignoreMouseCalls.length)).toBeGreaterThan(mouseCallsBefore);
  await expect(mouseToggleButton).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('.companion-settings-popover')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Natsume Live2D loads, reacts, and keeps wardrobe memory per character', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'natsume',
      histories: { nene: [], natsume: [] },
      settings: {
        model: '',
        provider: 'api',
        apiBaseUrl: '',
        apiModel: '',
        apiKey: '',
        webSearchEnabled: false,
        live2dEnabled: false,
        live2dOutfit: 'natsume-cafe',
        live2dOutfits: { nene: 'school', natsume: 'natsume-cafe' },
        autoVoice: false,
        volume: 80,
        drafts: { nene: '', natsume: '' },
      },
    }));
  });

  await page.goto('/chat');
  await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'natsume');
  await page.locator('.live2d-enable-cta').click();
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.live2d-host canvas')).toBeVisible();
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-backend', 'browser');
  await expect(page.locator('.wardrobe-trigger')).toContainText('咖啡店制服');
  await expect(page.locator('.wardrobe-static')).toContainText('互动动作含原生图层效果');
  await expect(page.locator('.wardrobe-menu')).toHaveCount(0);

  const stage = page.locator('.portrait-stage');
  const box = await stage.boundingBox();
  if (!box) throw new Error('Natsume portrait stage has no layout box');
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.35);
  await expect(stage).toHaveAttribute('data-pointer-focus', 'native');
  await expect(stage).toHaveAttribute('data-pointer-gaze-x', /0\.[4-9]\d*/);
  await page.mouse.move(box.x - 4, box.y - 4);
  await expect(stage).toHaveAttribute('data-pointer-focus', 'idle');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.08);
  // 点击互动每次随机抽取一个 Tap 变体，且提示文案现附好感度后缀——
  // 断言出现非空互动提示，而非特定台词
  await expect(page.locator('.live2d-interaction-hint')).toHaveText(/\S/);

  await page.getByRole('combobox', { name: '切换角色', exact: true }).click();
  await page.locator('.companion-picker-option[data-value="nene"]').click();
  await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'nene');
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.wardrobe-trigger')).toContainText('校服');

  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('aics_chat_v1') || '{}').settings);
  expect(settings.live2dOutfits).toMatchObject({ nene: 'school', natsume: 'natsume-cafe' });
  expect(errors).toEqual([]);
});

test('Natsume plays the Leave farewell before releasing Live2D', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'natsume',
      histories: { nene: [], natsume: [] },
      settings: {
        model: '',
        provider: 'api',
        apiBaseUrl: '',
        apiModel: '',
        apiKey: '',
        webSearchEnabled: false,
        live2dEnabled: true,
        live2dOutfit: 'natsume-cafe',
        live2dOutfits: { nene: 'school', natsume: 'natsume-cafe' },
        autoVoice: false,
        volume: 80,
        drafts: { nene: '', natsume: '' },
      },
    }));
  });

  await page.goto('/chat');
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
  await page.locator('.character-controls > summary').click();
  await page.getByRole('button', { name: '切换为静态立绘', exact: true }).click();

  // 先进入告别阶段（播 Leave 动作），再释放模型
  await expect(page.locator('.avatar-status')).toContainText('正在道别');
  await expect(page.locator('.live2d-host canvas')).toBeHidden({ timeout: 12_000 });
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.avatar-status')).toContainText('启用 Live2D');
  expect(errors).toEqual([]);
});

test('Live2D finishes the latest character switch after an auto-load race', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  let natsumeModelRequested = false;
  await page.route('**/assets/live2d-current/nene/nene.model3.json', async route => {
    await new Promise(resolve => setTimeout(resolve, 1_200));
    await route.continue();
  });
  page.on('request', request => {
    if (request.url().includes('/assets/live2d-current/natsume/natsume.model3.json')) {
      natsumeModelRequested = true;
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'nene',
      histories: { nene: [], natsume: [] },
      settings: {
        model: '',
        provider: 'api',
        apiBaseUrl: '',
        apiModel: '',
        apiKey: '',
        webSearchEnabled: false,
        live2dEnabled: true,
        live2dOutfit: 'school',
        live2dOutfits: { nene: 'school', natsume: 'natsume-cafe' },
        autoVoice: false,
        volume: 80,
        drafts: { nene: '', natsume: '' },
      },
    }));
  });

  await page.goto('/chat');
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'loading');
  await page.getByRole('combobox', { name: '切换角色', exact: true }).click();
  await page.locator('.companion-picker-option[data-value="natsume"]').click();
  await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'natsume');
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.live2d-host canvas')).toBeVisible();
  expect(natsumeModelRequested).toBe(true);
  expect(errors).toEqual([]);
});

test('Live2D falls back to the browser backend when native bridge is missing', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'natsume',
      histories: { nene: [], natsume: [] },
      settings: {
        model: '', provider: 'api', apiBaseUrl: '', apiModel: '', apiKey: '',
        webSearchEnabled: false, live2dEnabled: true, live2dOutfit: 'natsume-cafe',
        live2dOutfits: { nene: 'school', natsume: 'natsume-cafe' },
        autoVoice: false, volume: 80, drafts: { nene: '', natsume: '' },
      },
    }));
  });

  // 显式请求原生后端；无 window.nativeCapabilitiesFixture 时必须回退浏览器且仍可用
  await page.goto('/chat?live2dBackend=native');
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-backend', 'browser-fallback');
  await expect(page.locator('.live2d-host canvas')).toBeVisible();
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready');
  expect(errors).toEqual([]);
});

test.beforeEach(async ({ page }) => { await installDesktopHostFixture(page) })
