import type { CompanionDesktopBridge } from '@/types/desktop'
import { computed, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHARACTERS } from '@/config/characters'
import { useChatConversation } from './useChatConversation'

const { addScore } = vi.hoisted(() => ({ addScore: vi.fn() }))
vi.mock('@/composables/useCompanionAffection', () => ({ useCompanionAffection: () => ({ addScore }) }))

function stream(events: object[], close = true) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n'))
    if (close) controller.close()
  } }))
}
function setup() {
  const messages: Array<{ role: string; content: string; stopped: boolean }> = []
  const busy = ref(false)
  const options = {
    storage: { messages: () => messages, trim: vi.fn(), save: vi.fn(), setDraft: vi.fn(), setApiSettings: vi.fn(), setModel: vi.fn() },
    voice: { ensureAudioContext: vi.fn(), startTurn: vi.fn(), append: vi.fn(), finishTurn: vi.fn(), stop: vi.fn(), isActive: () => false },
    activeChar: ref('nene'), currentCharacter: computed(() => CHARACTERS.nene), busy,
    chatReady: computed(() => true), chatProvider: ref('api'), currentModel: ref('gpt-4'),
    apiBaseUrl: ref('http://localhost:1234/v1'), apiModel: ref('gpt-4'), apiKey: ref('test'),
    webSearchEnabled: ref(false), useHostConfig: ref(false), companionTools: ref(true),
    reasoning: ref('off'), userProfile: ref({}), recallMemories: () => [],
    setBusy: (value: boolean) => { busy.value = value }, onError: vi.fn(), onStreamEmotion: vi.fn(), nearBottom: () => false, scrollBottom: vi.fn(),
  }
  const conversation = useChatConversation(options as unknown as Parameters<typeof useChatConversation>[0])
  return { conversation, options, messages, busy }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); desktopFixture.current = undefined })

describe('chat recovery and tool lifecycle', () => {
  it('keeps each token visible and spoken while mood tags override hints and the next character starts fresh', async () => {
    const deltas = ['那', '个，好', '开心', '，脸', '红[moo', 'd=ha', 'ppy]难过', '[mood=BAD]', '[MOOD:sa', 'd]尾声', '[mood=hap']
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream([...deltas.map(content => ({ type: 'token', content })), { type: 'done' }]))
      .mockResolvedValueOnce(stream([{ type: 'token', content: '我在' }, { type: 'token', content: '这里' }, { type: 'done' }]))
      .mockResolvedValueOnce(stream([{ type: 'token', content: '不好[mood    ' }, { type: 'token', content: '=BAD]意思' }, { type: 'done' }]))
    vi.stubGlobal('fetch', fetchMock)
    const { conversation, options, messages } = setup()
    const displayed: string[] = []
    options.voice.append.mockImplementation(() => {
      displayed.push(messages.at(-1)!.content)
      options.activeChar.value = 'natsume'
    })
    await conversation.sendMessage('你好')
    expect(displayed).toEqual(['那', '那个，好', '那个，好开心', '那个，好开心，脸', '那个，好开心，脸红[moo',
      '那个，好开心，脸红', '那个，好开心，脸红难过', '那个，好开心，脸红难过', '那个，好开心，脸红难过',
      '那个，好开心，脸红难过尾声', '那个，好开心，脸红难过尾声'])
    expect(options.voice.append.mock.calls.map(([delta]) => delta)).toEqual(['那', '个，好', '开心', '，脸', '红[moo', '', '难过', '', '', '尾声', ''])
    expect(options.onStreamEmotion.mock.calls.map(([emotion]) => emotion)).toEqual(['shy', 'happy', 'shy', 'happy', 'sad', 'neutral'])
    options.onStreamEmotion.mockClear()
    await conversation.sendMessage('继续')
    expect(options.onStreamEmotion.mock.calls.map(([emotion]) => emotion)).toEqual(['gentle', 'neutral'])
    options.onStreamEmotion.mockClear()
    await conversation.sendMessage('继续')
    expect(messages.at(-1)?.content).toBe('不好意思')
    expect(options.onStreamEmotion.mock.calls.map(([emotion]) => emotion)).toEqual(['shy', 'neutral'])
    conversation.destroy()
  })
  it('discards a queued draft when another window clears content, then accepts new input', async () => {
    vi.useFakeTimers()
    const { conversation, options } = setup()
    conversation.inputText.value = 'old pending draft'
    conversation.onInputChange()
    conversation.clearDraftInput()
    await vi.advanceTimersByTimeAsync(300)
    expect(conversation.inputText.value).toBe('')
    expect(options.storage.setDraft).not.toHaveBeenCalled()
    conversation.inputText.value = 'new after reset'
    conversation.onInputChange()
    await vi.advanceTimersByTimeAsync(300)
    expect(options.storage.setDraft).toHaveBeenLastCalledWith('nene', 'new after reset')
  })
  it('passes drawing draft status back to the model without rewarding a generated image', async () => {
    addScore.mockClear()
    const output = '已保存绘画草稿。尚未提交生成任务，也未生成图片。'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream([{ type: 'tool-call', id: 'draft', name: 'generate_character_image', arguments: '{"description":"海边"}' }, { type: 'done' }]))
      .mockResolvedValueOnce(Response.json({ ok: true, status: 'draft', output }))
      .mockResolvedValueOnce(stream([{ type: 'token', content: '草稿准备好了' }, { type: 'done' }]))
    vi.stubGlobal('fetch', fetchMock)
    await setup().conversation.sendMessage('准备一幅画')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).messages.at(-1).content).toContain(output)
    expect(addScore).not.toHaveBeenCalled()
  })
  it('preserves received text when the connection ends unexpectedly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream([{ type: 'token', content: '已经收到的回复' }])))
    const { conversation, messages, options, busy } = setup()
    await conversation.sendMessage('你好')
    expect(messages.at(-1)).toMatchObject({ content: '已经收到的回复', stopped: true })
    expect(options.onError).toHaveBeenLastCalledWith(expect.stringContaining('意外中断'))
    expect(busy.value).toBe(false)
  })

  it('cancels a pending native tool and never starts the next tool or chat round', async () => {
    let toolSignal: AbortSignal | undefined
    const runTool = vi.fn((_name: string, _args: object, options?: { signal?: AbortSignal }) => {
      toolSignal = options?.signal
      return new Promise<{ ok: boolean; output: string }>(() => {})
    })
    desktopFixture.current = { runTool } as unknown as CompanionDesktopBridge
    const fetchMock = vi.fn().mockResolvedValue(stream([
      { type: 'tool-call', id: 'one', name: 'capture_screen', arguments: '{}' },
      { type: 'tool-call', id: 'two', name: 'read_image', arguments: '{}' }, { type: 'done' },
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const { conversation, busy } = setup()
    const pending = conversation.sendMessage('看一下屏幕')
    await vi.waitFor(() => expect(runTool).toHaveBeenCalledTimes(1))
    conversation.stopEverything()
    await pending
    expect(toolSignal?.aborted).toBe(true)
    expect(busy.value).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(runTool).toHaveBeenCalledTimes(1)
  })

  it('sends captured screen pixels to the next model request', async () => {
    const image = 'data:image/png;base64,aGVsbG8='
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream([{ type: 'tool-call', id: 'one', name: 'capture_screen', arguments: '{}' }, { type: 'done' }]))
      .mockResolvedValueOnce(Response.json({ ok: true, output: '截图完成', imageDataUrl: image }))
      .mockResolvedValueOnce(stream([{ type: 'token', content: '看到了' }, { type: 'done' }]))
    vi.stubGlobal('fetch', fetchMock)
    const { conversation } = setup()
    await conversation.sendMessage('看一下屏幕')
    const body = JSON.parse(fetchMock.mock.calls[2][1].body)
    expect(body.messages.at(-1).content).toContainEqual({ type: 'image_url', image_url: { url: image } })
  })

  it('returns invalid tool arguments as an error without executing the tool', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream([{ type: 'tool-call', id: 'one', name: 'capture_screen', arguments: '{bad' }, { type: 'done' }]))
      .mockResolvedValueOnce(stream([{ type: 'token', content: '参数错误' }, { type: 'done' }]))
    vi.stubGlobal('fetch', fetchMock)
    const { conversation } = setup()
    await conversation.sendMessage('看一下屏幕')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content).toContain('有效 JSON')
  })

  it('does not resurrect a sent draft from the debounce timer', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream([{ type: 'token', content: '你好' }, { type: 'done' }])))
    const { conversation, options } = setup()
    conversation.inputText.value = '草稿'
    conversation.onInputChange()
    await conversation.sendMessage()
    await vi.advanceTimersByTimeAsync(300)
    expect(options.storage.setDraft).toHaveBeenLastCalledWith('nene', '')
  })

  it('aborts a gateway tool request and prevents subsequent operations', async () => {
    let toolSignal: AbortSignal | undefined
    const fetchMock = vi.fn().mockResolvedValueOnce(stream([
      { type: 'tool-call', id: 'one', name: 'capture_screen', arguments: '{}' }, { type: 'done' },
    ])).mockImplementationOnce((_url, init) => {
      toolSignal = init.signal
      return new Promise((_resolve, reject) => toolSignal!.addEventListener('abort', () => reject(toolSignal!.reason)))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { conversation, busy } = setup()
    const pending = conversation.sendMessage('看屏幕')
    await vi.waitFor(() => expect(toolSignal).toBeDefined())
    conversation.stopEverything()
    await pending
    expect(toolSignal!.aborted).toBe(true)
    expect(busy.value).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports the tool round limit rather than presenting an empty successful reply', async () => {
    const runTool = vi.fn().mockResolvedValue({ ok: true, output: '完成' })
    desktopFixture.current = { runTool } as unknown as CompanionDesktopBridge
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(stream([
      { type: 'tool-call', id: 'one', name: 'capture_screen', arguments: '{}' }, { type: 'done' },
    ]))))
    const { conversation, options, messages } = setup()
    await conversation.sendMessage('继续')
    expect(runTool).toHaveBeenCalledTimes(4)
    expect(options.onError).toHaveBeenLastCalledWith(expect.stringContaining('达到上限'))
    expect(messages).toHaveLength(1)
    expect(options.voice.finishTurn).not.toHaveBeenCalled()
  })
})

const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => desktopFixture.current }))


it.each([false, true])('keeps tool rounds on their submitted connection while metadata respects edited=%s', async edited => {
  let deliver!: (events: object[]) => void
  const first = new Response(new ReadableStream({ start(controller) {
    deliver = events => { controller.enqueue(new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n')); controller.close() }
  } }))
  const fetchMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(stream([
    { type: 'meta', model: 'canonical-final' }, { type: 'token', content: 'Finished' }, { type: 'done' },
  ]))
  desktopFixture.current = { runTool: vi.fn(async () => ({ ok: true, output: 'fixture result' })) } as unknown as CompanionDesktopBridge
  vi.stubGlobal('fetch', fetchMock)
  const { conversation, options, messages } = setup()
  const pending = conversation.sendMessage('fixture request')
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  if (edited) {
    options.apiBaseUrl.value = 'http://localhost:5678/v1'
    options.apiModel.value = 'next-turn-model'
    options.apiKey.value = 'synthetic-next-key'
    options.webSearchEnabled.value = true
  }
  deliver([{ type: 'meta', model: 'canonical-first' }, { type: 'tool-call', id: 'fixture', name: 'get_status', arguments: '{}' }, { type: 'done' }])
  await pending
  const second = JSON.parse(fetchMock.mock.calls[1][1].body)
  expect(second).toMatchObject({ provider: 'api', webSearch: false, api: {
    baseUrl: 'http://localhost:1234/v1', model: 'canonical-first', apiKey: 'test',
  } })
  expect(options.apiModel.value).toBe(edited ? 'next-turn-model' : 'canonical-final')
  if (edited) expect(options.storage.setApiSettings).not.toHaveBeenCalled()
  else expect(options.storage.setApiSettings).toHaveBeenLastCalledWith({ baseUrl: 'http://localhost:1234/v1', model: 'canonical-final', apiKey: 'test' })
  expect(messages).toHaveLength(2)
  expect(messages[1].content).toBe('Finished')
  conversation.destroy()
})
