'use strict'

const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const { test }: typeof import('node:test') = require('node:test')

const root = path.resolve(__dirname, '..', '..')

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('native fit and hit testing share a load-time anchor instead of animated drawable bounds', () => {
  const source = read('desktop-tauri/src-tauri/src/live2d_overlay.rs')
  assert.match(source, /self\.fit_bounds = Some\(m\.content_bounds\(\)\)/)
  const frame = source.slice(source.indexOf('fn render_frame('), source.indexOf('fn hit_test('))
  const hit = source.slice(source.indexOf('fn hit_test('), source.indexOf('fn hit_area_ids('))
  assert.match(frame, /self\.fit_bounds/)
  assert.match(hit, /self\.fit_bounds/)
  assert.doesNotMatch(frame, /\.content_bounds\(\)/)
  assert.doesNotMatch(hit, /\.content_bounds\(\)/)
})

test('Native Companion owns the overlay and Atelier stays browser-only', () => {
  const companion = read('src/views/CompanionView.vue')
  const shim = read('desktop-tauri/src-tauri/src/shim.rs')
  const main = read('desktop-tauri/src-tauri/src/main.rs')

  assert.match(companion, /:backend="desktopBridge \? 'native' : 'browser'"/)
  assert.ok(shim.includes("location.pathname.replace(/\\/+$/, '')"))
  assert.match(shim, /if \(enableNativeLive2D\) window\.aicsLive2dNative/)
  assert.match(shim, /const waitForTauri = \(\) => new Promise/)
  assert.match(shim, /TAURI_API_UNAVAILABLE/)
  assert.match(shim, /entry\.cancelled/)
  assert.match(shim, /return id/)
  assert.match(shim, /onStopped: \(cb\) => on\('aics:live2d:stopped', cb\)/)
  assert.match(main, /arg == "--hidden"/)
  assert.match(main, /create_companion_window\(&handle, &url, shim, show_on_start\)/)
})

test('Native IPC payload and render ownership contracts stay aligned', () => {
  const overlay = read('desktop-tauri/src-tauri/src/live2d_overlay.rs')
  const adapter = read('desktop-tauri/src-tauri/src/live2d_adapter.rs')
  const renderer = read('desktop-tauri/native-live2d/src/renderer.rs')
  const model = read('desktop-tauri/native-live2d/src/model.rs')
  const mainShared = read('desktop-tauri/src-tauri/src/main_shared.rs')
  const bridge = read('desktop-tauri/src-tauri/src/bridge.rs')
  const main = read('desktop-tauri/src-tauri/src/main.rs')

  assert.match(overlay, /app\.emit\("aics:live2d:hit-test", areas\)/)
  assert.doesNotMatch(overlay, /index\.unwrap_or\(0\)/)
  assert.match(overlay, /adapter: Live2DAdapterConfig/)
  assert.match(overlay, /adapter\.validate\(\)/)
  assert.match(adapter, /pub fn mouth_value\(&self, level: f32\)/)
  assert.match(adapter, /level\.clamp\(0\.0, 1\.0\) \* mouth\.scale/)
  assert.match(adapter, /pub fn apply_emotion\(&self, model: &mut Model/)
  assert.doesNotMatch(overlay, /fn mouth_param_for\(|fn emotion_params\(/,
    'native parameter mappings must come from the validated adapter profile')
  assert.match(overlay, /ctx\.advance_motion\(dt, app\.as_ref\(\)\)/)
  // 渲染线程退出必须广播 stopped（带 reason），前端才知 overlay 不可用并可重试。
  assert.match(overlay, /"aics:live2d:stopped"/)
  assert.match(overlay, /fn emit_stopped\(app: Option<&AppHandle>, reason: &str\)/)
  assert.match(overlay, /stopped_reason = Some\(format!\("render frame failed: \{e\}"\)\)/)
  assert.match(overlay, /emit_stopped\(app\.as_ref\(\), &reason\)/)
  // overlay 位于透明 Companion WebView 下方，禁止用 SetWindowRgn 给控件挖洞：
  // Win32 region 同时裁剪 DComp 画面，会在角色身上留下矩形缺口。
  assert.doesNotMatch(overlay, /SetWindowRgn/)
  assert.match(overlay, /WS_EX_TRANSPARENT/)
  assert.match(overlay, /get_webview_window\("companion"\)/)
  assert.match(overlay, /last_z_order_sync\.elapsed\(\) >= Duration::from_millis\(250\)/)
  assert.match(overlay, /GetWindowRect\(companion, &mut companion_rect\)/)
  assert.match(overlay, /followed_overlay_rect/)
  assert.match(overlay, /SWP_NOACTIVATE \| SWP_NOSIZE/)
  assert.doesNotMatch(overlay, /OverlayCommand::HitTest \{ x, y, reply \}[\s\S]{0,300}?app\.emit\("aics:live2d:hit-test"/)
  assert.ok(overlay.indexOf('ShowWindow(hwnd, SW_SHOWNA);', overlay.indexOf('if visible {'))
    < overlay.indexOf('SetWindowPos(', overlay.indexOf('if visible {')),
  '首次显示必须发生在 z-order 定位前，避免 ShowWindow 把 overlay 提到 WebView 上方')
  // set_character 必须真异步：模型加载在渲染线程，主线程不得 block_on。
  assert.match(overlay, /pub async fn aics_live2d_set_character/)
  assert.match(overlay, /rx\s*\.await\s*\.map_err/)
  assert.doesNotMatch(overlay, /aics_live2d_set_character[\s\S]{0,400}?pollster::block_on/)
  // 同一互动播放中重复点击必须拒绝（返回"动作进行中"），不能 force 重启。
  assert.match(overlay, /motion already playing/)
  assert.match(overlay, /would_reject_interaction/)
  assert.match(overlay, /SetMaxFps\(u32\)/)
  assert.match(overlay, /target_fps\.load/)
  assert.match(overlay, /model_bounds/)
  const stateCommand = overlay.match(/pub fn aics_live2d_get_state[\s\S]*?\n}\n\n#\[tauri::command\]/)?.[0] || ''
  assert.match(stateCommand, /try_state::<Arc<Live2DOverlayState>>/)
  assert.doesNotMatch(stateCommand, /ensure_overlay/)
  for (const field of ['active', 'rect', 'visible', 'frameCount', 'targetFps', 'character', 'ready', 'windowReady', 'rendererAttached', 'modelBounds', 'mouthLevel', 'mouthMappedValue']) {
    assert.ok(stateCommand.includes(`"${field}"`), `Native diagnostic state must expose ${field}`)
  }
  assert.ok((overlay.match(/release_model_resources\(\)/g) || []).length >= 2,
    'model load and destroy must release renderer-owned caches')
  assert.match(overlay, /SurfaceError::Outdated \| wgpu::SurfaceError::Lost[\s\S]{0,160}?configure_surface/)
  assert.match(renderer, /prewarm_model_resources\(&drawables/)
  assert.match(renderer, /texture_upload\.buffer = None/)
  assert.match(model, /count <= 0 \|\| pointer\.is_null\(\)/)
  assert.match(mainShared, /aics:visibility/, 'window visibility must be emitted by the shell')
  assert.match(mainShared, /aics:window-bounds/)
  assert.match(main, /format!\("\{\}\/companion", url\.trim_end_matches\('\/'\)\)/)
  // 进程最早期 DPI awareness：必须在任何窗口创建前设置，覆盖 Companion WebView。
  assert.ok(main.indexOf('SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)')
    < main.indexOf('tauri::Builder::default()'),
    'DPI awareness 必须在 Builder 构建（窗口创建）之前设置')
  assert.match(bridge, /on_battery_power\(\)/)
  assert.doesNotMatch(main, /app\.manage\(state\.paths\.clone\(\)\)/)
})

test('Native IPC command inventory stays consistent across build manifest, invoke handler and capabilities', () => {
  const buildRs = read('desktop-tauri/src-tauri/build.rs')
  const main = read('desktop-tauri/src-tauri/src/main.rs')
  const capabilities = read('desktop-tauri/src-tauri/capabilities/companion-live2d.json')

  const commands = [
    'set_character', 'set_frame', 'play_motion', 'set_expression', 'set_mouth_level',
    'set_max_fps', 'set_emotion', 'set_gaze', 'hit_test', 'destroy', 'get_state',
  ]
  // build.rs app_manifest 必须登记全部命令（Tauri 2 capability 依赖 manifest）。
  for (const name of commands) {
    assert.ok(buildRs.includes(`"aics_live2d_${name}"`), `build.rs 缺少 aics_live2d_${name}`)
  }
  // invoke_handler 必须与 manifest 一一对应（遗漏 = 运行时命令不可达）。
  for (const name of commands) {
    const owner = name === 'set_frame' ? 'live2d_framing' : 'live2d_overlay'
    assert.ok(main.includes(`${owner}::aics_live2d_${name}`), `invoke_handler 缺少 aics_live2d_${name}`)
  }
  // capabilities 权限名用连字符（Tauri permission id 规范），与命令一一对应；
  // 只允许 Companion 窗口 + 本机回环来源。
  for (const name of commands) {
    const permission = `allow-aics-live2d-${name.replace(/_/g, '-')}`
    assert.ok(capabilities.includes(permission), `capabilities 缺少 ${permission}`)
  }
  assert.deepStrictEqual(JSON.parse(capabilities).windows, ['companion'])
  const urls = JSON.parse(capabilities).remote.urls
  assert.ok(urls.length === 1 && urls[0].startsWith('http://127.0.0.1:'), 'live2d 命令只允许本机回环来源')
})

test('Native destroy keeps the overlay thread alive for reuse (long-lived contract)', () => {
  const overlay = read('desktop-tauri/src-tauri/src/live2d_overlay.rs')

  // destroy 契约：释放模型与资源，但保留渲染线程/窗口，前端可重新 setCharacter。
  assert.match(overlay, /fn clear_model_state\(state: &Live2DOverlayState\)/)
  assert.match(overlay, /destroy 契约 = 释放模型与资源、隐藏 overlay，但渲染线程与窗口长期/)
  assert.match(overlay, /OverlayCommand::Destroy \{ reply \} => \{[\s\S]{0,900}?clear_model_state\(state\)/)
  // destroy 不得触发 stopped 事件（那是线程退出路径的专属）。
  assert.doesNotMatch(overlay, /OverlayCommand::Destroy \{ reply \} => \{[\s\S]{0,900}?emit_stopped/)
  // SetCharacter 复用同一清理函数：重复加载前先清模型态。
  assert.match(overlay, /OverlayCommand::SetCharacter \{ character, texture_scale, adapter, reply \} => \{\s*clear_model_state\(state\)/)
  // 单元测试锁定契约：清模型态但保留 window_ready/renderer_attached/cmd_tx。
  assert.match(overlay, /fn destroy_clears_model_state_but_keeps_thread_for_reuse\(\)/)
})

test('Native frontend lifecycle forwards reset, bounds, FPS and emotion ticks', () => {
  const live2d = read('src/composables/useLive2D.ts')
  // 2026-08-23 useLive2D 组合式拆分：实现移入 live2d/ 子模块，契约断言跟随新家。
  const emotionClock = read('src/composables/live2d/emotionClock.ts')
  const layoutFit = read('src/composables/live2d/layoutFit.ts')
  const interactions = read('src/composables/live2d/interactions.ts')
  const backend = read('src/live2d/nativeBackend.ts')
  const nativeTypes = read('src/types/live2dNative.ts')

  assert.match(live2d, /session\?\.sendMouthLevel\?\.\(0\)/)
  assert.match(emotionClock, /requestAnimationFrame\(tick\)/)
  assert.match(layoutFit, /const visible = !isStageHidden\(ctx\) && !prefersReducedMotion\(\)/)
  assert.match(layoutFit, /session\.updateOverlay\(overlayRect, visible, framing\(\)\)/)
  assert.match(layoutFit, /windowBounds: \{ x: 0, y: 0, width: bounds\.width, height: bounds\.height \}/)
  assert.match(interactions, /model\?\.hitTest\(/)
  assert.match(layoutFit, /nativeSession && ctx\.nativeOverlayReady && !sizeChanged/)
  assert.match(layoutFit, /function scheduleNativeLayout/)
  assert.match(layoutFit, /if \(isStageHidden\(ctx\)\) return/)
  assert.match(layoutFit, /tick\(\)/)
  assert.match(layoutFit, /session\.setPaused\(!visible\)/)
  assert.match(live2d, /setDesktopWindowBounds/)
  const lifecycle = read('src/composables/live2d/lifecycle.ts')
  assert.match(lifecycle, /destroyed\.value = true; ctx\.enabled\.value = false; destroyRuntime\(\)[\s\S]{0,180}?controllers\.layoutFit\.resetWindowBounds\(\)/)
  const companionView = read('src/views/CompanionView.vue')
  const characterStage = read('src/components/ChatCharacterStage.vue')
  assert.match(companionView, /:desktop-window-bounds="desktopWindowBounds"/)
  assert.match(characterStage, /watch\(\(\) => props\.desktopWindowBounds/)
  // 原生接电目标 165fps，不允许默认 60 或 120 上限覆盖。
  assert.match(live2d, /isNative \? 165 : 120/)
  assert.match(backend, /Math\.min\(165,/)
  // 单一情绪时间推进器：sendEmotion 只能出现在 RAF tick，口型回调不推进。
  assert.equal((emotionClock.match(/sendEmotion/g) || []).length, 1, 'sendEmotion 只允许出现在原生情绪时钟 tick')
  // 加载状态必须在 connect 之前显示。
  assert.ok(lifecycle.indexOf("setState('loading', 'Live2D 加载中…')") < lifecycle.indexOf('await ctx.backend!.connect('), 'loading 必须在 connect 之前设置')
  assert.match(interactions, /onMotionFailed/)
  assert.match(backend, /if \(!destroyed\) callback\(handle\)/)
  assert.match(backend, /bridge\.setMaxFps/)
  assert.match(lifecycle, /原生 Live2D 初始化失败，已回退到浏览器渲染/)
  assert.match(backend, /adapter: options\.adapter/)
  assert.match(nativeTypes, /adapter\?: Live2DRuntimeAdapterConfig/)
  assert.doesNotMatch(nativeTypes, /passthrough/)
  assert.match(nativeTypes, /setMaxFps\(fps: number\)/)
})
