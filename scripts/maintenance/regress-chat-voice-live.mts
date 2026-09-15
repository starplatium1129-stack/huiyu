import { chromium } from '@playwright/test'

const baseUrl = process.argv[2] || 'http://127.0.0.1:3000'
const status = await fetch(`${baseUrl}/api/tts-status`).then(response => response.json())
if (!status.online) throw new Error('GPT-SoVITS is offline')

const directions = {
  neutral: '',
  gentle: '（温柔）',
  happy: '（开心）',
  shy: '（害羞）',
  serious: '（认真）',
  sad: '（难过）',
}
const spokenText = '今日もお疲れさまでした。ここで少し休んでいきませんか。'
const results = []

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
})

for (const character of ['nene', 'natsume']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' })
  await context.addInitScript(({ active }) => {
    localStorage.setItem('aics_theme', 'dark')
    localStorage.setItem('aics_chat_v1', JSON.stringify({
      version: 3,
      active,
      histories: { nene: [], natsume: [] },
      settings: {
        model: 'voice-regression', provider: 'api', apiBaseUrl: 'https://local.example/v1',
        apiModel: 'voice-regression', apiKey: 'local-regression-key', webSearchEnabled: false,
        live2dEnabled: true, live2dOutfit: active === 'natsume' ? 'natsume-cafe' : 'school',
        live2dOutfits: { nene: 'school', natsume: 'natsume-cafe' },
        autoVoice: true, volume: 80, drafts: { nene: '', natsume: '' },
      },
    }))
  }, { active: character })

  const page = await context.newPage()
  let reply = ''
  await page.route('**/api/chat-provider/test', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, online: true, vendor: 'custom', models: ['voice-regression'], modelCount: 1 }),
  }))
  await page.route('**/api/translate', async route => {
    const body = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ translation: body.text }) })
  })
  await page.route('**/api/chat', route => route.fulfill({
    contentType: 'application/x-ndjson',
    body: `${JSON.stringify({ type: 'meta', model: 'voice-regression' })}\n${JSON.stringify({ type: 'token', content: reply })}\n${JSON.stringify({ type: 'done' })}\n`,
  }))

  await page.goto(`${baseUrl}/chat`, { waitUntil: 'domcontentloaded' })
  const stage = page.locator('.portrait-stage')
  await page.locator('.avatar-status[data-state="ready"]').waitFor({ timeout: 30_000 })
  await page.locator('.voice-capability[data-state="ready"]').waitFor({ timeout: 30_000 })

  for (const emotion of Object.keys(directions)) {
    reply = `${directions[emotion]}${spokenText}`
    await page.getByLabel('聊天输入').fill(`voice regression ${emotion}`)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await stage.waitFor({ state: 'visible' })
    await page.waitForFunction(expected => {
      const element = document.querySelector('.portrait-stage')
      return element?.getAttribute('data-emotion') === expected && element.classList.contains('speaking')
    }, emotion, { timeout: 90_000 })

    const samples = await page.evaluate(async () => {
      const output = []
      const started = performance.now()
      while (performance.now() - started < 8_000) {
        const element = document.querySelector('.portrait-stage')
        if (!element) break
        output.push({
          speaking: element.classList.contains('speaking'),
          mouth: Number(element.getAttribute('data-mouth-level') || 0),
          peak: Number(element.getAttribute('data-audio-peak') || 0),
          intensity: Number(element.getAttribute('data-emotion-intensity') || 0),
          emotion: element.getAttribute('data-emotion'),
        })
        if (!element.classList.contains('speaking') && output.length > 10) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return output
    })
    const maxMouth = Math.max(...samples.map(sample => sample.mouth))
    const maxPeak = Math.max(...samples.map(sample => sample.peak))
    const peakIntensity = Math.max(...samples.map(sample => sample.intensity))
    if (maxMouth < 0.04) throw new Error(`${character}/${emotion}: mouth telemetry stayed flat (${maxMouth})`)
    if (maxPeak < 0.08) throw new Error(`${character}/${emotion}: audio peak stayed flat (${maxPeak})`)

    await page.waitForFunction(() => {
      const element = document.querySelector('.portrait-stage')
      return element?.getAttribute('data-emotion') === 'neutral' && !element.classList.contains('speaking')
    }, undefined, { timeout: 30_000 })
    const fadeStart = Number(await stage.getAttribute('data-emotion-intensity') || 0)
    await page.waitForTimeout(1_200)
    const fadeAfter = Number(await stage.getAttribute('data-emotion-intensity') || 0)
    if (emotion !== 'neutral' && !(fadeStart > 0 && fadeAfter < fadeStart)) {
      throw new Error(`${character}/${emotion}: neutral fade did not decrease (${fadeStart} -> ${fadeAfter})`)
    }
    results.push({ character, emotion, maxMouth, maxPeak, peakIntensity, fadeStart, fadeAfter })
  }

  await context.close()
}

await browser.close()
console.table(results)
