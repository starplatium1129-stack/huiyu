import type { RegisteredWorkflows } from './workflow-types';

/** Manual diagnostics only: registry help/plan/audit never invokes these targets. */
const workflows: RegisteredWorkflows = {
  'diagnostics:window-capture': {
    desc: '显式人工 PrintWindow 窗口截图；写 PNG，不是自动设备验收',
    cmd: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/maintenance/capture-window.ps1'],
    required: ['-Out'], opts: '-Out <runtime内PNG路径> [-Title <准确窗口标题>] [-ProcessId <PID>] [-Scale <倍率，默认2>]',
    docs: 'docs/workflow.md#桌面人工诊断', needs: 'Windows；目标窗口已运行；输出父目录已存在',
    run: { nature: ['writes-product'], machine: ['windows'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/capture-window.ps1',
      unknown: ['PrintWindow 与原生 Overlay/WebView2 的实际像素完整性'],
      notes: ['仅显式调用；按PID主窗口或完整标题定位；现有PNG可被覆盖；工作流要求明确-Out，不执行默认当前目录截图'] },
  },
  'diagnostics:companion-shot': {
    desc: '显式人工 CDP 桌宠 DOM 状态与截图；固定截图路径可能覆盖旧文件',
    cmd: ['node', 'scripts/maintenance/cdp-shot.js'], docs: 'docs/workflow.md#桌面人工诊断',
    needs: '已运行的本机 Companion WebView；显式开启127.0.0.1:9222 CDP；现有Playwright依赖',
    run: { nature: ['writes-product'], machine: ['node', 'windows', 'playwright-browser'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/cdp-shot.ts',
      unknown: ['实际窗口、Overlay像素和GPU状态需人工核实'],
      notes: ['仅显式调用，不启动桌面或推理服务；选择CDP枚举中最后一个URL含/companion的页面；固定写C:/Users/Administrator/Desktop/_cdp_window.png，当前不接受输出参数'] },
  },
  'diagnostics:companion-state': {
    desc: '显式人工 CDP 桌宠状态诊断；临时显示既有UI，向标准输出报告DOM',
    cmd: ['node', 'scripts/maintenance/cdp-verify.js'], docs: 'docs/workflow.md#桌面人工诊断',
    needs: '已运行的本机 Companion WebView；显式开启127.0.0.1:9222 CDP；现有Playwright依赖',
    run: { nature: ['writes-product'], machine: ['node', 'windows', 'playwright-browser'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/cdp-verify.ts',
      unknown: ['DOM不证明原生像素、GPU或设备通过'],
      notes: ['仅显式调用；移除companion-ui-hidden会改变当前窗口界面；不写截图文件、不恢复原隐藏类；选择最后一个匹配页面'] },
  },
  'diagnostics:companion-taps': {
    desc: '显式人工 CDP 桌宠四位置点击诊断；会操作真实UI与既有互动链',
    cmd: ['node', 'scripts/maintenance/cdp-taps.js'], docs: 'docs/workflow.md#桌面人工诊断',
    needs: '已运行的本机 Companion WebView；显式开启127.0.0.1:9222 CDP；操作员确认目标及当前互动/语音配置',
    run: { nature: ['writes-product', 'external-model'], machine: ['node', 'windows', 'playwright-browser', 'gateway'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/cdp-taps.ts',
      unknown: ['点击后的模型/音频调用与持久状态由目标窗口当前设置决定'],
      notes: ['仅显式调用；取消隐藏并点击当前舞台头部、手部、衣裙和腿部；可能触发已配置互动、语音与状态更新，不属于无副作用测试'] },
  },
  'diagnostics:companion-interact': {
    desc: '显式人工 CDP 桌宠点击及旧切角入口诊断；可能改变当前角色与互动状态',
    cmd: ['node', 'scripts/maintenance/cdp-interact.js'], docs: 'docs/workflow.md#桌面人工诊断',
    needs: '已运行的本机 Companion WebView；显式开启127.0.0.1:9222 CDP；操作员确认目标及当前互动/语音配置',
    run: { nature: ['writes-product', 'external-model'], machine: ['node', 'windows', 'playwright-browser', 'gateway'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/cdp-interact.ts',
      unknown: ['旧companion-char-switch选择器在当前UI无对应入口；切角结果须看日志与实际画面'],
      notes: ['仅显式调用；临时显示UI、点击身体并尝试切宁宁/夏目；NO_SWITCH_BTN或ready字段不能冒充切角通过；不回收或重置生产角色设置'] },
  },
  'audit:orphans': {
    desc: '探测 scripts/maintenance/ 下零引用的孤儿脚本（只读，列清单不删）',
    cmd: ['node', 'scripts/maintenance/detect-orphan-scripts.js'], docs: 'scripts/maintenance/detect-orphan-scripts.js:1',
    opts: '[--json] 机器可读输出；[--check] 孤儿候选非零时失败',
    run: { nature: ['read-only'], machine: ['node'], switches: { '--check': ['guard'], '--json': ['read-only'] }, resume: 'na', evidence: 'scripts/maintenance/detect-orphan-scripts.js:90-144', unknown: [] },
  },
};
export = workflows;
