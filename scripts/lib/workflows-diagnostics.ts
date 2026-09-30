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
  'audit:orphans': {
    desc: '探测 scripts/maintenance/ 下零引用的孤儿脚本（只读，列清单不删）',
    cmd: ['node', 'scripts/maintenance/detect-orphan-scripts.js'], docs: 'scripts/maintenance/detect-orphan-scripts.js:1',
    opts: '[--json] 机器可读输出；[--check] 孤儿候选非零时失败',
    run: { nature: ['read-only'], machine: ['node'], switches: { '--check': ['guard'], '--json': ['read-only'] }, resume: 'na', evidence: 'scripts/maintenance/detect-orphan-scripts.js:90-144', unknown: [] },
  },
};
export = workflows;
