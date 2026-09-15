'use strict';

import { Server,IncomingMessage,ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

const { test }: typeof import('node:test') = require('node:test');

var assert: typeof import('assert') = require('assert');
var events: typeof import('events') = require('events');
var express: typeof import('express') = require('express');
var fs: typeof import('fs') = require('fs');
var http: typeof import('http') = require('http');
var net: typeof import('net') = require('net');
var os: typeof import('os') = require('os');
var path: typeof import('path') = require('path');
var childProcess: typeof import('child_process') = require('child_process');
var createControlRouter = (require('../../routes/control') as typeof import('../../routes/control')).createControlRouter;
var createTtsService = (require('../../services/tts-service') as typeof import('../../services/tts-service')).createTtsService;
var runtimePaths: typeof import('../lib/runtime-paths') = require('../lib/runtime-paths');
var gatewayTestStack: typeof import('./gateway-test-stack') = require('./gateway-test-stack');

var projectRoot = path.resolve(__dirname, '..', '..');
var WINDOWS_POWERSHELL_TEST = process.platform === 'win32'
  ? {}
  : { skip:'requires Windows PowerShell process ownership semantics' };

function listen(server: Server<IncomingMessage,ServerResponse>) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      resolve('http://127.0.0.1:' + server.address!().port);
    });
  });
}

function close(server: Server<IncomingMessage,ServerResponse>) {
  return new Promise(function (resolve) {
    if (!server || !server.listening) return resolve();
    server.close(function () { resolve(); });
  });
}

async function postJson(baseUrl: any, pathname: string, payload: { action?: string; sdHost?: string; }) {
  var response = await fetch(baseUrl + pathname, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify(payload)
  });
  var body = await response.text();
  var json = null;
  try { json = JSON.parse(body); } catch (error) {}
  return { status:response.status, body:body, json:json };
}

async function getJson(baseUrl: any, pathname: string) {
  var response = await fetch(baseUrl + pathname);
  return { status:response.status, json:await response.json() };
}

async function waitFor(check: any, description: string) {
  var deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    var value = await check();
    if (value) return value;
    await new Promise(function (resolve) { setTimeout(resolve, 25); });
  }
  throw new Error('Timed out waiting for ' + description);
}

function baseConfig(rootDir: string, runtime: any): any {
  return {
    ROOT_DIR:rootDir,
    RUNTIME:runtime,
    RUNTIME_ROOT:runtime.root,
    PORT:3000,
    HOST:'127.0.0.1',
    TOKEN:'control-contract-token',
    SD_HOST:'http://127.0.0.1:7860',
    COMFY_HOST:'http://127.0.0.1:8188',
    SD_API_AUTH:'',
    TTS_HOST:'http://127.0.0.1:9880',
    OLLAMA_HOST:'http://127.0.0.1:11434',
    OLLAMA_MODEL:'',
    OLLAMA_KEEP_ALIVE:'10m',
    OLLAMA_NUM_PREDICT:300,
    OLLAMA_NUM_CTX:4096,
    TRANSLATE_PORT:5310,
    TRANSLATE_URL:'http://127.0.0.1:5310',
    TRANSLATION_PYTHON:path.join(runtime.root, 'fixture-python.exe'),
    TRANSLATION_SCRIPT:path.join(runtime.root, 'fixture-translate.py'),
    TRANSLATION_LOG:path.join(runtime.logs, 'translate.log'),
    SELF_HEALING_INTERVAL_MS:50,
    LIVE2D_ROOT:path.join(rootDir, 'assets', 'live2d'),
    ASSETS_ROOT:path.join(rootDir, 'assets'),
    TOOLS_ROOT:path.join(rootDir, 'tools'),
    SCENE_SHOWCASE_DIR:'',
    VOICE_PROFILES:{},
    DISABLE_TUNNEL:true,
    CLOUDFLARED_PATH:''
  };
}

function createWeightMock() {
  var state = { paths:[], rejectGpt:true };
  var server = http.createServer(function (req, res) {
    state.paths.push(req.url || '');
    if ((req.url || '').startsWith('/set_gpt_weights') && state.rejectGpt) {
      res.statusCode = 500;
      res.end('gpt weight rejected');
      return;
    }
    res.end('ok');
  });
  return { server:server, state:state };
}

test('control-failure-contract: timeout, config rollback, voice weights, tunnel exit', async () => {
  var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-control-failure-'));
  var controlRuntime = runtimePaths.createRuntimePaths(path.join(temporaryRoot, 'control'));
  var controlConfig = baseConfig(projectRoot, controlRuntime);
  var controlProbeServer = http.createServer(function (req, res) { res.end('ok'); });
  controlConfig.TTS_HOST = await listen(controlProbeServer);
  var failConfigWrite = false;
  var controlRouter = createControlRouter(controlConfig, function () {
    return { tunnelUrl:'', startTunnel:function () {}, stopTunnel:function () {} };
  }, {
    runScriptAsync:async function () {
      return { ok:false, error:'operation timeout' };
    },
    refreshServiceStates:async function () {
      return { sdOnline:false, ttsOnline:false, ollamaOnline:false, ollamaModels:[], ollamaVram:0, webuiManaged:false };
    },
    writeJson:function (file: PathOrFileDescriptor, data: any) {
      if (failConfigWrite) throw new Error('simulated config write failure');
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    }
  });
  var controlApp = express();
  controlApp.use(controlRouter);
  var controlServer = http.createServer(controlApp);
  var controlBase = await listen(controlServer);
  var weightMock = null;
  var tunnelStack: any = null;

  try {
    var startedVoice = await postJson(controlBase, '/api/service/voice', { action:'start' });
    assert(startedVoice.status === 200 && startedVoice.json && startedVoice.json.pending,
      'voice start must acknowledge the asynchronous control operation');
    var failedVoice: any = await waitFor(async function () {
      var status = await getJson(controlBase, '/api/status');
      return status.json.operation && status.json.operation.status === 'failed' ? status.json.operation : null;
    }, 'voice startup timeout failure');
    assert(failedVoice.error.includes('timeout'), 'voice startup timeout must be exposed in the operation result');

    failConfigWrite = true;
    var previousSdHost = controlConfig.SD_HOST;
    var failedConfig = await postJson(controlBase, '/api/config', { sdHost:'http://127.0.0.1:7999' });
    assert(failedConfig.status === 500 && failedConfig.json && !failedConfig.json.ok,
      'config write failure must return the standard error envelope');
    assert.strictEqual(controlConfig.SD_HOST, previousSdHost,
      'a failed config write must not leave the in-memory SD host partially updated');
    if (controlRouter.close) controlRouter.close();
    await close(controlServer);

    weightMock = createWeightMock();
    var weightBase = await listen(weightMock.server);
    var tts = createTtsService({
      host:weightBase,
      profiles:{
        nene:{
          refAudioPath:'nene.wav', promptText:'reference',
          sovitsWeightsPath:'nene.pth', gptWeightsPath:'nene.ckpt'
        }
      }
    });
    var firstFailure = await tts.prepare('nene').then(function () { return null; }, function (error) { return error; });
    assert(firstFailure, 'a rejected GPT weight switch must reject voice preparation');
    assert.strictEqual((await tts.status()).activeVoice, '',
      'a partial weight switch must not mark a voice as active');

    weightMock.state.rejectGpt = false;
    await tts.prepare('nene');
    var sovitsRequests = weightMock.state.paths.filter(function (pathname: any) {
      return pathname.startsWith('/set_sovits_weights');
    });
    assert.strictEqual(sovitsRequests.length, 2,
      'retrying a partial weight switch must reapply the SoVITS weight instead of trusting stale cache state');
    await close(weightMock.server);
    weightMock = null;

    var tunnelChild: any = new events.EventEmitter();
    tunnelChild.unref = function () {};
    tunnelStack = await gatewayTestStack.start({
      runtimeRoot:path.join(temporaryRoot, 'tunnel'),
      spawn:function () { return tunnelChild; },
      configureConfig:function (config: { DISABLE_TUNNEL: boolean; CLOUDFLARED_PATH: PathOrFileDescriptor; }) {
        config.DISABLE_TUNNEL = false;
        config.CLOUDFLARED_PATH = path.join(temporaryRoot, 'cloudflared-test.exe');
        fs.writeFileSync(config.CLOUDFLARED_PATH, '', 'utf8');
      }
    });
    tunnelStack.gateway.startTunnel();
    fs.writeFileSync(tunnelStack.runtime.tunnelLog,
      'https://stable-test.trycloudflare.com\nRegistered tunnel connection\n', 'utf8');
    var readyTunnel = await waitFor(async function () {
      var status = await getJson(tunnelStack.baseUrl, '/api/status');
      return status.json.tunnelStatus === 'active' ? 'active' : '';
    }, 'tunnel ready status');
    assert.strictEqual(readyTunnel, 'active');

    tunnelChild.emit('exit', 1);
    var stoppedTunnel = await waitFor(async function () {
      var status = await getJson(tunnelStack.baseUrl, '/api/status');
      return status.json.tunnelStatus === 'waiting' ? 'cleared' : '';
    }, 'tunnel exit status cleanup');
    assert(stoppedTunnel, 'tunnel exit must remove the stale public URL from the real status route');
  } finally {
    if (controlRouter.close) controlRouter.close();
    await close(controlServer);
    if (weightMock) await close(weightMock.server);
    if (tunnelStack) await tunnelStack.close();
    await close(controlProbeServer);
    fs.rmSync(temporaryRoot, { recursive:true, force:true });
  }

  console.log('Control failure contracts passed: timeout, config rollback, voice weights, tunnel exit');
});

test('gateway test stack preserves caller-owned runtime roots by default', async () => {
  var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-gateway-owned-root-'));
  var runtimeRoot = path.join(temporaryRoot, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive:true });
  var marker = path.join(runtimeRoot, 'caller-owned.txt');
  fs.writeFileSync(marker, 'keep\n', 'utf8');
  var stack = null;
  try {
    stack = await gatewayTestStack.start({ runtimeRoot:runtimeRoot });
    await stack.close();
    stack = null;
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'keep\n');
  } finally {
    if (stack) await stack.close();
    fs.rmSync(temporaryRoot, { recursive:true, force:true });
  }
});

test('control contract: ComfyUI start/stop uses managed ownership and shared operations', async () => {
  var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-comfy-control-'));
  var runtime = runtimePaths.createRuntimePaths(path.join(temporaryRoot, 'control'));
  var config = baseConfig(projectRoot, runtime);
  config.AI_WORKSPACE_ROOT = path.join(temporaryRoot, 'AI workspace');
  var comfyOnline = false;
  var desiredComfyDuringStop = null;
  var calls: { args: string|string[]; }[] = [];
  var router = createControlRouter(config, function () { return { tunnelUrl:'' }; }, {
    runScriptAsync:async function (script: string, args: string|string[]) {
      calls.push({ script:script, args:args });
      if (path.basename(script) === 'managed-comfyui.ps1') {
        var action = args[args.indexOf('-Action') + 1];
        if (action === 'Stop') {
          desiredComfyDuringStop = JSON.parse(fs.readFileSync(runtime.config, 'utf8')).managedServices.comfy;
        }
        comfyOnline = action === 'Start';
        return { ok:true, message:JSON.stringify({ ok:true, managed:comfyOnline, state:comfyOnline ? 'ready' : 'stopped', message:'mock comfy' }) };
      }
      return { ok:true, message:JSON.stringify({ managed:false }) };
    },
    refreshServiceStates:async function () {
      return { sdOnline:false, comfyOnline:comfyOnline, ttsOnline:false, ollamaOnline:false, ollamaModels:[], ollamaVram:0, webuiManaged:false, comfyManaged:comfyOnline };
    }
  });
  var app = express();
  app.use(router);
  var server = http.createServer(app);
  var base = await listen(server);
  try {
    var start = await postJson(base, '/api/service/comfy', { action:'start' });
    assert.strictEqual(start.status, 200);
    assert.strictEqual(start.json.pending, true);
    var ready: any = await waitFor(async function () {
      var status = await getJson(base, '/api/status');
      return status.json.operation && status.json.operation.status === 'completed' ? status.json : null;
    }, 'mock ComfyUI start');
    assert.strictEqual(ready.comfyOnline, true);
    assert.strictEqual(ready.comfyManaged, true);
    assert.ok(calls[0].args.includes('-AIWorkspaceRoot') && calls[0].args.includes('-RuntimeRoot'));
    var stop = await postJson(base, '/api/service/comfy', { action:'stop' });
    assert.strictEqual(stop.status, 200);
    var stopped: any = await waitFor(async function () {
      var status = await getJson(base, '/api/status');
      return status.json.operation && status.json.operation.status === 'completed' ? status.json : null;
    }, 'mock ComfyUI stop');
    assert.strictEqual(stopped.comfyOnline, false);
    assert.strictEqual(stopped.comfyManaged, false);
    assert.strictEqual(desiredComfyDuringStop, false, 'explicit stop must disable watchdog recovery before terminating ComfyUI');
    assert.strictEqual(JSON.parse(fs.readFileSync(runtime.config, 'utf8')).managedServices.comfy, false);
  } finally {
    if (router.close) router.close();
    await close(server);
    fs.rmSync(temporaryRoot, { recursive:true, force:true });
  }
});

test('managed runtime scripts require injected paths and protect external ownership', () => {
  var comfy = fs.readFileSync(path.join(projectRoot, 'scripts', 'lib', 'managed-comfyui.ps1'), 'utf8');
  var webui = fs.readFileSync(path.join(projectRoot, 'scripts', 'lib', 'managed-webui.ps1'), 'utf8');
  assert.ok(comfy.includes('$AIWorkspaceRoot') && comfy.includes('$RuntimeRoot') && comfy.includes('$ComfyHost'));
  assert.ok(webui.includes('$PackageRoot') && webui.includes('$RuntimeRoot') && webui.includes('$WebuiHost'));
  assert.ok(comfy.includes('Test-ManagedProcess') && comfy.includes('taskkill.exe /PID'));
  assert.ok(webui.includes('Test-ManagedProcess') && webui.includes('taskkill.exe /PID'));
  assert.ok(comfy.includes('/system_stats') && webui.includes('/sdapi/v1/sd-models'));
  assert.ok(webui.includes("'--nowebui'") && webui.includes("'--skip-load-model-at-start'"),
    'managed WebUI must expose its API before lazily loading the large checkpoint');
  assert.ok(webui.includes('--(?:api|nowebui)'),
    'managed WebUI ownership detection must accept API-only background mode');
  assert.ok(webui.includes('Wait-Ready([int]$seconds = 300)'),
    'managed WebUI must allow a real WAI cold load to finish before timing out');
  // 2026-08-21 用户决策：控制面板 Stop 也要能关掉手动启动的 ComfyUI / reForge。
  // 识别方式必须按端口 + 入口脚本名（main.py / launch.py）判定，不得仅凭 PID 文件。
  assert.ok(comfy.includes('Get-ExternalProcess') && webui.includes('Get-ExternalProcess'),
    'Stop must be able to identify a manually started instance on the configured port');
  assert.ok(comfy.includes('[Regex]::Escape([IO.Path]::GetFileName($mainPath))'),
    'ComfyUI external ownership must match the main.py entry command line');
  assert.ok(webui.includes('[Regex]::Escape([IO.Path]::GetFileName($launchPath))'),
    'WebUI external ownership must match the launch.py entry command line');
  assert.ok(comfy.includes('Get-NetTCPConnection') && webui.includes('Get-NetTCPConnection'),
    'external ownership must resolve via the listening port, not a PID file');
});

// 模拟“手动启动”的外部 ComfyUI / reForge：真实监听端口 + 健康接口 + 命令行
// 携带入口脚本名（main.py / launch.py），从而通过脚本的外部进程识别。
function startFakeService(options: any) {
  return new Promise(function (resolve, reject) {
    var entryName = options.entryName;
    var healthPath = options.healthPath;
    var freePortProbe = net.createServer();
    freePortProbe.once('error', reject);
    freePortProbe.listen(0, '127.0.0.1', function () {
      var port = freePortProbe.address!().port;
      freePortProbe.close(function () {
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-fake-' + entryName + '-'));
        var helper = path.join(dir, 'fake.js');
        fs.writeFileSync(helper, [
          "var http = require('http');",
          "var port = Number(process.argv[2]);",
          "var server = http.createServer(function (req, res) {",
          "  res.writeHead(String(req.url).indexOf('" + healthPath + "') === 0 ? 200 : 404);",
          "  res.end('{}');",
          "});",
          "server.listen(port, '127.0.0.1', function () { console.log('READY ' + port); });"
        ].join('\n'), 'utf8');
        // node <helper> <port> main.py|launch.py：入口脚本名挂在命令行末位
        var child = childProcess.spawn(process.execPath, [helper, String(port), entryName], {
          stdio:['ignore', 'pipe', 'ignore'],
          windowsHide:true
        });
        var timer = setTimeout(function () {
          child.kill();
          reject(new Error('fake service did not become ready'));
        }, 4000);
        child.stdout.on('data', function (chunk) {
          if (String(chunk).indexOf('READY') >= 0) {
            clearTimeout(timer);
            resolve({ child:child, port:port, dir:dir });
          }
        });
        child.on('exit', function () {
          clearTimeout(timer);
          reject(new Error('fake service exited early'));
        });
      });
    });
  });
}

function waitForExit(child: any) {
  return new Promise(function (resolve) {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', resolve);
  });
}

test('managed-comfyui Stop refuses to kill an unrelated process on the configured port', WINDOWS_POWERSHELL_TEST, async () => {
  var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-comfy-script-'));
  // 端口被与本项目无关的进程占用（这里就是测试进程自己）：命令行不含 main.py，
  // Stop 必须视之为不可识别并保持不碰。
  var health = http.createServer(function (req, res) {
    res.statusCode = req.url === '/system_stats' ? 200 : 404;
    res.end('{}');
  });
  var base: any = await listen(health);
  function invoke(action: string) {
    return new Promise(function (resolve, reject) {
      childProcess.execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(projectRoot, 'scripts', 'lib', 'managed-comfyui.ps1'), '-Action', action,
        '-AIWorkspaceRoot', path.join(temporaryRoot, 'workspace'), '-RuntimeRoot', path.join(temporaryRoot, 'runtime'), '-ComfyHost', base],
        { windowsHide:true }, function (error: any, stdout: any, _stderr: any) {
          if (error && !stdout) return reject(error);
          resolve(JSON.parse(String(stdout).trim()));
        });
    });
  }
  try {
    var status: any = await invoke('Status');
    assert.strictEqual(status.state, 'external-running');
    assert.strictEqual(status.managed, false);
    var stopped: any = await invoke('Stop');
    assert.strictEqual(stopped.state, 'external-or-stopped');
    assert.strictEqual(stopped.managed, false);
    var stillUp = await getJson(base, '/system_stats');
    assert.strictEqual(stillUp.status, 200, 'an unrelated process must survive a ComfyUI Stop');
  } finally {
    await close(health);
    fs.rmSync(temporaryRoot, { recursive:true, force:true });
  }
});

test('managed-comfyui Stop closes a recognized externally started ComfyUI', WINDOWS_POWERSHELL_TEST, async () => {
  var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-comfy-stop-'));
  var fake: any = await startFakeService({ entryName:'main.py', healthPath:'/system_stats' });
  var base = 'http://127.0.0.1:' + fake.port;
  function invoke(action: string) {
    return new Promise(function (resolve, reject) {
      childProcess.execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(projectRoot, 'scripts', 'lib', 'managed-comfyui.ps1'), '-Action', action,
        '-AIWorkspaceRoot', path.join(temporaryRoot, 'workspace'), '-RuntimeRoot', path.join(temporaryRoot, 'runtime'), '-ComfyHost', base],
        { windowsHide:true }, function (error, stdout, _stderr) {
          if (error && !stdout) return reject(error);
          resolve(JSON.parse(String(stdout).trim()));
        });
    });
  }
  try {
    var status: any = await invoke('Status');
    assert.strictEqual(status.state, 'external-running');
    var stopped: any = await invoke('Stop');
    assert.strictEqual(stopped.state, 'stopped');
    assert.strictEqual(stopped.managed, false);
    await waitForExit(fake.child);
    var stillUp = await fetch(base + '/system_stats').then(function () { return true; }, function () { return false; });
    assert.strictEqual(stillUp, false, 'a recognized external ComfyUI must be closed by Stop');
  } finally {
    if (fake.child.exitCode === null) fake.child.kill();
    fs.rmSync(temporaryRoot, { recursive:true, force:true });
    fs.rmSync(fake.dir, { recursive:true, force:true });
  }
});

test('managed-webui Stop closes a recognized externally started reForge', WINDOWS_POWERSHELL_TEST, async () => {
  var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-webui-stop-'));
  var fake: any = await startFakeService({ entryName:'launch.py', healthPath:'/sdapi/v1/sd-models' });
  var base = 'http://127.0.0.1:' + fake.port;
  function invoke(action: string) {
    return new Promise(function (resolve, reject) {
      childProcess.execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(projectRoot, 'scripts', 'lib', 'managed-webui.ps1'), '-Action', action,
        '-PackageRoot', path.join(temporaryRoot, 'package'), '-RuntimeRoot', path.join(temporaryRoot, 'runtime'),
        '-WebuiHost', base, '-ImagesRoot', path.join(temporaryRoot, 'images'), '-ControlNetRoot', path.join(temporaryRoot, 'controlnet')],
        { windowsHide:true }, function (error, stdout, _stderr) {
          if (error && !stdout) return reject(error);
          resolve(JSON.parse(String(stdout).trim()));
        });
    });
  }
  try {
    var status: any = await invoke('Status');
    assert.strictEqual(status.state, 'external-running');
    var stopped: any = await invoke('Stop');
    assert.strictEqual(stopped.state, 'stopped');
    assert.strictEqual(stopped.managed, false);
    await waitForExit(fake.child);
    var stillUp = await fetch(base + '/sdapi/v1/sd-models').then(function () { return true; }, function () { return false; });
    assert.strictEqual(stillUp, false, 'a recognized external reForge must be closed by Stop');
  } finally {
    if (fake.child.exitCode === null) fake.child.kill();
    fs.rmSync(temporaryRoot, { recursive:true, force:true });
    fs.rmSync(fake.dir, { recursive:true, force:true });
  }
});

// 自愈看门狗单测随控制面失败契约一起跑（validate 已串接本文件）。
