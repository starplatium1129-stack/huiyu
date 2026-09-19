import { test, expect, type Page } from '@playwright/test'
import MOCK_PORTS from '../../scripts/lib/e2e-ports.js'

async function chooseCharacter(page: Page, name: string) {
  if (new URL(page.url()).pathname === '/prompt-builder') {
    await page.locator('.character-browse-all').click()
    const dialog = page.getByRole('dialog', { name: '挑选这一幕的主角' })
    await dialog.getByRole('searchbox', { name: '搜索角色或作品' }).fill(name)
    await dialog.locator('.directory-item').filter({ hasText: name }).click()
  } else {
    await page.locator('.directory-item').filter({ hasText: name }).click()
  }
}

test('anima engine: main generate shows result in main frame through mock ComfyUI', async ({ page, request }) => {
  test.setTimeout(60000)
  const errors: string[] = []
  const directComfyRequests: string[] = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 200)))
  page.on('request', browserRequest => {
    const pathname = new URL(browserRequest.url()).pathname
    if (pathname.startsWith('/comfy') || ['/prompt', '/queue', '/history', '/interrupt', '/view'].includes(pathname)) {
      directComfyRequests.push(pathname)
    }
  })

  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10, historyTransient: 2 } })

  // 绘图页有持续的服务状态轮询，networkidle 永远不会成立。
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  // 受控路线：引擎切换只在专家模式渲染
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  const animaEngine = page.locator('.engine-switch button').nth(1)
  await expect(animaEngine).toBeEnabled({ timeout: 30000 })
  await animaEngine.click()
  await expect(page.locator('#baseModel')).toHaveValue(/anima/, { timeout: 30000 })
  // c2bbb9a 起在线徽章文案改为「<引擎> 已连接」
  await expect(page.locator('.api-status .badge')).toContainText(/Anima 已连接/, { timeout: 30000 })

  await page.locator('.material-switch button[aria-controls="material-story"]').click()
  await page.locator('.story-input').fill('宁宁在咖啡馆里穿着魔女服，对我微笑')

  const genBtn = page.getByTestId('anima-generate')
  await expect(genBtn).toBeEnabled({ timeout: 30000 })
  console.log('GEN_BTN_ENABLED: true')
  await genBtn.click()

  let imgFound = false
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && !imgFound) {
    await page.waitForTimeout(5000)
    const count = await page.locator('.result-image-wrap img.result-image').count()
    if (count > 0) imgFound = true
  }
  console.log('MAIN_RESULT_IMG:', imgFound)
  console.log('PAGE_ERRORS:', errors.length ? errors.join(' | ') : 'none')
  expect(imgFound).toBe(true)
  expect(directComfyRequests).toEqual([])
  const comfyState = await (await request.get(`${mockComfy}/__mock/state`)).json()
  expect(comfyState.calls.filter((call: { path: string }) => call.path === '/prompt')).toHaveLength(1)
  expect(comfyState.calls.filter((call: { path: string }) => call.path === '/view')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('anima expert parameters and unified button share one parent-owned request metadata snapshot', async ({ page, request }) => {
  test.setTimeout(60000)
  const bodies: unknown[] = []
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'POST' && new URL(browserRequest.url()).pathname === '/api/anima/jobs') {
      bodies.push(browserRequest.postDataJSON())
    }
  })

  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10 } })
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').nth(1).click()
  await page.locator('.anima-quick-panel').evaluate(el => { (el as HTMLDetailsElement).open = true })
  await page.locator('.material-switch button[aria-controls="material-story"]').click()
  await page.locator('.story-input').fill('宁宁在咖啡馆里穿着魔女服，对我微笑')
  await page.locator('.anima-quick-panel .anima-seed').fill('424242')
  await page.waitForTimeout(600)

  await page.getByTestId('anima-generate').click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1)
  await expect(page.locator('.result-image-wrap img.result-image')).toHaveCount(1, { timeout: 30000 })

  await page.getByTestId('anima-generate').click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(2)
  expect(bodies[0]).toEqual(bodies[1])
  expect((bodies[0] as { profileId?: string }).profileId).toBeUndefined()
  // 受控路线：宁宁默认 LoRA 为 V21（unified e16），请求角色为 nene
  expect((bodies[0] as { character: string }).character).toBe('nene')
})

test('anima derives the promoted Natsume v21 LoRA and blocks triad', async ({ page, request }) => {
  test.setTimeout(60000)
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'POST' && new URL(browserRequest.url()).pathname === '/api/anima/jobs') {
      bodies.push(browserRequest.postDataJSON() as Record<string, unknown>)
    }
  })
  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10 } })
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('#stepChar .char-btn').filter({ hasText: '夏目' }).click()
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').nth(1).click()
  await expect(page.locator('.anima-preview-note')).toHaveCount(0)
  await page.locator('.material-switch button[aria-controls="material-story"]').click()
  await page.locator('.story-input').fill('夏目在咖啡馆里端来一杯咖啡')
  await page.getByTestId('anima-generate').click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1)
  expect(bodies[0].character).toBe('natsume')
  expect(bodies[0].loraId).toBe('L_NAT_V21_ANIMA')
  await expect(page.locator('.result-image-wrap img.result-image')).toHaveCount(1, { timeout: 30000 })

  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('#stepChar .char-btn').filter({ hasText: '宁宁' }).click()
  await expect(page.locator('.engine-switch button').nth(1)).toBeEnabled()
  await expect(page.locator('.anima-preview-note')).toHaveCount(0)
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('#stepChar .char-btn').filter({ hasText: '双人' }).click()
  await expect(page.locator('.engine-switch button').nth(1)).toBeDisabled()
  expect(bodies).toHaveLength(1)
})

test('Krea 2 is a separate natural-language request with no LoRA or negative field', async ({ page, request }) => {
  test.setTimeout(60000)
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/creative/status', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true,
      online: true,
      models: [{ id: 'krea2-turbo-fp8', label: 'Krea 2 Turbo', family: 'krea2', profileId: 'krea2_turbo_fp8', available: true, sizes: ['1024x1024', '1024x1536', '1536x1024'], defaults: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' } }],
      loras: [],
    }) })
  })
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'POST' && new URL(browserRequest.url()).pathname === '/api/creative/jobs') {
      bodies.push(browserRequest.postDataJSON() as Record<string, unknown>)
    }
  })
  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10 } })
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').nth(2).click()
  await expect(page.locator('.engine-switch button').nth(2)).toHaveClass(/active/)
  await page.getByRole('tab', { name: '画面', exact: true }).click()
  await page.locator('#stepMood > summary').click()
  const sadMood = page.locator('.mood-card').filter({ hasText: '忧伤' })
  await sadMood.click()
  await expect(sadMood).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(500)
  await expect(sadMood).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'pro')
  expect(bodies).toHaveLength(0)
  await page.locator('.material-switch button[aria-controls="material-story"]').click()
  await page.locator('#visualDescription').fill('A girl stands beside a rain-covered cafe window, warm interior light behind her.')
  await page.getByTestId('anima-generate').click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1)
  expect(bodies[0].loraId).toBeUndefined()
  expect(bodies[0].negative).toBe('')
  expect(bodies[0].modelId).toBe('krea2-turbo-fp8')
  expect(String(bodies[0].prompt)).toContain('color palette uses blue theme and cool tones')
})

test('Krea 2 and Anima both block triad mode', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('#stepChar .char-btn').filter({ hasText: '双人' }).click()
  await expect(page.locator('.engine-switch button').nth(1)).toBeDisabled()
  await expect(page.locator('.engine-switch button').nth(2)).toBeDisabled()
  await expect(page.locator('.engine-switch button').nth(2)).toHaveAttribute('title', /双人.*SD/)
})

// ── 热门角色无 LoRA 创作模式 ───────────────────────────────────────────────

test('popular creator · Anima no-LoRA: loraId omitted, workflow has no LoraLoader, negative encoded', async ({ page, request }) => {
  test.setTimeout(60000)
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'POST' && new URL(browserRequest.url()).pathname === '/api/anima/jobs') {
      bodies.push(browserRequest.postDataJSON() as Record<string, unknown>)
    }
  })
  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10, historyTransient: 2 } })
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '雷电将军')
  await expect(page.locator('.popular-outfits')).toBeVisible()
  await expect(page.locator('.popular-nolora-badge')).toContainText('无需 LoRA')

  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card').first().click()
  await expect(page.locator('.blueprint-card.active')).toHaveCount(1)

  // 画面描述框输入必须真正进入无 LoRA 请求（此前被 outfit.prose 硬编码吞掉）。
  await page.locator('.material-switch button[aria-controls="material-story"]').click()
  await page.locator('#visualDescription').fill('The girl gently holds a bouquet of flowers, petals drifting onto her shoulder.')
  await expect(page.locator('#visualDescription')).toHaveValue(/bouquet/)

  // 进入热门模式应自动切到 Anima；SD 按钮被禁用（引擎切换在专家模式渲染）。
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await expect(page.locator('.engine-switch button').nth(1)).toHaveClass(/active/)
  await expect(page.locator('.engine-switch button').nth(0)).toBeDisabled()
  await page.getByRole('tab', { name: '画面', exact: true }).click()
  await page.locator('#stepMood > summary').click()
  await page.locator('.mood-card').filter({ hasText: '恋爱' }).click()

  const genBtn = page.getByRole('button', { name: '生成图片' })
  await expect(genBtn).toBeEnabled({ timeout: 30000 })
  await genBtn.click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1)
  expect(bodies[0].loraId).toBeUndefined()
  expect(bodies[0].loraStrength).toBeUndefined()
  expect(bodies[0].character).toBeNull()
  expect(bodies[0].modelId).toBe('anima-miaomiao-v1.2')
  expect(String(bodies[0].prompt)).toContain('raiden_shogun')
  expect(String(bodies[0].prompt)).toContain('bouquet')
  expect(String(bodies[0].prompt)).toContain('pink theme')
  expect(String(bodies[0].prompt)).toContain('warm light')
  expect(String(bodies[0].prompt)).not.toMatch(/nene_|natsume_|ayachi_nene|shiki_natsume|<lora:/i)

  await expect(page.locator('.result-image-wrap img.result-image')).toHaveCount(1, { timeout: 30000 })

  const comfyState = await (await request.get(`${mockComfy}/__mock/state`)).json()
  const promptCall = comfyState.calls.find((call: { path: string }) => call.path === '/prompt')
  const graph = promptCall?.body?.prompt as Record<string, { class_type?: string; inputs?: Record<string, unknown> }> | undefined
  expect(graph).toBeTruthy()
  const classes = Object.values(graph || {}).map(node => node.class_type)
  expect(classes).not.toContain('LoraLoader')
  expect(graph!['2'].inputs?.clip_name).toBe('qwen_3_06b_base.safetensors')
  expect(String(graph!['5'].inputs?.text)).toContain('worst quality')
  expect(graph!['7'].inputs?.sampler_name).toBe('res_multistep')
})

test('popular creator · Krea 2 request has no negative and no LoRA', async ({ page, request }) => {
  test.setTimeout(60000)
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'POST' && new URL(browserRequest.url()).pathname === '/api/creative/jobs') {
      bodies.push(browserRequest.postDataJSON() as Record<string, unknown>)
    }
  })
  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10 } })
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '雷电将军')
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card').first().click()
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').nth(2).click()
  await expect(page.locator('.engine-switch button').nth(2)).toHaveClass(/active/)

  const genBtn = page.getByRole('button', { name: '生成图片' })
  await expect(genBtn).toBeEnabled({ timeout: 30000 })
  await genBtn.click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1)
  expect(bodies[0].loraId).toBeUndefined()
  expect(bodies[0].negative).toBe('')
  expect(bodies[0].modelId).toBe('krea2-turbo-fp8')
  expect(String(bodies[0].prompt)).toContain('Raiden Shogun')
  expect(String(bodies[0].prompt)).toContain('color palette uses orange theme and candlelight')
  expect(String(bodies[0].prompt)).not.toMatch(/nene_|natsume_|ayachi_nene|shiki_natsume|<lora:/i)
  await expect(page.locator('.result-image-wrap img.result-image')).toHaveCount(1, { timeout: 30000 })
})

test('popular creator · Krea style is inferred automatically from the selected blueprint', async ({ page, request }) => {
  test.setTimeout(60000)
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'POST' && new URL(browserRequest.url()).pathname === '/api/creative/jobs') {
      bodies.push(browserRequest.postDataJSON() as Record<string, unknown>)
    }
  })
  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10 } })
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '雷电将军')
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-reco-btn').filter({ hasText: '查看全部' }).click()
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card').filter({ hasText: '花海逆光' }).first().click()
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').nth(2).click()
  await expect(page.locator('.engine-switch button').nth(2)).toHaveClass(/active/)

  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await expect(page.locator('#stepRecipe')).toHaveCount(0)
  await expect(page.getByText(/画师影响|Style LoRA/)).toHaveCount(0)

  const genBtn = page.getByRole('button', { name: '生成图片' })
  await expect(genBtn).toBeEnabled({ timeout: 30000 })
  await genBtn.click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1)
  const prompt = String(bodies[0].prompt)
  expect(prompt).toContain('A cinematic film still')
  expect(prompt.split(/(?<=\.)\s/).length).toBeGreaterThanOrEqual(3)
  expect(prompt.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(5)
  expect(bodies[0].styleLoraId).toBeUndefined()
  expect(prompt).not.toMatch(/nene_|natsume_|ayachi_nene|shiki_natsume|<lora:/i)
  await expect(page.locator('.result-image-wrap img.result-image')).toHaveCount(1, { timeout: 30000 })
})

test('popular creator · manual style controls are available for all characters (full-open)', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '樱岛麻衣')
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.getByRole('tab', { name: '画面', exact: true }).click()
  // 全部开放后任何角色都可选成人配方，专家模式风格区（ArtistStylePicker）不被 underage 隐藏。
  await expect(page.locator('[data-testid="artist-style-picker"]')).toHaveCount(1)
})

test('popular creator · adult gate requires the mature switch, not character underage', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '樱岛麻衣')
  await expect(page.locator('.popular-outfits')).toBeVisible()

  // 全部开放（2026-08-14）：所有热门角色 adult，成人蓝图可见可达。
  // 推荐轮换（换一批）与角色池大小相关，断言放在「查看全部」下保持数据无关。
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-reco-btn').filter({ hasText: '查看全部' }).click()
  await expect(page.locator('.blueprint-card[data-adult="true"]').first()).toBeVisible()
})

test('popular creator · draft round-trips subject/outfit/blueprint through reload', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '雷电将军')
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.outfit-chip').filter({ hasText: '将军神装' }).click()
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card').first().click()

  // 草稿经 280ms debounce 落盘；等待 localStorage 出现完整热门角色状态。
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem('aics_pb_last_draft')
    if (!raw) return null
    try {
      const draft = JSON.parse(raw)
      return draft.subject === 'popular' && draft.characterId === 'raiden_shogun'
        && draft.outfitId && typeof draft.blueprintId === 'string' && draft.noLora === true ? 'ok' : null
    } catch { return null }
  })).toBe('ok')

  await page.reload()
  await page.waitForTimeout(2000)
  // 刷新后热门角色状态、服装与蓝图选择原样恢复；引擎被强制回 Anima。
  await expect(page.locator('.pb')).toHaveAttribute('data-subject', 'popular')
  await expect(page.locator('.directory-item[aria-pressed="true"]')).toContainText('雷电将军')
  await expect(page.locator('.outfit-chip.active')).toHaveCount(1)
  await page.locator('[aria-controls="material-scenes"]').click()
  await expect(page.locator('.blueprint-card.active')).toHaveCount(1)
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await expect(page.locator('.engine-switch button').nth(1)).toHaveClass(/active/)
})

test('popular creator · copy copies the popular-aware prompt', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '雷电将军')
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card').first().click()

  // #promptMonitor 是 advanced-decision，basic 模式 display:none，先切专家模式。
  // 注意：专家模式下面板默认展开（:open=pro），再点 summary 会把它关闭，因此直接点复制按钮。
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('#inspector-tab-prompt').click()
  await expect(page.locator('#promptMonitor .preview-actions .btn-primary')).toBeVisible()
  await page.locator('#promptMonitor .preview-actions .btn-primary').click()
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  // 复制的必须是 popular prompt：身份锚 + 蓝图词 + [NEG] 负向，且无宁宁/夏目 LoRA 痕迹。
  expect(clipboard).toContain('raiden_shogun')
  expect(clipboard).toContain('[NEG]')
  expect(clipboard).toMatch(/flower field|festival|library|night|snow|street|cafe|sunset/i)
  expect(clipboard).not.toMatch(/ayachi_nene|shiki_natsume|nene_|natsume_|<lora:/i)
})

test('popular creator · select blueprint after Krea is active clamps size to Krea sizes', async ({ page, request }) => {
  test.setTimeout(60000)
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'POST' && new URL(browserRequest.url()).pathname === '/api/creative/jobs') {
      bodies.push(browserRequest.postDataJSON() as Record<string, unknown>)
    }
  })
  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10 } })
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '雷电将军')
  // 先切 Krea，再选场景：blueprint 推荐尺寸必须收敛到 Krea 白名单，不能 400。
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').nth(2).click()
  await expect(page.locator('.engine-switch button').nth(2)).toHaveClass(/active/)
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card').first().click()

  const genBtn = page.getByRole('button', { name: '生成图片' })
  await expect(genBtn).toBeEnabled({ timeout: 30000 })
  await genBtn.click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1)
  const width = Number(bodies[0].width)
  const height = Number(bodies[0].height)
  expect(['1024x1024', '1024x1536', '1536x1024']).toContain(`${width}x${height}`)
  expect(bodies[0].modelId).toBe('krea2-turbo-fp8')
  await expect(page.locator('.result-image-wrap img.result-image')).toHaveCount(1, { timeout: 30000 })
})

test('popular creator · switching back to studio immediately restores the nene LoRA path', async ({ page, request }) => {
  test.setTimeout(60000)
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'POST' && new URL(browserRequest.url()).pathname === '/api/anima/jobs') {
      bodies.push(browserRequest.postDataJSON() as Record<string, unknown>)
    }
  })
  const mockGateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
  const mockComfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
  await request.post(`${mockComfy}/__mock/reset`)
  await request.post(`${mockComfy}/__mock/fault`, { data: { renderMs: 10, historyTransient: 2 } })
  await page.goto(`${mockGateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '雷电将军')
  await expect(page.locator('.popular-nolora-badge')).toContainText('无需 LoRA')
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card').first().click()

  // 切回工作室角色：model/lora 必须立即恢复，不等 15s 轮询。
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '工作室角色' }).click()
  await expect(page.locator('.pb')).toHaveAttribute('data-subject', 'studio')
  await expect(page.locator('.anima-preview-note')).toHaveCount(0)

  const genBtn = page.getByRole('button', { name: '生成图片' })
  await expect(genBtn).toBeEnabled({ timeout: 30000 })
  await genBtn.click()
  await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1)
  // 受控路线：宁宁默认 LoRA 为 V21（unified e16），请求角色为 nene
  expect(bodies[0].character).toBe('nene')
  expect(bodies[0].loraId).toBe('L_NENE_V21_ANIMA')
  await expect(page.locator('.result-image-wrap img.result-image')).toHaveCount(1, { timeout: 30000 })
})

test('popular creator · adult blueprint stays reachable across all characters (full-open)', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await page.locator('.char-source-btn').filter({ hasText: '热门角色' }).click()
  // 成年角色：默认成熟内容开关开启 → 成人蓝图可见。
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '雷电将军')
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-reco-btn').filter({ hasText: '查看全部' }).click()
  await expect(page.locator('.blueprint-card[data-adult="true"]').first()).toBeVisible()
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card[data-adult="true"]').first().click()
  await expect(page.locator('.blueprint-card.active[data-adult="true"]')).toHaveCount(1)

  // 全部开放决策（2026-08-14）：切换任何热门角色，成人蓝图保持可达且已选蓝图不清空。
  // 切换角色会回到「只看推荐」，推荐轮换随角色池大小变化，在「查看全部」下断言保持数据无关。
  await page.locator('.material-switch button[aria-controls="material-character"]').click()
  await chooseCharacter(page, '樱岛麻衣')
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-reco-btn').filter({ hasText: '查看全部' }).click()
  await expect(page.locator('.blueprint-card[data-adult="true"]').first()).toBeVisible()
  await page.locator('.material-switch button[aria-controls="material-scenes"]').click()
  await page.locator('.blueprint-card[data-adult="true"]').first().click()
  await expect(page.locator('.blueprint-card.active[data-adult="true"]')).toHaveCount(1)
})

test('popular creator · scene library page deep-links character and blueprint into the director', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/popular-scenes`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  // 角色场景库：角色可选（2026-08-16 审计：mock 网关喂真实数据 33 角色，旧断言
  // toHaveCount(18) 随扩容漂移；改为下限断言，数据继续扩容不红）。
  const charCount = await page.locator('.character-directory .directory-item').count()
  expect(charCount).toBeGreaterThanOrEqual(18)
  await page.locator('.character-directory .directory-item').filter({ hasText: '雷电将军' }).click()
  await page.locator('.pop-card').filter({ hasText: '花海逆光' }).first()
    .getByRole('link', { name: '开始绘制', exact: true }).click()
  // 深链：绘图页应预选角色 + 展开全部列表 + 激活目标蓝图。
  await page.waitForTimeout(3000)
  await expect(page.locator('.blueprint-card.active')).toContainText('花海逆光')
  await page.locator('[aria-controls="material-character"]').click()
  await expect(page.locator('.directory-item[aria-pressed="true"]')).toContainText('雷电将军')
  await page.locator('[aria-controls="material-scenes"]').click()
  await expect(page.locator('.blueprint-reco-note')).toContainText(/个可选场景/)
  await expect(page.locator('.blueprint-card.active')).toContainText('花海逆光')
  // 成人场景在角色场景库中带 R18 标记，且绘图页展开后可见。
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/popular-scenes`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await page.locator('.character-directory .directory-item').filter({ hasText: '樱岛麻衣' }).click()
  await expect(page.locator('.pop-card.adult').first()).toBeVisible()
  await page.locator('.pop-card.adult').first().getByRole('link', { name: '开始绘制', exact: true }).click()
  await page.waitForTimeout(3000)
  await expect(page.locator('.blueprint-card.active[data-adult="true"]')).toHaveCount(1)
})

test('anima inpaint modal: opens local outfit swap modal, toggles mask modes, adjusts threshold and presets', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/prompt-builder`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  // 切换到专家模式并选择 Anima 引擎
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  const animaEngine = page.locator('.engine-switch button').nth(1)
  await expect(animaEngine).toBeEnabled({ timeout: 30000 })
  await animaEngine.click()

  // 验证空闲状态下「导入本地图片换装」按钮并点击打开弹窗
  const openInpaintBtn = page.getByRole('button', { name: /导入图片换装/ })
  await expect(openInpaintBtn).toBeVisible()
  await openInpaintBtn.click()

  // 弹窗可见
  const modal = page.locator('.inpaint-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.modal-header')).toContainText('智能视觉换装')

  // 遮罩模式切换：手绘 vs 自动识别
  await page.getByRole('button', { name: '自动识别', exact: true }).click()
  await expect(page.locator('#maskPromptInput')).toBeVisible()
  await expect(page.locator('.param-slider-group').filter({ hasText: '识别灵敏度' })).toBeVisible()

  // 预设服装选择
  await page.locator('.preset-card').filter({ hasText: /夏日比基尼/ }).click()
  await expect(page.locator('.preset-card.active')).toContainText('夏日比基尼')

  // 切换回手绘模式
  await page.getByRole('button', { name: '手绘精确遮罩', exact: true }).click()
  await expect(page.locator('#brushSizeInput')).toBeVisible()

  // 关闭弹窗
  await page.locator('.modal-header .btn-close').click()
  await expect(modal).not.toBeVisible()
})


for (const theme of ['dark', 'light']) {
  for (const width of [1440, 390]) {
    test(`anima panel audit ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme);
      await page.goto(`http://127.0.0.1:${MOCK_PORTS.gateway}/prompt-builder`);
      await page.locator('.material-switch button[aria-controls="material-story"]').click();
      await expect(page.locator('.story-input')).toBeVisible();
      await page.screenshot({ path: `runtime/audit-basic-${theme}-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: '专家模式', exact: true }).click();
      await page.locator('.engine-switch button').nth(1).click();
      const panel = page.locator('.anima-quick-panel');
      await expect(panel).toBeVisible();
      await panel.evaluate(el => { (el as HTMLDetailsElement).open = true; });
      await expect(panel.locator('.anima-output-note')).toContainText('预计成片');
      const overflow = await panel.evaluate(el => el.scrollWidth > el.clientWidth + 2);
      expect(overflow).toBe(false);
      await panel.screenshot({ path: `runtime/audit-panel-${theme}-${width}.png` });
      await page.screenshot({ path: `runtime/audit-page-${theme}-${width}.png`, fullPage: true });
    });
  }
}
