'use strict';

import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import type { GatewayOptions, GatewayState } from './server/gateway-types';
import { errorField } from './scripts/lib/runtime-errors';

let express: typeof import('express') = require('express');
let compression: typeof import('compression') = require('compression');
let path: typeof import('path') = require('path');
let fs: typeof import('fs') = require('fs');
let cp: typeof import('child_process') = require('child_process');
let createProxyMiddleware = (require('http-proxy-middleware') as typeof import('http-proxy-middleware')).createProxyMiddleware;
let loadGatewayConfig = (require('./server/config') as typeof import('./server/config')).loadGatewayConfig;
let security: typeof import('./server/security') = require('./server/security');
let sdProxyPolicy: typeof import('./server/sd-proxy-policy') = require('./server/sd-proxy-policy');
let envelope: typeof import('./server/http-envelope') = require('./server/http-envelope');
let { precompressed }: typeof import('./server/precompressed') = require('./server/precompressed');
let { createTunnelManager }: typeof import('./server/tunnel') = require('./server/tunnel');
let createChatRouter = (require('./routes/chat') as typeof import('./routes/chat')).createChatRouter;
let createVoiceRouter = (require('./routes/voice') as typeof import('./routes/voice')).createVoiceRouter;
let createLive2dRouter = (require('./routes/live2d') as typeof import('./routes/live2d')).createLive2dRouter;
let createMaintenanceRouter = (require('./routes/maintenance') as typeof import('./routes/maintenance')).createMaintenanceRouter;
let isDesktopPackagedMode = (require('./routes/maintenance') as typeof import('./routes/maintenance')).isDesktopPackagedMode;
let maintenanceReadBarrier = (require('./routes/maintenance-read-barrier') as typeof import('./routes/maintenance-read-barrier')).maintenanceReadBarrier;
let createControlRouter = (require('./routes/control') as typeof import('./routes/control')).createControlRouter;
let createAnimaRouter = (require('./routes/anima') as typeof import('./routes/anima')).createAnimaRouter;
let createGenerationRouter = (require('./routes/generation') as typeof import('./routes/generation')).createGenerationRouter;
let createInterrogateRouter = (require('./routes/interrogate') as typeof import('./routes/interrogate')).createInterrogateRouter;
let createVideoRouter = (require('./routes/video') as typeof import('./routes/video')).createVideoRouter;
let showcaseAssets: typeof import('./server/showcase-assets') = require('./server/showcase-assets');
let createResourcesRouter = (require('./routes/resources') as typeof import('./routes/resources')).createResourcesRouter;
let createReferenceResources = (require('./routes/resources-reference') as typeof import('./routes/resources-reference')).createReferenceResources;

let ONE_DAY = 24 * 60 * 60 * 1000;
let ONE_YEAR = 365 * ONE_DAY;

// SD WebUI 只放行前端真正调用的端点。
// 之前整段透传 /sdapi、/controlnet、/adetailer —— SD 的 API 能换模型，
// 装了扩展还能碰文件系统，等于把这些能力一并交给任何 token 持有者。
let SD_PROXY_ALLOWLIST = sdProxyPolicy.paths;

function staticOptions(maxAge: number): NonNullable<Parameters<typeof express.static>[1]> {
  return {
    dotfiles:'deny',
    index:false,
    maxAge:maxAge,
    setHeaders:function (res: any, filePath: string) {
      if (/\.(?:html|json)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  };
}

function createGateway(options: GatewayOptions = {}) {
  options = options || {};
  let spawn = options.spawn || cp.spawn;
  let config = options.config || loadGatewayConfig(__dirname, options.env || process.env);
  // 网关主日志：按天写 runtime/logs/gateway-*.log（保留 14 天），console 行为不变。
  // RUNTIME.logs 在 fixture 栈下可能缺失（无 runtime 目录的极端配置），此时只走 console。
  let logger = (require('./server/logger') as typeof import('./server/logger')).createLogger({
    dir: config.RUNTIME && config.RUNTIME.logs || '',
    prefix: 'gateway'
  });
  let app = express();

  app.disable('x-powered-by');
  app.use(security.responseHeaders);
  // Host 白名单必须在 tokenAuth 之前：本机请求可免 token，
  // 不校验 Host 时任意网页都能把域名 rebind 到 127.0.0.1 并以「本机」身份调控制接口。
  // precompressed 也必须在两者之后：否则远程无 token / rebinding 请求能直接拿到
  // _app、assets、docs 等预压产物，绕过 tokenAuth 与 hostGuard。
  let tunnelManager: ReturnType<typeof createTunnelManager> | null = null;
  app.use(security.hostGuard(config, function () { return tunnelManager ? tunnelManager.getUrl() : ''; }));
  app.use(security.tokenAuth(config.TOKEN));
  // Fence mutable content before any installed projection, precompressed file or
  // ordinary static handler can return bytes from a maintenance transaction.
  if (!isDesktopPackagedMode(config)) {
    app.use(['/data', '/scene-showcase'], maintenanceReadBarrier({ rootDir: config.ROOT_DIR,
      runtimeRoot: config.RUNTIME_ROOT, showcaseRoot: config.SCENE_SHOWCASE_DIR }));
  }
  let resources = createResourcesRouter(config);
  app.use(resources.router);
  // Installed allowlist precedes bundled/precompressed media. Request authorization is still
  // evaluated here; no policy/configuration paths are exposed by the management API.
  app.use(resources.staticMiddleware);
  app.use(createReferenceResources(config));
  app.use('/docs', (require('./server/docs') as typeof import('./server/docs')).redirectLegacyDocs);
  app.use(precompressed(config.ROOT_DIR, { assetsRoot: config.ASSETS_ROOT }));
  // 流式响应（聊天 NDJSON / SSE）不进 zlib 缓冲：compression 默认攒满才吐，
  // token 到达会变成一段一段的突发；X-Accel-Buffering 只对反代生效管不了它
  // （2026-08-21 性能审计 #4）。
  app.use(compression({
    threshold:1024,
    filter: function (req, res) {
      let contentType = String(res.getHeader('Content-Type') || '');
      if (/\bapplication\/x-ndjson\b/i.test(contentType) || /\btext\/event-stream\b/i.test(contentType)) return false;
      return compression.filter(req, res);
    },
  }));

  let chat = createChatRouter(config, options.services);
  let voice = createVoiceRouter(config, options.services);
  let live2d = createLive2dRouter(config, options.services);
  let maintenance = createMaintenanceRouter(config);
  let anima = createAnimaRouter(config, options.services);
  let generation = createGenerationRouter(config, options.services);
  let interrogate = createInterrogateRouter(config);
  let video = createVideoRouter(config, options.services);
  let videoAi = (require('./routes/video-ai') as typeof import('./routes/video-ai')).createVideoAiRouter(config, options.services);
  let desktopTools = (require('./routes/desktop-tools') as typeof import('./routes/desktop-tools')).createDesktopToolsRouter({ security: security, config: config });

  // 控制面板路由需要访问 gateway 对象（tunnelUrl、startTunnel/stopTunnel）
  // 用闭包延迟引用，避免循环依赖
  let gatewayState: GatewayState = { tunnelUrl:'', startTunnel:null, stopTunnel:null };
  tunnelManager = createTunnelManager({
    config:config,
    spawn:spawn,
    onStateChange:function () { if (tunnelManager) gatewayState.tunnelUrl = tunnelManager.getUrl(); }
  });
  let controlDependencies = Object.assign({}, options.control || {});
  if (!controlDependencies.translation) controlDependencies.translation = voice.translation;
  let control = createControlRouter(config, function() { return gatewayState; }, controlDependencies);

  app.use(chat.router);
  app.use(voice.router);
  app.use(live2d.router);
  app.use(maintenance.router);
  app.use(control);
  app.use(anima.router);
  app.use(generation.router);
  app.use(interrogate.router);
  app.use(video.router);
  app.use(videoAi.router);
  app.use(desktopTools);

  app.get('/api/health', function (req, res) {
    let live2dStatus = live2d.service.status();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok:true,
      app:'ai-cg-studio',
      gateway:true,
      desktopProtocol:1,
      port:Number(config.PORT),
      capabilities:{
        chat:true,
        tts:true,
        translation:true,
        live2d:live2dStatus.available
      },
      queues:{
        chat:chat.service.queueStatus(),
        voice:voice.tts.queueStatus()
      }
    });
  });

  // Vue SPA — 优先从 dist/ 提供；dist/ 不存在时回退到旧 index.html
  let DIST_DIR = path.join(config.ROOT_DIR, 'dist');
  let distReady = fs.existsSync(path.join(DIST_DIR, 'index.html'));
  if (distReady) {
    // dist/_app 里的文件名带内容 hash，改动必然换名 → 可以永久缓存。
    // 之前统一 max-age=86400 且无 immutable，34 个 JS/CSS 每天都要回验一次。
    app.use('/_app', express.static(path.join(DIST_DIR, '_app'), {
      dotfiles:'deny',
      index:false,
      immutable:true,
      maxAge:ONE_YEAR
    }));
    // 其余产物（favicon 等无 hash 文件）保持一天
    app.use(express.static(DIST_DIR, staticOptions(ONE_DAY)));
  }

  app.get(['/', '/index.html'], function (req, res) {
    res.setHeader('Cache-Control', 'no-cache');
    let spaEntry = path.join(DIST_DIR, 'index.html');
    res.sendFile('index.html', { root: fs.existsSync(spaEntry) ? DIST_DIR : config.ROOT_DIR });
  });
  app.use('/css', express.static(path.join(config.ROOT_DIR, 'css'), staticOptions(ONE_DAY)));
  // docs/*.html 引用设计系统的唯一一份实现（src/assets/css）。
  // 只提供深浅主题的两份共享样式，不开放整个 src/。
  app.use('/src/assets/css', function (req, res, next) {
    if (!['/design-system.css', '/light-theme.css'].includes(req.path)) return res.status(404).end();
    next();
  }, express.static(path.join(config.ROOT_DIR, 'src', 'assets', 'css'), staticOptions(ONE_DAY)));
  // Live2D manifests reference unhashed moc/texture/motion files. Revalidate
  // them so model fixes do not leave existing browsers on a week-old asset set.
  app.use(['/assets/live2d', '/assets/live2d-current'], function (req, res, next) {
    res.setHeader('Cache-Control', 'no-cache');
    next();
  }, express.static(config.LIVE2D_ROOT, {
    dotfiles:'deny',
    index:false,
    fallthrough:false
  }));
  // assets (立绘、角色参考图、粒子、图标等运行时媒体)：
  // 采用 no-cache + ETag 协商缓存——文件未修改返回 304 零流量秒开；
  // 用户或脚本在本地替换图片后，刷新浏览器立即生效，彻底无需手动改 ?v= 版本号。
  app.use('/assets', function (req, res, next) {
    res.setHeader('Cache-Control', 'no-cache');
    next();
  }, express.static(config.ASSETS_ROOT, {
    dotfiles: 'deny',
    index: false
  }));
  // 角色参考标准图（Cinematic Bible）——2026-08-29 随样张模式迁出项目、
  // 落 AI 工作区 CharacterReferences（~1GB 媒体图不随桌面安装包携带）。
  // 与 /assets 同为 no-cache + ETag 协商缓存；外部目录缺失时不挂路由。
  if (config.CHARACTER_REF_ROOT) {
    app.use('/character-references', function (req, res, next) {
      res.setHeader('Cache-Control', 'no-cache');
      next();
    }, express.static(config.CHARACTER_REF_ROOT, {
      dotfiles: 'deny',
      index: false,
      fallthrough: false
    }));
  }
  // 只放行 SPA 真正读取的数据文件（白名单唯一来源：server/public-data.js，
  // precompressed 中间件共用同一份——此前两份拷贝已发生漂移）。
  // 之前整个 data/ 目录对外可读，包括 history.json / projects.json / prompts.json
  // 这类个人内容，以及 data/scenes/*.json（build-scenes.js 的输入，共 893KB，
  // 客户端从不读取）。
  let PUBLIC_DATA_FILES: typeof import('./server/public-data') = require('./server/public-data');
  // data/ 下的公开 JSON 是维护链路的可变内容，统一 no-cache + ETag：
  // 没变时仍返回 304，变更后同一 URL 不会被 immutable 缓存冻结。带内容哈希的
  // SPA _app 资源继续走 immutable；数据版本 query 只保留给强制刷新兜底。
  let NO_CACHE_DATA_FILES = PUBLIC_DATA_FILES;
  app.use('/data', function (req, res, next) {
    let name = req.path.replace(/^\//, '');
    if (PUBLIC_DATA_FILES.indexOf(name) === -1) return res.status(404).end();
    // 参考标准由多个维护脚本直接改写、无统一版本号入口，
    // 用 no-cache + ETag 协商缓存：没变回 304 零流量，变了立即生效。
    res.setHeader('Cache-Control', NO_CACHE_DATA_FILES.indexOf(name) !== -1
      ? 'no-cache'
      : 'public, max-age=31536000, immutable');
    next();
  }, express.static(path.join(config.ROOT_DIR, 'data'), {
    dotfiles:'deny',
    index:false,
    maxAge:ONE_YEAR
  }));
  // scene-showcase 是运行时媒体（换图即时生效）：no-cache + ETag，
  // 文件没变回 304 零流量，变了立即出新图。
  // 之前是 7 天强缓存且封面 URL 无版本号 —— 换图后浏览器继续显示旧图，
  // 用户会误以为"网站还是以前的"。
  app.use('/scene-showcase', function (req, res, next) {
    if (!config.SCENE_SHOWCASE_DIR) return res.status(404).end();
    // 白名单同时约束了 images|thumbs 下的 scNNN / artist_ / pc_ / lora_ 文件
    // 与穿越字符/绝对 URL/query-hash，见 server/showcase-assets.js。
    if (!showcaseAssets.isShowcaseAssetPath(req.path)) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    next();
  }, config.SCENE_SHOWCASE_DIR
    ? express.static(config.SCENE_SHOWCASE_DIR, { dotfiles:'deny', index:false, fallthrough:false })
    : function (req, res) { res.status(404).end(); });
  app.use('/docs', express.static(path.join(config.ROOT_DIR, 'docs'), Object.assign(staticOptions(ONE_DAY), { index:'index.html' })));
  app.use('/tools', function (req, res, next) {
    if (req.path === '/control-server.js') return res.status(404).end();
    next();
  }, express.static(config.TOOLS_ROOT, staticOptions(ONE_DAY)));

  let sdProxy = createProxyMiddleware({
    // router 按请求解析 target：控制面板改 SD_HOST 后立即生效。
    // 之前 target 在构造时就被定住，面板报成功而 /sdapi 仍打旧 host 直到重启。
    target:config.SD_HOST,
    router:function () { return config.SD_HOST; },
    changeOrigin:true,
    // ws:false —— http-proxy-middleware 的 ws:true 会直接订阅 server 的 'upgrade' 事件，
    // 完全绕过 Express 中间件栈，于是 tokenAuth 失效。升级请求改由 startGateway 手动鉴权后转交。
    ws:false,
    pathFilter:function (pathname) {
      return SD_PROXY_ALLOWLIST.indexOf(pathname) !== -1;
    },
    proxyTimeout:20 * 60 * 1000,
    auth:config.SD_API_AUTH || undefined,
    on:{
      // 每次转发都打日志会把长时运行的日志刷成噪音；需要排查时用 DEBUG=1。
      proxyReq:function (proxyReq) {
        // httpxy 的 timeout 会限制整个客户端 socket，并在复用连接上累积监听器。
        // 15 秒只等真正的上游 TCP 建连；连接成功后保留上面的 20 分钟生成时限。
        const socket = proxyReq.socket;
        if (socket && socket.connecting) {
          let connectionTimer = setTimeout(function () {
            let error: NodeJS.ErrnoException = new Error('SD WebUI 连接超时');
            error.code = 'ETIMEDOUT';
            proxyReq.destroy(error);
          }, 15000);
          connectionTimer.unref();
          let clearConnectionTimer = function () {
            clearTimeout(connectionTimer);
            socket.removeListener('connect', clearConnectionTimer);
            proxyReq.removeListener('close', clearConnectionTimer);
          };
          socket.once('connect', clearConnectionTimer);
          proxyReq.once('close', clearConnectionTimer);
        }
        if (process.env.DEBUG === '1') console.log('  → SD API 请求已转发');
      },
      error:function (error, req, res) {
        console.error('  ❌ SD 代理错误:', error.message);
        // upgrade 失败时第三个参数是裸 net.Socket，不是 Express response。
        // 直接调 res.status() 会抛 TypeError 并带走整个进程。
        if (res && typeof (res as Partial<Response>).status === 'function') {
          const response = res as Response;
          if (!response.headersSent) {
            envelope.fail(response, 502, 'SD WebUI 未响应，请确认已经启动 (' + config.SD_HOST + ')');
          }
          return;
        }
        if (res && typeof res.destroy === 'function') {
          try { res.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch (writeError) {}
          try { res.destroy(); } catch (destroyError) {}
        }
      }
    }
  });
  // txt2img 是唯一真正吃 GPU 的 SD 端点，单独限流。
  // 容量按前端出图队列的上限（8 个任务）留余量；补充速率远慢于单张出图耗时，
  // 所以正常使用碰不到，持续刷才会碰到。其余白名单端点是廉价读，不限。
  app.use(sdProxyPolicy.middleware);
  app.post('/sdapi/v1/txt2img', security.rateLimit({
    capacity:12, refillMs:5000, label:'出图'
  }));
  app.use(sdProxy);

  // ComfyUI 原生端点不再对浏览器暴露。浏览器只能通过应用级 /api/anima/*
  // 与 /api/creative/* 访问服务端固定工作流；根 prompt/history/queue/view 等路径统一回 JSON 404。
  app.use([
    '/sdapi', '/controlnet', '/adetailer', '/comfy',
    '/prompt', '/queue', '/history', '/object_info', '/interrupt', '/view'
  ], function (req, res) {
    envelope.fail(res, 404, '该接口未开放：' + req.baseUrl + req.path);
  });

  // SPA fallback — Vue Router 的前端路由在刷新时返回 index.html
  // 正则 /^(?!\/api).*/ 既完美排除 /api/* 接口，又能在 Express 4（打包侧）与 Express 5（根工作区）两端通用。
  app.get(/^(?!\/api).*/, function (req, res, next) {
    let spaEntry = path.join(config.ROOT_DIR, 'dist', 'index.html');
    if (!fs.existsSync(spaEntry)) return next();
    let ext = path.extname(req.path);
    if (ext && ext !== '.html') return next();
    res.setHeader('Cache-Control', 'no-cache');
    // Resolve the fixed entry relative to its root; hidden worktree ancestors are not web paths.
    res.sendFile('index.html', { root: path.dirname(spaEntry) });
  });

  app.use('/api', function (req, res) {
    envelope.fail(res, 404, '接口不存在: ' + req.method + ' ' + req.baseUrl + req.path);
  });

  app.use(function (error: any, req: Request, res: Response, next: NextFunction) {
    if (res.headersSent) return next(error);
    // 尊重 err.status/err.statusCode：否则 express.static 的 404、body-parser 的 413
    // 都会变成 500，而 detail 还会把主机绝对路径回给客户端。
    let status = Number(error && (errorField(error, 'status') || errorField(error, 'statusCode')));
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
    if (error && errorField(error, 'type') === 'entity.parse.failed') status = 400;
    if (error && errorField(error, 'code') === 'ENOENT') status = 404;

    let messages: Record<number, string> = {
      400:'请求 JSON 格式错误',
      404:'资源不存在',
      413:'请求体过大'
    };
    if (status >= 500) logger.error('网关内部错误 ' + req.method + ' ' + req.originalUrl, error);
    envelope.fail(res, status, messages[status] || (status >= 500 ? '网关内部错误' : '请求无法处理'));
  });

  function close() {
    resources.close();
    voice.close();
    if (anima && typeof anima.close === 'function') anima.close();
    if (generation && typeof generation.close === 'function') generation.close();
    if (video && typeof video.close === 'function') video.close();
    if (maintenance && typeof maintenance.close === 'function') maintenance.close();
    if (control && typeof control.close === 'function') control.close();
    if (tunnelManager) tunnelManager.stop();
  }

  // 将控制函数暴露给 gatewayState，供 control 路由调用
  gatewayState.startTunnel = function () { if (tunnelManager) tunnelManager.start(); };
  gatewayState.stopTunnel  = function () { if (tunnelManager) tunnelManager.stop(); };

  // upgrade 请求不经过 Express 中间件，所以在这里复刻 hostGuard + tokenAuth 的判定。
  function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer<ArrayBufferLike>) {
    try {
      let pathname = String(req.url || '/').split('?')[0];
      if (SD_PROXY_ALLOWLIST.indexOf(pathname) === -1) { socket.destroy(); return; }
      // hostGuard 的 DNS rebinding 防御必须同样覆盖 WebSocket 升级路径。
      // 这里直接复用纯函数 hostAllowed（hostGuard 是 Express 中间件，依赖 res）。
      let tunnelHost = security.tunnelHostFromUrl(tunnelManager ? tunnelManager.getUrl() : '');
      if (!security.hostAllowed(req.headers.host, config.PORT, tunnelHost)) { socket.destroy(); return; }

      let authorized = security.isDirectLocalRequest(req);
      if (!authorized) {
        let query = '';
        let q = String(req.url || '').indexOf('?');
        if (q >= 0) query = String(req.url).slice(q + 1);
        let suppliedToken = new URLSearchParams(query).get('token') || req.headers['x-token'] || '';
        if (!suppliedToken) {
          let cookieMatch = (req.headers.cookie || '').match(/(?:^|;\s*)aics_token=([^;]+)/);
          if (cookieMatch) suppliedToken = cookieMatch[1];
        }
        authorized = security.tokenMatches(config.TOKEN, suppliedToken);
      }
      if (!authorized) {
        try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch (error) {}
        socket.destroy();
        return;
      }
      let policyStatus = sdProxyPolicy.denial(req, pathname, true);
      if (policyStatus) {
        socket.end('HTTP/1.1 ' + policyStatus + ' Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      sdProxy.upgrade(req, socket, head);
    } catch (error) {
      logger.error('WebSocket 升级失败', error);
      try { socket.destroy(); } catch (ignore) {}
    }
  }

  return {
    app:app,
    config:config,
    services:{
      resources:resources.manager,
      chat:chat.service,
      tts:voice.tts,
      translation:voice.translation,
      live2d:live2d.service,
      anima:anima.service
    },
    startTunnel:function () { if (tunnelManager) tunnelManager.start(); },
    handleUpgrade:handleUpgrade,
    close:close,
    logger:logger
  };
}

function startGateway(options?: GatewayOptions) {
  let gateway = createGateway(options);
  let config = gateway.config;
  let logger = gateway.logger;

  // 兜底：未处理 Promise 拒绝记录后继续；未捕获异常记录后必须退出——
  // V8 状态可能已不一致（句柄泄漏/半写），带病运行比重启更危险，
  // 交给控制面板/看门狗重新拉起。延迟一拍让 fire-and-forget 日志先落盘。
  process.on('unhandledRejection', function (reason) {
    logger.error('未处理的 Promise 拒绝', reason instanceof Error ? reason : String(reason));
  });
  process.on('uncaughtException', function (error) {
    logger.error('未捕获异常，网关即将退出', error);
    setTimeout(function () { process.exit(1); }, 200).unref();
  });

  // 数据聚合产物自愈（产物自 2026-08-28 起不入库）：语义源分片与产物不一致时
  // 启动即重建，免"改完数据忘跑 scenes:build"心智；源分片损坏或精简安装缺
  // scripts/lib 时仅告警降级，沿用现有 data/ 产物，不阻塞网关启动。
  try {
    let ensuredData = (require('./scripts/lib/ensure-data-build') as typeof import('./scripts/lib/ensure-data-build')).ensureAll();
    let rebuiltFaces = (['scenes', 'popular', 'blueprints'] as const).filter(function (face) { return ensuredData[face] && ensuredData[face].rebuilt; });
    if (rebuiltFaces.length) {
      logger.info('[data-build] 已自愈重建聚合产物: ' + rebuiltFaces.join(' + '));
    }
  } catch (error) {
    logger.warn('[data-build] 自愈构建失败，沿用现有 data/ 产物', error instanceof Error ? error.message : error);
  }

  let server = gateway.app.listen(config.PORT, config.HOST, function () {    console.log('');
    console.log('  ══════════════════════════════════════════');
    console.log('  🔗 绘遇 · HUIYU 联机网关已启动');
    console.log('  📗 端口: ' + config.PORT);
    console.log('  🛡️ 监听: ' + config.HOST);
    console.log('  🎨 SD 后端: ' + config.SD_HOST);
    console.log('  🔊 TTS 后端: ' + config.TTS_HOST);
    console.log('  💬 Ollama 后端: ' + config.OLLAMA_HOST);
    console.log('  🖼️ 场景样张: ' + (config.SCENE_SHOWCASE_DIR || '未配置'));
    console.log('  🔐 Token: ' + (config.TOKEN_SOURCE || 'runtime/state')
      + ' (length ' + String(config.TOKEN || '').length + ')');
    console.log('  ══════════════════════════════════════════');
    console.log('');
    logger.info('网关已启动 port=' + config.PORT + ' host=' + config.HOST
      + ' sd=' + config.SD_HOST + ' tts=' + config.TTS_HOST + ' ollama=' + config.OLLAMA_HOST);
    // 公网分享不再随网关自动开启：默认仅本机，由控制面板显式启动。
    // 需要开机即分享时设 AUTO_TUNNEL=1。
    let saved: any = {};
    try { saved = JSON.parse(fs.readFileSync(config.RUNTIME.config, 'utf8')); } catch (error) {}
    let autoTunnel = process.env.AUTO_TUNNEL === '1' || saved.autoTunnel === true;
    if (autoTunnel) gateway.startTunnel();
    else console.log('  🔒 仅本机访问（公网分享可在控制面板启动）');
  });

  // 端口占用 / 权限错误等监听失败必须立刻退出，不能留一个没有监听器的僵尸进程，
  // 否则后续 startTunnel 还会指向一个死端口。
  server.once('error', function (error) {
    logger.error('网关监听失败: ' + (error && error.message || error));
    process.exit(1);
  });

  // 显式 HTTP 超时，不依赖 Node 默认值：
  // headersTimeout 覆盖慢隧道上的请求头接收；requestTimeout 覆盖大上传
  // （26MB 样张经 cloudflared）的完整接收窗口；keepAliveTimeout 给复用连接留余量。
  server.requestTimeout = 600000;
  server.headersTimeout = 120000;
  server.keepAliveTimeout = 6000;

  server.on('upgrade', gateway.handleUpgrade);

  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    gateway.close();
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(1); }, 5000).unref();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { gateway:gateway, server:server, shutdown:shutdown, logger:logger };
}

if (require.main === module) startGateway();

export = {
  createGateway:createGateway,
  startGateway:startGateway
};
