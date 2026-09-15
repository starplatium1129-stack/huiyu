'use strict';

/**
 * 办公机快速状态检查。
 * 目标：在开始开发前快速确认工作区、依赖和关键入口是否正常。
 */

const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));

const root = path.resolve(__dirname, '..', '..');
interface HealthCheck { name: string; passed: boolean; detail: string }
const checks: HealthCheck[] = [];

function check(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

check('package.json', fs.existsSync(path.join(root, 'package.json')), '项目入口文件');
check('node_modules', fs.existsSync(path.join(root, 'node_modules')), '依赖目录');
check('runtime source', fs.existsSync(path.join(root, 'src')) && fs.existsSync(path.join(root, 'services')), '前后端源码');
check('desktop source', fs.existsSync(path.join(root, 'desktop-tauri')), '桌面端目录');
check('docs index', fs.existsSync(path.join(root, 'docs', 'INDEX.md')), '工程索引');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('workflow command', Boolean(packageJson.scripts && packageJson.scripts.workflow), '维护工作流入口');
check('quality command', Boolean(packageJson.scripts && packageJson.scripts.validate), '完整验证入口');

const failed = checks.filter((item: any) => !item.passed);
for (const item of checks) {
  console.log(`${item.passed ? '✔' : '✘'} ${item.name}: ${item.detail}`);
}

console.log(`\n办公机检查 ${checks.length - failed.length}/${checks.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
