'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * 运行条件元数据（W1）枚举。run.nature / run.switches 的值取自 EFFECTS，
 * run.machine 取自 MACHINES；仅用于 help/plan/audit 展示与审计，
 * runner 执行路径（main/plan/invocation）不读取元数据、不据此拦截。
 */
const EFFECTS = Object.freeze([
  'read-only',          // 不写任何盘上状态
  'preview',            // 只打印将执行/将变更的内容
  'self-heal-missing',  // 前置产物缺失时落盘重建（仅缺失场景）
  'guard',              // 校验守卫：不一致/缺失即退出非零
  'writes-source',      // 写语义源（data/ 分片、standards/view、DATA_VERSION、版本文件）
  'writes-product',     // 写生成产物（聚合、dist、图片、候选、报告）
  'writes-release',     // 写发布/安装产物（showcase 版本目录、安装包、更新产物）
  'writes-baseline',    // 重写门禁基线文件
  'delete',             // 删除文件/目录
  'external-model',     // 调用本地网关/ComfyUI/视觉模型
  'network-download',   // 从外网下载
  'publish-remote',     // 推送远端（GitHub Releases 等）
  'service',            // 启动长驻服务
  'isolated-fixture',   // 仅使用临时夹具，不触碰生产数据
]);
const MACHINES = Object.freeze([
  'node', 'windows', 'windows-toolchain', 'python-pillow', 'gateway',
  'comfyui', 'vision-api', 'network', 'playwright-browser', 'build-present',
]);
const RESUME_MODES = Object.freeze(['idempotent', 'checkpoint', 'na']);
/** 描述性标签无需在复合项中逐个重复；有副作用的子项必须被完整声明。 */
const PASSIVE_EFFECTS = Object.freeze(['read-only', 'preview', 'isolated-fixture']);

/** 校验单个注册项的 run 元数据；返回错误消息数组（空 = 合法）。 */
function validateRun(name, def) {
  const errors = [];
  const run = def.run;
  if (!run || typeof run !== 'object') {
    errors.push(`${name}: 缺少 run 运行条件元数据`);
    return errors;
  }
  const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
  const nature = list(run.nature);
  if (!Array.isArray(run.nature)) errors.push(`${name}: run.nature 必须是数组`);
  if (!nature.length) errors.push(`${name}: run.nature 不能为空`);
  for (const effect of nature) if (!EFFECTS.includes(effect)) errors.push(`${name}: 未知 nature "${effect}"（合法值见 EFFECTS）`);
  const machine = list(run.machine);
  if (!Array.isArray(run.machine)) errors.push(`${name}: run.machine 必须是数组`);
  if (!machine.length) errors.push(`${name}: run.machine 不能为空`);
  for (const item of machine) if (!MACHINES.includes(item)) errors.push(`${name}: 未知 machine "${item}"`);
  if (run.switches != null && typeof run.switches === 'object' && !Array.isArray(run.switches)) {
    for (const [flag, effects] of Object.entries(run.switches)) {
      if (!flag.startsWith('--')) errors.push(`${name}: 开关名必须以 -- 开头（${flag}）`);
      const values = list(effects);
      if (!Array.isArray(effects)) errors.push(`${name}: 开关 ${flag} 的行为必须是数组`);
      if (!values.length) errors.push(`${name}: 开关 ${flag} 的行为不能为空`);
      for (const effect of values) if (!EFFECTS.includes(effect)) errors.push(`${name}: 开关 ${flag} 未知行为 "${effect}"`);
    }
  } else if (run.switches != null) {
    errors.push(`${name}: run.switches 必须是对象`);
  }
  if (!RESUME_MODES.includes(run.resume)) errors.push(`${name}: resume 必须是 ${RESUME_MODES.join('|')} 之一`);
  const evidence = list(run.evidence).filter((item) => String(item).trim());
  if (!evidence.length) errors.push(`${name}: run.evidence 必须指向核实位置（文件:行）`);
  if (run.unknown != null && !Array.isArray(run.unknown)) errors.push(`${name}: run.unknown 必须是数组`);
  return errors;
}

function audit(registry, root) {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const errors = [];
  for (const [name, def] of Object.entries(registry)) {
    if (!def.cmd && !def.steps && !def.builtin) errors.push(`${name}: 缺少入口`);
    if (def.cmd?.includes('--help')) errors.push(`${name}: 固定 --help 阻止执行`);
    if (def.cmd?.[0] === 'npm' && !scripts[def.cmd[1] === 'run' ? def.cmd[2] : def.cmd[1]]) errors.push(`${name}: npm 入口不存在`);
    for (const arg of def.cmd || []) {
      if (/^(scripts\/|deploy-desktop\.bat)/.test(arg) && !fs.existsSync(path.join(root, arg))) errors.push(`${name}: 文件不存在 ${arg}`);
    }
    if (def.docs && !fs.existsSync(path.join(root, def.docs.split('#')[0].replace(/:\d+$/, '')))) errors.push(`${name}: 文档不存在 ${def.docs}`);
    try {
      const children = expand(name, [], registry);
      if (def.steps) {
        const effects = new Set(children.flatMap(child => Array.isArray(child.def.run?.nature) ? child.def.run.nature : []));
        for (const effect of effects) {
          if (!PASSIVE_EFFECTS.includes(effect) && !def.run?.nature?.includes(effect)) errors.push(`${name}: 复合工作流遗漏子步骤行为 ${effect}`);
        }
      }
    } catch (error) { errors.push(error.message); }
    errors.push(...validateRun(name, def));
  }
  return { count: Object.keys(registry).length, errors, ok: errors.length === 0 };
}

function expand(name, args, registry, parents = []) {
  const def = registry[name];
  if (!def) throw new Error(`未知工作流: ${name}`);
  if (parents.includes(name)) throw new Error(`复合步骤循环: ${[...parents, name].join(' → ')}`);
  if (!def.steps) return [{ name, args, def }];
  if (args.length) throw new Error(`${name} 不共享参数；请分别执行子步骤，或 showcase:full 使用 --output 与 --target。`);
  return def.steps.flatMap(step => expand(step, [], registry, [...parents, name]));
}

function option(args, key) {
  const i = args.indexOf(key);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

function plan(name, args, registry) {
  if (name !== 'showcase:full') return expand(name, args, registry);
  const allowed = ['--output', '--target', '--source', '--showcase', '--gateway', '--keys', '--concurrency', '--limit'];
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !option(args, args[i])) throw new Error(`showcase:full 参数无效: ${args[i]}`);
  }
  const output = option(args, '--output');
  const target = option(args, '--target');
  const source = option(args, '--source');
  if (!output || !target || !source) throw new Error('showcase:full 需要 --output <候选目录> --source <现有版本> --target <新版本>；默认仅预览发布。');
  const manifest = path.join(output, 'generation-manifest.json');
  return [
    { name: 'showcase:generate', args: ['--output', output, ...['--gateway', '--keys', '--concurrency', '--limit'].flatMap(k => option(args, k) ? [k, option(args, k)] : [])] },
    { name: 'showcase:audit', args: ['--manifest', manifest, '--out', path.join(output, 'audit-results.json')] },
    { name: 'showcase:publish', args: ['--from', manifest, '--source', source, '--target', target, ...(option(args, '--showcase') ? ['--showcase', option(args, '--showcase')] : [])] },
  ].map(step => ({ ...step, def: registry[step.name] }));
}

function invocation(def, args) {
  const [cmd, ...defaults] = def.cmd;
  if (cmd === 'node') return [process.execPath, [...defaults, ...args]];
  if (cmd === 'npm') {
    // Invoke npm's JS entry so spaces and shell metacharacters remain literal arguments.
    const cli = process.env.npm_execpath || [
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ].find(file => fs.existsSync(file));
    if (!cli) throw new Error('无法定位 npm；请使用 npm run wf -- <命令>。');
    return [process.execPath, [cli, ...defaults, ...(args.length && !defaults.includes('--') ? ['--'] : []), ...args]];
  }
  return [cmd, [...defaults, ...args]];
}

function main(argv, registry, root, run = spawnSync) {
  try {
    const [name, ...raw] = argv;
    if (name === 'audit:workflows' && !raw.includes('--help')) {
      const result = audit(registry, root);
      console.log(raw.includes('--json') ? JSON.stringify(result, null, 2) : `${result.ok ? 'PASS' : 'FAIL'} · ${result.count} 个入口\n${result.errors.join('\n')}`);
      return result.ok ? 0 : 1;
    }
    const help = !name || argv.includes('--help') || argv.includes('-h');
    const search = name === 'search';
    if (help || search || (name && !registry[name] && Object.keys(registry).some(k => k.startsWith(name + ':')))) {
      const query = search ? raw.join(' ').toLowerCase() : '';
      const entries = Object.entries(registry).filter(([k, v]) => search ? `${k} ${v.desc}`.toLowerCase().includes(query) : !name || name.startsWith('-') || k === name || k.startsWith(name + ':'));
      if (!entries.length) throw new Error(`没有匹配工作流: ${name} ${query}`);
      console.log('用法: npm run wf -- <命令> [参数]；search <关键词>；--plan 只预览；audit:workflows --json 只读审计');
      for (const [k, v] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`${k.padEnd(25)} ${v.desc}`);
        if (k === name) console.log(JSON.stringify({ command: v.cmd, steps: v.steps, required: v.required, options: v.opts, docs: v.docs, needs: v.needs, run: v.run }, null, 2));
      }
      return 0; // Never execute a child for discovery/help.
    }
    const preview = raw.includes('--plan');
    const steps = plan(name, raw.filter(a => a !== '--plan'), registry);
    for (const { name: step, args, def } of steps) {
      for (const key of def.required || []) if (!option(args, key)) throw new Error(`${step} 需要 ${key} <值>；使用 --help 查看入口。`);
    }
    for (const { name: step, args, def } of steps) {
      const [cmd, cmdArgs] = invocation(def, args);
      // 保留默认与各开关说明的区别，不将 --apply 错标成仅预览，也不猜组合开关优先级。
      const conditions = preview && def.run
        ? Object.entries(def.run.switches || {}).filter(([flag]) => cmdArgs.some(arg => arg === flag || arg.startsWith(flag + '=')))
          .map(([flag, effects]) => `[${flag}: ${effects.join(', ')}]`) : [];
      const tags = preview && def.run ? ` [默认: ${(def.run.nature || []).join(', ')}]${conditions.length ? ' ' + conditions.join(' ') : ''}` : '';
      console.error(`${preview ? '[预览]' : '[执行]'} ${step}: ${JSON.stringify([cmd, ...cmdArgs])}${tags}`);
      if (preview) continue;
      const batch = cmd.endsWith('.bat');
      if (batch && process.platform !== 'win32') throw new Error('桌面部署仅支持 Windows。');
      // The batch entry accepts only switches; never interpolate arbitrary paths into cmd.exe.
      if (batch && cmdArgs.some(a => !/^-[A-Za-z]+$/.test(a))) throw new Error('桌面入口仅接受开关参数。');
      const result = run(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: batch, windowsHide: true, env: { ...process.env, AICS_WORKFLOW_NONINTERACTIVE: '1' } });
      if (result.error || result.status !== 0) {
        console.error(`${step} 失败: ${result.error?.message || result.signal || result.status}`);
        return result.status || 1;
      }
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

module.exports = { main, plan, audit, invocation, validateRun, EFFECTS, MACHINES, RESUME_MODES, PASSIVE_EFFECTS };
