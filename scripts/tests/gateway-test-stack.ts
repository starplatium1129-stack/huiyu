'use strict';

import { Server, RequestListener } from 'node:http';
import { AddressInfo } from 'node:net';

let fs: typeof import('fs') = require('fs');
let http: typeof import('http') = require('http');
let os: typeof import('os') = require('os');
let path: typeof import('path') = require('path');
let createGateway = require(path.join(__dirname, '..', '..', 'server.js')).createGateway;
let loadGatewayConfig = require(path.join(__dirname, '..', '..', 'server', 'config.js')).loadGatewayConfig;
let runtimePaths = require(path.join(__dirname, '..', 'lib', 'runtime-paths.js'));
let mocks: typeof import('./mock-upstreams.js') = require('./mock-upstreams.js');

let ROOT = path.join(__dirname, '..', '..');
let DEFAULT_TOKEN = 'gateway-fixture-token-0123456789abcdef012345';

type MockEntry = { name: string; mock: { server: Server }; port?: number; url?: string };
type Upstreams = Record<string, MockEntry> & { list: MockEntry[]; close: () => Promise<void> };

function closeServer(server: Server | null) {
  return new Promise<void>(function (resolve) {
    if (!server || !server.listening) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(function () { resolve(); });
  });
}

function removeFixtureRoot(root: string) {
  let tempRoot = fs.realpathSync.native(os.tmpdir());
  let resolved = fs.realpathSync.native(path.resolve(root));
  let relative = path.relative(tempRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove non-temporary fixture root: ' + root);
  }
  fs.rmSync(resolved, { recursive:true, force:true });
}

async function startMockUpstreams() {
  let entries: MockEntry[] = [
    { name:'sd', mock:mocks.createSdMock() },
    { name:'comfy', mock:mocks.createComfyMock() },
    { name:'ollama', mock:mocks.createOllamaMock() },
    { name:'tts', mock:mocks.createTtsMock() },
    { name:'translate', mock:mocks.createTranslateMock() }
  ];
  try {
    for (let i = 0; i < entries.length; i += 1) {
      let address = await mocks.listen(entries[i].mock.server, 0, '127.0.0.1') as AddressInfo;
      entries[i].port = address.port;
      entries[i].url = 'http://127.0.0.1:' + address.port;
    }
  } catch (error) {
    for (let c = 0; c < entries.length; c += 1) await closeServer(entries[c].mock.server);
    throw error;
  }

  let upstreams: Upstreams = {} as Upstreams;
  entries.forEach(function (entry) { upstreams[entry.name] = entry; });
  upstreams.list = entries;
  upstreams.close = async function () {
    for (let i = entries.length - 1; i >= 0; i -= 1) await closeServer(entries[i].mock.server);
  };
  return upstreams;
}

function buildConfig(runtime: { root: string; }, upstreams: Upstreams, options: { token?: string; env?: Record<string, string> } = {}) {
  options = options || {};
  let env = Object.assign({
    AICS_APP_ROOT:ROOT,
    AI_WORKSPACE_ROOT:path.join(runtime.root, 'workspace'),
    AICS_RUNTIME_ROOT:runtime.root,
    AICS_DISABLE_LEGACY_RUNTIME_MIGRATION:'1',
    PORT:'3000',
    HOST:'127.0.0.1',
    TOKEN:options.token || DEFAULT_TOKEN,
    DISABLE_TUNNEL:'1',
    SD_HOST:upstreams.sd.url,
    COMFY_HOST:upstreams.comfy.url,
    TTS_HOST:upstreams.tts.url,
    OLLAMA_HOST:upstreams.ollama.url,
    TRANSLATE_PORT:String(upstreams.translate.port),
    TRANSLATION_PYTHON:path.join(runtime.root, 'fixture-python.exe'),
    TRANSLATION_SCRIPT:path.join(runtime.root, 'fixture-translate.py')
  }, options.env || {});
  let config = loadGatewayConfig(ROOT, env);
  // The fixture owns the actual listener, so the OS chooses an ephemeral port.
  config.PORT = 0;
  return config;
}

async function start(options: { runtimeRoot?: string; cleanupRuntime?: boolean; prefix?: string; token?: string; env?: Record<string,string>; [key: string]: any } = {}) {
  options = options || {};
  let ownsTemporaryRoot = !options.runtimeRoot;
  let temporaryRoot = ownsTemporaryRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || 'aics-gateway-test-'))
    : path.resolve(options.runtimeRoot || '');
  let cleanupRuntime = options.cleanupRuntime === true || (ownsTemporaryRoot && options.cleanupRuntime !== false);
  let runtime = runtimePaths.createRuntimePaths(temporaryRoot);
  let upstreams: Upstreams | null = null;
  let gateway: { app: RequestListener; handleUpgrade: (...args: any[]) => void; close: () => void | Promise<void>; }|null = null;
  let server: Server | null = null;
  let closed = false;

  try {
    upstreams = await startMockUpstreams();
    let config = buildConfig(runtime, upstreams, options);
    if (typeof options.configureConfig === 'function') options.configureConfig(config, runtime, upstreams);
    if (typeof options.prepare === 'function') {
      await options.prepare({ root:temporaryRoot, runtime:runtime, config:config, upstreams:upstreams });
    }

    let services = typeof options.createServices === 'function'
      ? (await options.createServices({ root:temporaryRoot, runtime:runtime, config:config, upstreams:upstreams }) || {})
      : (options.services || {});
    let control = Object.assign({
      // Fixture routes must never launch PowerShell or another managed process.
      runScriptAsync:function () {
        return Promise.resolve({ ok:false, error:'fixture process execution disabled' });
      }
    }, options.control || {});
    gateway = createGateway({
      config:config,
      env:options.env || {},
      services:services,
      control:control,
      workspace:options.workspace,
      spawn:options.spawn
    });
    server = http.createServer(gateway!.app);
    server.on('upgrade', gateway!.handleUpgrade);
    let address = await new Promise<AddressInfo>(function (resolve, reject) {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', function () { resolve(server!.address() as AddressInfo); });
    });
    config.PORT = address.port;
    config.HOST = '127.0.0.1';

    return {
      root:temporaryRoot,
      runtime:runtime,
      config:config,
      upstreams:upstreams,
      gateway:gateway,
      server:server,
      address:address,
      baseUrl:'http://127.0.0.1:' + address.port,
       close:async function () {
         if (closed) return;
         closed = true;
         let errors = [];
         try { if (gateway) await gateway.close(); } catch (error) { errors.push(error); }
         try { await closeServer(server); } catch (error) { errors.push(error); }
         try { if (upstreams) await upstreams.close(); } catch (error) { errors.push(error); }
         try { if (cleanupRuntime) removeFixtureRoot(temporaryRoot); } catch (error) { errors.push(error); }
         if (errors.length) throw new AggregateError(errors, 'gateway fixture cleanup failed');
       }
    };
  } catch (error) {
    try { if (gateway) await gateway.close(); } catch (closeError) {}
    await closeServer(server);
    if (upstreams) await upstreams.close();
    if (cleanupRuntime) removeFixtureRoot(temporaryRoot);
    throw error;
  }
}

export = {
  ROOT:ROOT,
  start:start,
  closeServer:closeServer,
  removeFixtureRoot:removeFixtureRoot
};
