'use strict';

import { Dirent } from 'node:fs';

/**
 * 桌宠本地工具执行器（从 desktop/toolRunner.ts 下沉到网关的 CJS 版）。
 *
 * 安全边界（与 toolRunner.ts 一致）：
 * - localOnly：仅本机可调（localOnly 网关级）。
 * - 所有路径解析后必须落在 AI 工作区（AI_WORKSPACE_ROOT）内（Windows 大小写不敏感）。
 * - 文件工具核对链接的实际目标；通用命令默认关闭。
 * - 命令只在操作员显式启用 trusted 档时可用，具有当前系统账户权限，非工作区沙箱。
 * - 参数数组执行、白名单、取消与输出限制仍适用于受信任命令。
 * - 读 1MB / 写 512KB / 命令 120s 超时 + 64KB 输出上限。
 */

let express: typeof import('express') = require('express');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let runToolProcess = (require('../server/tool-process') as typeof import('../server/tool-process')).runToolProcess;
let crypto: typeof import('crypto') = require('crypto');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
let validationCore: typeof import('../server/validation-core') = require('../server/validation-core');
let workspacePaths: typeof import('../server/workspace-path') = require('../server/workspace-path');
let isPathInsideWorkspace = workspacePaths.isPathInsideWorkspace;
let resolveWorkspacePath = workspacePaths.resolveWorkspacePath;
let resolveToolCommand = (require('../server/tool-command') as typeof import('../server/tool-command')).resolveToolCommand;

let MAX_READ_BYTES = 1024 * 1024;
let MAX_WRITE_BYTES = 512 * 1024;
let MAX_COMMAND_OUTPUT = 64 * 1024;
let COMMAND_TIMEOUT_MS = 120 * 1000;
let MAX_DISPLAY_CHARS = 500 * 1000;
let MAX_IMAGE_BYTES = 8 * 1024 * 1024;
let IMAGE_MAGIC = [
  { magic: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { magic: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { magic: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
  { magic: [0x47, 0x49, 0x46], mime: 'image/gif' },
];

/** run_command 白名单：只有这些解释器/常用工具可以裸名执行。 */
let ALLOWED_COMMANDS = Object.freeze(new Set([
  'python', 'python3', 'pythonw', 'pwsh', 'powershell',
  'node', 'npm', 'npx', 'git', 'conda',
].map(function (name) { return name.toLowerCase(); })));

/**
 * 成人内容白名单契约（AGENTS.md 红线 #4 的网关侧落地，与前端 popularContent.ts
 * 的 adultEligibility 契约同源）：仅内容契约中确认成人的角色可注入裸露 token
 * （宁宁/夏目，对应 nene_r18/natsume_r18 门控词）。未知角色一律 fail-closed 拒绝。
 * adultEnabled 则必须来自传输层显式授权（请求体顶层字段，由前端本机环境开关派生），
 * 模型在 args 里自行声明无效 —— 双门齐备才放行。白名单常量定义于
 * server/validation-core.js。
 */

/**
 * R18 双门校验（AGENTS.md 红线 #4）：白名单与授权判定收口在
 * server/validation-core.js（2026-08-28 审计 P1-6，此前 4 处实现漂移）。
 * 本家族保留返回值形态：返回 null 表示放行，否则返回带 code 的拒绝结果
 * （由调用方转成带 code 的 Error 抛出）。
 * @param {string} targetChar 归一化后的角色 ID
 * @param {{adultEnabled?: boolean}} [context] 传输层授权上下文
 */
function assertAdultAllowed(targetChar: string, context: any) {
  let denial = validationCore.evaluateAdultAccess(targetChar, context && context.adultEnabled);
  if (!denial) return null;
  return {
    code: denial.reason === 'CHARACTER_NOT_ELIGIBLE' ? 'adult_character_not_eligible' : 'adult_not_enabled',
    message: denial.message,
  };
}

/**
 * run_command 命令校验收紧：裸命令必须是白名单解释器；含路径分隔符时必须
 * 是工作区内脚本的相对路径（禁止绝对路径与 `..` 穿越）。都是参数数组 execFile，
 * 无 shell 注入面。
 */
function assertSafeCommand(root: string, command: string) {
  let value = String(command || '').trim();
  if (!value) throw new Error('缺少命令');
  let hasPathSeparator = /[/\\]/.test(value);
  if (!hasPathSeparator) {
    let base = value.replace(/\.exe$/i, '').toLowerCase();
    if (/^(npm|npx)\.cmd$/i.test(base)) base = base.slice(0, -4);
    if (ALLOWED_COMMANDS.has(base)) return value;
    throw new Error('命令不在允许列表（python/pwsh/node/npm/npx/git/conda）或缺少工作区内脚本相对路径');
  }
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    throw new Error('只接受工作区内的相对脚本路径');
  }
  if (value.split(/[\\/]/).some(function (part) { return part === '..'; })) {
    throw new Error('脚本路径不能包含 ..');
  }
  let resolved = path.resolve(root, value);
  if (!isPathInsideWorkspace(root, resolved)) {
    throw new Error('脚本路径超出 AI 工作区范围');
  }
  return resolveWorkspacePath(root, value);
}

function sniffImageMime(buffer: number[]|NonSharedBuffer) {
  for (let i = 0; i < IMAGE_MAGIC.length; i += 1) {
    let candidate = IMAGE_MAGIC[i];
    let match = candidate.magic.every(function (byte, index) {
      return buffer[index] === byte;
    });
    if (match) return candidate.mime;
  }
  return null;
}

function formatEntryName(entry: Dirent<string>) {
  return entry.isDirectory() ? entry.name + '/' : entry.name;
}

function runTool(workspaceRoot: any, name: string, args: any, context?: any) {
  let root = path.resolve(workspaceRoot || '.');
  context = context || {};
  function checkCancelled() {
    if (context.signal && context.signal.aborted) {
      throw Object.assign(new Error('工具操作已取消'), { code: 'ABORT_ERR' });
    }
  }
  function fail(error: any) {
    let message = String(error instanceof Error ? error.message : error).slice(0, 2000);
    let payload: any = { ok: false, output: message };
    // 信封对齐（server/http-envelope.js 形状）：error/msg 与 output 同镜像，
    // 新代码读 error；output 保留 —— 它会作为 tool 消息回传给对话模型。
    payload.error = message;
    payload.msg = message;
    if (error instanceof Error && error.code) payload.code = error.code;
    return payload;
  }
  return Promise.resolve().then(function () {
    checkCancelled();
    switch (name) {
      case 'list_files': {
        let dir = resolveWorkspacePath(root, String(args.path || ''));
        return fs.promises.readdir(dir, { withFileTypes: true })
          .then(function (entries) {
            let rows = entries
              .sort(function (a, b) {
                return a.isDirectory() === b.isDirectory()
                  ? a.name.localeCompare(b.name)
                  : a.isDirectory() ? -1 : 1;
              })
              .slice(0, 200)
              .map(function (entry) {
                let extra = '';
                if (!entry.isDirectory()) {
                  try {
                    let stat = fs.lstatSync(path.join(dir, entry.name));
                    extra = ' (' + stat.size + ' B)';
                  } catch (e) { /* 忽略瞬时不可读 */ }
                }
                return formatEntryName(entry) + extra;
              });
            let count = entries.length > 200
              ? '（前 200 项，共 ' + entries.length + ' 项）'
              : '共 ' + entries.length + ' 项';
            return { ok: true, output: '[' + dir + ']\n' + (rows.join('\n') || '(空目录)') + '\n' + count };
          })
          .catch(function (error) {
            throw new Error('目录不存在或不可读：' + String(error.message || error));
          });
      }
      case 'read_file': {
        let file = resolveWorkspacePath(root, String(args.path || ''));
        return fs.promises.stat(file).then(function (stat) {
          if (!stat.isFile()) throw new Error('目标不是文件');
          if (stat.size > MAX_READ_BYTES) throw new Error('文件超过 ' + (MAX_READ_BYTES / 1024) + 'KB 读取上限');
          return fs.promises.readFile(file);
        }).then(function (buffer) {
          if (buffer.includes(0)) throw new Error('看起来是二进制文件，不读取');
          let text = buffer.toString('utf8');
          if (text.length > MAX_DISPLAY_CHARS) text = text.slice(0, MAX_DISPLAY_CHARS) + '\n…（内容已截断）';
          return { ok: true, output: text };
        });
      }
      case 'write_file': {
        let writeFile = resolveWorkspacePath(root, String(args.path || ''));
        let content = String(args.content || '');
        if (content.length > MAX_WRITE_BYTES) throw new Error('内容超过 ' + (MAX_WRITE_BYTES / 1024) + 'KB 写入上限');
        return fs.promises.mkdir(path.dirname(writeFile), { recursive: true })
          .then(function () {
            checkCancelled();
            resolveWorkspacePath(root, String(args.path || ''));
            let temporary = writeFile + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tool.tmp';
            return fs.promises.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
              .then(function () {
                checkCancelled();
                resolveWorkspacePath(root, String(args.path || ''));
                return fs.promises.rename(temporary, writeFile);
              })
              .finally(function () { return fs.promises.rm(temporary, { force: true }); });
          })
          .then(function () {
            return { ok: true, output: '已写入 ' + (path.relative(root, writeFile) || path.basename(writeFile)) + '（' + content.length + ' 字符）' };
          });
      }
      case 'run_command': {
        if (context.trustedCommands !== true) {
          throw Object.assign(new Error('通用命令默认关闭：此能力可访问当前系统账户的文件，并非仅限工作区。仅操作员可通过 AICS_DESKTOP_COMMANDS=trusted 启用后重启网关'), { code: 'TRUSTED_EXECUTION_REQUIRED' });
        }
        let command = String(args.command || '').trim();
        let rawArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        if (!command) throw new Error('缺少命令');
        // 2026-08-16 审计：命令校验收紧——白名单解释器或工作区内相对脚本。
        command = assertSafeCommand(root, command);
        if (command.length > 256) throw new Error('命令名过长');
        if (rawArgs.length > 16) throw new Error('参数过多');
        if (rawArgs.some(function (arg: string|any[]) { return arg.length > 256; })) throw new Error('参数过长');
        let executable = resolveToolCommand(command, rawArgs);
        return runToolProcess(executable.command, executable.args, {
            cwd: root,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_COMMAND_OUTPUT,
            signal: context.signal,
            env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
        }).then(function (result) {
          return { ok: true, output: (result.stdout + result.stderr).trim() || '（命令已执行，无输出）' };
        });
      }
      case 'read_image': {
        let imageFile = resolveWorkspacePath(root, String(args.path || ''));
        return fs.promises.stat(imageFile).then(function (stat) {
          if (!stat.isFile()) throw new Error('目标不是文件');
          if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 ' + (MAX_IMAGE_BYTES / 1024 / 1024) + 'MB 上限');
          return fs.promises.readFile(imageFile);
        }).then(function (buffer) {
          let mime = sniffImageMime(buffer);
          if (!mime) throw new Error('不支持的文件格式（仅 PNG / JPEG / WebP / GIF）');
          return {
            ok: true,
            output: '已读取图片 ' + (path.relative(root, imageFile) || path.basename(imageFile)) + '（' + buffer.length + ' B，' + mime.replace('image/', '') + '）',
            imageDataUrl: 'data:' + mime + ';base64,' + buffer.toString('base64'),
          };
        });
      }
      case 'get_workspace_info': {
        let exists = fs.existsSync(root);
        return { ok: true, output: JSON.stringify({ workspaceRoot: root, exists: exists, os: process.platform, commandMode: context.trustedCommands === true ? 'trusted-system-account' : 'disabled' }) };
      }
      case 'capture_screen': {
        if (process.platform !== 'win32') {
          throw new Error('当前系统暂不支持原生屏幕截取');
        }
        let psScript = [
          'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
          '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
          '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
          '$ms = New-Object System.IO.MemoryStream',
          '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
          '$bytes = $ms.ToArray()',
          '$g.Dispose()',
          '$bmp.Dispose()',
          '$ms.Dispose()',
          '[System.Convert]::ToBase64String($bytes)'
        ].join('\n');

        return runToolProcess('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
            maxBuffer: 20 * 1024 * 1024,
            timeout: 10000,
            signal: context.signal,
        }).then(function (result) {
            let base64 = result.stdout.trim();
            if (!base64) throw new Error('未捕获到屏幕数据');
            return {
              ok: true,
              output: '已成功捕获当前桌面屏幕画面（' + Math.round(base64.length * 0.75 / 1024) + ' KB JPEG）',
              imageDataUrl: 'data:image/jpeg;base64,' + base64,
            };
        });
      }
      case 'generate_character_image': {
        let char = String(args.character || 'natsume').toLowerCase().trim();
        let desc = String(args.description || '').trim();
        if (!desc) throw new Error('缺少画面描述（description）');

        let isNatsume = char.includes('natsume') || char.includes('夏目');
        let isNene = char.includes('nene') || char.includes('宁宁');
        let targetChar = isNatsume ? 'natsume' : (isNene ? 'nene' : char);

        let promptTokens = [];
        let loras = [];

        if (targetChar === 'natsume') {
          promptTokens.push('shiki_natsume', '1girl', 'solo', 'mole under right eye');
          loras.push({ id: 'L_NAT_V21_ANIMA', strength: 0.85 });
        } else if (targetChar === 'nene') {
          promptTokens.push('ayachi_nene', '1girl', 'solo', 'ahoge', 'mole under left eye');
          loras.push({ id: 'L_NENE_V21_ANIMA', strength: 0.85 });
        } else {
          promptTokens.push(targetChar, '1girl', 'solo');
        }

        let wantsMature = args.outfit === 'nsfw_nude' || args.mature === true;
        if (wantsMature) {
          // R18 双门（fail-closed）：adultEligibility 白名单 × 传输层 adultEnabled 授权。
          // 任一不满足即整体拒绝 —— 不回退到安全 token，也不写入任何生成元数据。
          let denial = assertAdultAllowed(targetChar, context);
          if (denial) {
            let refusal: any = new Error(denial.message);
            refusal.code = denial.code;
            throw refusal;
          }
          promptTokens.push('completely naked', 'full body bare', 'natural skin');
        } else if (args.outfit && typeof args.outfit === 'string') {
          promptTokens.push(args.outfit);
        }

        promptTokens.push(desc);
        let outDir = resolveWorkspacePath(root, 'generated-images');
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }
        let timestamp = Date.now();
        let fileCharacter = encodeURIComponent(targetChar).replace(/\./g, '%2E').slice(0, 100);
        let metaFile = 'companion_' + fileCharacter + '_' + timestamp + '.json';
        let charName = targetChar === 'natsume' ? '四季夏目' : targetChar === 'nene' ? '绫地宁宁' : targetChar;

        let metaPayload = {
          character: targetChar,
          characterName: charName,
          description: desc,
          promptTokens: promptTokens,
          loras: loras,
          outfit: args.outfit || 'default',
          // 审计字段如实记录：outfit=nsfw_nude 同样视为成人内容（与 wantsMature 判定同源）
          mature: wantsMature,
          createdAt: timestamp,
          status: 'draft'
        };
        fs.writeFileSync(path.join(outDir, metaFile), JSON.stringify(metaPayload, null, 2), 'utf8');

        return {
          ok: true,
          status: 'draft',
          output: '已为角色【' + charName + '】保存绘画草稿：“' + desc + '”。尚未提交生成任务，也未生成图片；请在工作台确认后出图。',
          character: targetChar,
          draftRelativePath: 'generated-images/' + metaFile,
        };
      }
      default:
        throw new Error('未知工具：' + name);
    }
  }).then(function (result) { checkCancelled(); return result; }).catch(fail);
}

function createDesktopToolsRouter(options?: any) {
  options = options || {};
  let router = express.Router();
  let security = options.security || (require('../server/security') as typeof import('../server/security'));
  let config = options.config || (require('../server/config') as typeof import('../server/config')).loadGatewayConfig(path.join(__dirname, '..'), process.env);

  router.use('/api/desktop-tools', express.json({ limit: '768kb' }));
  router.use('/api/desktop-tools', security.localOnly);

  router.post('/api/desktop-tools', function (req, res) {
    let payload = req.body && typeof req.body === 'object' ? req.body : {};
    let name = typeof payload.name === 'string' ? payload.name : '';
    let args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
      ? payload.args
      : {};
    if (!name) {
      envelope.fail(res, 400, '缺少工具名', { output: '缺少工具名' });
      return;
    }
    let workspaceRoot = config.AI_WORKSPACE_ROOT;
    // 成人授权取请求体顶层字段（严格 === true），与模型可控的 args 隔离
    let controller = new AbortController();
    let cancel = function () { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', cancel);
    res.once('close', cancel);
    if (req.aborted || res.destroyed) controller.abort();
    let context = { adultEnabled: payload.adultEnabled === true, signal: controller.signal, trustedCommands: config.DESKTOP_TRUSTED_COMMANDS === true };
    runTool(workspaceRoot, name, args, context).then(function (result) {
      if (!res.destroyed) res.json(result);
    }).catch(function (error) {
      if (res.destroyed) return;
      let err: any = error instanceof Error ? error : new Error(String(error));
      let extra: any = { output: String(err.message).slice(0, 2000) };
      if (err.code) extra.code = err.code;
      envelope.fail(res, envelope.statusFor(err, 500), err.message, extra);
    }).finally(function () {
      req.removeListener('aborted', cancel);
      res.removeListener('close', cancel);
    });
  });

  return router;
}

export = { createDesktopToolsRouter: createDesktopToolsRouter, runTool: runTool, isPathInsideWorkspace: isPathInsideWorkspace, resolveWorkspacePath: resolveWorkspacePath };
