import { installDesktopHostFixture } from './helpers/desktopHost'
import { collectRuntimeErrors } from './helpers/runtimeErrors'
import { expect, test, type Page } from '@playwright/test';
import { expectStudioSelectValue, pickStudioOptionByValue, readStudioOptions } from './helpers/studioSelect';

/**
 * Vue SPA 浏览器回归
 *
 * 重构前这些用例走 /tools/*.html + 全局 DOM id。
 * 现在是 Vue Router 单页应用，断言改为路由路径 + 语义/类选择器，
 * 避免再次和某个实现细节的 id 绑死。
 */


const SHOWCASE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 视觉回归必须自带审核样张，仓库没有样张时也验证正常查看器路径。 */
async function mockShowcase(page: Page) {
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      sceneCount: 2,
      counts: { All: 2, R15: 0, R18: 0 },
      entries: [{
        id: 'e2e-showcase',
        title: '测试样张',
        story: '用于验证样张查看器布局。',
        category: '日常',
        char: 'nene',
        rating: 'All',
        attempt: 1,
      }, {
        id: 'e2e-popular',
        title: '热门角色测试样张',
        story: '用于验证跨类型筛选复位。',
        category: '热门角色',
        char: 'popular-test',
        displayName: '测试角色',
        type: 'popular',
        rating: 'All',
        attempt: 1,
      }],
    }),
  }));
  await page.route(/\/scene-showcase\/(?:thumbs|images)\/e2e-(?:showcase|popular)\.jpg(?:\?.*)?$/, route => route.fulfill({
    contentType: 'image/png',
    body: SHOWCASE_PIXEL,
  }));
}


test('director separates a focused scene mode from the expert tag workflow', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/prompt-builder');

  await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'basic');
  await expect(page.locator('.material-switch button[aria-controls="material-character"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.material-switch button[aria-controls="material-story"]').click();
  await expect(page.locator('.story-input')).toBeVisible();
  await expect(page.locator('.voice-studio')).toBeHidden();
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.locator('.inspector-voice > summary').click();
  await expect(page.locator('.voice-studio')).toBeVisible();
  await page.locator('.inspector-voice > summary').click();
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click();
  await expect(page.locator('.scene-list button.scene-card').first()).toBeVisible();
  await expect(page.locator('#stepTags')).toBeHidden();
  await expect(page.locator('#projectSelect')).toHaveCount(0);
  await expect(page.locator('.director-inspector')).toBeVisible();
  await expect(page.locator('.inspector-tabs')).toBeVisible();
  await page.getByRole('tab', { name: '生成', exact: true }).click();
  // 受控路线：basic 模式由系统自动选择引擎，底模选择器只在专家模式出现
  await expect(page.locator('#baseModel')).toBeHidden();
  await page.locator('#inspector-render .inspector-route > summary').filter({ hasText: '推荐配方与复用' }).click();
  await expect(page.locator('.managed-route-card')).toBeVisible();
  await page.locator('#inspector-render .inspector-route > summary').filter({ hasText: '推荐配方与复用' }).click();
  await expect(page.getByRole('button', { name: '生成图片' })).toHaveCount(1);

  // 选一张场景后，提示词应实时生成，并带出结构健康统计
  await page.locator('.scene-list button.scene-card').first().click();
  await page.getByRole('button', { name: '专家模式', exact: true }).click();
  await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'pro');
  // 专家模式放开引擎选择；SD 格式断言（<lora: / [NEG]）需显式切回 SD 引擎
  await page.locator('.engine-switch button').first().click();
  await expect(page.locator('#baseModel')).toBeVisible();
  // Camera controls load with the style tab; verify their initial state after opening it.
  await page.getByRole('tab', { name: '画面', exact: true }).click();
  await expect(page.locator('#stepCamera')).toBeVisible();
  await expect(page.locator('#stepCamera')).not.toHaveAttribute('open', '');
  await page.getByRole('tab', { name: '提示词', exact: true }).click();
  await expect(page.locator('#stepTags')).toBeVisible();
  await expect(page.locator('.inspector-section[data-panel="prompt"] > #stepTags')).toHaveCount(1);
  await expect(page.locator('.tag-results button').first()).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索词条', exact: true }).fill('校服');
  await expect(page.locator('.tag-results')).toContainText('school_uniform');
  const promptHealth = page.locator('#promptMonitor');
  // 7c3f9fe 起专家模式 Live Preview 默认展开（basic 模式仍折叠）
  await expect(promptHealth).toHaveAttribute('open', '');
  await expect(promptHealth.locator('.prompt-health-summary .token-counter')).toBeVisible();
  // 有 prompt 时面板渲染结构化视图（token-chip 流 + prose + 负向块）
  const previewBody = page.locator('.prompt-health-body');
  await expect(previewBody).toBeVisible();
  await expect(previewBody).not.toHaveText(/^选择左侧场景/);
  await expect(previewBody).toContainText('masterpiece');
  await expect(previewBody).toContainText('<lora:');
  // SD 组装的负向排除块（结构化视图以「负向排除」标签呈现，替代旧 [NEG] 行内标记）
  await expect(previewBody).toContainText('负向排除');
  // 质量前缀必须来自模型 profile，而不是硬编码
  await expect(page.locator('.monitor-profile')).not.toHaveText('');

  expect(errors).toEqual([]);
});

test('director expert artist tags use model-native syntax and stay out of scene mode', async ({ page }) => {
  await page.goto('/prompt-builder');
  await expect(page.getByTestId('artist-style-picker')).toHaveCount(0);
  await page.getByRole('button', { name: /专家模式/ }).click();
  await page.getByRole('tab', { name: '画面', exact: true }).click();
  const picker = page.getByTestId('artist-style-picker');
  await expect(picker).toBeVisible();
  await picker.locator('summary').click();
  await picker.locator('[data-artist-style-id="kantoku"]').click();
  // 有 prompt 后面板渲染结构化 token 流，画师词条以 chip 呈现
  await page.getByRole('tab', { name: '提示词', exact: true }).click();
  await expect(page.locator('.prompt-health-body')).toContainText('kantoku');
  await page.getByRole('tab', { name: '生成', exact: true }).click();
  await page.getByRole('button', { name: /Anima 引擎/ }).click();
  await page.getByRole('tab', { name: '提示词', exact: true }).click();
  await expect(page.locator('.prompt-health-body')).toContainText('@kantoku');
  await page.getByRole('tab', { name: '生成', exact: true }).click();
  await page.getByRole('button', { name: /Krea 2/ }).click();
  await page.getByRole('tab', { name: '提示词', exact: true }).click();
  await expect(page.locator('.prompt-health-body')).toContainText(/clear and soft Japanese anime style/i);
  await page.getByRole('button', { name: /场景模式/ }).click();
  await expect(page.getByTestId('artist-style-picker')).toHaveCount(0);
  // 场景模式收起专家编译面板；无论空态还是结构态，kantoku 都不得出现
  await expect(page.locator('.prompt-health-body')).not.toContainText(/kantoku/i);

});


test('scene manager loads project data and opens the editor without dirtying state', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const stateResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/maintenance/scenes-state' && response.request().method() === 'GET');
  await page.goto('/scene-manager');
  expect((await stateResponse).ok()).toBe(true);

  await expect(page.locator('#maintenanceTitle')).toHaveText('已同步', { timeout: 15_000 });
  await expect(page.locator('.catalog-record').first()).toBeVisible();
  // 未改动时保存按钮必须不可用
  await expect(page.getByRole('button', { name: /保存到项目/ })).toBeDisabled();

  await page.getByRole('button', { name: /新增场景/ }).click();
  await expect(page.locator('.modal-card')).toBeVisible();
  await expect(page.locator('.modal-card input').first()).toHaveValue(/sc\d+/);
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('.modal-card')).toBeHidden();

  expect(errors).toEqual([]);
});

test('scene manager protects unsaved changes during internal navigation', async ({ page }) => {
  await page.goto('/scene-manager');
  await page.getByRole('button', { name: /新增场景/ }).click();
  await page.getByLabel('标题 *').fill('未保存场景');
  await page.getByLabel('故事 *').fill('用于验证站内离开保护。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: /保存到项目/ })).toBeEnabled();

  await page.locator('.nav-links a[href="/scene-explorer"]').click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/\/scene-manager$/);

  await page.locator('.nav-links a[href="/scene-explorer"]').click();
  await page.getByRole('alertdialog', { name: '离开场景管理？', exact: true })
    .getByRole('button', { name: '离开页面', exact: true }).click();
  await expect(page).toHaveURL(/\/scene-explorer$/);
});

test('scene manager exposes tag, showcase and duplicate tooling', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/scene-manager');

  // 标签库：字段来自 tags.json 的 en/cn/cat/weight
  await page.getByRole('button', { name: '标签库' }).click();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.locator('.tag-chip').first()).not.toHaveText('');

  // 样张管理
  await page.getByRole('button', { name: '样张', exact: true }).click();
  await expect(page.locator('.sm-image-card').first()).toBeVisible();

  // 重复检测
  await page.getByRole('button', { name: '重复检测' }).click();
  await page.getByRole('button', { name: '开始检测' }).click();
  await expect(page.locator('.list-meta')).toContainText('发现');

  expect(errors).toEqual([]);
});



test('showcase renders one frosted toolbar and a side-by-side viewer', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await mockShowcase(page);
  await page.goto('/showcase');

  await expect(page.locator('.sample').first()).toBeVisible();

  // 工具条只应有一层磨砂容器：内层 search-row 不得再叠圆角/底色
  const layers = await page.evaluate(() => {
    const row = document.querySelector('.search-row');
    if (!row) return null;
    const cs = getComputedStyle(row);
    return { radius: cs.borderRadius, bg: cs.backgroundColor, border: cs.borderTopWidth };
  });
  expect(layers).not.toBeNull();
  expect(layers!.radius).toBe('0px');
  expect(layers!.border).toBe('0px');

  // 查看器：图与文字并排，不得重叠
  await page.locator('.sample .sample-visual').first().click();
  await expect(page.locator('.showcase-viewer')).toHaveAttribute('open', '');
  const boxes = await page.evaluate(() => {
    const art = document.querySelector('.showcase-viewer .viewer-art');
    const copy = document.querySelector('.showcase-viewer .viewer-copy');
    if (!art || !copy) return null;
    const a = art.getBoundingClientRect();
    const c = copy.getBoundingClientRect();
    return { artRight: Math.round(a.right), copyLeft: Math.round(c.left) };
  });
  expect(boxes).not.toBeNull();
  expect(boxes!.artRight).toBeLessThanOrEqual(boxes!.copyLeft + 2);

  await page.getByRole('button', { name: '关闭大图' }).click();
  await expect(page.locator('.showcase-viewer')).not.toHaveAttribute('open', '');
  await expect(page.locator('.sample .sample-visual').first()).toBeFocused();
  await page.locator('.showcase-filters > summary').press('Enter');
  await pickStudioOptionByValue(page.getByLabel('筛选作品类型'), 'popular');
  await pickStudioOptionByValue(page.getByLabel('筛选角色'), 'popular-test');
  await expect(page.locator('.sample')).toHaveCount(1);
  await pickStudioOptionByValue(page.getByLabel('筛选作品类型'), 'scene');
  await expectStudioSelectValue(page.locator('#showcaseCharSelect'), 'all');
  await expect(page.locator('.sample')).toHaveCount(1);

  expect(errors).toEqual([]);
});


test('character room mounts portrait, composer and voice console', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const live2dAssetRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/assets/live2d-current/nene/')) live2dAssetRequests.push(request.url());
  });
  await page.route('**/api/chat-provider/test', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      online: true,
      vendor: 'opencode',
      models: ['deepseek-v4-flash-free', 'zen-discovered-model'],
      modelCount: 2,
    }),
  }));
  // 本机 runtime/state/chat_api_config.json 可能已存在站主托管配置；
  // 预置"用户已配置"的本地 API 草稿，让本用例聚焦供应商预设切换，
  // 不依赖站主配置是否存在，也不去清除用户真实配置。
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'nene',
      histories: { nene: [], natsume: [] },
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
        volume: 80,
        drafts: { nene: '', natsume: '' },
      },
    }))
  });
  await page.goto('/chat');

  await expect(page.getByRole('heading', { name: '此刻，与你', level: 1 })).toBeVisible();
  await expect(page.locator('.chat-input')).toBeVisible();
  await expect(page.locator('.send-btn')).toBeVisible();
  await expect(page.locator('.portrait-main')).toBeVisible();
  await expect(page.locator('.voice-console')).toBeVisible();
  await expect(page.locator('.live2d-enable-cta')).toContainText('加载绫地宁宁动态立绘');
  expect(live2dAssetRequests).toEqual([]);
  // 角色目录可扩展；原有两位角色仍可通过角色菜单切换。
  await page.getByRole('combobox', { name: '切换角色', exact: true }).click();
  await expect(page.locator('.companion-picker-option[data-value="nene"], .companion-picker-option[data-value="natsume"]')).toHaveCount(2);
  await page.locator('.companion-picker-option[data-value="natsume"]').click();
  await expect(page.locator('.live2d-enable-cta')).toContainText('加载四季夏目动态立绘');
  await page.locator('.live2d-enable-cta').click();
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.live2d-host canvas')).toBeVisible();
  await page.locator('.room-model-settings summary').click();
  await page.locator('.api-settings-toggle').click();
  await expect(page.locator('.api-settings')).toBeVisible();
  await page.locator('[data-vendor="deepseek"]').click();
  await expect(page.locator('[data-vendor="deepseek"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('API 地址')).toHaveValue('https://api.deepseek.com');
  await expectStudioSelectValue(page.getByLabel('模型名'), 'deepseek-v4-flash');
  await page.locator('[data-vendor="opencode"]').click();
  await expect(page.getByLabel('API 地址')).toHaveValue('https://opencode.ai/zen/v1');
  await expectStudioSelectValue(page.getByLabel('模型名'), 'deepseek-v4-flash-free');
  await page.locator('[data-vendor="opencode-go"]').click();
  await expect(page.getByLabel('API 地址')).toHaveValue('https://opencode.ai/zen/go/v1');
  await expectStudioSelectValue(page.getByLabel('模型名'), 'deepseek-v4-flash');
  await page.locator('[data-vendor="opencode"]').click();
  await page.getByLabel('API Key').fill('test-key');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.locator('.api-test-status')).toContainText('连接成功，发现 2 个模型');
  expect((await readStudioOptions(page.getByLabel('模型名'))).length).toBe(6);
  await expect(page.locator('.voice-console')).toBeVisible();

  expect(errors).toEqual([]);
});


test('companion chat window renders history from storage and relays sends to the character window', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'nene',
      histories: {
        nene: [
          { role: 'user', content: '你好呀', mid: 'm-user' },
          { role: 'assistant', content: '今天也在这里陪着你。', mid: 'm-assistant' },
        ],
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
    // 实时状态由角色窗下行：聊天窗据此显示状态/发送
    localStorage.setItem('aics_companion_chat_live_v1', JSON.stringify({
      busy: false, thinking: false, speaking: false,
      activeChar: 'nene', chatReady: true, ts: 1,
    }));
    (window as any).__relayedCommands = [];
    (window as any).__radioStates = [];
    (window as any).__hideChatCalls = 0;
    window.desktopCapabilitiesFixture = {
        isDesktop: true,
        hide: () => {},
        quit: () => {},
        openAtelier: () => {},
        openChat: async () => {},
        hideChatWindow: async () => { (window as any).__hideChatCalls += 1; },
        chatRelay: async (payload: Record<string, unknown>) => {
          (window as any).__relayedCommands.push(payload);
          // 模拟角色窗处理 'send' 后回写一条 assistant 消息到 storage
          if ((payload as any).command === 'send') {
            const raw = JSON.parse(localStorage.getItem('aics_chat_v1') || 'null');
            const list = raw?.histories?.nene || [];
            list.push({ role: 'user', content: payload.text, mid: `echo-user-${Date.now()}` });
            list.push({ role: 'assistant', content: '已收到。', mid: `echo-ai-${Date.now()}` });
            raw.histories.nene = list;
            localStorage.setItem('aics_chat_v1', JSON.stringify(raw));
            window.dispatchEvent(new StorageEvent('storage', { key: 'aics_chat_v1', newValue: JSON.stringify(raw) }));
            // The owning window acknowledges acceptance separately from IPC delivery.
            window.dispatchEvent(new StorageEvent('storage', { key: 'aics_chat_relay_receipt_v1', newValue: JSON.stringify({ requestId: payload.requestId, accepted: true, ts: Date.now() }) }));
          }
        },
        onChatCommand: () => 1,
        offChatCommand: () => {},
        onVisibilityChanged: () => 1,
        offVisibilityChanged: () => {},
      };
  });
  await page.setViewportSize({ width: 560, height: 720 });
  await page.goto('/companion-chat');

  await expect(page.locator('.companion-chat-window')).toBeVisible();
  // 历史从 storage 渲染（跨窗经 storage 事件同步）
  await expect(page.locator('.companion-chat-bubble.user p')).toHaveText('你好呀', { timeout: 5000 });
  await expect(page.locator('.companion-chat-bubble p', { hasText: '今天也在这里陪着你' })).toBeVisible();
  // 角色切换控件 + 迷你标题栏
  await expect(page.getByRole('combobox', { name: '切换角色', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '切换角色', exact: true }).click();
  await expect(page.locator('.companion-picker-option[data-value="nene"], .companion-picker-option[data-value="natsume"]')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // 发送 → chatRelay({ command:'send', text })，清空输入
  const input = page.locator('.companion-chat-input');
  await input.fill('晚上好');
  await page.locator('.companion-chat-send').click();
  await expect.poll(() => page.evaluate(() => (window as any).__relayedCommands.length)).toBeGreaterThan(0);
  const sent = await page.evaluate(() => (window as any).__relayedCommands.find((c: any) => c?.command === 'send'));
  expect(sent?.text).toBe('晚上好');
  await expect(input).toHaveValue('');
  // 角色窗回写的新消息经 storage 事件合并进气泡列表
  await expect(page.locator('.companion-chat-bubble p', { hasText: '晚上好' })).toBeVisible();
  await expect(page.locator('.companion-chat-bubble p', { hasText: '已收到。' })).toBeVisible();
  // 点 × 关闭聊天窗 → 走 hideChatWindow（直接 hide，不触发 window.close
  // 的卸载链路，避免重开空白）
  await page.locator('.companion-chat-mini[aria-label="关闭聊天窗"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__hideChatCalls)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('speech input: hold-talk entry hidden until ASR endpoint configured', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'nene',
      histories: { nene: [], natsume: [] },
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
        volume: 80,
        drafts: { nene: '', natsume: '' },
      },
    }))
  });
  await page.goto('/chat');

  // 未配置 ASR 端点：按住说话入口不出现
  await expect(page.locator('.chat-input')).toBeVisible();
  await expect(page.locator('.hold-talk-btn')).toHaveCount(0);
  await page.getByRole('button', { name: '语音输入设置' }).click();
  await expect(page.locator('.speech-settings')).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  // 配置启用 + http 端点后出现
  await page.evaluate(() => {
    localStorage.setItem('aics_speech_input_v1', JSON.stringify({
      enabled: true,
      kind: 'openai',
      endpoint: 'http://127.0.0.1:8000/v1',
      model: 'whisper-1',
      apiKey: '',
      language: '',
      autoSend: false,
    }))
  });
  await page.reload();
  await expect(page.locator('.hold-talk-btn')).toBeVisible();
  await expect(page.locator('.hold-talk-btn')).toHaveText(/按住说话/);

  // 设置弹层可打开、关闭；保存后配置持久化
  await page.getByRole('button', { name: '语音输入设置' }).click();
  await expect(page.locator('.speech-settings')).toBeVisible();
  await expect(page.getByLabel('服务地址')).toHaveValue('http://127.0.0.1:8000/v1');
  await page.getByRole('button', { name: '关闭' }).click();
  await expect(page.locator('.speech-settings')).toHaveCount(0);

  // 唤醒词配置：开启后字段出现，保存后持久化
  await page.getByRole('button', { name: '语音输入设置' }).click();
  await expect(page.getByLabel('服务地址')).toBeVisible();
  await page.getByLabel('唤醒词连续对话').check();
  await page.getByLabel(/唤醒词（逗号分隔）/).fill('宁宁，小宁');
  await page.getByLabel(/结束词（逗号分隔）/).fill('再见，结束对话');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.speech-settings')).toHaveCount(0);
  await page.getByRole('button', { name: '语音输入设置' }).click();
  await expect(page.getByLabel('唤醒词连续对话')).toBeChecked();
  await expect(page.getByLabel(/唤醒词（逗号分隔）/)).toHaveValue('宁宁，小宁');
  await expect(page.getByLabel(/结束词（逗号分隔）/)).toHaveValue('再见，结束对话');
  await page.getByRole('button', { name: '关闭' }).click();
  await expect(page.locator('.speech-settings')).toHaveCount(0);

  // 禁用后入口再次隐藏
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('aics_speech_input_v1') || '{}');
    localStorage.setItem('aics_speech_input_v1', JSON.stringify({ ...raw, enabled: false }))
  });
  await page.reload();
  await expect(page.locator('.hold-talk-btn')).toHaveCount(0);

  // 自动监听在无麦克风环境会报一次权限错误（不应无限重试）；
  // 其余运行时错误不允许出现。
  const permissionErrors = errors.filter(error => !/microphone|Permissions policy/.test(error));
  expect(permissionErrors).toEqual([]);
});

test('companion speech: page Space is hold-to-talk but DND blocks auto listening', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'nene',
      histories: { nene: [], natsume: [] },
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
        volume: 80,
        drafts: { nene: '', natsume: '' },
      },
    }));
    localStorage.setItem('aics_speech_input_v1', JSON.stringify({
      enabled: true,
      kind: 'openai',
      endpoint: 'http://127.0.0.1:8000/v1',
      model: 'whisper-1',
      apiKey: '',
      language: '',
      autoSend: false,
      wakeEnabled: true,
      wakeWords: [],
      endWords: ['结束对话'],
    }));
    localStorage.setItem('aics_companion_behavior_v1', JSON.stringify({
      enabled: true,
      dnd: true,
      idleMinutes: 0,
      quietStartHour: 23,
      quietEndHour: 8,
    }));
    (window as any).__speechMicCalls = 0;
    (window as any).__speechTrackStops = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          (window as any).__speechMicCalls += 1;
          return { getTracks: () => [{ stop: () => { (window as any).__speechTrackStops += 1; } }] };
        },
      },
    });
    class MockAudioContext {
      sampleRate = 16000;
      destination = {};
      state = 'running';
      createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
      createScriptProcessor() { return { connect: () => {}, disconnect: () => {}, onaudioprocess: null }; }
      createGain() { return { gain: { value: 0 }, connect: () => {}, disconnect: () => {} }; }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    (window as any).AudioContext = MockAudioContext;
  });
  await page.goto('/companion');

  await expect(page.locator('.companion-speech-btn')).toBeVisible();
  await expect(page.locator('.companion-speech-cluster')).toBeVisible();
  const speechLayout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      textarea: rect('.companion-input'),
      send: rect('.companion-send'),
      cluster: rect('.companion-speech-cluster'),
    };
  });
  expect(speechLayout.scrollWidth).toBeLessThanOrEqual(speechLayout.viewport);
  expect(speechLayout.cluster?.width).toBeGreaterThan(0);
  expect(speechLayout.cluster?.right).toBeLessThanOrEqual(speechLayout.viewport + 1);
  expect(speechLayout.textarea?.right).toBeLessThanOrEqual(speechLayout.send?.left || 0);
  expect(speechLayout.send?.right).toBeLessThanOrEqual(speechLayout.cluster?.left || 0);
  await expect(page.locator('.companion-speech-btn')).toHaveAttribute('data-state', 'idle');
  await expect.poll(() => page.evaluate(() => (window as any).__speechMicCalls)).toBe(0);

  const input = page.locator('.companion-input');
  await input.focus();
  await page.keyboard.down(' ');
  await expect(page.locator('.companion-speech-btn')).toHaveAttribute('data-state', 'idle');
  await page.keyboard.up(' ');

  await page.locator('.companion-page').click({ position: { x: 10, y: 10 } });
  await page.keyboard.down(' ');
  await expect(page.locator('.companion-speech-btn')).toHaveAttribute('data-state', 'capturing');
  await page.keyboard.up(' ');
  await expect(page.locator('.companion-speech-btn')).toHaveAttribute('data-state', 'idle');
  await expect.poll(() => page.evaluate(() => (window as any).__speechMicCalls)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__speechTrackStops)).toBe(1);
  expect(errors).toEqual([]);
});

test('companion speech: releasing Space while acquiring cancels deferred microphone start', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'nene',
      histories: { nene: [], natsume: [] },
      settings: {
        model: 'local-model', provider: 'api', apiBaseUrl: 'https://local.example/v1',
        apiModel: 'local-model', apiKey: 'local-key', webSearchEnabled: false,
        live2dEnabled: false, live2dOutfit: 'school', autoVoice: false, volume: 80,
        drafts: { nene: '', natsume: '' },
      },
    }));
    localStorage.setItem('aics_speech_input_v1', JSON.stringify({
      enabled: true, kind: 'openai', endpoint: 'http://127.0.0.1:8000/v1',
      model: 'whisper-1', apiKey: '', language: '', autoSend: false,
      wakeEnabled: false, wakeWords: [], endWords: ['结束对话'],
    }));
    (window as any).__speechMicCalls = 0;
    (window as any).__speechTrackStops = 0;
    (window as any).__resolveSpeechMic = null;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => {
          (window as any).__speechMicCalls += 1;
          return new Promise(resolve => { (window as any).__resolveSpeechMic = resolve; });
        },
      },
    });
    class MockAudioContext {
      sampleRate = 16000;
      destination = {};
      state = 'running';
      createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
      createScriptProcessor() { return { connect: () => {}, disconnect: () => {}, onaudioprocess: null }; }
      createGain() { return { gain: { value: 0 }, connect: () => {}, disconnect: () => {} }; }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    (window as any).AudioContext = MockAudioContext;
  });
  await page.goto('/companion');
  await expect(page.locator('.companion-speech-btn')).toBeVisible();

  await page.locator('.companion-page').click({ position: { x: 10, y: 10 } });
  await page.keyboard.down(' ');
  await expect(page.locator('.companion-speech-btn')).toHaveAttribute('data-state', 'acquiring');
  await page.keyboard.up(' ');
  await expect(page.locator('.companion-speech-btn')).toHaveAttribute('data-state', 'idle');
  await expect.poll(() => page.evaluate(() => (window as any).__speechMicCalls)).toBe(1);

  await page.evaluate(() => {
    (window as any).__resolveSpeechMic({
      getTracks: () => [{ stop: () => { (window as any).__speechTrackStops += 1; } }],
    });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__speechTrackStops)).toBe(1);
  await expect(page.locator('.companion-speech-btn')).toHaveAttribute('data-state', 'idle');
});


test('chat storage migrates legacy settings and removes durable credentials', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e_chat_storage_seeded') === '1') return;
    sessionStorage.setItem('e2e_chat_storage_seeded', '1');
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 1,
      activeCharacter: 'natsume',
      provider: 'api',
      api: {
        baseUrl: 'https://legacy.example/v1',
        model: 'legacy-model',
        apiKey: 'legacy-browser-secret',
        headers: { Authorization: 'Bearer legacy-browser-secret' },
      },
      settings: { password: 'must-not-survive' },
    }));
  });
  await page.goto('/chat');
  await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'natsume');

  await expect.poll(() => page.evaluate(() => localStorage.getItem('aics_chat_v1') || '')).not.toContain('legacy-browser-secret');
  const migrated = await page.evaluate(() => ({
    local: localStorage.getItem('aics_chat_v1') || '',
    sessionKey: sessionStorage.getItem('aics_chat_api_key_v1'),
  }));
  const durable = JSON.parse(migrated.local);
  expect(durable.version).toBe(3);
  expect(durable.settings.provider).toBe('api');
  expect(durable.settings.apiBaseUrl).toBe('https://legacy.example/v1');
  expect(durable.settings.apiModel).toBe('legacy-model');
  expect(durable.settings.live2dOutfit).toBe('natsume-cafe');
  expect(durable.settings.live2dOutfits).toMatchObject({ nene: 'school', natsume: 'natsume-cafe' });
  expect(migrated.local).not.toContain('legacy-browser-secret');
  expect(durable.settings.apiKey).toBe('');
  expect(migrated.local).not.toContain('Authorization');
  expect(migrated.local).not.toContain('password');
  expect(migrated.sessionKey).toBeNull();

  await page.evaluate(() => {
    localStorage.setItem('aics_chat_v1', '{damaged');
    sessionStorage.removeItem('aics_chat_api_key_v1');
  });
  await page.reload();
  await expect(page.locator('.chat-input')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('aics_chat_v1'))).toBe('{damaged');
  await expect(page.getByText(/聊天数据版本不兼容或已损坏/).first()).toBeVisible();
  await expect(page.locator('.send-btn')).toBeDisabled();
});

test('character profile opens the selected character room and persona scenes', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.route('**/api/chat-status', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, online: false, models: [] }),
  }));
  await page.route('**/api/tts-status', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, online: false, voices: {} }),
  }));
  await page.goto('/character?character=natsume');

  await expect(page.locator('.character-name')).toHaveText('四季夏目');
  await expect(page.locator('.recommend-title').filter({ hasText: '人设核心场景' })).toBeVisible();
  await expect(page.locator('.recommend-grid a')).toHaveCount(6);
  await page.getByRole('link', { name: '进入她的房间' }).click();
  await expect(page).toHaveURL(/\/chat\?character=natsume/);
  await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'natsume');
  await page.locator('.room-model-settings > summary').click();
  await expect(page.getByRole('group', { name: '对话模型来源' })).toBeVisible();
  await expect(page.getByRole('button', { name: '自定义 API', exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});


test('scene explorer collapses filters into a single toolbar', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/scene-explorer');

  await expect(page.locator('.scene-toolbar')).toHaveCount(1);
  await expect(page.locator('.scene-grid .sc')).toHaveCount(12);
  await expect(page.getByRole('button', { name: '人设核心', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.scene-count')).toHaveText('已显示 12 / 12 个场景');
  const firstScene = page.locator('.scene-grid .sc').first();
  await firstScene.locator('.ex-more summary').click();
  await firstScene.getByRole('button', { name: '隐藏', exact: true }).click();
  await expect(page.locator('.scene-grid .sc')).toHaveCount(11);
  // 精细筛选默认收起，点开后才出现
  await expect(page.locator('.scene-facet-panel')).toBeHidden();
  await page.locator('.filter-toggle').click();
  await expect(page.locator('.scene-facet-panel')).toBeVisible();
  await expect(page.locator('.mature-hint')).toContainText(/成人 \d+ · 已展示/);
  const hiddenToggle = page.getByRole('switch', { name: /管理已隐藏/ });
  await expect(hiddenToggle).toHaveAccessibleName(/1/);
  await hiddenToggle.check();
  await expect(page.locator('.scene-grid .sc')).toHaveCount(1);
  const hiddenScene = page.locator('.scene-grid .sc').first();
  await hiddenScene.locator('.ex-more summary').click();
  await hiddenScene.getByRole('button', { name: '↩ 恢复', exact: true }).click();
  await expect(page.locator('.scene-grid .sc')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('scene explorer promotes locally used scenes without deleting the archive', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_scene_usage_v1', JSON.stringify({
      sc001: { uses: 3, lastUsed: Date.now() },
    }));
  });

  await page.goto('/scene-explorer');
  await expect(page.getByRole('button', { name: '常用 1', exact: true })).toHaveClass(/active/);
  await expect(page.locator('.scene-grid .sc')).toHaveCount(1);
  await expect(page.locator('.sc-tier.personal')).toContainText('常用 3');

  await page.getByRole('button', { name: /完整库/ }).click();
  await expect(page.locator('.scene-grid .sc')).toHaveCount(24);
  const fullLibrary = page.getByRole('button', { name: /^完整库 \d+$/ });
  await expect(fullLibrary).toHaveAttribute('aria-pressed', 'true');
  const total = Number((await fullLibrary.innerText()).match(/\d+$/)![0]);
  expect(total).toBeGreaterThan(24);
  await expect(page.locator('.scene-count')).toHaveText(`已显示 24 / ${total} 个场景`);

  expect(errors).toEqual([]);
});


test('guest query forces the guide and local dismissal persists', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/?guest=1');
  await expect(page.locator('.nav-brand .nav-logo')).toHaveAttribute('alt', '绘遇 · HUIYU');
  await expect(page.locator('.journal-entry').first()).toBeVisible();
  await expect(page.locator('#continueCta')).toHaveAttribute('href', '/scene-explorer');
  await expect(page.getByRole('dialog', { name: '访客导览' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '欢迎来到 绘遇' })).toBeVisible();
  await page.getByRole('button', { name: '开始创作' }).click();
  await expect(page.getByRole('dialog', { name: '访客导览' })).toBeHidden();
  const dismissed = await page.evaluate(() => localStorage.getItem('aics_guest_guide_dismissed'));
  expect(dismissed).toBe('1');
  await page.goto('/?guest=1');
  await expect(page.getByRole('dialog', { name: '访客导览' })).toBeVisible();
  expect(errors).toEqual([]);
});


test.beforeEach(async ({ page }) => { await installDesktopHostFixture(page) })
