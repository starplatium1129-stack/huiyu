import { expect, test, type Page } from '@playwright/test';
import { expectStudioSelectValue, pickStudioOptionByValue, readStudioOptions } from './helpers/studioSelect';

/**
 * Vue SPA 浏览器回归
 *
 * 重构前这些用例走 /tools/*.html + 全局 DOM id。
 * 现在是 Vue Router 单页应用，断言改为路由路径 + 语义/类选择器，
 * 避免再次和某个实现细节的 id 绑死。
 */

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  const ignore = /favicon|ERR_CONNECTION_REFUSED|404|Failed to load resource.*50[23]|Content Security Policy.*fonts\.googleapis|net::ERR_|Transition was skipped/;
  page.on('pageerror', error => {
    if (!ignore.test(error.message)) errors.push(error.message);
  });
  page.on('console', message => {
    if (message.type() === 'error' && !ignore.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
}

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

/** 往 IndexedDB 塞两条作品记录（一横一竖），用于作品册相关用例 */
async function seedGallery(page: Page) {
  await page.evaluate(async () => {
    const svg = (w: number, h: number, color: string) =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/></svg>`,
      )}`;

    const records = [
      { id: 1, timestamp: Date.now(), scene: 'sc001', sceneTitle: '横向作品', character: 'nene', size: '1200x600', image_data: svg(1200, 600, '#7057c7'), favorite: true, version: 1, rating: {}, prompt: 'landscape' },
      { id: 2, timestamp: Date.now() - 1000, scene: 'sc005', sceneTitle: '竖向作品', character: 'natsume', size: '600x1200', image_data: svg(600, 1200, '#d87898'), favorite: false, version: 1, rating: {}, prompt: 'portrait' },
    ];

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('aics_kv_store', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) {
          request.result.createObjectStore('kv', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'aics_pb_history', value: records });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

test('home renders hero, featured scenes and live counts', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/');

  await expect(page.locator('.nav-brand .nav-logo')).toHaveAttribute('alt', '绘遇 · HUIYU');
  await expect(page.locator('.hero-register')).toContainText('绘遇 HUIYU · AI 角色创作画室');
  await expect(page.locator('.hero-title')).toBeVisible();
  // 精选场景来自 scenes.json + curation.json，必须真的渲染进画册手帖
  await expect(page.locator('.journal-entry').first()).toBeVisible();
  // 主要创作入口
  await expect(page.locator('#continueCta')).toHaveText(/选场景，开始创作/);
  await expect(page.locator('#continueCta')).toHaveAttribute('href', '/scene-explorer');

  expect(errors).toEqual([]);
});

test('director separates a focused scene mode from the expert tag workflow', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.goto('/prompt-builder');

  await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'basic');
  await expect(page.locator('.material-switch button[aria-controls="material-character"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.material-switch button[aria-controls="material-story"]').click();
  await expect(page.locator('.story-input')).toBeVisible();
  await expect(page.locator('.voice-studio')).toBeHidden();
  await page.locator('.inspector-voice > summary').click();
  await expect(page.locator('.voice-studio')).toBeVisible();
  await page.locator('.inspector-voice > summary').click();
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click();
  await expect(page.locator('.scene-list button.scene-card').first()).toBeVisible();
  await expect(page.locator('.scene-list button.scene-card')).toHaveCount(6);
  await expect(page.locator('#stepTags')).toBeHidden();
  await expect(page.locator('#projectSelect')).toHaveCount(0);
  const shellWidth = await page.locator('.pb').evaluate(element => element.getBoundingClientRect().width);
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(shellWidth).toBeGreaterThanOrEqual(1000);
  expect(shellWidth).toBeLessThanOrEqual(1880);
  expect(shellWidth).toBeLessThanOrEqual(viewportWidth);
  const basicColumns = await page.locator('.director-workspace').evaluate(element => {
    const [left, center, right] = ['.col-left', '.col-center', '.director-inspector'].map(selector => element.querySelector(selector)!.getBoundingClientRect().width);
    return { left, center, right };
  });
  // Atelier basic mode reserves 280px for story and 320px for decisions at >=1400px.
  expect(basicColumns.left).toBeCloseTo(280, 0);
  expect(basicColumns.center).toBeGreaterThan(basicColumns.left * 1.75);
  expect(basicColumns.right).toBeCloseTo(320, 0);
  await expect(page.locator('.director-inspector')).toBeVisible();
  await expect(page.locator('.inspector-tabs')).toBeHidden();
  // 受控路线：basic 模式由系统自动选择引擎，底模选择器只在专家模式出现
  await expect(page.locator('#baseModel')).toBeHidden();
  await page.locator('.inspector-route > summary').click();
  await expect(page.locator('.managed-route-card')).toBeVisible();
  await page.locator('.inspector-route > summary').click();
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
  await expect(page.locator('.tag-results button')).toHaveCount(72);
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
  await expect(page.locator('.prompt-health-body')).toContainText('clear and soft Japanese anime style');
  await page.getByRole('button', { name: /场景模式/ }).click();
  await expect(page.getByTestId('artist-style-picker')).toHaveCount(0);
  // 场景模式收起专家编译面板；无论空态还是结构态，kantoku 都不得出现
  await expect(page.locator('.prompt-health-body')).not.toContainText(/kantoku/i);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /专家模式/ }).click();
  await page.getByRole('tab', { name: '画面', exact: true }).click();
  const mobilePicker = page.getByTestId('artist-style-picker');
  await mobilePicker.locator('summary').click();
  // 画师库随调研持续扩容（20→37），断言下限而非写死
  await expect(mobilePicker.locator('[data-artist-style-id]').first()).toBeVisible();
  const artistCount = await mobilePicker.locator('[data-artist-style-id]').count();
  expect(artistCount).toBeGreaterThanOrEqual(20);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('director restores state from a scene deep link', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/prompt-builder?scene=sc001');

  // 深链必须把场景真正装进导演台
  await expect(page.locator('.pb')).toHaveAttribute('data-character', /nene|natsume|triad/);
  await expect(page.locator('.material-switch button[aria-controls="material-scenes"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.material-switch button[aria-controls="material-story"]').click();
  await expect(page.locator('.scene-context-title')).toBeVisible();
  await page.getByRole('button', { name: '专家模式', exact: true }).click();
  // 受控路线下 basic 自动走 Anima；SD LoRA 断言需在专家模式切回 SD 引擎
  await page.locator('.engine-switch button').first().click();
  await page.getByRole('tab', { name: '提示词', exact: true }).click();
  await expect(page.locator('.prompt-health-body')).toContainText('lora');

  expect(errors).toEqual([]);
});

test('scene manager loads project data and opens the editor without dirtying state', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const stateResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/maintenance/scenes-state' && response.request().method() === 'GET');
  await page.goto('/scene-manager');
  expect((await stateResponse).ok()).toBe(true);

  await expect(page.locator('#maintenanceTitle')).toHaveText('已同步', { timeout: 15_000 });
  await expect(page.locator('.catalog-record').first()).toBeVisible();
  await expect(page.locator('.stats')).toContainText('302');
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

test('gallery preserves horizontal and vertical art in the immersive viewer', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/gallery');
  await seedGallery(page);
  await page.reload();

  await expect(page.locator('.artwork')).toHaveCount(2);
  const ratios = await page.locator('.artwork-media').evaluateAll(nodes => nodes.map(node => {
    const raw = getComputedStyle(node).aspectRatio;
    const parts = raw.split('/').map(part => Number(part.trim()));
    return parts.length === 2 && parts[1] ? parts[0] / parts[1] : Number(raw);
  }));
  expect(ratios[0]).toBeCloseTo(2, 1);
  expect(ratios[1]).toBeCloseTo(0.5, 1);

  await page.locator('.artwork-button').first().click();
  await expect(page.locator('.art-viewer')).toHaveClass(/open/);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.viewer-position')).toContainText('2 / 2');
  await page.keyboard.press('Escape');
  await expect(page.locator('.art-viewer')).not.toHaveClass(/open/);

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
  await pickStudioOptionByValue(page.getByLabel('筛选作品类型'), 'popular');
  await pickStudioOptionByValue(page.getByLabel('筛选角色'), 'popular-test');
  await expect(page.locator('.sample')).toHaveCount(1);
  await pickStudioOptionByValue(page.getByLabel('筛选作品类型'), 'scene');
  await expectStudioSelectValue(page.locator('#showcaseCharSelect'), 'all');
  await expect(page.locator('.sample')).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('control panel shows service status wall and scheduling controls', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/control');

  await expect(page.locator('.control-rail')).toBeVisible();
  await expect(page.locator('.control-rail-link')).toHaveCount(6);
  await expect(page.locator('.control-rail-brand')).toContainText('Local control room');
  await expect(page.locator('.control-title')).toBeVisible();
  await expect(page.locator('.status-tile').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /检测所有服务/ })).toBeVisible();
  // 显存调度与单服务启停
  await expect(page.getByRole('button', { name: /绘图优先/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /聊天优先/ })).toBeVisible();
  await expect(page.locator('.service-row')).toHaveCount(4);

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
  await expect(page.locator('.avatar-status')).toHaveText('启用 Live2D');
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
    Object.defineProperty(window, 'companionDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        hide: () => {},
        quit: () => {},
        openAtelier: () => {},
        openChat: () => { (window as any).__openChatCalls.push(1); },
        toggleChat: () => {},
        chatRelay: (payload: Record<string, unknown>) => { (window as any).__relayedCommands.push(payload); },
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
        onFileDrop: () => 1,
        offFileDrop: () => {},
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
        getWorkspace: async () => ({ root: '', exists: false }),
        setWorkspace: async () => ({ root: '' }),
      },
    });
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
    Object.defineProperty(window, 'companionDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        hide: () => {},
        quit: () => {},
        openAtelier: () => {},
        openChat: () => {},
        hideChatWindow: () => { (window as any).__hideChatCalls += 1; },
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
      },
    });
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
  await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'natsume');
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.live2d-host canvas')).toBeVisible();
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

test('Natsume Live2D eyes blink symmetrically via the blink scheduler', async ({ page }) => {
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
  await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'natsume');
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });

  // 眨眼调度器把双眼参数逐帧写同一值（stage.dataset.blink = 1 睁 / 0 闭）。
  // 低负载和共享 CI runner 的采样频率差异很大，按状态轮询完整闭眼→睁眼周期。
  const stage = page.locator('.portrait-stage');
  await expect.poll(async () => Number(await stage.getAttribute('data-blink')), {
    message: '20 秒内应出现至少一次闭眼状态',
    timeout: 20_000,
    intervals: [80],
  }).toBeLessThan(0.5);
  await expect.poll(async () => Number(await stage.getAttribute('data-blink')), {
    message: '眨眼结束后眼睛应回到全睁',
    timeout: 3_000,
    intervals: [40],
  }).toBe(1);
  expect(errors).toEqual([]);
});

test('Natsume plays the Start entrance motion on load', async ({ page }) => {
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

  // 登场动作（Start 组）启动后，覆盖式眨眼暂停、stage.dataset.entrance='1'，
  // 窗口 5.2s 后回到 '0'。采样 7 秒必须能抓到 '1'。
  const stage = page.locator('.portrait-stage');
  const seen: string[] = [];
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    seen.push(await stage.getAttribute('data-entrance') || '');
    await page.waitForTimeout(100);
  }
  expect(seen, '模型加载后应播放一次登场动作').toContain('1');
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

test('style page offers full colour moods that route into the director', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/style');

  await expect(page.locator('.style-mood-card')).toHaveCount(6);
  // 每张色卡应有多色条，而不是单色块
  const swatches = await page.locator('.style-mood-card').first().locator('.mood-swatch').count();
  expect(swatches).toBeGreaterThan(1);

  await page.locator('.style-mood-card').first().getByRole('link', { name: '用这个调子绘制' }).click();
  await expect(page).toHaveURL(/\/prompt-builder\?mood=/);

  expect(errors).toEqual([]);
});

test('scene explorer collapses filters into a single toolbar', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/scene-explorer');

  await expect(page.locator('.scene-toolbar')).toHaveCount(1);
  await expect(page.locator('.scene-grid .sc')).toHaveCount(12);
  await expect(page.locator('.scene-count')).toContainText('人设核心 12');
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
  await expect(page.locator('.scene-count')).toContainText('全库');

  expect(errors).toEqual([]);
});

test('home page stays inside the performance budget', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.journal-entry').first()).toBeVisible();
  const heroImages = page.locator('.hero-character');
  await expect(heroImages).toHaveCount(2);
  await expect(heroImages.first()).toHaveAttribute('width', '1024');
  await expect(heroImages.first()).toHaveAttribute('height', '1344');
  const selectedHeroSources = await heroImages.evaluateAll(images =>
    images.map(image => (image as HTMLImageElement).currentSrc)
  );
  // 内置 hero 是 webp/avif；用户经场景管理替换的首页主视觉允许 jpg/png
  //（POST /api/maintenance/home-hero 接受 PNG/JPEG/WebP）。
  expect(selectedHeroSources.every(source => /\.(?:avif|webp|jpe?g|png)(?:$|\?)/.test(source))).toBe(true);
  const budget = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    // 请求数不含 woff2：自托管 Noto Sans SC 按 unicode-range 拆了数十个子集，
    // 中文页面必然触发 50+ 次字体请求（每个 ~30KB），这是 CJK 字体的固有形态，
    // 不算应用膨胀；字体体积由下方 transferBytes 上限统一约束。
    const fontRequests = resources.filter(item => /\.woff2?($|\?)/i.test(item.name));
    const nonFontRequests = resources.filter(item => !/\.woff2?($|\?)/i.test(item.name));
    return {
      requests: nonFontRequests.length,
      // transferSize includes per-request response headers and varies with
      // cache/protocol state under parallel workers. encodedBodySize measures
      // the stable payload while still budgeting every loaded font and asset.
      payloadBytes: resources.reduce((sum, item) => sum + item.encodedBodySize, 0),
      domNodes: document.querySelectorAll('*').length,
      // 带颜色过渡的元素数：曾经用 * 选择器命中近 200 个，是性能回归信号
      animated: Array.from(document.querySelectorAll('*')).filter(el => {
        const d = getComputedStyle(el).transitionDuration;
        return d && d !== '0s';
      }).length,
      font500: fontRequests.filter(item => /-500-/.test(item.name)).length,
    };
  });
  expect(budget.requests).toBeLessThanOrEqual(62);
  // Noto Sans SC 字重从 5 降到 4（砍掉 500）后字体文件数下降约 20%；
  // 资源 payload budget remains tight; the current curated home hero pair is
  // currently just over 3.2MB after encoded-body accounting.
  // 2026-08-21 调整 3.25MB → 3.75MB：热门角色横条上线后首屏必载 ~13 张立绘，
  // 原图直出曾达 16MB；经 build-character-thumbs.py 缩略图化（320px WebP
  // ~13KB/张）回收 12MB 后实测 3.58-3.73MB（懒加载张数随布局时序浮动）。
  // 现构成：字体子集 1.73MB（CJK 固有）、showcase 主视觉与场景缩略图 0.82MB、
  // data 0.4MB、应用 chunk 0.24MB、立绘缩略图 0.17-0.56MB——全部为真实内容成本。
  expect(budget.payloadBytes).toBeLessThanOrEqual(3_750_000);
  expect(budget.domNodes).toBeLessThanOrEqual(1_800);
  // 画册手帖与角色目录改版后首屏新增卡片级 hover 反馈；216 为当前实测，
  // 留约 10% 时序浮动，同时继续阻止全局 * transition 回潮。
  expect(budget.animated).toBeLessThanOrEqual(240);
  expect(budget.font500).toBe(0);
});

test('roadmap points to the markdown roadmap document', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/docs/roadmap.html');
  await expect(page.getByRole('heading', { name: '产品路线图', level: 1 })).toBeVisible();
  await expect(page.locator('a[href="roadmap.md"]')).toContainText('docs/roadmap.md');
  expect(errors).toEqual([]);
});

test('guest query forces the guide and local dismissal persists', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/?guest=1');
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

test('Live2D uses the browser backend by default and labels it on the host', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active: 'nene',
      histories: { nene: [], natsume: [] },
      settings: {
        model: '', provider: 'api', apiBaseUrl: '', apiModel: '', apiKey: '',
        webSearchEnabled: false, live2dEnabled: true, live2dOutfit: 'school',
        live2dOutfits: { nene: 'school', natsume: 'natsume-cafe' },
        autoVoice: false, volume: 80, drafts: { nene: '', natsume: '' },
      },
    }));
  });

  await page.goto('/chat');
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-backend', 'browser');
  await expect(page.locator('.live2d-host canvas')).toBeVisible();
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

  // 显式请求原生后端；无 window.aicsLive2dNative 时必须回退浏览器且仍可用
  await page.goto('/chat?live2dBackend=native');
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-backend', 'browser-fallback');
  await expect(page.locator('.live2d-host canvas')).toBeVisible();
  await expect(page.locator('.avatar-status')).toHaveAttribute('data-state', 'ready');
  expect(errors).toEqual([]);
});
