/**
 * Live2D 双后端抽象层测试（test-live2d-backend.js）
 *
 * 覆盖：
 * 1. overlay 布局纯函数（computeOverlayRect / clampToMonitors / normalizeToOverlay）
 * 2. 后端工厂与回退（selectLive2DBackend：native 桥缺失 → browser + fallback 标记）
 * 3. 原生后端会话契约（stub 桥：setCharacter/motion/expression/意图通道/overlay 帧/销毁）
 * 4. 原生桥形状校验（防 Rust 侧实现遗漏命令/事件）
 *
 * 运行：node --test scripts/tests/test-live2d-backend.js
 */
const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');

const {
  computeOverlayRect,
  clampToMonitors,
  normalizeToOverlay,
  overlayPointToScreen,
}: typeof import('../../src/utils/live2dOverlayLayout.ts') = require('../../src/utils/live2dOverlayLayout.ts');
const {
  selectLive2DBackend,
}: typeof import('../../src/live2d/createBackend.ts') = require('../../src/live2d/createBackend.ts');
const {
  createNativeLive2DBackend,
}: typeof import('../../src/live2d/nativeBackend.ts') = require('../../src/live2d/nativeBackend.ts');
const {
  NATIVE_BACKEND_UNAVAILABLE,
}: typeof import('../../src/live2d/types.ts') = require('../../src/live2d/types.ts');
const {
  clampGaze,
  gazeFromClientPoint,
  gazeSettled,
  stepGaze,
}: typeof import('../../src/utils/live2dGaze.ts') = require('../../src/utils/live2dGaze.ts');

// ---------- overlay 布局纯函数 ----------

test('computeOverlayRect：DPR=1 时屏幕坐标 = 窗口原点 + CSS 矩形', () => {
  const rect = computeOverlayRect({
    stageRect: { left: 120, top: 60, width: 300, height: 480 },
    dpr: 1,
    windowBounds: { x: 100, y: 50, width: 1280, height: 800 },
  });
  assert.deepEqual(rect, { x: 220, y: 110, width: 300, height: 480 });
});

test('computeOverlayRect：DPR=1.25 / 2 时按设备像素放大', () => {
  const at125 = computeOverlayRect({
    stageRect: { left: 120, top: 60, width: 300, height: 480 },
    dpr: 1.25,
    windowBounds: { x: 100, y: 50, width: 1280, height: 800 },
  });
  assert.deepEqual(at125, { x: Math.round(100 + 120 * 1.25), y: Math.round(50 + 60 * 1.25), width: 375, height: 600 });

  const at200 = computeOverlayRect({
    stageRect: { left: 0, top: 0, width: 100, height: 100 },
    dpr: 2,
    windowBounds: { x: 0, y: 0, width: 800, height: 600 },
  });
  assert.deepEqual(at200, { x: 0, y: 0, width: 200, height: 200 });
});

test('computeOverlayRect：无 windowBounds 时按 0,0 起点', () => {
  const rect = computeOverlayRect({
    stageRect: { left: 10, top: 20, width: 50, height: 80 },
    dpr: 1,
  });
  assert.deepEqual(rect, { x: 10, y: 20, width: 50, height: 80 });
});

test('clampToMonitors：完全在屏幕内不动', () => {
  const rect = { x: 100, y: 100, width: 300, height: 400 };
  const out = clampToMonitors(rect, [{ x: 0, y: 0, width: 1920, height: 1080 }]);
  assert.deepEqual(out, rect);
});

test('clampToMonitors：超出屏幕右边/下边时收进屏幕', () => {
  const out = clampToMonitors(
    { x: 1800, y: 900, width: 400, height: 300 },
    [{ x: 0, y: 0, width: 1920, height: 1080 }],
  );
  assert.deepEqual(out, { x: 1800, y: 900, width: 120, height: 180 });
});

test('clampToMonitors：双屏时落入任一屏幕即不动', () => {
  const rect = { x: 2000, y: 300, width: 200, height: 300 };
  const out = clampToMonitors(rect, [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1920, height: 1080 },
  ]);
  assert.deepEqual(out, rect);
});

test('clampToMonitors：窗口跨屏时收进主屏', () => {
  const out = clampToMonitors(
    { x: 1900, y: 0, width: 400, height: 300 },
    [{ x: 0, y: 0, width: 1920, height: 1080 }],
  );
  assert.deepEqual(out, { x: 1900, y: 0, width: 20, height: 300 });
});

test('normalizeToOverlay / overlayPointToScreen 互为逆变换', () => {
  const stageRect = { left: 50, top: 30, width: 200, height: 400 };
  const normalized = normalizeToOverlay(150, 230, stageRect);
  assert.deepEqual(normalized, { x: 0.5, y: 0.5 });
  const rect = { x: 100, y: 80, width: 400, height: 800 };
  const screen = overlayPointToScreen(normalized, rect);
  assert.deepEqual(screen, { x: 300, y: 480 });
});

test('normalizeToOverlay：零尺寸舞台返回原点', () => {
  assert.deepEqual(normalizeToOverlay(10, 10, { left: 0, top: 0, width: 0, height: 0 }), { x: 0, y: 0 });
});

// ---------- 后端工厂与回退 ----------

test('selectLive2DBackend：默认/浏览器请求返回 browser，无 fallback', () => {
  const selection = selectLive2DBackend('browser');
  assert.equal(selection.effectiveKind, 'browser');
  assert.equal(selection.backend.kind, 'browser');
  assert.equal(selection.fallbackReason, null);
});

test('selectLive2DBackend：native 无桥 → 回退 browser 并带原因', () => {
  const selection = selectLive2DBackend('native', () => undefined);
  assert.equal(selection.effectiveKind, 'browser');
  assert.equal(selection.backend.kind, 'browser');
  assert.match(selection.fallbackReason!, /回退/);
});

test('selectLive2DBackend：native 有桥 → 原生后端', () => {
  const bridge = createStubBridge();
  const selection = selectLive2DBackend('native', () => bridge);
  assert.equal(selection.effectiveKind, 'native');
  assert.equal(selection.backend.kind, 'native');
  assert.equal(selection.fallbackReason, null);
});

test('原生后端 capability：参数/眨眼/口型/情绪由 Rust 执行，命中与入场原生接管', () => {
  const backend = createNativeLive2DBackend(() => createStubBridge());
  assert.equal(backend.capability.parameterOverride, false);
  assert.equal(backend.capability.blinkOverride, false);
  assert.equal(backend.capability.lipSyncChannel, 'bridge');
  assert.equal(backend.capability.emotionChannel, 'bridge');
  assert.equal(backend.capability.hitTestNative, true);
  assert.equal(backend.capability.entranceNative, true);
});

// ---------- 原生后端会话（stub 桥） ----------

test('原生后端：桥缺失时 connect reject NATIVE_BACKEND_UNAVAILABLE', async () => {
  const backend = createNativeLive2DBackend(() => undefined);
  await assert.rejects(
    backend.connect({ selector: '#host', modelUrl: '/moc.json', canvasWidth: 420, canvasHeight: 610, character: 'nene' }),
    (error) => error instanceof Error && error.message === NATIVE_BACKEND_UNAVAILABLE,
  );
});

test('原生后端：connect 调用 setCharacter，失败传播错误', async () => {
  const bridge = createStubBridge();
  const backend = createNativeLive2DBackend(() => bridge);
  bridge.setCharacter = async () => ({ ok: false, error: '模型不存在' });
  await assert.rejects(
    backend.connect({ selector: '#host', modelUrl: '/missing.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' }),
    /模型不存在/,
  );
});

test('原生后端：会话回传模型句柄，motion/expression 委托桥', async () => {
  const bridge = createStubBridge();
  const backend = createNativeLive2DBackend(() => bridge);
  const session = await backend.connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  assert.equal(session.kind, 'native');

  let loaded: any = null;
  session.onModelLoaded((handle) => { loaded = handle; });
  assert(loaded, 'setCharacter 成功后应立即回传模型句柄');
  await loaded.motion('TapHead', undefined, 3);
  assert.equal(bridge.calls.playMotion[0][0], 'TapHead');
  assert.equal(bridge.calls.playMotion[0][2], 'force', 'FORCE 数值 3 应映射为 force');
  await loaded.motion('TapSkirt', 1, 1);
  assert.equal(bridge.calls.playMotion[1][1], 1);
  assert.equal(bridge.calls.playMotion[1][2], 'idle');

  await loaded.expression('school');
  assert.deepEqual(bridge.calls.setExpression[0], ['school']);
});

test('原生后端：意图通道（口型/情绪/凝视）与 overlay 帧', async () => {
  const bridge: any = createStubBridge();
  const backend = createNativeLive2DBackend(() => bridge);
  const session = await backend.connect({ selector: '#host', modelUrl: '/natsume.moc3', canvasWidth: 420, canvasHeight: 610, character: 'natsume' });

  session.sendMouthLevel!(0.42);
  assert.deepEqual(bridge.calls.setMouthLevel[0], [0.42]);
  session.sendMouthLevel!(1.5);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(bridge.calls.setMouthLevel[1], [1], '口型电平应钳制到 0..1');

  session.sendEmotion!('happy', 0.8);
  assert.deepEqual(bridge.calls.setEmotion[0], ['happy', 0.8]);

  session.sendGaze!(-0.5, 0.25);
  assert.deepEqual(bridge.calls.setGaze[0], [-0.5, 0.25]);

  session.setMaxFps(30);
  assert.deepEqual(bridge.calls.setMaxFps[0], [30]);
  session.setMaxFps(200);
  assert.deepEqual(bridge.calls.setMaxFps[1], [165], '原生接电目标 165fps，不被浏览器 120 上限覆盖');
  session.setMaxFps(10);
  assert.deepEqual(bridge.calls.setMaxFps[2], [24], '下限仍为 24');

  session.updateOverlay!({ x: 100, y: 80, width: 300, height: 480 }, true);
  assert.deepEqual(bridge.calls.setFrame[0][0], {
    rect: { x: 100, y: 80, width: 300, height: 480 },
    visible: true,
    opacity: 1,
  });

  session.setPaused(true);
  assert.equal(bridge.calls.setFrame[1][0].visible, false, '暂停 → overlay 隐藏');
  assert.equal(bridge.calls.setFrame[1][0].rect.width, 300, '暂停保留上次矩形');

  session.setPaused(false);
  assert.equal(bridge.calls.setFrame[2][0].visible, true, '恢复 → overlay 显示');
  session.destroy();
});

test('凝视轨迹：坐标归一化、边界钳制与连续回中', () => {
  assert.deepEqual(gazeFromClientPoint(75, 25, { left: 0, top: 0, width: 100, height: 100 }), { x: 0.5, y: 0.5 });
  assert.deepEqual(gazeFromClientPoint(500, -200, { left: 0, top: 0, width: 100, height: 100 }, 0.82), { x: 0.82, y: 0.82 });
  assert.equal(clampGaze(-2), -1);
  const first = stepGaze({ x: 0, y: 0 }, { x: 1, y: -1 }, 1 / 60, 12);
  assert(first.x > 0 && first.x < 1);
  assert(first.y < 0 && first.y > -1);
  const returning = stepGaze(first, { x: 0, y: 0 }, 1 / 60, 6);
  assert(Math.abs(returning.x) < Math.abs(first.x));
  assert.equal(gazeSettled({ x: 0.001, y: -0.001 }, { x: 0, y: 0 }), true);
});

test('native framing changes update the image without moving the window; identical framing is coalesced', async () => {
  const bridge = createStubBridge() as any;
  bridge.supportsFraming = true;
  const session = await createNativeLive2DBackend(() => bridge).connect({ selector: '#host', modelUrl: '/model', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  const rect = { x: 0, y: 60, width: 480, height: 600 };
  const framing = { zoom: 1.6, x: -0.1, y: 0.08 };
  session.updateOverlay!(rect, true, framing);
  session.updateOverlay!(rect, true, framing);
  assert.equal(bridge.calls.setFrame.length, 1);
  assert.deepEqual(bridge.calls.setFrame[0][0].framing, framing);
  session.updateOverlay!(rect, true, { ...framing, zoom: 1.8 });
  assert.equal(bridge.calls.setFrame.length, 2);
  assert.deepEqual(bridge.calls.setFrame[1][0].rect, rect);
  session.destroy();
});

test('原生后端：高频凝视 latest-wins，桥繁忙时只保留最新目标', async () => {
  const bridge = createStubBridge();
  const releases: { (value: any): void; (): void; new(): any; }[] = [];
  bridge.setGaze = (x: any, y: any) => {
    bridge.calls.setGaze.push([x, y]);
    return new Promise((resolve: any) => releases.push(resolve));
  };
  const backend = createNativeLive2DBackend(() => bridge);
  const session = await backend.connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  session.sendGaze!(0.1, 0.1);
  session.sendGaze!(0.2, 0.2);
  session.sendGaze!(0.7, -0.4);
  assert.deepEqual(bridge.calls.setGaze, [[0.1, 0.1]], '首个请求未完成时不堆积桥调用');
  releases.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bridge.calls.setGaze, [[0.1, 0.1], [0.7, -0.4]], '完成后只发送最新目标');
  releases.shift()!();
});

test('原生后端：原生 HitArea 事件回传（作者分区命中）', async () => {
  const bridge = createStubBridge();
  const backend = createNativeLive2DBackend(() => bridge);
  const session = await backend.connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });

  const hits: any = [];
  const unsubscribe = session.onNativeHitTest!((areas) => hits.push(areas));
  assert(bridge._hitTestListeners.length > 0, '应订阅 onHitTest');
  bridge._hitTestListeners.forEach((listener: any) => listener(['Head', 'Body']));
  assert.deepEqual(hits, [['Head', 'Body']]);

  unsubscribe();
  bridge._hitTestListeners.forEach((listener: any) => listener(['Skirt']));
  assert.equal(hits.length, 1, '退订后不再回传');
});

test('原生后端：onMotionFailed 转发 busy 拒绝（同一互动播放中）', async () => {
  const bridge = createStubBridge();
  const backend = createNativeLive2DBackend(() => bridge);
  const session = await backend.connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });

  const failures: any = [];
  const unsubscribe = session.onMotionFailed!((info) => failures.push(info));
  bridge._motionFailedListeners.forEach((listener: any) => listener({ group: 'TapHead', index: 2, reason: 'motion already playing: TapHead[2]' }));
  assert.deepEqual(failures, [{ group: 'TapHead', index: 2, reason: 'motion already playing: TapHead[2]' }]);

  unsubscribe();
  bridge._motionFailedListeners.forEach((listener: any) => listener({ group: 'TapSkirt', index: 0, reason: 'x' }));
  assert.equal(failures.length, 1, '退订后不再回传');
});

test('原生后端：渲染线程 stopped 转发 onModelError（带 reason，可重试）', async () => {
  const bridge = createStubBridge();
  const backend = createNativeLive2DBackend(() => bridge);
  const session = await backend.connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });

  const errors: any = [];
  session.onModelError((error) => errors.push(error));
  assert(bridge._stoppedListeners.length > 0, '连接期应订阅 onStopped');
  bridge._stoppedListeners.forEach((listener: any) => listener({ reason: 'render frame failed: surface error' }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'NATIVE_RENDER_STOPPED');
  assert.match(errors[0].message, /渲染线程已停止/);
  assert.match(errors[0].message, /surface error/);

  // 销毁后 stopped 事件不再派发
  session.destroy();
  bridge._stoppedListeners.forEach((listener: any) => listener({ reason: 'late' }));
  assert.equal(errors.length, 1, '销毁后不再派发');
});

test('原生后端：销毁时 off 全部订阅并调用 bridge.destroy', async () => {
  const bridge = createStubBridge();
  const backend = createNativeLive2DBackend(() => bridge);
  const session = await backend.connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  assert.equal(bridge._offCalls.length, 0, '连接阶段不应有 off');
  session.destroy();
  assert.equal(bridge._offCalls.length, 4, '未注册 onModelLoaded 时应逐个 off 四个连接期订阅');
  assert.equal(bridge.calls.destroy.length, 1);
  assert.equal(bridge._readyListeners.length, 0, '销毁后事件不再派发');
});

// ---------- 桥形状校验（契约防漂移） ----------

test('Live2DNativeBridge 契约：命令与事件方法齐全', () => {
  const bridge: any = createStubBridge();
  const commands = ['setCharacter', 'setFrame', 'setMaxFps', 'playMotion', 'setExpression', 'setMouthLevel', 'setEmotion', 'setGaze', 'hitTest', 'destroy'];
  const events = ['onReady', 'onMotionStarted', 'onMotionFailed', 'onHitTest', 'onEntranceFinished', 'onStopped', 'off'];
  for (const name of commands) {
    assert.equal(typeof bridge[name], 'function', `缺失命令 ${name}`);
  }
  for (const name of events) {
    assert.equal(typeof bridge[name], 'function', `缺失事件 ${name}`);
  }
  assert.equal(bridge.isNativeLive2D, true);
});

// ---------- stub 桥 ----------

test('原生后端：取消挂起连接立即清理，迟到响应不影响重试会话', async () => {
  const bridge = createStubBridge();
  let release;
  const originalSetCharacter = bridge.setCharacter;
  bridge.setCharacter = () => new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const options = { selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' };
  const backend = createNativeLive2DBackend(() => bridge);
  const pending = backend.connect({ ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(bridge.calls.destroy.length, 1);
  bridge.setCharacter = originalSetCharacter;
  const session = await backend.connect(options);
  release!({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.calls.destroy.length, 1, '迟到结果不能再清理已经加载的新模型');
  assert.equal(bridge._offCalls.length, 0);
  session.destroy();
  assert.equal(bridge.calls.destroy.length, 2);
});

test('原生后端：相同帧率不重复发送，失败后允许下一次重试', async () => {
  const bridge = createStubBridge();
  let reject;
  bridge.setMaxFps = (fps: any) => {
    bridge.calls.setMaxFps.push([fps]);
    return new Promise((_, fail) => { reject = fail; });
  };
  const session = await createNativeLive2DBackend(() => bridge).connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  for (let i = 0; i < 120; i++) session.setMaxFps(60);
  assert.equal(bridge.calls.setMaxFps.length, 1);
  reject!(new Error('IPC unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  session.setMaxFps(60);
  assert.equal(bridge.calls.setMaxFps.length, 2);
  session.destroy();
});

test('原生后端：失败帧可重试，迟到的旧失败不清除新帧缓存', async () => {
  const bridge = createStubBridge();
  const failures: any = [];
  bridge.setFrame = (frame: any) => {
    bridge.calls.setFrame.push([frame]);
    return new Promise((_, reject) => failures.push(reject));
  };
  const session = await createNativeLive2DBackend(() => bridge).connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  const rect = { x: 0, y: 0, width: 300, height: 480 };
  session.updateOverlay!(rect, true);
  failures[0](new Error('first failure'));
  await new Promise(resolve => setImmediate(resolve));
  session.updateOverlay!(rect, true);
  assert.equal(bridge.calls.setFrame.length, 2);
  session.updateOverlay!({ ...rect, x: 10 }, true);
  failures[1](new Error('old failure'));
  await new Promise(resolve => setImmediate(resolve));
  session.updateOverlay!({ ...rect, x: 10 }, true);
  assert.equal(bridge.calls.setFrame.length, 3);
  session.destroy();
});

test('原生后端：销毁幂等，旧句柄和会话不能再发命令', async () => {
  const bridge = createStubBridge();
  const session = await createNativeLive2DBackend(() => bridge).connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  let handle: any;
  session.onModelLoaded(model => { handle = model; });
  session.destroy();
  session.destroy();
  session.setPaused(false);
  session.updateOverlay!({ x: 0, y: 0, width: 300, height: 480 }, true);
  session.setMaxFps(60);
  session.sendMouthLevel!(1);
  session.sendEmotion!('happy', 1);
  session.sendGaze!(0, 0);
  assert.equal(await handle.motion('TapHead'), false);
  assert.equal(await handle.expression('school'), false);
  assert.deepEqual(handle.hitTest(0.5, 0.5), []);
  for (const [name, calls] of Object.entries<any>(bridge.calls)) {
    assert.equal(calls.length, ['setCharacter', 'destroy'].includes(name) ? 1 : 0, name);
  }
});

test('原生后端：点击查询拒绝不会产生未处理异常', async () => {
  const bridge = createStubBridge();
  bridge.hitTest = async () => { throw new Error('closed'); };
  const session = await createNativeLive2DBackend(() => bridge).connect({ selector: '#host', modelUrl: '/nene.moc3', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  let handle: any;
  session.onModelLoaded(model => { handle = model; });
  assert.deepEqual(handle.hitTest(0.5, 0.5), []);
  await new Promise(resolve => setImmediate(resolve));
  session.destroy();
});

test('native texture quality is sent only to bridges that advertise support', async () => {
  for (const supported of [false, true]) {
    const bridge: any = createStubBridge();
    bridge.supportsTextureQuality = supported;
    const session = await createNativeLive2DBackend(() => bridge).connect({ selector: '#host', modelUrl: '/nene.model3.json', canvasWidth: 420, canvasHeight: 610, character: 'nene', textureScale: 4 });
    assert.deepEqual(bridge.calls.setCharacter[0][1], supported ? { character: 'nene', textureScale: 4 } : { character: 'nene' });
    session.destroy();
  }
});

test('native pause clears queued samples, closes the mouth and blocks hidden gaze', async () => {
  const bridge = createStubBridge();
  const session = await createNativeLive2DBackend(() => bridge).connect({ selector: '#host', modelUrl: '/nene.model3.json', canvasWidth: 420, canvasHeight: 610, character: 'nene' });
  session.sendMouthLevel!(0.7);
  session.sendEmotion!('happy', 0.8);
  session.sendGaze!(0.1, 0.2);
  session.setPaused(true);
  session.sendMouthLevel!(1);
  session.sendEmotion!('sad', 1);
  session.sendGaze!(0.9, 0.9);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(bridge.calls.setMouthLevel, [[0.7], [0]]);
  assert.deepEqual(bridge.calls.setEmotion, [['happy', 0.8]]);
  assert.deepEqual(bridge.calls.setGaze, [[0.1, 0.2]]);
  session.setPaused(false);
  session.sendGaze!(-0.2, 0.3);
  assert.deepEqual(bridge.calls.setGaze[1], [-0.2, 0.3]);
  session.destroy();
});

function createStubBridge(): any {
  const calls: Record<string, any[]> = {
    setCharacter: [],
    setFrame: [],
    setMaxFps: [],
    playMotion: [],
    setExpression: [],
    setMouthLevel: [],
    setEmotion: [],
    setGaze: [],
    hitTest: [],
    destroy: [],
  };
  const listeners: Record<string, any[]> = {
    ready: [],
    motionStarted: [],
    motionFailed: [],
    hitTest: [],
    entranceFinished: [],
    stopped: [],
  };
  let nextId = 1;
  const offCalls: any[] = [];
  const bridge: any = {
    isNativeLive2D: true,
    calls,
    _readyListeners: listeners.ready,
    _hitTestListeners: listeners.hitTest,
    _motionFailedListeners: listeners.motionFailed,
    _stoppedListeners: listeners.stopped,
    _offCalls: offCalls,

    async setCharacter(modelPath: any, options: any) { calls.setCharacter.push([modelPath, options]); return { ok: true }; },
    setFrame(frame: any) { calls.setFrame.push([frame]); },
    setMaxFps(fps: any) { calls.setMaxFps.push([fps]); },
    async playMotion(group: any, index: any, priority: any) { calls.playMotion.push([group, index, priority]); return { ok: true }; },
    async setExpression(name: any) { calls.setExpression.push([name]); return { ok: true }; },
    setMouthLevel(level: any) { calls.setMouthLevel.push([level]); },
    setEmotion(name: any, intensity: any) { calls.setEmotion.push([name, intensity]); },
    setGaze(x: any, y: any) { calls.setGaze.push([x, y]); },
    async hitTest(x: any, y: any) { calls.hitTest.push([x, y]); return { areas: [] }; },
    async destroy() { calls.destroy.push([]); },

    onReady(listener: any) { listeners.ready.push(listener); return nextId++; },
    onMotionStarted(listener: any) { listeners.motionStarted.push(listener); return nextId++; },
    onMotionFailed(listener: any) { listeners.motionFailed.push(listener); return nextId++; },
    onHitTest(listener: any) { listeners.hitTest.push(listener); return nextId++; },
    onEntranceFinished(listener: any) { listeners.entranceFinished.push(listener); return nextId++; },
    onStopped(listener: any) { listeners.stopped.push(listener); return nextId++; },
    off(id: any) {
      offCalls.push(id);
      listeners.ready.splice(0, listeners.ready.length);
      listeners.motionStarted.splice(0, listeners.motionStarted.length);
      listeners.motionFailed.splice(0, listeners.motionFailed.length);
      listeners.hitTest.splice(0, listeners.hitTest.length);
      listeners.entranceFinished.splice(0, listeners.entranceFinished.length);
      listeners.stopped.splice(0, listeners.stopped.length);
    },
  };
  return bridge;
}
