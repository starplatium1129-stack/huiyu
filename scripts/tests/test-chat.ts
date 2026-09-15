'use strict';
const { test }: typeof import('node:test') = require('node:test');

test('chat', async () => {
var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');
var http: typeof import('http') = require('http');
var gatewayTestStack: typeof import('./gateway-test-stack') = require('./gateway-test-stack');
var root = path.resolve(__dirname, '..', '..');

function assert(condition: any, message: any) {
  if (!condition) throw new Error('[chat] ' + message);
}

function listen(server: any) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      resolve('http://127.0.0.1:' + server.address().port);
    });
  });
}

function close(server: any) {
  return new Promise(function (resolve) {
    if (!server || !server.listening) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(function () { resolve(); });
  });
}

async function postJson(url: any, payload: any) {
  var response = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify(payload)
  });
  var body = await response.text();
  var json = null;
  try { json = JSON.parse(body); } catch (error) {}
  return { status:response.status, body:body, json:json };
}

// 模拟公网访客（localOnly 判定：本机 socket + 无转发头才放行）。
// 公网请求需要 token；用 X-Token 头（query token 会 302 种 cookie，
// fetch 跟随后不带 cookie 反而 401）。
async function postJsonWithHost(url: any, payload: any, forwardedFor?: any) {
  var response = await fetch(url, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Forwarded-For':forwardedFor || '8.8.8.8',
      'X-Token':'test-token'
    },
    body:JSON.stringify(payload)
  });
  var body = await response.text();
  var json = null;
  try { json = JSON.parse(body); } catch (error) {}
  return { status:response.status, body:body, json:json };
}

function readNdjson(body: any) {
  return body.trim().split('\n').filter(Boolean).map(function (line: any) { return JSON.parse(line); });
}

function createMockAiServer() {
  var state = {
    activeChat:0,
    maxActiveChat:0,
    activeVoice:0,
    maxActiveVoice:0,
    voicePayloads:[],
    unloaded:[],
    compatiblePayloads:[],
    compatibleAuth:''
  };
  var server = http.createServer(function (req, res) {
    var chunks: any = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () {
      var body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (error) {}
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models:[
          { name:'model-a', size:1, details:{ parameter_size:'7B', quantization_level:'Q4' } },
          { name:'model-b', size:2, details:{ parameter_size:'9B', quantization_level:'Q5' } }
        ] }));
        return;
      }
      if (req.url === '/api/generate') {
        state.unloaded.push(body.model);
        res.end('{}');
        return;
      }
      if (req.url === '/api/chat') {
        state.activeChat += 1;
        state.maxActiveChat = Math.max(state.maxActiveChat, state.activeChat);
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write('{"message":{"content":"你');
        setTimeout(function () {
          res.write('好。"}}\n{"done":true}\n');
          res.end();
          state.activeChat -= 1;
        }, 35);
        return;
      }
      if (req.url === '/v1/models') {
        state.compatibleAuth = String(req.headers.authorization || '');
        res.setHeader('Content-Type', 'application/json');
        if (state.compatibleAuth === 'Bearer rejected-key') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error:{ message:'credential rejected' } }));
          return;
        }
        if (state.compatibleAuth === 'Bearer empty-list-key') {
          res.end(JSON.stringify({ data:[] }));
          return;
        }
        res.end(JSON.stringify({ data:[
          { id:'compatible-model' },
          { id:'compatible-model-fast' }
        ] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        state.compatiblePayloads.push(body);
        state.compatibleAuth = String(req.headers.authorization || '');
        if (body.model === 'json-model') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices:[{ message:{ content:'non-stream reply' } }] }));
          return;
        }
        if (body.model === 'malformed-sse-model') {
          res.setHeader('Content-Type', 'text/event-stream');
          res.end('data: {not valid json}\n\ndata: [DONE]\n\n');
          return;
        }
        if (body.model === 'tool-call-model') {
          res.setHeader('Content-Type', 'text/event-stream');
          // OpenAI 兼容的 tool_calls 增量：id/name 首次出现，arguments 分片；
          // 思考轮带工具调用：reasoning_content 增量先到（DeepSeek V4 回传契约）
          res.write('data: {"choices":[{"delta":{"reasoning_content":"我得先看看"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_files","arguments":"{\\"path\\":\\"\\"}"}}]}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":"让我看看工作区里有什么。"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"."}}]}}]}\n\n');
          res.end('data: [DONE]\n\n');
          return;
        }
        if (body.model === 'thinking-model') {
          res.setHeader('Content-Type', 'text/event-stream');
          // DeepSeek 思考模式：reasoning_content 增量先到，正文后到
          res.end('data: {"choices":[{"delta":{"reasoning_content":"让我想想"}}]}\n\n' +
            'data: {"choices":[{"delta":{"reasoning_content":"再想想"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"答案是 42"}}]}\n\n' +
            'data: [DONE]\n\n');
          return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        var utf8Event = Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n', 'utf8');
        var chineseStart = utf8Event.indexOf(Buffer.from('你', 'utf8'));
        res.write(utf8Event.subarray(0, chineseStart + 1));
        setTimeout(function () {
          res.end(utf8Event.subarray(chineseStart + 1));
        }, 10);
        return;
      }
      if (req.url === '/docs') {
        res.end('ok');
        return;
      }
      if (req.url.startsWith('/set_sovits_weights') || req.url.startsWith('/set_gpt_weights')) {
        res.end('ok');
        return;
      }
      if (req.url === '/tts') {
        state.voicePayloads.push(body);
        state.activeVoice += 1;
        state.maxActiveVoice = Math.max(state.maxActiveVoice, state.activeVoice);
        res.setHeader('Content-Type', 'audio/wav');
        res.write(Buffer.from('RIFF'));
        setTimeout(function () {
          res.end(Buffer.from('voice'));
          state.activeVoice -= 1;
        }, 35);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return { server:server, state:state };
}

async function consumeVoice(service: any, input: any) {
  return service.stream(input, {
    onResponse:async function (result: any) {
      for await (var chunk of result.response) void chunk;
    }
  });
}

async function run() {
  // 网站角色房间与 Companion 是独立视图，只共享最小会话编排。
  var html = fs.readFileSync(path.join(root, 'src', 'views', 'ChatView.vue'), 'utf8');
  var companionHtml = fs.readFileSync(path.join(root, 'src', 'views', 'CompanionView.vue'), 'utf8');
  companionHtml += '\n' + fs.readFileSync(path.join(root, 'src/composables/chat/useCompanionWorkspace.ts'), 'utf8');
  // 2026-08-22 行为运行时（30s 心跳：syncReminders + reconcileAutoListen）自
  // CompanionView 下沉，tick 哨兵随之迁移；同轮语音输入簇（按住说话/Space
  // 保持/唤醒会话/auto-listen gating）下沉 useCompanionSpeechInput。
  var companionBehavior = fs.readFileSync(path.join(root, 'src', 'composables', 'useCompanionBehaviorRuntime.ts'), 'utf8');
  var companionSpeech = fs.readFileSync(path.join(root, 'src', 'composables', 'useCompanionSpeechInput.ts'), 'utf8');
  // d674a99 将角色房间会话核心迁入 chat/ 子目录（与 useChatConversation 等同层）
  var roomSession = fs.readFileSync(path.join(root, 'src', 'composables', 'chat', 'useCharacterRoomSession.ts'), 'utf8');
  var apiSettingsComponent = fs.readFileSync(path.join(root, 'src', 'components', 'ChatApiSettings.vue'), 'utf8');
  var chatApiConfig = fs.readFileSync(path.join(root, 'src', 'config', 'chatApi.ts'), 'utf8');
  var characterStageComponent = fs.readFileSync(path.join(root, 'src', 'components', 'ChatCharacterStage.vue'), 'utf8');
  var voiceStudio = fs.readFileSync(path.join(root, 'src', 'components', 'VoiceStudio.vue'), 'utf8');
  var voiceModule = fs.readFileSync(path.join(root, 'src', 'composables', 'useVoice.ts'), 'utf8');
  var live2dModule = fs.readFileSync(path.join(root, 'src', 'composables', 'useLive2D.ts'), 'utf8');
  // 双后端抽象后 wl-live2d 专属逻辑（运行库导入/模型创建/画布布局）在
  // browserBackend；源码哨兵断言检查两者合并，防止单侧重构回退。
  var live2dBrowserBackend = fs.readFileSync(path.join(root, 'src', 'live2d', 'browserBackend.ts'), 'utf8');
  var live2dStageModule = live2dModule + '\n' + live2dBrowserBackend;
  var live2dSubmodules = fs.readdirSync(path.join(root, 'src', 'composables', 'live2d')).filter(function (name) { return name.endsWith('.ts'); }).map(function (name) { return fs.readFileSync(path.join(root, 'src', 'composables', 'live2d', name), 'utf8'); }).join('\n');
  var live2dAggregated = live2dModule + '\n' + live2dBrowserBackend + '\n' + live2dSubmodules;
  var chatCss = fs.readFileSync(path.join(root, 'src', 'assets', 'css', 'chat.css'), 'utf8');
  var mainTs = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
  var streamUtils = fs.readFileSync(path.join(root, 'src', 'utils', 'stream.ts'), 'utf8');
  var chatStorage = fs.readFileSync(path.join(root, 'src', 'composables', 'chat', 'useChatStorage.ts'), 'utf8');
  var characterConfig = fs.readFileSync(path.join(root, 'src', 'config', 'characters.ts'), 'utf8');
  var chatProvider = fs.readFileSync(path.join(root, 'src', 'composables', 'chat', 'useChatProvider.ts'), 'utf8');
  var chatConversation = fs.readFileSync(path.join(root, 'src', 'composables', 'chat', 'useChatConversation.ts'), 'utf8');
  var userProfilePanel = fs.readFileSync(path.join(root, 'src', 'components', 'ChatUserProfilePanel.vue'), 'utf8');
  var memoryPanel = fs.readFileSync(path.join(root, 'src', 'components', 'ChatMemoryPanel.vue'), 'utf8');
  var characterPrompts = fs.readFileSync(path.join(root, 'server', 'chat-character-prompts.js'), 'utf8');
  var securitySource = fs.readFileSync(path.join(root, 'server', 'security.js'), 'utf8');
  var voiceRoute = fs.readFileSync(path.join(root, 'routes', 'voice.js'), 'utf8');
  var chatRouteSource = fs.readFileSync(path.join(root, 'routes', 'chat.js'), 'utf8');
  var serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert(html.includes('chat-page'), 'chat view must render the character room shell');
  assert(companionHtml.includes('companion-page'), 'companion view must render its own desktop shell');
  assert(!companionHtml.includes("import ChatView") && !companionHtml.includes('<ChatView'), 'companion must not wrap the website chat view');
  assert(
    html.includes('useCharacterRoomSession')
      && companionHtml.includes('useCharacterRoomSession')
      && roomSession.includes('useChatConversation')
      && roomSession.includes('useChatProvider')
      && roomSession.includes('useVoice'),
    'website chat and companion must share only the character-room session core'
  );
  assert(characterStageComponent.includes("'nene'") && characterStageComponent.includes("'natsume'") && html.includes('switchCharacter'), 'both characters must be selectable');
  // chat.css 是路由专属样式：由 ChatView 自己 import，随 /chat 的懒加载块下发，
  // 不再进全局包（它曾占 139KB 全局 CSS 的 13%，而只有一个路由用得到）。
  assert(html.includes('assets/css/chat.css'), 'chat styles must be imported by the chat view');
  assert(!mainTs.includes('assets/css/chat.css'), 'chat styles must not ship in the global entry bundle');
  assert(roomSession.includes('useVoice') && html.includes('ChatCharacterStage'), 'shared session must own voice while the chat view composes the character stage');
  assert(characterStageComponent.includes('useLive2D'), 'the character stage must own the Live2D lifecycle');
  assert(characterStageComponent.includes("'live2d-ready': live2d.ready"), 'Vue must own the Live2D visibility class so voice state renders cannot restore the static portrait');
  assert(html.includes('voice-console') && html.includes('replay-btn'), 'live voice and replay must share one visual control');
  assert(!html.includes('portrait-blink') && !html.includes('scheduleBlink'), 'static portraits must not use a duplicate-image blink effect');
  assert(!chatCss.includes('portrait-talk'), 'static portraits must not scale or bounce while voice is playing');
  assert(
    roomSession.includes('useChatConversation')
      && chatConversation.includes("fetch('/api/chat'")
      && chatConversation.includes('parseNdjsonResponse'),
    'chat conversation composable must stream from the gateway'
  );
  assert(
    chatStorage.includes('historiesRevision')
      && chatStorage.includes('historiesRevisions')
      && chatStorage.includes('remoteRevision'),
    'clearing a conversation must create a tombstone that blocks delayed stale saves'
  );
  assert(html.includes('ChatApiSettings'), 'chat API settings must have independent component ownership');
  assert(html.includes('ChatUserProfilePanel') && userProfilePanel.includes('CHAT_RELATIONSHIPS'), 'user profile editing must have independent component ownership');
  assert(html.includes('ChatMemoryPanel') && memoryPanel.includes('LONG-TERM MEMORY') && html.includes('messageRemembered'), 'manual long-term memory must have independent UI ownership');
  assert(chatConversation.includes('userProfile: hasChatUserProfile') && roomSession.includes('loadChatUserProfile'), 'the validated local user profile must reach every chat request');
  assert(chatConversation.includes('memories: options.recallMemories') && roomSession.includes('recallChatFacts'), 'recalled user-confirmed facts must reach the chat request');
  assert(chatRouteSource.includes("require('../server/chat-character-prompts')") && characterPrompts.includes('buildCharacterPrompt'), 'server prompt layering must have independent ownership');
  assert(roomSession.includes('useChatProvider') && chatProvider.includes('refreshChatStatus') && chatProvider.includes('saveApiSettings'), 'chat provider settings and status must have composable ownership');
  assert(
    /defineExpose\(\{[\s\S]*setSpeaking,[\s\S]*setMouth,[\s\S]*setAudioLevel,[\s\S]*setEmotion,[\s\S]*setUserMessage,?\s*(?:setDesktopVisible,?\s*)?(?:setDesktopWindowBounds,?\s*)?(?:setDesktopPerformanceMode,?\s*)?(?:setGlobalPointer,?\s*)?(?:releasePointerFocus,?\s*)?\}\)/.test(characterStageComponent)
      && characterStageComponent.includes("emit('live2dEnabled'")
      && characterStageComponent.includes("emit('outfitChanged'"),
    'the character stage must expose only voice animation controls and persist Live2D preferences'
  );
  assert(
    apiSettingsComponent.includes('chatApi.testProvider')
      && apiSettingsComponent.includes('discoveredModels'),
    'chat API settings must test credentials and discover models'
  );
  assert(
    apiSettingsComponent.includes("'opencode-go'")
      && apiSettingsComponent.includes('OPENCODE_GO_BASE_URL')
      && chatApiConfig.includes('https://opencode.ai/zen/go/v1')
      && chatApiConfig.includes('deepseek-v4-flash'),
    'OpenCode Go must offer its dedicated endpoint and DeepSeek V4 Flash preset'
  );
  assert(chatConversation.includes('AbortController') && html.includes('stop-btn'), 'chat requests must be cancellable');
  assert(!/\bany\b/.test(html), 'ChatView model, stream, error, and history boundaries must stay explicitly typed');
  assert(!/\bany\b/.test(companionHtml), 'CompanionView boundaries must stay explicitly typed');
  assert(companionSpeech.includes('useVoiceInput') && companionSpeech.includes('createSpeechSession') && companionSpeech.includes('loadSpeechInputConfig'), 'Companion speech must reuse the existing input/session modules');
  assert(companionSpeech.includes("event.key !== ' '") && companionHtml.includes('onWindowKeyup') && companionSpeech.includes('speechHeldByKeyboard'), 'Companion speech must own Space keydown/keyup state');
  assert(companionSpeech.includes('documentHidden') && companionSpeech.includes('!dnd.value') && companionSpeech.includes('!inQuietHours.value'), 'Companion auto listening must gate visibility, DND, and quiet hours');
  assert(companionSpeech.includes("speechState.value === 'acquiring'") && companionSpeech.includes('speechCancel()'), 'Companion speech must cancel pending acquisition');
  assert(/watch\(busy, value => \{\s*if \(value\) \{\s*speechHeldByKeyboard = false\s+speechHeldByPointer = false\s+speechSession\.markReplyBusy\(\)\s+speechCancel\(\)\s*\} else \{/.test(companionSpeech), 'busy=true must clear held inputs and cancel every speech mode before reconcile');
  assert(companionHtml.includes('function setDesktopVisibility(visible: boolean)'), 'Companion visibility handler must remain present');
  assert(companionHtml.includes('if (!visible)') && companionHtml.includes('cancelSpeechActivity()'), 'Companion window hiding must cancel speech');
  assert(companionBehavior.includes('syncReminders()') && companionBehavior.includes('reconcileAutoListen()'), 'Companion behavior ticks must refresh quiet state and auto listening');
  assert(companionHtml.includes('companion-speech-cluster') && companionSpeech.includes('speechRelease()') && companionSpeech.includes('speechSession.endSession()') && !companionSpeech.includes('/audio/transcriptions'), 'Companion speech must use one UI cluster, release on unmount, and avoid a second ASR fetch path');
  assert(!/\bany\b/.test(roomSession), 'shared character-room session boundaries must stay explicitly typed');
  assert(!/\bany\b/.test(chatConversation), 'chat conversation stream, cancellation, and draft boundaries must stay explicitly typed');
  assert(!/\bany\b/.test(streamUtils), 'chat stream events and abort errors must stay explicitly typed');
  assert(!/\bany\b/.test(chatStorage), 'persisted chat messages must stay explicitly typed');
  assert(html.includes('streamingMid'), 'only the active assistant message may keep the streaming cursor');
  assert(
    voiceModule.includes('SentenceBuffer') && voiceModule.includes("'/api/tts?'") && voiceModule.includes('URLSearchParams'),
    'voice must stream complete sentence WAV via the GET endpoint so public playback starts before the whole file is downloaded'
  );
  assert(
    voiceRoute.includes('router.get(\'/api/tts\'')
      && voiceRoute.includes('Buffer.concat') && voiceRoute.includes('fixWavHeaderServer')
      && voiceRoute.includes('ttsAudioCache')
      && voiceRoute.includes('inFlightTts')
      && voiceRoute.includes('body.emotion'),
    'streaming endpoint must collect, fix and cache the complete sentence WAV server-side and coalesce identical in-flight generations'
  );
  assert(
    voiceModule.includes("consistency: 'locked'") && voiceModule.includes('referenceEmotion: meta.referenceEmotion'),
    'voice must lock a stable identity reference while a sentence mood stays unchanged'
  );
  assert(
    voiceStudio.includes('referenceEmotion: voiceEmotion.value,')
      && !voiceStudio.includes("voiceEmotion.value === 'neutral' ? 'gentle'")
      && voiceModule.includes('meta.referenceEmotion = rawEmotion'),
    'neutral delivery must use the character main reference instead of silently borrowing gentle emotion'
  );
  assert(
    voiceModule.includes('extractSpokenDialogue')
      && voiceModule.includes("(directionText && rawEmotion !== 'neutral') || emotionChanged ? 'adaptive' : 'locked'")
      && voiceModule.includes('const emotionChanged = Boolean(firstReference && emotion !== firstReference)')
      && voiceModule.includes('90_000')
      && voiceModule.includes('retryLeft')
      && voiceModule.includes('minimumLength: 12')
      && voiceModule.includes('maximumLength: 44')
      && voiceModule.includes('firstThreshold: 8'),
    'voice must omit roleplay directions, honor their emotion, and bound stuck synthesis'
  );
  assert(
    voiceModule.includes('audio.networkState === 2')
      && voiceModule.includes("onStatus(waitExtensions === 1 ? '语音生成较慢，继续等待…' : '语音生成很慢，还在排队…')")
      && voiceModule.includes("audio.pause()") && voiceModule.includes("audio.removeAttribute('src')")
      && voiceModule.includes('function onPlaying() { started = true }')
      && voiceModule.includes("const retryable = !started && reason !== 'timeout' && item.retryLeft !== 0 && sess === session"),
    'voice must never double-play or replay from the start after mid-playback failure, and must extend slow generations instead of killing them'
  );
  assert(voiceModule.includes('AbortController') && voiceModule.includes('messageAudio'), 'voice sessions must support cancellation and replay');
  assert(!/\bany\b/.test(voiceModule), 'voice queue, turn, API responses, and Web Audio boundaries must stay explicitly typed');
  assert(
    voiceModule.includes('readVoiceAvailability') && voiceModule.includes('voiceApi.translate'),
    'voice API responses must be narrowed at the JSON boundary'
  );
  assert(voiceModule.includes('voiceApi.prepare') && voiceRoute.includes("router.post('/api/voice/prepare'"), 'voice models and translation must prewarm before the first line');
  assert(voiceModule.includes('getByteTimeDomainData') && voiceModule.includes('onMouth'), 'lip sync must use real audio amplitude');
  assert(live2dAggregated.includes('ResizeObserver') && live2dAggregated.includes('webglcontextlost'), 'Live2D must recover layout and WebGL failures');
  assert(live2dAggregated.includes('setOutfit') && live2dAggregated.includes('setSpeaking') && live2dAggregated.includes('setMouth') && live2dAggregated.includes('ParamMouthOpenY'), 'Live2D must switch authored outfits and write real speech amplitudes into the mouth parameter');
  assert(
    characterConfig.includes("{ id: 'school', label: '校服', expression: 'expression1' }")
      && characterConfig.includes("{ id: 'casual', label: '常服', expression: 'expression2' }")
      && characterConfig.includes("{ id: 'sleepwear', label: '睡衣', expression: 'expression3' }")
      && characterConfig.includes("{ id: 'cosplay', label: 'COS 服', expression: 'expression4' }")
      && characterConfig.includes("{ id: 'witch', label: '魔女服', expression: 'expression5' }")
      && characterStageComponent.includes('class="wardrobe-trigger wardrobe-static"')
      && characterStageComponent.includes('互动动作含原生图层效果')
      && characterStageComponent.includes('class="wardrobe-menu"')
      && apiSettingsComponent.includes(':data-vendor="option.value"')
      && live2dAggregated.includes('model.expression(target.expression)')
      && !live2dAggregated.includes('LIVE2D_EXPRESSIONS')
      && !html.includes('setExpression'),
    'all five source-authored outfits must be explicit controls and must not be driven by chat emotion'
  );
  assert(
    live2dAggregated.includes('INTERACTION_MOTIONS')
      && live2dAggregated.includes('worldPoint')
      && live2dAggregated.includes('model.hitTest(point.x, point.y)')
      && live2dAggregated.includes('interactionFromStagePosition')
      && live2dAggregated.includes('if (y < 0.29) return INTERACTION_MOTIONS.Face')
      && live2dAggregated.includes("hint: '碰到了画面左侧胸前，宁宁有点生气'")
      && live2dAggregated.includes("hint: '碰到了画面右侧胸前，宁宁有点生气'")
      && live2dAggregated.includes('y >= 0.29 && y < 0.42 && x >= 0.40 && x < 0.50')
      && live2dAggregated.includes('y >= 0.42 && y < 0.57')
      && live2dAggregated.includes('return INTERACTION_MOTIONS.Body')
      && live2dAggregated.includes('wl-live2d sometimes reports the broad body mesh for every DOM click')
      && live2dAggregated.includes('model.motion(interaction.group, undefined, 3)')
      && live2dAggregated.includes("motionPreload: 'ALL'")
      && live2dAggregated.includes('function markInteractionStarted')
      && live2dAggregated.includes("interactionHint.value = '这个动作正在进行中'")
      && live2dAggregated.includes("interactionHint.value = '动作没有启动，请重试'"),
    'Live2D clicks must map source hit areas to authored motions with FORCE priority, report feedback only after startup, and distinguish an active motion from a real failure'
  );
  assert(
    live2dAggregated.includes('点击呆毛、头部、脸、身体、两侧或裙摆可互动'),
    'Live2D must advertise every packaged source interaction area'
  );
  assert(!/\bany\b/.test(live2dAggregated), 'Live2D catalog, runtime, controller, and model boundaries must stay explicitly typed');
  assert(
    live2dAggregated.includes('readLive2DCatalog') && live2dAggregated.includes('readLibrary'),
    'Live2D status JSON and dynamic runtime exports must be narrowed before use'
  );
  assert(!characterStageComponent.includes('live2d-quick-actions') && !live2dAggregated.includes('beginGreetingGesture'), 'Live2D must not expose simulated quick actions');
  assert(
    live2dAggregated.includes('options.autoLoad === true')
      && live2dAggregated.includes("setState('idle', '启用 Live2D'"),
    'Live2D must stay unloaded until the user explicitly enables it'
  );
  assert(live2dAggregated.includes("'degraded'") && live2dAggregated.includes('已经显示的模型失效'), 'runtime expression failures must not replace a loaded Live2D model with the static portrait');
  // Live2D 运行库必须真正被加载（重构后曾漏掉，导致"运行库加载失败"）
  assert(live2dStageModule.includes("import('wl-live2d')"), 'Live2D runtime must be imported by the composable');
  // PixiJS 需要 unsafe-eval：两个 Live2D 页面都必须放行，否则运行时初始化失败
  assert(
    securitySource.includes("path === '/chat'")
      && securitySource.includes("path === '/companion'")
      && securitySource.includes('unsafe-eval'),
    'CSP must allow unsafe-eval on chat and companion routes for the Live2D renderer'
  );
  // 情绪关键词曾因编码损坏全部失效，导致语音永远 neutral
  assert(!/\uFFFD/.test(streamUtils), 'emotion keywords must not contain replacement characters');
  ['shy', 'happy', 'sad', 'serious', 'gentle'].forEach(function (emotion) {
    assert(streamUtils.includes("'" + emotion + "'"), 'inferEmotion must classify ' + emotion);
  });
  assert(serverSource.includes('createGateway') && serverSource.includes("require('./routes/chat')"), 'gateway must use modular route composition');
  assert(
    chatRouteSource.includes('kept.unshift')
      && chatRouteSource.includes('used + text.length > 12000')
      && chatRouteSource.includes('count < 24')
      && !chatRouteSource.includes('当前对话过长'),
    'long conversations must be trimmed from the oldest messages instead of being rejected'
  );

  var utils: typeof import('../../src/utils/stream.ts') = require('../../src/utils/stream.ts');
  var chatStatus: typeof import('../../src/utils/chatStatus.ts') = require('../../src/utils/chatStatus.ts');
  var parsedStatus = chatStatus.parseChatStatus({
    online:true,
    model:'model-a',
    models:[{ name:'model-a', parameters:'7B' }, null, { name:4 }]
  });
  assert(parsedStatus.online && parsedStatus.models.length === 1,
    'chat status parsing must discard malformed model records');
  assert(parsedStatus.models[0].parameters === '7B',
    'chat status parsing must preserve display metadata');
  assert(utils.streamErrorMessage(
    Object.assign(new Error('upstream failed'), { detail:'timeout' }),
    'fallback'
  ) === 'upstream failed：timeout', 'stream errors must preserve safe detail text');
  var sentences = new utils.SentenceBuffer({ minimumLength:6 });
  assert(sentences.push('嗯。').length === 0, 'short sentence should wait for the next boundary');
  assert(sentences.push('今天过得怎么样？')[0] === '嗯。今天过得怎么样？', 'short sentence should merge without being lost');
  assert(sentences.push('最后一句', true)[0] === '最后一句', 'flush must emit the remaining sentence');
  var firstSentences = new utils.SentenceBuffer({ minimumLength:12, firstThreshold:8 });
  assert(firstSentences.push('嗯嗯嗯嗯。').length === 0, 'first sentence below firstThreshold should still wait');
  assert(firstSentences.push('今天也辛苦啦！')[0] === '嗯嗯嗯嗯。今天也辛苦啦！', 'under-threshold first sentence must merge with the next');
  var firstFast = new utils.SentenceBuffer({ minimumLength:12, firstThreshold:8 });
  assert(firstFast.push('今天过得怎么样？')[0] === '今天过得怎么样？', 'first sentence reaching firstThreshold must emit immediately');
  assert(firstFast.push('很好。').length === 0, 'later short sentences must still wait for the normal minimum');
  assert(firstFast.push('', true)[0] === '很好。', 'flush must still emit a short later sentence');
  var dialogue = utils.extractSpokenDialogue('（稍微有点慌乱）诶、和我一起看吗……');
  assert(dialogue.text === '诶、和我一起看吗……', 'roleplay directions must not enter spoken dialogue');
  assert(JSON.stringify(dialogue.directions) === JSON.stringify(['稍微有点慌乱']), 'roleplay directions must remain available for emotion selection');
  assert(utils.inferEmotion(dialogue.directions.join(' '), 'nene') === 'shy', 'nervous stage directions must select a shy delivery');

  var wav = new ArrayBuffer(48);
  var wavView = new DataView(wav);
  wavView.setUint32(0, 0x52494646, false);
  wavView.setUint32(8, 0x57415645, false);
  wavView.setUint32(12, 0x666d7420, false);
  wavView.setUint32(16, 16, true);
  wavView.setUint32(36, 0x64617461, false);
  utils.fixWavHeader(wav);
  assert(wavView.getUint32(4, true) === 40 && wavView.getUint32(40, true) === 4, 'WAV sizes must be repaired');

  var chatRoute: typeof import('../../routes/chat') = require('../../routes/chat');
  var crypto: typeof import('crypto') = require('crypto');
  assert(chatRoute.validateChatBody({
    character:'nene',
    messages:[{ role:'user', content:'你好' }]
  }).value, 'valid chat body must pass');
  assert(chatRoute.validateChatBody({ character:'unknown', messages:[] }).error, 'invalid character must be rejected');
  assert(chatRoute.validateChatBody({
    character:'nene',
    provider:'api',
    api:{ baseUrl:'http://example.com/v1', model:'model-a', apiKey:'secret' },
    messages:[{ role:'user', content:'hello' }]
  }).error, 'remote compatible APIs must require HTTPS');
  var compatibleValidation = chatRoute.validateChatBody({
    character:'nene',
    provider:'api',
    api:{ baseUrl:'https://api.example.com/v1', model:'model-a', apiKey:'secret' },
    messages:[{ role:'user', content:'hello' }]
  });
  assert(
    compatibleValidation.value.api.pathname === '/v1/chat/completions',
    'compatible API base paths must preserve the /v1 prefix'
  );
  var deepseekValidation = chatRoute.validateCompatibleApi({
    baseUrl:'https://api.deepseek.com',
    model:'deepseek-v4-flash',
    apiKey:'secret'
  });
  assert(deepseekValidation.value.vendor === 'deepseek', 'official DeepSeek endpoints must receive the role-chat optimization');
  var opencodeValidation = chatRoute.validateCompatibleApi({
    baseUrl:'https://opencode.ai/zen/v1',
    model:'deepseek-v4-flash-free',
    apiKey:'secret'
  });
  assert(
    opencodeValidation.value.vendor === 'opencode'
      && opencodeValidation.value.pathname === '/zen/v1/chat/completions',
    'OpenCode Zen must use its OpenAI-compatible chat endpoint'
  );
  var opencodeGoValidation = chatRoute.validateCompatibleApi({
    baseUrl:'https://opencode.ai/zen/go/v1',
    model:'deepseek-v4-flash',
    apiKey:'secret'
  });
  assert(
    opencodeGoValidation.value.vendor === 'opencode'
      && opencodeGoValidation.value.pathname === '/zen/go/v1/chat/completions',
    'OpenCode Go must preserve its dedicated OpenAI-compatible chat endpoint'
  );
  assert(chatRoute.chatCharacterPrompt('nene').includes('不要每句话都结巴'), 'Nene prompt must constrain repetitive roleplay mannerisms');
  assert(chatRoute.chatCharacterPrompt('natsume').includes('关心藏进提醒'), 'Natsume prompt must preserve restrained care');
  assert(chatRoute.chatCharacterPrompt('nene').includes('不要假装知道用户没说过的'), 'character prompts must not invent shared facts');
  assert(chatRoute.chatCharacterPrompt('nene').includes('先辨认用户这句话里的情绪'), 'Nene prompt must explicitly respond to the user emotion');
  assert(chatRoute.chatCharacterPrompt('natsume').includes('先辨认用户这句话里的情绪'), 'Natsume prompt must explicitly respond to the user emotion');
  assert(chatRoute.chatCharacterPrompt('natsume').includes('关心不等于管束或占有'), 'character prompts must keep care distinct from control');
  assert(chatRoute.chatCharacterPrompt('nene').includes('这是私人本地角色扮演'), 'character prompts must identify the private local context');
  assert(chatRoute.chatCharacterPrompt('natsume').includes('不输出政策声明或机械拒绝'), 'character prompts must stay in character for sensitive adult topics');
  assert(!chatRoute.chatCharacterPrompt('nene').includes('未成年人性内容'), 'character prompts must not contain generic content-review boilerplate');
  assert(crypto.createHash('sha256').update(chatRoute.chatCharacterPrompt('nene')).digest('hex') === '39001ea39f6a3f64e9cb70d43e24575df997ee7bff31b09c35dfb359ed93bb5c', 'Nene base prompt must remain byte-for-byte stable');
  assert(crypto.createHash('sha256').update(chatRoute.chatCharacterPrompt('natsume')).digest('hex') === 'd404be246def4b4b03df275eaa3882a6a9ce091ff1309a130811f35414fc3275', 'Natsume base prompt must remain byte-for-byte stable');
  var profiledPrompt = chatRoute.chatCharacterPrompt('nene', { userProfile:{ callName:'小林', relationship:'confidant', note:'夜间工作，希望先听我说完。' } });
  assert(profiledPrompt.includes('【用户档案（用户自述') && profiledPrompt.includes('• 希望称呼：小林') && profiledPrompt.includes('• 关系定位：知己'), 'profile facts must be layered into the prompt');
  assert(profiledPrompt.indexOf('【用户档案') < profiledPrompt.indexOf('【对话判断与表达控制】'), 'untrusted profile facts must precede final behavior rules');
  var profiledValidation = chatRoute.validateChatBody({
    character:'natsume',
    userProfile:{ callName:'阿澈', relationship:'lover', note:'喜欢苦咖啡。' },
    messages:[{ role:'user', content:'你好' }]
  });
  assert(profiledValidation.value.messages[0].content.includes('• 希望称呼：阿澈'), 'validated user profile must reach the system prompt');
  assert(chatRoute.validateChatBody({ character:'nene', userProfile:{ relationship:'invalid' }, messages:[{ role:'user', content:'x' }] }).error, 'unknown relationship must fail closed');
  assert(chatRoute.validateChatBody({ character:'nene', userProfile:{ callName:'x'.repeat(41) }, messages:[{ role:'user', content:'x' }] }).error, 'overlong profile fields must be rejected');
  var memoryValidation = chatRoute.validateChatBody({
    character:'nene', memories:['用户每周五晚上会玩 MMORPG。'], messages:[{ role:'user', content:'周五做什么？' }]
  });
  assert(memoryValidation.value.messages[0].content.includes('【长期记忆（用户确认过的本机事实') && memoryValidation.value.messages[0].content.includes('用户每周五晚上会玩 MMORPG。'), 'validated memory facts must reach the system prompt');
  assert(chatRoute.validateChatBody({ character:'nene', memories:['1','2','3','4','5'], messages:[{ role:'user', content:'x' }] }).error, 'memory injection count must be bounded');

  var live2dService = (require('../../services/live2d-service') as typeof import('../../services/live2d-service')).createLive2dService({
    rootDir:path.join(root, 'assets', 'live2d'),
    characters:['nene', 'natsume']
  });
  var liveStatus = live2dService.status();
  assert(liveStatus.models.nene.available, 'Nene Live2D model and all references must exist');
  var neneManifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'live2d', 'nene', 'nene.model3.json'), 'utf8'));
  ['Hair', 'Head', 'Face', 'LeftChest', 'RightChest', 'Skirt', 'Body'].forEach(function (name) {
    assert(neneManifest.HitAreas.some(function (area: any) { return area.Name === name; }), 'Nene model must expose source hit area ' + name);
  });
  ['TapHair', 'TapHead', 'TapFace', 'TapLeftChest', 'TapRightChest', 'TapSkirt', 'TapBody'].forEach(function (group) {
    var motions = neneManifest.FileReferences.Motions[group];
    assert(Array.isArray(motions) && motions.length === 1, 'Nene model must expose source motion group ' + group);
    assert(!motions[0].Sound, group + ' must not conflict with AI voice playback');
  });
  assert(liveStatus.models.natsume.available, 'Natsume Live2D model and all references must exist');

  var mock: any = createMockAiServer();
  var mockBase = await listen(mock.server);
  try {
    var ollama = (require('../../services/ollama-service') as typeof import('../../services/ollama-service')).createOllamaService({
      host:mockBase,
      model:'model-a',
      keepAlive:'1m'
    });
    var outputs: any = [];
    function runChat(model: any) {
      return ollama.streamChat({
        model:model,
        messages:[{ role:'user', content:'test' }]
      }, {
        onToken:function (content) { outputs.push(content); }
      });
    }
    await Promise.all([runChat('model-a'), runChat('model-b')]);
    assert(mock.state.maxActiveChat === 1, 'Ollama streams must be serialized');
    assert(mock.state.unloaded.includes('model-a'), 'switching models must unload the previous model');
    assert(outputs.join('') === '你好。你好。', 'split NDJSON chunks must be reconstructed');

    var compatibleOutput: any = [];
    var localApi = chatRoute.validateCompatibleApi({
      baseUrl:mockBase + '/v1',
      model:'compatible-model',
      apiKey:'local-secret'
    });
    assert(localApi.value, 'loopback compatible APIs may use HTTP');
    var compatibleStatus = await chatRoute.inspectCompatibleApi(localApi.value);
    assert(
      compatibleStatus.online && compatibleStatus.models.includes('compatible-model-fast'),
      'compatible API diagnostics must authenticate and discover models'
    );
    await chatRoute.streamCompatibleApi({
      api:localApi.value,
      messages:[{ role:'system', content:'persona' }, { role:'user', content:'hello' }]
    }, {
      onToken:function (content: any) { compatibleOutput.push(content); }
    });
    assert(compatibleOutput.join('') === '你好', 'compatible API SSE must preserve Chinese characters split across UTF-8 chunks');
    assert(!compatibleOutput.join('').includes('\uFFFD'), 'compatible API output must not contain replacement characters');
    assert(mock.state.compatibleAuth === 'Bearer local-secret', 'compatible API key must be sent as a bearer token');
    assert(mock.state.compatiblePayloads[0].messages[0].content === 'persona', 'compatible APIs must receive the character system prompt');

    // ---- 桌宠本地工具（companionTools）：tools 注入 + tool_calls 增量事件 ----
    var toolCalls: any = [];
    var toolTokens: any = [];
    var toolApi = chatRoute.validateCompatibleApi({
      baseUrl:mockBase + '/v1',
      model:'tool-call-model',
      apiKey:'local-secret'
    });
    await chatRoute.streamCompatibleApi({
      api:toolApi.value,
      messages:[{ role:'system', content:'persona' }, { role:'user', content:'看看工作区' }],
      companionTools:true
    }, {
      onToken:function (content: any) { toolTokens.push(content); },
      onToolCall:function (call: any) { toolCalls.push(call); }
    });
    var toolPayload: any = mock.state.compatiblePayloads[mock.state.compatiblePayloads.length - 1];
    assert(
      Array.isArray(toolPayload.tools) && toolPayload.tools.some(function (t: any) {
        return t.type === 'function' && t.function && t.function.name === 'list_files';
      }),
      'companionTools must inject the local tool schemas into the upstream request'
    );
    assert(!toolPayload.tools.some(function (t: any) {
      return t.function && !['list_files', 'read_file', 'write_file', 'run_command', 'read_image', 'get_workspace_info', 'capture_screen', 'generate_character_image'].includes(t.function.name);
    }), 'only the whitelisted companion tools may be advertised');
    assert(toolCalls.length === 1, 'split tool_calls deltas must accumulate into one event');
    assert(toolCalls[0].id === 'call_1', 'tool-call event must carry the call id');
    assert(toolCalls[0].name === 'list_files', 'tool-call event must carry the tool name');
    assert(toolCalls[0].arguments === '{"path":""}.', 'tool-call arguments must be concatenated across chunks');
    assert(toolCalls[0].reasoning === '我得先看看', 'tool-call events must carry the round reasoning for V4 round-trip');
    assert(toolTokens.join('') === '让我看看工作区里有什么。', 'text tokens must still stream alongside tool calls');

    // ---- 思考模式（thinking）：reasoning_content 增量事件 + 参数注入 ----
    var reasoningChunks: any = [];
    var thinkingTokens: any = [];
    var thinkingApi = chatRoute.validateCompatibleApi({
      baseUrl:mockBase + '/v1',
      model:'thinking-model',
      apiKey:'local-secret'
    });
    await chatRoute.streamCompatibleApi({
      api:thinkingApi.value,
      messages:[{ role:'system', content:'persona' }, { role:'user', content:'想一下' }],
      reasoning:'high'
    }, {
      onReasoning:function (content: any) { reasoningChunks.push(content); },
      onToken:function (content: any) { thinkingTokens.push(content); }
    });
    assert(reasoningChunks.join('') === '让我想想再想想', 'reasoning_content deltas must stream as reasoning events');
    assert(thinkingTokens.join('') === '答案是 42', 'final content must still stream after reasoning');
    assert(
      chatRouteSource.includes("input.reasoning === 'low' ? { reasoning_effort:'high' } : { reasoning_effort:'max' }"),
      'deepseek V4 must map low→high effort and medium/high→max effort with thinking enabled/disabled'
    );
    assert(
      chatRouteSource.includes('reasoning_effort:input.reasoning'),
      'opencode endpoints must receive the OpenAI reasoning_effort parameter'
    );
    var badReasoning = chatRoute.validateChatBody({
      character:'nene',
      provider:'api',
      api:{ baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', apiKey:'k' },
      reasoning:'turbo',
      messages:[{ role:'user', content:'hi' }]
    });
    assert(badReasoning.error, 'unknown reasoning levels must be rejected');

    // validateChatBody：tool 消息接受、未知工具拒绝、reasoning_content 回传
    var toolRound = chatRoute.validateChatBody({
      character:'nene',
      provider:'api',
      api:{ baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', apiKey:'k' },
      companionTools:true,
      messages:[
        { role:'user', content:'看看' },
        { role:'assistant', content:'', reasoning_content:'我先想想', tool_calls:[{ id:'call_9', type:'function', function:{ name:'read_file', arguments:'{"path":"a.txt"}' } }] },
        { role:'tool', tool_call_id:'call_9', content:'文件内容' }
      ]
    });
    assert(toolRound.value, 'tool messages must be accepted when companionTools is enabled');
    var toolMessages = toolRound.value.messages.filter(function (m: any) { return m.role === 'tool' || Array.isArray(m.tool_calls); });
    assert(toolMessages.length === 2, 'tool messages must survive validation untouched');
    var toolCallMsg: any = toolRound.value.messages.find(function (m: any) { return Array.isArray(m.tool_calls); });
    assert(
      toolCallMsg && toolCallMsg.reasoning_content === '我先想想',
      'V4 reasoning_content must round-trip through validation alongside tool_calls'
    );
    var badTool = chatRoute.validateChatBody({
      character:'nene',
      provider:'api',
      api:{ baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', apiKey:'k' },
      messages:[
        { role:'user', content:'看看' },
        { role:'assistant', content:'', tool_calls:[{ id:'call_1', type:'function', function:{ name:'evil_tool', arguments:'{}' } }] }
      ]
    });
    assert(badTool.error, 'unknown tool names must be rejected by validation');

    // validateChatBody：多模态 user 消息（read_image 结果）接受，非法图片 URL 拒绝
    var multimodal = chatRoute.validateChatBody({
      character:'nene',
      provider:'api',
      api:{ baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', apiKey:'k' },
      messages:[
        { role:'user', content:'看看' },
        { role:'assistant', content:'', tool_calls:[{ id:'call_9', type:'function', function:{ name:'read_image', arguments:'{"path":"pic.png"}' } }] },
        { role:'tool', tool_call_id:'call_9', content:'已读取图片' },
        { role:'user', content:[
          { type:'text', text:'（这是 read_image 返回的图片）' },
          { type:'image_url', image_url:{ url:'data:image/png;base64,iVBORw0KGgo=' } }
        ] }
      ]
    });
    assert(multimodal.value, 'multimodal user messages from read_image must be accepted');
    var multimodalParts: any = multimodal.value.messages.filter(function (m: any) { return Array.isArray(m.content); });
    assert(multimodalParts.length === 1, 'multimodal content arrays must survive validation');
    assert(
      multimodalParts[0].content.some(function (p: any) { return p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'); }),
      'image_url parts must be preserved'
    );
    var badImage = chatRoute.validateChatBody({
      character:'nene',
      provider:'api',
      api:{ baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', apiKey:'k' },
      messages:[
        { role:'user', content:[{ type:'image_url', image_url:{ url:'http://evil.example.com/steal.png' } }] }
      ]
    });
    assert(badImage.error, 'remote image URLs must be rejected');
    assert(/data URL/.test(badImage.error), 'rejection message must explain the data URL rule');

    var abortController = new AbortController();
    var resolveStarted: any;
    var started = new Promise(function (resolve) { resolveStarted = resolve; });
    var cancelled = ollama.streamChat({
      model:'model-b',
      messages:[{ role:'user', content:'cancel' }],
      signal:abortController.signal
    }, {
      onStart:function () { resolveStarted(); }
    }).then(function () {
      return null;
    }, function (error) {
      return error;
    });
    await started;
    abortController.abort();
    var cancelError = await cancelled;
    assert(cancelError && cancelError.name === 'AbortError', 'aborting a chat must cancel the upstream stream');
    assert(ollama.queueStatus().active === 0, 'cancelled chat must release the Ollama queue');

    var tts = (require('../../services/tts-service') as typeof import('../../services/tts-service')).createTtsService({
      host:mockBase,
      profiles:{
        nene:{
          refAudioPath:'nene.wav', promptText:'ref', sovitsWeightsPath:'nene.pth', gptWeightsPath:'nene.ckpt',
          references:{ gentle:{ refAudioPath:'nene-gentle.wav', promptText:'gentle ref' }, shy:{ refAudioPath:'nene-shy.wav', promptText:'shy ref' } }
        },
        natsume:{ refAudioPath:'natsume.wav', promptText:'ref', sovitsWeightsPath:'natsume.pth', gptWeightsPath:'natsume.ckpt' }
      }
    });
    await tts.prepare('nene');
    assert((await tts.status()).activeVoice === 'nene', 'voice preparation must activate the requested character before synthesis');
    await Promise.all([
      consumeVoice(tts, { voice:'nene', text:'a', language:'ja', emotion:'neutral', speed:1 }),
      consumeVoice(tts, { voice:'natsume', text:'b', language:'ja', emotion:'neutral', speed:1 })
    ]);
    assert(mock.state.maxActiveVoice === 1, 'GPT-SoVITS streams must remain serialized until audio ends');
    await consumeVoice(tts, { voice:'nene', text:'綾地寧々です。', language:'ja', emotion:'shy', referenceEmotion:'gentle', consistency:'locked', speed:1 });
    var lockedPayload: any = mock.state.voicePayloads[mock.state.voicePayloads.length - 1];
    assert(lockedPayload.ref_audio_path === 'nene-gentle.wav', 'locked voice must keep the turn reference even when the sentence emotion changes');
    assert(lockedPayload.text.includes('あやち ねね') && lockedPayload.text_split_method === 'cut5', 'Japanese speech must normalize character names and preserve the complete sentence');
    assert(lockedPayload.seed === 1234 && lockedPayload.top_k === 15 && lockedPayload.streaming_mode === false, 'short sentence synthesis must use deterministic identity settings instead of ineffective audio streaming');
    var ttsModule: typeof import('../../services/tts-service') = require('../../services/tts-service');
    assert(ttsModule.normalizeSpeechText('  四季夏目\nありがとう。 ', 'ja') === 'しき なつめ。ありがとう。', 'speech normalization must keep every sentence and stabilize character-name pronunciation');
    assert(ttsModule.normalizeSpeechText('\u30fb\u30c6\u30b9\u30c8', 'ja') === '\u30c6\u30b9\u30c8', 'speech normalization must remove the Windows-incompatible Japanese middle dot');
  } finally {
    await close(mock.server);
  }

  var providerMock = createMockAiServer();
  var providerBase = await listen(providerMock.server);
  var gatewayStack = await gatewayTestStack.start({ token:'test-token' });
  var gatewayBase = gatewayStack.baseUrl;
  try {
    var healthResponse = await fetch(gatewayBase + '/api/health');
    var health = await healthResponse.json();
    assert(health.ok && health.capabilities.chat && health.capabilities.tts, 'gateway health must expose conversation capabilities');

    // SPA 路由由 index.html 承载；同时确认 /chat 的 CSP 放行了 Live2D 所需的 unsafe-eval
    var chatResponse = await fetch(gatewayBase + '/chat');
    assert(chatResponse.ok, 'chat route must be served by the SPA fallback');
    var chatCsp = chatResponse.headers.get('content-security-policy') || '';
    assert(chatCsp.includes("'unsafe-eval'"), 'chat route CSP must allow the Live2D renderer');
    var companionResponse = await fetch(gatewayBase + '/companion');
    assert(companionResponse.ok, 'companion route must be served by the SPA fallback');
    var companionCsp = companionResponse.headers.get('content-security-policy') || '';
    assert(companionCsp.includes("'unsafe-eval'"), 'companion route CSP must allow the Live2D renderer');
    var homeResponse = await fetch(gatewayBase + '/');
    assert(homeResponse.ok, 'home route must be served');
    var homeCsp = homeResponse.headers.get('content-security-policy') || '';
    assert(!homeCsp.includes("'unsafe-eval'"), 'unsafe-eval must stay scoped to the chat route');

    // 设计系统只剩 src/assets/css 一份（css/ 下的分叉副本已删除）
    var cssResponse = await fetch(gatewayBase + '/src/assets/css/design-system.css', {
      headers:{ 'Accept-Encoding':'gzip' }
    });
    assert((cssResponse.headers.get('cache-control') || '').includes('max-age=86400'), 'versioned CSS and JS should use a one-day browser cache');
    assert(cssResponse.headers.get('content-encoding') === 'gzip', 'text assets larger than 1 KB should be compressed');
    var lightCssResponse = await fetch(gatewayBase + '/src/assets/css/light-theme.css');
    assert(lightCssResponse.ok && (await lightCssResponse.text()).includes(':root[data-theme="light"]'), 'documentation must receive the shared light theme');
    assert((await fetch(gatewayBase + '/src/assets/css/home.css')).status === 404, 'documentation styles must not expose unrelated source files');

    var dataResponse = await fetch(gatewayBase + '/data/scenes.json');
    assert((dataResponse.headers.get('cache-control') || '').includes('immutable'), 'data files are cached immutable; freshness is versioned by ?v=DATA_VERSION and enforced by validate-content-contracts');

    var assetResponse = await fetch(gatewayBase + '/assets/logo.svg');
    assert((assetResponse.headers.get('cache-control') || '').includes('no-cache'), 'runtime image assets should use no-cache ETag revalidation');

    var badChat = await fetch(gatewayBase + '/api/chat', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ character:'bad', messages:[] })
    });
    assert(badChat.status === 400, 'chat route must reject invalid input without contacting Ollama');

    // 超长对话（>12000 字 / >24 条）必须从旧到新平滑裁剪并照常转发，不能 400 打断
    var longMessages = [];
    for (var li = 0; li < 30; li += 1) {
      longMessages.push({ role: li % 2 ? 'assistant' : 'user', content: '长对话填充。'.repeat(120) });
    }
    longMessages.push({ role:'user', content:'最近的这条消息一定要被保留' });
    var trimmedChat = await postJson(gatewayBase + '/api/chat', {
      character:'nene', provider:'api',
      api:{ baseUrl:providerBase + '/v1', model:'json-model', apiKey:'local-secret' },
      messages:longMessages
    });
    var trimmedEvents = readNdjson(trimmedChat.body);
    assert(
      trimmedChat.status === 200 && trimmedEvents.some(function (event: any) {
        return event.type === 'token';
      }),
      'an over-budget conversation must be trimmed and forwarded, not rejected',
    );

    var emptyModels = await postJson(gatewayBase + '/api/chat-provider/test', {
      baseUrl:providerBase + '/v1', model:'compatible-model', apiKey:'empty-list-key'
    });
    assert(
      emptyModels.status === 200 && emptyModels.json && emptyModels.json.ok
        && emptyModels.json.modelCount === 0 && emptyModels.json.models.length === 0,
      'compatible provider test must report an empty model list without treating the API as offline',
    );

    var rejectedCredentials = await postJson(gatewayBase + '/api/chat-provider/test', {
      baseUrl:providerBase + '/v1', model:'compatible-model', apiKey:'rejected-key'
    });
    assert(
      rejectedCredentials.status === 401 && rejectedCredentials.json && !rejectedCredentials.json.ok
        && rejectedCredentials.json.error.includes('401') && !rejectedCredentials.body.includes('rejected-key'),
      'compatible provider authentication failures must keep the 401 status and never leak the API key',
    );

    var jsonCompletion = await postJson(gatewayBase + '/api/chat', {
      character:'nene', provider:'api',
      api:{ baseUrl:providerBase + '/v1', model:'json-model', apiKey:'local-secret' },
      messages:[{ role:'user', content:'hello' }]
    });
    var jsonEvents = readNdjson(jsonCompletion.body);
    assert(
      jsonCompletion.status === 200 && jsonEvents.some(function (event: any) {
        return event.type === 'token' && event.content === 'non-stream reply';
      }) && jsonEvents.some(function (event: any) { return event.type === 'done'; }),
      'compatible chat must convert a non-stream OpenAI response into gateway NDJSON events',
    );

    var malformedSse = await postJson(gatewayBase + '/api/chat', {
      character:'nene', provider:'api',
      api:{ baseUrl:providerBase + '/v1', model:'malformed-sse-model', apiKey:'local-secret' },
      messages:[{ role:'user', content:'hello' }]
    });
    var malformedEvents = readNdjson(malformedSse.body);
    assert(
      malformedSse.status === 200 && malformedEvents.some(function (event: any) { return event.type === 'error'; })
        && !malformedEvents.some(function (event: any) { return event.type === 'done'; }),
      'a malformed compatible SSE stream must end with a gateway error event rather than false success',
    );

    // ── 站主 API 配置托管：访客只使用、看不到密钥 ──
    var hostBefore = await fetch(gatewayBase + '/api/chat-provider/host-config');
    var hostBeforeJson = await hostBefore.json();
    assert(hostBefore.status === 200 && hostBeforeJson.configured === false, 'host config must start unconfigured');

    var hostSave = await postJson(gatewayBase + '/api/chat-provider/host-config', {
      baseUrl:providerBase + '/v1', model:'json-model', apiKey:'host-secret-key'
    });
    var hostSaveJson = hostSave.json;
    assert(
      hostSave.status === 200 && hostSaveJson.configured === true && !hostSave.body.includes('host-secret-key'),
      'saving host config must succeed locally and never echo the API key',
    );

    var hostAfter = await fetch(gatewayBase + '/api/chat-provider/host-config');
    var hostAfterBody = await hostAfter.text();
    assert(
      hostAfter.status === 200 && hostAfterBody.includes('json-model') && !hostAfterBody.includes('host-secret-key'),
      'reading host config must expose model but never the API key',
    );

    // 公网视角（非本机 Host）写入必须被拒绝
    var remoteWrite = await postJsonWithHost(gatewayBase + '/api/chat-provider/host-config', {
      baseUrl:providerBase + '/v1', model:'evil', apiKey:'evil-key'
    }, 'evil.example.com');
    assert(remoteWrite.status === 421 || remoteWrite.status === 403, 'remote host must not be able to write host config');

    // 访客聊天：hostConfig 标记 → 上游必须收到站主密钥
    var hostChat = await postJsonWithHost(gatewayBase + '/api/chat', {
      character:'nene', provider:'api', hostConfig:true,
      messages:[{ role:'user', content:'hello' }]
    });
    var hostEvents = readNdjson(hostChat.body);
    assert(
      hostChat.status === 200 && hostEvents.some(function (event: any) { return event.type === 'token'; })
        && providerMock.state.compatibleAuth === 'Bearer host-secret-key',
      'hostConfig chat must stream via the stored host key without the visitor supplying one',
    );

    var privateCallsBefore = providerMock.state.compatiblePayloads.length;
    var privateChat = await postJsonWithHost(gatewayBase + '/api/chat', {
      character:'nene', provider:'api',
      api:{ baseUrl:providerBase + '/v1', model:'json-model' },
      messages:[{ role:'user', content:'private service must not be contacted' }]
    });
    assert(privateChat.status === 403, 'remote custom loopback API must be forbidden');
    assert(providerMock.state.compatiblePayloads.length === privateCallsBefore,
      'forbidden remote target must receive no request');

    var hostClear = await fetch(gatewayBase + '/api/chat-provider/host-config', { method:'DELETE' });
    var hostClearJson = await hostClear.json();
    assert(hostClear.status === 200 && hostClearJson.configured === false, 'clearing host config must reset to unconfigured');
  } finally {
    await gatewayStack.close();
    await close(providerMock.server);
  }

  console.log('Chat tests passed: modular gateway, compatible API contracts, serialized AI queues, cancellable streaming voice, Live2D recovery and fallback');
}

await run();
});

test('remote API target policy rejects private DNS, mapped IPs and mixed answers', async () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const { isPublicAddress, resolvePublicAddress }: typeof import('../../services/public-upstream') = require('../../services/public-upstream');
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1',
    'fc00::1', 'fe80::1', '2002:7f00:1::', '64:ff9b::7f00:1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true);
  for (const address of ['https://127.1', 'https://2130706433', 'https://[::ffff:127.0.0.1]', 'http://8.8.8.8']) {
    await assert.rejects(resolvePublicAddress(new URL(address)), { status:403 });
  }
  const target = new URL('https://custom.example/v1');
  for (const addresses of [[], [{ address:'127.0.0.1', family:4 }],
    [{ address:'8.8.8.8', family:4 }, { address:'10.0.0.1', family:4 }]]) {
    await assert.rejects(resolvePublicAddress(target, async () => addresses), { status:403 });
  }
  assert.deepEqual(await resolvePublicAddress(target, async () => [{ address:'8.8.8.8', family:4 }]),
    { address:'8.8.8.8', family:4 });
});

test('public API requests pin DNS, bypass proxy DNS and do not follow redirects', async (t) => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const dns: typeof import('node:dns/promises') = require('node:dns/promises');
  const https: typeof import('node:https') = require('node:https');
  const { PassThrough }: typeof import('node:stream') = require('node:stream');
  const { EventEmitter }: typeof import('node:events') = require('node:events');
  const client: typeof import('../../services/http-client') = require('../../services/http-client');
  let resolutions = 0;
  let requests = 0;
  t.mock.method(dns, 'lookup', async () => {
    resolutions += 1;
    return [{ address:resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family:4 }];
  });
  t.mock.method(https, 'request', (target: any, options: any, onResponse: any) => {
    requests += 1;
    assert.equal(target.hostname, 'custom.example');
    assert.equal(options.agent, false);
    options.lookup(target.hostname, { all:true }, (error: any, addresses: any) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address:'8.8.8.8', family:4 }]);
    });
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 302;
      response.headers = { location:'http://127.0.0.1/private' };
      onResponse(response);
      response.end();
    };
    return request;
  });
  const oldProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  t.after(() => { if (oldProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = oldProxy; });
  const result = await client.request('https://custom.example', '/v1/chat/completions', { publicOnly:true });
  assert.equal(result.response.statusCode, 302);
  assert.equal(resolutions, 1);
  assert.equal(requests, 1);
  await assert.rejects(client.request('https://custom.example', '/v1/chat/completions', { publicOnly:true }), { status:403 });
  assert.equal(requests, 1, 'rebinding to private DNS must not start another request');
});
