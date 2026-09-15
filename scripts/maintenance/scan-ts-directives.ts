'use strict';

/**
 * scripts/maintenance/scan-ts-directives.js
 *
 * 前端源码静默绕过门禁指令的入库门禁（2026-08-28 工程审计 P0 固化）。
 *
 * 背景：src/composables/useGenerationSession.ts 曾以首行 `// @ts-nocheck`
 * 静默绕过 typecheck:app 门禁入库，注释与真实代码状态矛盾，对 AI 协作
 * 项目是最高危的误导源。此后 src/ 一律禁止以下指令：
 *   - @ts-nocheck / @ts-ignore / @ts-expect-error：绕过 typecheck 门禁
 *   - eslint-disable*：绕过 lint 门禁（确需豁免时走 eslint 配置文件，
 *     让豁免集中可审计）
 *
 * 用法: node scripts/maintenance/scan-ts-directives.js --check
 */

const fs = (require('fs') as typeof import('fs'));
const path = (require('path') as typeof import('path'));
import ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_DIRS = ['src'];
const EXTENSIONS = /\.(?:[cm]?ts|vue|tsx)$/;
const RUNTIME_DIRS = ['server', 'routes', 'services', 'scripts', 'tools', 'docs/guides/prompts'];

const FORBIDDEN = [
  '@ts-nocheck',
  '@ts-ignore',
  '@ts-expect-error',
  'eslint-disable',
];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'archive' ? [] : walk(full);
    return EXTENSIONS.test(full) ? [full] : [];
  });
}

/** Parse comments, so negative-test strings and descriptions are not treated as directives. */
function runtimeDirectives(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, number>();
  const collect = (start: number, end: number) => { ranges.set(start, end); };
  function visit(node: ts.Node) {
    ts.forEachLeadingCommentRange(text, node.pos, collect);
    ts.forEachTrailingCommentRange(text, node.end, collect);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const violations: string[] = [];
  for (const [start, end] of ranges) {
    const comment = text.slice(start, end);
    if (/(?:^|[\r\n])\s*(?:\/\/|\/\*+|\*)\s*(?:@ts-(?:nocheck|ignore|expect-error)\b|eslint-disable(?:-next-line|-line)?\b)/.test(comment)) {
      violations.push(`${path.relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(start).line + 1} — ${comment.split(/\r?\n/)[0]}`);
    }
  }
  return violations;
}

function main() {
  const violations: string[] = [];
  for (const dir of TARGET_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const directive of FORBIDDEN) {
          if (line.includes(directive)) {
            violations.push(path.relative(ROOT, file) + ':' + (index + 1) + ' — ' + directive);
          }
        }
      });
    }
  }
  const runtimeFiles = RUNTIME_DIRS.flatMap(dir => walk(path.join(ROOT, dir)))
    .concat(['server.ts', 'eslint.config.mts', 'assets/theme-bootstrap.ts'].map(file => path.join(ROOT, file)))
    .filter(file => fs.existsSync(file) && !file.endsWith('.d.ts'));
  for (const file of runtimeFiles) violations.push(...runtimeDirectives(fs.readFileSync(file, 'utf8'), file));
  if (violations.length) {
    console.error('TypeScript 源码内发现静默绕过门禁的指令（一律禁止入库）:');
    violations.forEach((v) => console.error('  - ' + v));
    process.exit(1);
  }
  console.log('TypeScript directive scan passed: frontend, runtime, tooling and tests are checked.');
}

if (require.main === module) main();

export = { FORBIDDEN, runtimeDirectives };
