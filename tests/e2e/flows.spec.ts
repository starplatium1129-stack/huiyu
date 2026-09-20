import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import MOCK_PORTS from '../../scripts/lib/e2e-ports.js';

/**
 * 六条主流程回归 —— 跑在 mock 上游之上（scripts/tests/mock-stack.js）。
 *
 * 与 studio.spec.ts 的分工：
 *   studio.spec.ts  断言「页面渲染成什么样」
 *   flows.spec.ts   断言「按下按钮之后，网关到底往上游发了什么、拿回来怎么处理」
 *
 * 之所以要真跑一个网关而不是在浏览器里 route mock：这六条流程里有五条会穿过
 * 服务端代码（SD 代理白名单、/api/chat 的 NDJSON 中继、/api/tts 的音频背压
 * 中继、/api/translate 的常驻服务探测、/api/tts-status 的声线判定）。在浏览器
 * 层拦 fetch 会把这些整段跳过 —— 那种"通过"和真机行为无关。
 */

const MOCK = {
  sd: `http://127.0.0.1:${MOCK_PORTS.sd}`,
  comfy: `http://127.0.0.1:${MOCK_PORTS.translate + 1}`,
  ollama: `http://127.0.0.1:${MOCK_PORTS.ollama}`,
  tts: `http://127.0.0.1:${MOCK_PORTS.tts}`,
  translate: `http://127.0.0.1:${MOCK_PORTS.translate}`,
};

interface MockCall {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

/** 读回某个 mock 上游收到的请求 */
async function calls(request: APIRequestContext, base: string): Promise<MockCall[]> {
  const res = await request.get(`${base}/__mock/state`);
  expect(res.ok(), `${base} mock state must be readable`).toBeTruthy();
  return (await res.json()).calls as MockCall[];
}

async function callsTo(request: APIRequestContext, base: string, path: string): Promise<MockCall[]> {
  return (await calls(request, base)).filter(call => call.path === path);
}

async function resetMocks(request: APIRequestContext) {
  await Promise.all(Object.values(MOCK).map(base => request.post(`${base}/__mock/reset`)));
}

/** 注入故障（如 CUDA OOM），驱动错误恢复路径 */
async function fault(request: APIRequestContext, base: string, faults: Record<string, unknown>) {
  const res = await request.post(`${base}/__mock/fault`, { data: faults });
  expect(res.ok()).toBeTruthy();
}

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  const ignore = /favicon|ERR_CONNECTION_REFUSED|404|Failed to load resource.*50[23]|Content Security Policy.*fonts\.googleapis|net::ERR_|autoplay|play\(\) failed/i;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !ignore.test(message.text())) errors.push(message.text());
  });
  return errors;
}

/**
 * 出图参数（CFG / seed / 采样器）折在 <details> 里，默认收起。
 * 用点 summary 的真实路径打开，而不是 evaluate 改 open —— 后者会绕过
 * "这个折叠区到底点不点得开"这件事。
 * 受控路线（6be3a95）：basic 模式系统自动选引擎，SD 参数面板只在
 * 专家模式 + SD 引擎下渲染，因此打开前先切到专家模式与 SD 引擎。
 */
async function openGenerationSettings(page: Page) {
  const panel = page.locator('details.generation-settings');
  if (!await panel.isVisible()) {
    await page.getByRole('button', { name: '专家模式', exact: true }).click();
    // 受控路线默认 Anima；SD 断言需要显式切回 SD 引擎
    await page.locator('.engine-switch button').first().click();
    await expect(panel).toBeVisible();
  }
  if (await panel.evaluate(node => (node as HTMLDetailsElement).open)) return;
  await panel.locator('summary').click();
  await expect(panel.locator('.controls-grid')).toBeVisible();
}

/** 切到专家模式 + SD 引擎（受控路线下 SD 出图流程的前置） */
async function switchToSdEngine(page: Page) {
  await page.getByRole('button', { name: '专家模式', exact: true }).click();
  await page.locator('.engine-switch button').first().click();
  await expect(page.locator('.api-status .badge')).toHaveText(/SD 已连接/);
}

/**
 * 设计系统的开关是 <label><input><span class="slider"> —— slider 盖在 input 上，
 * 常规 check() 会被判成 pointer 被拦截。force 让点击直接落在 input 上，
 * v-model 的 change 仍会触发。
 */
async function toggle(page: Page, target: string | Locator, on: boolean) {
  const input = typeof target === 'string' ? page.locator(target) : target;
  if (await input.isChecked() === on) return;
  // Reka 开关直接操作语义控件；旧语音复选框仍通过可见 label 操作。
  if (await input.getAttribute('role') === 'switch') await input.setChecked(on);
  else await input.locator('xpath=ancestor::label[1]').click();
  await expect(input).toBeChecked({ checked: on });
}

async function useLocalChat(page: Page) {
  const settings = page.locator('.room-model-settings');
  if (await settings.getAttribute('open') === null) await settings.locator('summary').click();
  const button = page.getByRole('button', { name: '本地模型', exact: true });
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

// 浏览器上下文按用例隔离，localStorage / IndexedDB 天然是空的 ——
// 不要在 addInitScript 里清库：那会在 restore() 触发的 reload 上再清一次。
test.beforeEach(async ({ request }) => {
  await resetMocks(request);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 出图
// ─────────────────────────────────────────────────────────────────────────────
test('flow 1 · 出图：选场景 → 生成 → 成片入册，参数如实送到 SD', async ({ page, request }) => {
  const errors = collectRuntimeErrors(page);
  // 让出图耗时 2.5 秒，好让 1.2 秒一次的进度轮询真的跑起来
  await fault(request, MOCK.sd, { renderMs: 2500 });
  await page.goto('/prompt-builder?scene=sc001');

  // 受控路线：basic 模式系统自动选 Anima 高质量路线，SD 流程需进专家模式切引擎。
  // 先从可见入口展开推荐路线，再切 SD 引擎走 SD 出图断言。
  await page.locator('details.inspector-route > summary').filter({ hasText: '推荐配方与复用' }).click();
  await expect(page.locator('.managed-route-card')).toBeVisible();
  await expect(page.locator('details.generation-settings')).toBeHidden();
  await expect(page.getByRole('button', { name: '生成图片' })).toHaveCount(1);
  await switchToSdEngine(page);
  await openGenerationSettings(page);
  await expect(page.locator('.prompt-health-body')).toContainText('lora');

  // 固定尺寸与 seed，好让断言不依赖推荐值
  await page.locator('.gen-bar-size select').selectOption('896x1344');
  await toggle(page, '.ctrl-seed [role="switch"]', true);
  await page.locator('.ctrl-seed input[type="number"]').fill('4242');

  await page.getByRole('button', { name: '生成图片' }).click();

  // 生成中的等待态：舞台切到 RENDERING，进度条出现
  await expect(page.locator('.stage-ready')).toHaveText('正在显影');
  await expect(page.locator('.stage-progress-ring')).toBeVisible();
  await expect(page.locator('.stage-generating-sub')).toContainText(/%/);

  // 成片出现 → blob URL 来自 mock 返回的 base64 PNG
  await expect(page.locator('.result-image')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.pb')).toHaveClass(/has-result/);

  const generated = await callsTo(request, MOCK.sd, '/sdapi/v1/txt2img');
  expect(generated).toHaveLength(1);
  expect(generated[0].body).toMatchObject({ width:896, height:1344, seed:4242 });
  expect(String(generated[0].body?.prompt)).toContain('school_uniform');
  expect(String(generated[0].body?.prompt)).toContain('<lora:');

  // 保存快照 → IndexedDB 落盘 + 历史面板出现记录
  await page.getByRole('button', { name: '存入作品册' }).click();
  await expect(page.locator('.toast-msg')).toContainText('画面已存入本地作品册');
  // 历史按首次访问加载；打开面板再核对真实保存记录。
  await page.locator('[aria-controls="material-history"]').click();
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.locator('.history-item').first().locator('.history-meta')).toContainText('seed 4242');

  expect(errors).toEqual([]);
});

test('flow 1a · 切换场景：中文字幕跟随第二个场景更新', async ({ page }) => {
  await page.goto('/prompt-builder?scene=sc001');
  const caption = page.locator('.voice-caption-text');
  await expect(caption).toHaveValue(/放学后的等待/);

  await page.locator('button.scene-card').filter({ hasText: '樱花树下的约定' }).click();
  await expect(page.locator('button.scene-card.active')).toContainText('樱花树下的约定');
  await expect(caption).toHaveValue(/樱花树下的约定/);
  await expect(caption).not.toHaveValue(/放学后的等待/);
});

test('flow 1b · 出图失败：CUDA OOM 分类成可执行的降负载重试', async ({ page, request }) => {
  await fault(request, MOCK.sd, { oom: true });
  await page.goto('/prompt-builder?scene=sc001');
  await switchToSdEngine(page);

  await openGenerationSettings(page);
  await page.locator('.gen-bar-size select').selectOption('1216x832');
  await toggle(page, page.getByRole('switch', { name: 'hires.fix', exact: true }), true);
  await page.getByRole('button', { name: '生成图片' }).click();

  // 分类结果必须是显存不足，而不是笼统的"生成失败"
  await expect(page.locator('.sd-recovery-title')).toHaveText('显存不足');
  await page.getByRole('button', { name: '查看恢复选项', exact: true }).click();
  const recovery = page.getByRole('button', { name: '降低负载后重试' });
  await expect(recovery).toBeVisible();

  // 让重试这次成功，断言恢复动作真的改了参数
  await fault(request, MOCK.sd, {});
  await recovery.click();
  await expect(page.locator('.result-image')).toBeVisible();

  const attempts = await callsTo(request, MOCK.sd, '/sdapi/v1/txt2img');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].body?.enable_hr).toBe(true);
  expect(attempts[1].body?.enable_hr).toBeUndefined();
});

test('flow 1c · 出图队列：串行执行、自动入册', async ({ page, request }) => {
  await page.goto('/prompt-builder?scene=sc001');
  await switchToSdEngine(page);

  await page.getByRole('button', { name: '加入队列', exact: true }).click();
  await page.getByRole('button', { name: '加入队列', exact: true }).click();

  // 队列跑完：两张图都出，且都自动写进历史
  await expect(page.locator('.sd-queue')).toBeHidden({ timeout: 20_000 });
  await page.locator('[aria-controls="material-history"]').click();
  await expect(page.locator('.history-item')).toHaveCount(2, { timeout: 20_000 });

  const webuiCalls = await callsTo(request, MOCK.sd, '/sdapi/v1/txt2img');
  expect(webuiCalls).toHaveLength(2);
});

test('flow Anima · 应用 job 经过真网关和假 ComfyUI 出图', async ({ page, request }) => {
  const errors = collectRuntimeErrors(page);
  const directComfyRequests: string[] = [];
  page.on('request', browserRequest => {
    const url = new URL(browserRequest.url());
    if (url.pathname.startsWith('/comfy') || ['/prompt', '/queue', '/history', '/interrupt', '/view'].includes(url.pathname)) {
      directComfyRequests.push(url.pathname);
    }
  });

  await fault(request, MOCK.comfy, { renderMs: 10, historyTransient: 2 });
  await page.goto('/prompt-builder');
  await page.getByRole('button', { name: '夏目', exact: true }).click();
  // 受控路线下引擎切换只在专家模式渲染
  await page.getByRole('button', { name: '专家模式', exact: true }).click();
  await page.locator('.engine-switch button').nth(1).click();
  await expect(page.locator('#baseModel')).toHaveValue(/anima/, { timeout: 10_000 });
  await page.locator('[aria-controls="material-story"]').click();
  await page.locator('.story-input').fill('夏目在咖啡馆里对我微笑');
  await expect(page.getByTestId('anima-generate')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('anima-generate').click();
  await expect(page.locator('.result-image-wrap img.result-image')).toBeVisible({ timeout: 20_000 });

  expect(directComfyRequests).toEqual([]);
  const comfyCalls = await calls(request, MOCK.comfy);
  expect(comfyCalls.filter(call => call.path === '/prompt')).toHaveLength(1);
  expect(comfyCalls.filter(call => call.path.startsWith('/history/')).length).toBeGreaterThan(0);
  expect(comfyCalls.filter(call => call.path === '/view')).toHaveLength(1);
  expect(comfyCalls.some(call => call.path === '/queue' || call.path === '/interrupt')).toBeFalsy();

  const promptPayload = comfyCalls.find(call => call.path === '/prompt')?.body?.prompt as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  expect(promptPayload['1'].class_type).toBe('UNETLoader');
  expect(promptPayload['4'].class_type).toBe('LoraLoader');
  expect(promptPayload['7'].inputs?.batch_size).toBe(1);
  expect(comfyCalls.filter(call => call.path === '/prompt')).toHaveLength(1);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 配音
// ─────────────────────────────────────────────────────────────────────────────
test('flow 2 · 配音：中文字幕 → 本机翻译 → GPT-SoVITS 生成 WAV', async ({ page, request }) => {
  // 整套负载下 mock 网关的 voice 状态查询会变慢，放宽等待
  const VOICE_TIMEOUT = 12_000;
  const errors = collectRuntimeErrors(page);
  await page.goto('/prompt-builder');
  await page.locator('details.inspector-voice > summary').filter({ hasText: '配音与字幕' }).click();
  await expect(page.locator('.voice-state')).toHaveText('AI 声线就绪', { timeout: VOICE_TIMEOUT });

  /**
   * 显式切到夏目。
   *
   * tts-service 的 activeGptWeights / activeSoVitsWeights 是网关进程级状态，
   * 而 mock 栈的网关跨用例长活着 —— 前面的用例已经激活过宁宁的权重，于是
   * "本次是否 set_*_weights" 会随执行顺序漂移。换声线强制重新激活，断言才稳定。
   */
  await page.getByRole('button', { name: '展开配音面板' }).click();
  await page.locator('.voice-field select').first().selectOption('natsume');
  await expect(page.locator('.voice-state')).toHaveText('AI 声线就绪', { timeout: VOICE_TIMEOUT });

  await page.locator('.voice-caption-text').fill('今天也辛苦了，先休息一会儿吧。');
  await page.getByRole('button', { name: '翻译成日文' }).click();

  // 译文必须来自上游（mock 固定加 [JA] 前缀），不是前端兜底原文
  await expect(page.locator('.voice-script-details textarea')).toHaveValue(/^\[JA\] 今天也辛苦了/);
  await expect(page.locator('.voice-status')).toContainText('已生成日语配音稿');

  const translateCalls = await callsTo(request, MOCK.translate, '/translate');
  expect(translateCalls).toHaveLength(1);
  expect(String(translateCalls[0].body?.text)).toContain('今天也辛苦了');

  await page.getByRole('button', { name: '生成 AI 声线' }).click();
  await expect(page.locator('.voice-audio')).toBeVisible({ timeout: VOICE_TIMEOUT });
  await expect(page.locator('.voice-download')).toBeVisible();
  await expect(page.locator('.voice-status')).toContainText('AI 声线已生成');

  // 上游收到的 TTS 载荷：声线权重先切换，再送规范化后的文本
  const ttsCalls = await callsTo(request, MOCK.tts, '/tts');
  expect(ttsCalls).toHaveLength(1);
  expect(ttsCalls[0].body?.text_lang).toBe('ja');
  expect(String(ttsCalls[0].body?.ref_audio_path)).toContain('natsume');
  expect(ttsCalls[0].body?.media_type).toBe('wav');
  const weightCalls = await calls(request, MOCK.tts);
  expect(weightCalls.some(c => c.path === '/set_sovits_weights' && c.query.includes('natsume'))).toBeTruthy();
  expect(weightCalls.some(c => c.path === '/set_gpt_weights' && c.query.includes('natsume'))).toBeTruthy();

  expect(errors).toEqual([]);
});

test('flow 2b · 配音失败：GPT-SoVITS 502 带出真实原因而不是"不可用"', async ({ page, request }) => {
  const VOICE_TIMEOUT = 12_000;
  await fault(request, MOCK.tts, { ttsStatus: 500, ttsError: 'RuntimeError: reference audio missing' });
  await page.goto('/prompt-builder');
  await page.locator('details.inspector-voice > summary').filter({ hasText: '配音与字幕' }).click();
  await expect(page.locator('.voice-state')).toHaveText('AI 声线就绪', { timeout: VOICE_TIMEOUT });

  await page.getByRole('button', { name: '展开配音面板' }).click();
  await page.locator('.voice-caption-text').fill('测试失败路径。');
  await page.locator('.voice-field select').nth(1).selectOption('zh');  // 跳过翻译
  await page.getByRole('button', { name: '生成 AI 声线' }).click();

  await expect(page.locator('.voice-status')).toContainText('GPT-SoVITS 生成失败');
  await expect(page.locator('.voice-status')).toContainText('reference audio missing');
  await expect(page.locator('.voice-audio')).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 聊天
// ─────────────────────────────────────────────────────────────────────────────
test('flow 3 · 聊天：流式回复逐字到达，system prompt 由网关注入', async ({ page, request }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/chat');
  await useLocalChat(page);

  // 关掉实时配音：这条用例只测聊天流
  await toggle(page, page.getByRole('checkbox', { name: /实时配音/ }), false);
  await expect(page.locator('.model-select')).toBeEnabled();
  await expect(page.locator('.character-status')).toContainText('本地聊天模型已连接');

  await page.locator('.chat-input').fill('今天有点累');
  await page.locator('.send-btn').click();

  await expect(page.locator('.message.user .message-bubble')).toHaveText('今天有点累');
  await expect(page.locator('.message.assistant .message-bubble')).toContainText('今天也辛苦了', { timeout: 15_000 });
  await expect(page.locator('.message.assistant.streaming')).toHaveCount(0, { timeout: 15_000 });

  const chatCalls = await callsTo(request, MOCK.ollama, '/api/chat');
  expect(chatCalls).toHaveLength(1);
  const messages = chatCalls[0].body?.messages as Array<{ role: string; content: string }>;
  // 角色人格由服务端注入，前端只送 user/assistant
  expect(messages[0].role).toBe('system');
  expect(messages[0].content).toContain('绫地宁宁');
  expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '今天有点累' });
  expect(chatCalls[0].body?.stream).toBe(true);

  // 刷新后记忆仍在（localStorage 持久化）
  await page.reload();
  await expect(page.locator('.message.user .message-bubble')).toHaveText('今天有点累');

  expect(errors).toEqual([]);
});

test('flow 3a · 用户档案与手动长期记忆进入后续 system prompt', async ({ page, request }) => {
  await page.goto('/chat');
  await useLocalChat(page);
  await toggle(page, page.getByRole('checkbox', { name: /实时配音/ }), false);

  // 2026-08-21：次要操作收进「更多」菜单，先展开再点「我的档案」（只点一次，二次点击会收起）
  await page.locator('.chat-more-trigger').click();
  await page.getByRole('menuitem', { name: '我的档案' }).click();
  await page.getByLabel('希望她怎样称呼你').fill('小林');
  await page.getByLabel('关系定位').selectOption('confidant');
  await page.getByLabel('希望她记住的背景').fill('我习惯夜间工作，希望先听我说完。');
  await page.getByRole('button', { name: '保存档案' }).click();

  await page.locator('.chat-input').fill('我每周五晚上会玩 MMORPG。');
  await page.locator('.send-btn').click();
  await expect(page.locator('.message.assistant .message-bubble').last()).toContainText('今天也辛苦了', { timeout: 15_000 });
  const remember = page.locator('.message.user').getByRole('button', { name: /^(钉住记忆|已记住)$/ }).first();
  await remember.click();
  await expect(remember).toHaveText('已记住');

  await page.locator('.chat-input').fill('周五晚上做什么好？');
  await page.locator('.send-btn').click();
  await expect(page.locator('.message.assistant .message-bubble').last()).toContainText('今天也辛苦了', { timeout: 15_000 });

  const calls = await callsTo(request, MOCK.ollama, '/api/chat');
  expect(calls).toHaveLength(2);
  const secondMessages = calls[1].body?.messages as Array<{ role: string; content: string }>;
  expect(secondMessages[0].content).toContain('• 希望称呼：小林');
  expect(secondMessages[0].content).toContain('• 关系定位：知己');
  expect(secondMessages[0].content).toContain('我每周五晚上会玩 MMORPG。');
  expect(secondMessages[0].content.indexOf('【长期记忆')).toBeLessThan(secondMessages[0].content.indexOf('【对话判断与表达控制】'));

  await page.reload();
  await page.locator('.chat-more-trigger').click();
  await page.getByRole('menuitem', { name: '长期记忆' }).click();
  await expect(page.getByLabel(/编辑记忆/)).toHaveValue('我每周五晚上会玩 MMORPG。');
});

test('chat memory write failure keeps the action retryable without a success message', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem
    Object.assign(window, { failMemoryWrites: true })
    Storage.prototype.setItem = function (key, value) {
      if (key === 'aics_chat_memories_v1' && (window as unknown as { failMemoryWrites: boolean }).failMemoryWrites) throw new DOMException('quota', 'QuotaExceededError')
      original.call(this, key, value)
    }
  })
  await page.goto('/chat')
  await useLocalChat(page)
  await toggle(page, page.getByRole('checkbox', { name: /实时配音/ }), false)
  await page.locator('.chat-input').fill('我喜欢周五晚上散步')
  await page.locator('.send-btn').click()
  const remember = page.locator('.message.user').getByRole('button', { name: /^(钉住记忆|已记住)$/ }).first()
  await remember.click()
  await expect(page.locator('.chat-error')).toContainText('长期记忆保存失败')
  await expect(remember).not.toHaveText('已记住')
  await page.evaluate(() => { Object.assign(window, { failMemoryWrites: false }) })
  await remember.click()
  await expect(remember).toHaveText('已记住')
})

test('flow 3b · 聊天配音：开启实时配音后逐句走翻译 + TTS', async ({ page, request }) => {
  await page.goto('/chat');
  await useLocalChat(page);
  await toggle(page, page.getByRole('checkbox', { name: /实时配音/ }), true);
  await expect(page.locator('.voice-capability')).toHaveAttribute('data-state', 'ready');

  await page.locator('.chat-input').fill('陪我说说话');
  await page.locator('.send-btn').click();
  await expect(page.locator('.message.assistant .message-bubble')).toContainText('今天也辛苦了', { timeout: 15_000 });

  // mock 回复有三句 → 至少两句应各自触发一次翻译与合成
  await expect.poll(async () => (await callsTo(request, MOCK.tts, '/tts')).length,
    { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  expect((await callsTo(request, MOCK.translate, '/translate')).length).toBeGreaterThanOrEqual(2);

  const ttsCalls = await callsTo(request, MOCK.tts, '/tts');
  // 聊天配音必须走日语（翻译成功时），并且带上锁定的参考情绪
  expect(ttsCalls[0].body?.text_lang).toBe('ja');
  expect(String(ttsCalls[0].body?.text)).toContain('[JA]');
});

test('flow 3c · 聊天配音：舞台提示保留显示但不进入朗读', async ({ page, request }) => {
  await fault(request, MOCK.ollama, { reply: '（稍微有点慌乱）诶、和我一起看吗……' });
  await page.goto('/chat');
  await useLocalChat(page);
  await toggle(page, page.getByRole('checkbox', { name: /实时配音/ }), true);
  await expect(page.locator('.voice-capability')).toHaveAttribute('data-state', 'ready');

  await page.locator('.chat-input').fill('一起看恐怖片吗？');
  await page.locator('.send-btn').click();
  await expect(page.locator('.message.assistant .message-bubble')).toContainText('稍微有点慌乱', { timeout: 15_000 });
  await expect.poll(async () => (await callsTo(request, MOCK.tts, '/tts')).length,
    { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

  const translationCalls = await callsTo(request, MOCK.translate, '/translate');
  const ttsCalls = await callsTo(request, MOCK.tts, '/tts');
  expect(String(translationCalls[0].body?.text)).toBe('诶、和我一起看吗……');
  expect(String(ttsCalls[0].body?.text)).not.toContain('稍微有点慌乱');
});

test('flow 3d · 聊天中断：停止后已生成的片段保留并标记', async ({ page, request }) => {
  // 拉长上游延迟，好在流中途按停止
  await fault(request, MOCK.ollama, { latency: 400 });
  await page.goto('/chat');
  await useLocalChat(page);
  await toggle(page, page.getByRole('checkbox', { name: /实时配音/ }), false);
  await expect(page.locator('.model-select')).toBeEnabled();

  await page.locator('.chat-input').fill('讲个长故事');
  await page.locator('.send-btn').click();
  await expect(page.locator('.message.assistant')).toBeVisible();
  await page.locator('.stop-btn').click();

  await expect(page.locator('.chat-error')).toContainText('已停止本次回复');
  await expect(page.locator('.message.assistant.streaming')).toHaveCount(0);
});

for (const theme of ['dark', 'light']) {
  test(`chat recovery ${theme} · 断线保留回复并能继续发送`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme);
    await page.goto('/chat');
    await useLocalChat(page);
    await toggle(page, page.getByRole('checkbox', { name: /实时配音/ }), false);
    // 故障注入只覆盖前端断流恢复；其余 flow 3 用例继续验证真实网关中继。
    await page.route('**/api/chat', route => route.fulfill({
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ type: 'token', content: '这段回复需要保留' }) + '\n',
    }));
    await page.locator('.chat-input').fill('请回复');
    await page.locator('.send-btn').click();
    await expect(page.locator('.chat-error')).toContainText('意外中断');
    await expect(page.locator('.message.assistant .message-bubble').last()).toContainText('这段回复需要保留');
    await page.reload();
    await expect(page.locator('.message.assistant .message-bubble').last()).toContainText('这段回复需要保留');
    await page.unroute('**/api/chat');
    await page.locator('.chat-input').fill('继续聊');
    await page.locator('.send-btn').click();
    await expect(page.locator('.message.assistant .message-bubble').last()).toContainText('今天也辛苦了', { timeout: 15_000 });
  });
}

test('flow 3e · 情绪标签协议：标签剥离不进展示/历史，显式驱动情绪', async ({ page, request }) => {
  const errors = collectRuntimeErrors(page);
  // 逐字流式延迟：给"流式期间协议情绪生效"留出断言窗口（回合结束会复位 neutral）
  await fault(request, MOCK.ollama, { reply: '[mood=happy]今天也辛苦了，先休息一会儿吧！', latency: 150 });
  await page.goto('/chat');
  await useLocalChat(page);
  await toggle(page, page.getByRole('checkbox', { name: /实时配音/ }), false);
  await expect(page.locator('.model-select')).toBeEnabled();

  await page.locator('.chat-input').fill('陪我聊聊天');
  await page.locator('.send-btn').click();

  // 发送后立即轮询流式窗口（回合结束会复位 neutral，必须在流中命中 happy）
  let sawHappy = false;
  for (let i = 0; i < 30; i += 1) {
    const emotion = await page.locator('.portrait-stage').getAttribute('data-emotion');
    if (emotion === 'happy') { sawHappy = true; break; }
    await page.waitForTimeout(100);
  }
  expect(sawHappy).toBe(true);
  await expect(page.locator('.message.assistant .message-bubble')).toContainText('今天也辛苦了', { timeout: 15_000 });
  // 标签不泄漏到展示文本
  await expect(page.locator('.message.assistant .message-bubble')).not.toContainText('[mood');
  await expect(page.locator('.message.assistant .message-bubble')).not.toContainText('happy]');

  // 刷新后历史记录也不含标签
  await page.reload();
  await expect(page.locator('.message.assistant .message-bubble')).toContainText('今天也辛苦了');
  await expect(page.locator('.message.assistant .message-bubble')).not.toContainText('[mood');

  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 备份 / 恢复
// ─────────────────────────────────────────────────────────────────────────────
test('flow 4 · 备份：导出含图片的备份 → 覆盖恢复回同一份历史', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/prompt-builder?scene=sc001');
  await switchToSdEngine(page);

  // 先造一条真实历史（出图 + 保存快照），这样备份里才有 IndexedDB 图片
  await page.getByRole('button', { name: '生成图片' }).click();
  await expect(page.locator('.result-image')).toBeVisible();
  await page.getByRole('button', { name: '存入作品册' }).click();
  await page.locator('[aria-controls="material-history"]').click();
  await expect(page.locator('.history-item')).toHaveCount(1);

  // 导出
  await page.locator('.utility-trigger').click();
  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出备份 JSON', exact: true }).click(),
  ]).then(([dl]) => dl);
  expect(download.suggestedFilename()).toMatch(/^aics-backup-.*\.json$/);
  const backupPath = await download.path();
  expect(backupPath).toBeTruthy();

  const backupJson = JSON.parse(readFileSync(backupPath!, 'utf8'));
  expect(backupJson.app).toBe('ai-cg-studio');
  expect(backupJson.data.history).toHaveLength(1);
  expect(backupJson.images).toHaveLength(1);
  expect(String(backupJson.images[0].dataUrl)).toMatch(/^data:image\//);

  // 清空本地，再从备份恢复
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('aics_kv_store', 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete('aics_pb_history');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.reload();
  // 新文档重新按需挂载历史；打开后确认存储清空的状态。
  await page.getByRole('button', { name: '专家模式', exact: true }).click();
  await page.locator('[aria-controls="material-history"]').click();
  await expect(page.locator('.history-empty')).toHaveCount(1);

  await page.locator('.utility-trigger').click();
  await page.locator('.pb-backup-file-input').setInputFiles(backupPath!);

  // 恢复弹层必须报出真实条数，且是带焦点陷阱的对话框
  const card = page.locator('.pb-backup-card');
  await expect(card).toHaveAttribute('aria-modal', 'true');
  await expect(card.locator('.pb-backup-summary')).toContainText('1 条历史');
  await expect(card.locator('.pb-backup-summary')).toContainText('1 张图片');

  await card.getByRole('button', { name: '覆盖本地' }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirmation.getByRole('button', { name: '覆盖', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '覆盖本地' }).click();
  await confirmation.getByRole('button', { name: '覆盖', exact: true }).click();

  // restore() 会 reload；恢复后历史回来了
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('aics_kv_store', 1);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('kv').objectStore('kv').get('aics_pb_history');
      read.onsuccess = () => { db.close(); resolve(Array.isArray(read.result?.value) ? read.result.value.length : 0); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
    request.onerror = () => reject(request.error);
  })), { timeout: 15_000 }).toBe(1);

  expect(errors).toEqual([]);
});

test('flow 4b · 备份：损坏文件不得污染本地数据', async ({ page }) => {
  await page.goto('/prompt-builder');
  await page.locator('.utility-trigger').click();
  await page.locator('.pb-backup-file-input').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"app":"ai-cg-studio","data":{}}'),
  });
  await expect(page.locator('.toast-msg').filter({ hasText: '备份文件里没有可恢复的数据' })).toBeVisible();
  await expect(page.locator('.pb-backup-card')).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 场景保存
// ─────────────────────────────────────────────────────────────────────────────
for (const theme of ['dark', 'light']) {
  test(`backup atomic recovery ${theme} · metadata failure preserves originals`, async ({ page }) => {
    await page.addInitScript(value => {
      localStorage.setItem('aics_theme', value)
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.name === 'kv' && value?.key === 'aics_pb_projects' && value.value?.some?.((item: { id?: string }) => item.id === 'incoming-project')) {
          throw new DOMException('Test storage quota failure', 'QuotaExceededError')
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key)
      }
    }, theme)
    await page.goto('/prompt-builder')
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('aics_image_store', 1)
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('images')) request.result.createObjectStore('images', { keyPath: 'id' }) }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite')
        tx.objectStore('images').put({ id: 'original-image', blob: new Blob(['original-bytes']), name: 'original.png' })
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
      })
      db.close()
      const kvDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('aics_kv_store', 1)
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv', { keyPath: 'key' }) }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = kvDb.transaction('kv', 'readwrite')
        tx.objectStore('kv').put({ key: 'aics_pb_history', value: [{ id: 'original-artwork', image_id: 'original-image', prompt: 'original' }] })
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
      })
      kvDb.close()
    })
    await page.locator('.pb-backup-file-input').setInputFiles({ name: 'fault-test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      data: { history: [{ id: 'incoming-artwork', image_id: 'original-image' }], projects: [{ id: 'incoming-project' }], settings: { aics_theme: theme === 'dark' ? 'light' : 'dark' } },
      images: [{ id: 'original-image', dataUrl: 'data:image/png;base64,YQ==' }],
    })) })
    const card = page.locator('.pb-backup-card')
    await card.getByRole('button', { name: '覆盖本地', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '覆盖', exact: true }).click()
    await expect(page.locator('.toast-msg').filter({ hasText: '原有作品与原图未删除' })).toBeVisible()
    const stored = await page.evaluate(async () => {
      async function read(database: string, store: string, key: string) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(database, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        return new Promise<any>((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).get(key)
          request.onsuccess = () => { db.close(); resolve(request.result) }; request.onerror = () => { db.close(); reject(request.error) }
        })
      }
      const history = await read('aics_kv_store', 'kv', 'aics_pb_history')
      const image = await read('aics_image_store', 'images', 'original-image')
      return { ids: history.value.map((item: { id: string }) => item.id), bytes: await image.blob.text(), theme: localStorage.getItem('aics_theme') }
    })
    expect(stored).toEqual({ ids: ['original-artwork'], bytes: 'original-bytes', theme })
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: '覆盖本地', exact: true })).toBeEnabled()
    await page.screenshot({ path: `.review-shots/backup-atomic-recovery-${theme}.png`, fullPage: true })
  })
}

test('flow 5 · 场景保存：编辑 → 脏态 → POST 精确场景变更集', async ({ page }) => {
  const errors = collectRuntimeErrors(page);

  /**
   * POST /api/maintenance/scenes/changes 会真的写回 data/scenes/*.json 并跑三个校验脚本。
   * E2E 不该改仓库内容，所以这里拦在网络层，断言送出的载荷 —— 服务端的写盘 /
   * 回滚逻辑由 scripts/tests/test-maintenance.js 覆盖。
  */
  let saved: any = null;
  await page.route('**/api/maintenance/scenes/changes', async route => {
    saved = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        count: saved.changeSet.scenes.upsert.length,
        backup: '2026-07-28-content',
        version: saved.baseVersion + 1,
        snapshot: { scenes: saved.changeSet.scenes.upsert, tags: [], blueprints: [], curation: {} },
      }),
    });
  });

  await page.goto('/scene-manager');
  await expect(page.locator('.maintenance-catalog:visible .catalog-record').first()).toBeVisible();

  const saveButton = page.getByRole('button', { name: /保存到项目/ });
  await expect(saveButton).toBeDisabled();

  // 改一个已有场景的标题
  await page.locator('.maintenance-catalog:visible').getByRole('button', { name: '编辑', exact: true }).click();
  const modal = page.locator('.modal-card');
  await expect(modal).toBeVisible();
  const sceneId = await modal.locator('input').first().inputValue();
  await modal.locator('.form-group', { hasText: '标题' }).locator('input').fill('E2E 改过的标题');
  await modal.getByRole('button', { name: '保存' }).click();
  await expect(modal).toBeHidden();

  await expect(page.locator('.maintenance-state')).toHaveClass(/dirty/);
  await expect(saveButton).toBeEnabled();

  await saveButton.click();
  await expect(page.locator('.maintenance-state')).not.toHaveClass(/dirty/);
  await expect(page.locator('.maintenance-state')).toContainText('备份编号 2026-07-28-content');

  // 载荷：精确变更集中的完整场景记录，避免把整库快照重复写回。
  expect(Number.isSafeInteger(saved.baseVersion)).toBeTruthy();
  expect(saved.changeSet.version).toBe(1);
  expect(saved.changeSet.scenes.remove).toEqual([]);
  const edited = saved.changeSet.scenes.upsert.find((s: any) => s.id === sceneId);
  expect(edited?.title).toBe('E2E 改过的标题');

  expect(errors).toEqual([]);
});

test('flow 5b · 场景保存失败：错误如实回显，脏态保留', async ({ page }) => {
  await page.route('**/api/maintenance/scenes/changes', route => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: 'sc001 标记为招牌场景时必须填写推荐理由', rolledBack: true }),
  }));

  await page.goto('/scene-manager');
  await expect(page.locator('.maintenance-catalog:visible .catalog-record').first()).toBeVisible();
  await page.locator('.maintenance-catalog:visible').getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.modal-card .form-group', { hasText: '标题' }).locator('input').fill('会被拒绝的标题');
  await page.locator('.modal-card').getByRole('button', { name: '保存' }).click();

  const saveButton = page.getByRole('button', { name: /保存到项目/ });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(page.locator('.maintenance-state')).toContainText('推荐理由');
  // 保存失败后必须仍是脏态，否则用户会以为已经存上了
  await expect(page.locator('.maintenance-state')).toHaveClass(/dirty/);
  await expect(page.getByRole('button', { name: /保存到项目/ })).toBeEnabled();
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 深链
// ─────────────────────────────────────────────────────────────────────────────
test('flow 6 · 深链：?scene 决定角色，?mood 与场景推断共存', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  // sc005 是夏目场景。同时给 ?char=nene 是故意的：场景自带的角色必须赢 ——
  // 否则会出现「夏目的场景配宁宁的 LoRA」这种串位成片。
  await page.goto('/prompt-builder?scene=sc005&char=nene&mood=warmth');

  await expect(page.locator('.pb')).toHaveAttribute('data-character', 'natsume');
  await page.locator('[aria-controls="material-character"]').click();
  await expect(page.locator('.char-btn.active')).toContainText('夏目');
  await page.locator('[aria-controls="material-story"]').click();
  await expect(page.locator('.scene-context-title')).not.toHaveText('');
  // 受控路线：basic 默认 Anima 格式，preview 是角色 exact-token（underscore）
  // 而非 SD 的 <lora:...>；shiki_natsume 是夏目的角色控制词
  await expect(page.locator('.preview-output-structured')).toContainText('shiki_natsume');
  await page.getByRole('button', { name: '专家模式', exact: true }).click();
  await page.getByRole('tab', { name: '画面', exact: true }).click();
  await expect(page.locator('.mood-card.active')).toHaveCount(1);
  // 场景推断出的镜头/光照/构图至少落一项，否则"智能预填"等于没接
  await expect(page.locator('.col-right .option.selected')).not.toHaveCount(0);

  expect(errors).toEqual([]);
});

test('flow 6b · 深链：无场景时 ?char 生效', async ({ page }) => {
  await page.goto('/prompt-builder?char=natsume');
  await expect(page.locator('.pb')).toHaveAttribute('data-character', 'natsume');
  await expect(page.locator('.char-btn.active')).toContainText('夏目');
  // 声线随角色联动
  await expect(page.locator('.voice-field select').first()).toHaveValue('natsume');
});

test('flow 6c · 深链：?resume=1 恢复上次草稿', async ({ page }) => {
  // 先留下一份草稿
  await page.goto('/prompt-builder');
  await page.locator('[aria-controls="material-story"]').click();
  await page.locator('.story-input').fill('雪天围围巾的温柔一瞬');
  await page.locator('[aria-controls="material-character"]').click();
  await page.locator('.trait-chip').first().click();
  // 等草稿保存包含 manualTags（saveDraft 有 280ms debounce，仅检查 non-null 会命中
  // 早于 trait-chip 点击的草稿快照，导致恢复后缺少 tag）
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem('aics_pb_last_draft')
    if (!raw) return null
    try { const d = JSON.parse(raw); return Array.isArray(d.manualTags) && d.manualTags.length > 0 ? 'ok' : null } catch { return null }
  })).toBe('ok');

  await page.goto('/prompt-builder?resume=1');
  await page.locator('[aria-controls="material-story"]').click();
  await expect(page.locator('.story-input')).toHaveValue('雪天围围巾的温柔一瞬');
  await page.getByRole('button', { name: '专家模式', exact: true }).click();
  await page.getByRole('tab', { name: '提示词', exact: true }).click();
  await expect(page.locator('.manual-tag')).toHaveCount(1);
});

test('flow 6d · 深链：?regen=<id> 复原历史参数与 seed', async ({ page }) => {
  await page.goto('/prompt-builder?scene=sc001');
  await switchToSdEngine(page);
  await openGenerationSettings(page);
  await toggle(page, '.ctrl-seed [role="switch"]', true);
  await page.locator('.ctrl-seed input[type="number"]').fill('777');
  await page.getByRole('button', { name: '生成图片' }).click();
  await expect(page.locator('.result-image')).toBeVisible();
  await page.getByRole('button', { name: '存入作品册' }).click();
  await page.locator('[aria-controls="material-history"]').click();
  await expect(page.locator('.history-item')).toHaveCount(1);

  const entryId = await page.evaluate(async () => {
    const value = await new Promise<any>((resolve, reject) => {
      const request = indexedDB.open('aics_kv_store', 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('kv', 'readonly');
        const get = tx.objectStore('kv').get('aics_pb_history');
        get.onsuccess = () => { resolve(get.result?.value ?? []); db.close(); };
        get.onerror = () => reject(get.error);
      };
      request.onerror = () => reject(request.error);
    });
    return value[0]?.id as number;
  });
  expect(entryId).toBeTruthy();

  await page.goto(`/prompt-builder?regen=${entryId}`);
  await openGenerationSettings(page);
  await expect(page.locator('.ctrl-seed input[type="number"]')).toHaveValue('777');
  await expect(page.locator('.ctrl-seed [role="switch"]')).toBeChecked();
  await page.locator('[aria-controls="material-story"]').click();
  await expect(page.locator('.scene-context-title')).not.toHaveText('');

  // 兼容旧作品册链接：即使同时带 scene，也必须优先恢复历史快照。
  await page.goto(`/prompt-builder?scene=sc005&regen=${entryId}`);
  await openGenerationSettings(page);
  await expect(page.locator('.ctrl-seed input[type="number"]')).toHaveValue('777');
  await page.locator('[aria-controls="material-story"]').click();
  await expect(page.locator('.scene-context-title')).toContainText('放学后的等待');
});

test('flow 6e · 深链：未知场景 id 不得让导演台崩在半途', async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto('/prompt-builder?scene=sc999&mood=not-a-mood');

  // 无效参数应被忽略，页面保持可用
  await page.locator('[aria-controls="material-story"]').click();
  await expect(page.locator('.story-input')).toBeVisible();
  await page.locator('[aria-controls="material-scenes"]').click();
  await expect(page.locator('.scene-list button.scene-card').first()).toBeVisible();
  await expect(page.locator('.scene-context-title')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('flow 6f · 快速出图：复用最近成功参数并自动提交一次生成', async ({ page, request }) => {
  const errors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('aics_sd_last_success_v1', JSON.stringify({
      version: 1,
      savedAt: 1,
      checkpoint: 'waiNSFWIllustrious_v140.safetensors [abc123]',
      sampler: 'Euler a',
      scheduler: 'Karras',
      cfg: 6,
      steps: 22,
      size: '896×1152',
      hiresFix: false,
      hiresUpscaler: 'Latent',
      hiresScale: 1.5,
    }));
  });

  await page.goto('/prompt-builder?scene=sc001&quick=1');
  await expect(page.locator('.result-image')).toBeVisible();
  const generated = await callsTo(request, MOCK.sd, '/sdapi/v1/txt2img');
  const comfyGenerated = (await calls(request, MOCK.comfy)).filter(call => call.path === '/prompt');
  expect(generated.length + comfyGenerated.length).toBe(1);
  // 受控路线：basic 模式宁宁单人自动走 Anima 高质量路线（V21 unified e16 LoRA），
  // SD quick 参数不再适用于该路线；若走 SD（双人/专家模式）则按原契约断言。
  if (generated.length) {
    expect(generated[0].body).toMatchObject({ width: 896, height: 1152, sampler_name: 'Euler a', scheduler: 'Karras', cfg_scale: 6, steps: 22 });
  } else {
    const graph = comfyGenerated[0].body?.prompt as Record<string, any>;
    const latent = Object.values(graph).find((node: any) => node?.class_type === 'EmptyLatentImage') as any;
    expect(latent?.inputs).toMatchObject({ width: 832, height: 1216 });
    const loraLoader = Object.values(graph).find((node: any) => node?.class_type === 'LoraLoader') as any;
    expect(loraLoader?.inputs?.lora_name).toContain('ayachi_nene_v21_anima');
  }
  // 受控路线 Anima 出图不写 SD 专属 quick 参数（aics_sd_last_success_v1 只记录 SD 成功参数）
  const savedAt = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('aics_sd_last_success_v1') || '{}');
    return Number(saved.savedAt);
  });
  if (generated.length) {
    expect(savedAt).toBeGreaterThan(1);
  }
  expect(errors).toEqual([]);
});

test('flow 6g · popular→studio 深链：热门角色模式进灵感场景出图必须切回 studio 组装', async ({ page }) => {
  const errors = collectRuntimeErrors(page);

  // 第 1 步：热门角色场景「开始绘制」→ 绘图区进入 popular 模式（SPA 导航，Pinia 保留）
  await page.goto('/popular-scenes', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pop-card .pop-draw-action', { timeout: 20000 });
  await page.locator('.pop-card .pop-draw-action').first().click();
  await page.waitForURL(/prompt-builder\?popular=/, { timeout: 20000 });
  await expect(page.locator('.pb')).toHaveAttribute('data-subject', 'popular');
  const popPreview = (await page.locator('#promptMonitor .prompt-health-body').textContent() ?? '').replace(/\s+/g, ' ').trim();

  // 第 2 步：顶栏 SPA 跳到灵感场景（不整页刷新，popular 模式仍留在 store），选工作室场景出图
  await page.locator('a[href="/scene-explorer"]').first().click();
  await page.waitForURL(/scene-explorer/, { timeout: 20000 });
  await page.waitForSelector('.sc[data-scene-id]', { timeout: 20000 });
  const full = page.locator('.scene-personal-nav button').filter({ hasText: '完整库' });
  if (await full.count()) { await full.click(); }
  await page.locator('.sc[data-scene-id] a.scene-draw-action').first().click();
  await page.waitForURL(/prompt-builder\?scene=/, { timeout: 20000 });

  // 提示词组装必须整体切回工作室分支：subject=studio、不再残留热门角色身份词、
  // 预览随本场景变化（不能与 popular 预览相同）。
  await expect(page.locator('.pb')).toHaveAttribute('data-subject', 'studio');
  const studioPreview = (await page.locator('#promptMonitor .prompt-health-body').textContent() ?? '').replace(/\s+/g, ' ').trim();
  expect(studioPreview).not.toBe(popPreview);
  expect(studioPreview).toMatch(/ayachi[ _]nene|shiki[ _]natsume/i);
  expect(studioPreview).not.toMatch(/raiden[ _]shogun|shogun|raiden ei|electro/i);
  expect(errors).toEqual([]);
});

test('flow 6h · studio→popular 深链：工作室场景进热门角色出图不残留工作室身份词', async ({ page }) => {
  const errors = collectRuntimeErrors(page);

  // 第 1 步：灵感场景选宁宁/夏目场景 → 绘图区进入 studio 模式（SPA 导航保留 store）
  await page.goto('/scene-explorer', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sc[data-scene-id]', { timeout: 20000 });
  const full = page.locator('.scene-personal-nav button').filter({ hasText: '完整库' });
  if (await full.count()) { await full.click(); }
  await page.locator('.sc[data-scene-id] a.scene-draw-action').first().click();
  await page.waitForURL(/prompt-builder\?scene=/, { timeout: 20000 });
  await expect(page.locator('.pb')).toHaveAttribute('data-subject', 'studio');
  await page.locator('[aria-controls="material-story"]').click();
  const studioStory = await page.locator('.story-input').inputValue();

  // 第 2 步：SPA 跳到热门角色场景（不整页刷新），点「开始绘制」进入 popular 模式
  await page.locator('a[href="/popular-scenes"]').first().click();
  await page.waitForURL(/popular-scenes/, { timeout: 20000 });
  await page.waitForSelector('.pop-card .pop-draw-action', { timeout: 20000 });
  await page.locator('.pop-card .pop-draw-action').first().click();
  await page.waitForURL(/prompt-builder\?popular=/, { timeout: 20000 });
  await expect(page.locator('.pb')).toHaveAttribute('data-subject', 'popular');

  // 故事框不再是上一个工作室场景的故事（进入热门模式时清空，蓝图选中后为蓝图描述）。
  await page.locator('[aria-controls="material-story"]').click();
  const popularStory = await page.locator('.story-input').inputValue();
  expect(popularStory.trim()).not.toBe('');
  expect(popularStory).not.toBe(studioStory);

  // 提示词必须整体切到热门角色组装：不得残留工作室身份/服装锚点（漏词即回归）。
  const popularPreview = (await page.locator('#promptMonitor .prompt-health-body').textContent() ?? '').replace(/\s+/g, ' ').trim();
  expect(popularPreview).not.toBe('');
  expect(popularPreview).not.toMatch(/ayachi[ _]nene|shiki[ _]natsume|nene_|natsume_/i);
  expect(errors).toEqual([]);
});
