import { expect, test, type Page } from '@playwright/test';

/**
 * 无障碍与多设备回归（Vue SPA 版本）
 *
 * 骨架断言从各页 HTML 移到 AppLayout：整站共用一个 skip-link + main landmark，
 * 所以这里逐路由验证「唯一 landmark」而不是每页各自实现一份。
 */

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  const ignore = /favicon|ERR_CONNECTION_REFUSED|404|Failed to load resource.*50[23]|Content Security Policy.*fonts\.googleapis|net::ERR_/;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !ignore.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
}

async function seedGallery(page: Page) {
  await page.evaluate(async () => {
    const svg = (w: number, h: number, color: string) =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/></svg>`,
      )}`;
    const records = [
      { id: 1, timestamp: Date.now(), scene: 'sc001', sceneTitle: '横向作品', character: 'nene', size: '1200x600', image_data: svg(1200, 600, '#7057c7'), favorite: true, version: 1, rating: {}, prompt: 'a' },
      { id: 2, timestamp: Date.now() - 1000, scene: 'sc005', sceneTitle: '竖向作品', character: 'natsume', size: '600x1200', image_data: svg(600, 1200, '#d87898'), favorite: false, version: 1, rating: {}, prompt: 'b' },
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

// 走 AppLayout 的路由：共享 skip-link 与 main landmark
const layoutRoutes = [{ path: '/', name: 'shared app layout' }];

for (const entry of layoutRoutes) {
  test(`${entry.name} exposes a single skip link and main landmark`, async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    await page.goto(entry.path);
    await expect(page.locator('a.skip-link[href="#main"]')).toHaveCount(1);
    await expect(page.locator('#main')).toHaveCount(1);
    // 必须是真的 <main>，且全页恰好一个。
    // 这条断言原先写的是 toHaveCount(0) —— 那是在锁定"没有 main 地标"这个 bug：
    // AppLayout 当时输出 <div id="main">，skip-link 落在一个普通容器上。
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('main#main')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

test('not-found route gets a distinct document title', async ({ page }) => {
  await page.goto('/route-that-does-not-exist');
  await expect(page).toHaveTitle('页面未找到 · 绘遇');
});

test('primary navigation is reachable and marks the active route', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/');

  // 品牌字标必须完整渲染（曾被塞进方框裁成色块）
  const logo = page.locator('.nav-logo');
  await expect(logo).toBeVisible();
  const box = await logo.boundingBox();
  expect(box!.width).toBeGreaterThan(box!.height);

  // 窄屏导航收进汉堡菜单，先展开
  const toggle = page.locator('.nav-menu-toggle');
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(page.locator('.nav-links')).toHaveClass(/open/);
  }

  // 限定在顶栏：首页正文里也有指向 /showcase 的入口卡
  await page.locator('.nav-more-trigger').click();
  await page.locator('.nav-links a[href="/showcase"]').click();
  await expect(page).toHaveURL(/\/showcase/);
  await expect(page.locator('.nav-links a[href="/showcase"]')).toHaveAttribute('aria-current', 'page');
  expect(errors).toEqual([]);
});

test('gallery viewer traps focus and restores it on Escape', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/gallery');
  await seedGallery(page);
  await page.reload();

  const firstArt = page.locator('.artwork-button').first();
  await expect(firstArt).toBeVisible();
  await firstArt.focus();
  await firstArt.click();
  await expect(page.locator('.art-viewer')).toHaveClass(/open/);

  await expect.poll(async () => page.evaluate(() => {
    const viewer = document.querySelector('.art-viewer');
    const active = document.activeElement as HTMLElement | null;
    return !!(viewer && active && viewer.contains(active));
  }), { timeout: 5000 }).toBe(true);

  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const viewer = document.querySelector('.art-viewer');
      return !!(viewer && viewer.contains(document.activeElement));
    });
    expect(inside).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(page.locator('.art-viewer')).not.toHaveClass(/open/);
  await expect(firstArt).toBeFocused();
  expect(errors).toEqual([]);
});

test('静态氛围层在桌面减弱动效模式下不引入动态负担', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  await page.goto('/prompt-builder');
  const atmosphere = page.locator('.route-atmosphere');
  await expect(atmosphere).toHaveAttribute('aria-hidden', 'true');
  await expect(atmosphere).toHaveCSS('animation-name', 'none');
  await expect(atmosphere).toHaveCSS('pointer-events', 'none');
  expect(await atmosphere.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(page.locator('.route-loader')).not.toHaveClass(/active/);
  await expect(page.locator('.route-cut.active')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.routeMotion || '')).toBe('');
});
