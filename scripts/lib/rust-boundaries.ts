import fs = require('node:fs');
import path = require('node:path');
import type { RefactorReport } from './refactor-boundaries';

function rustTokens(text: string): string[] {
  const lexer = /\/\*|\/\/[^\n]*|r(#+)?"[\s\S]*?"\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|[A-Za-z_][A-Za-z_0-9]*|::|[{},;]/g;
  const code: string[] = [];
  for (let match; (match = lexer.exec(text));) {
    const token = match[0];
    if (token === '/*') {
      let depth = 1;
      while (depth && lexer.lastIndex < text.length) {
        const open = text.indexOf('/*', lexer.lastIndex);
        const close = text.indexOf('*/', lexer.lastIndex);
        if (close < 0) { lexer.lastIndex = text.length; break; }
        if (open >= 0 && open < close) { depth++; lexer.lastIndex = open + 2; }
        else { depth--; lexer.lastIndex = close + 2; }
      }
    } else if (!/^(?:\/|r#*"|"|')/.test(token)) code.push(token);
  }
  return code;
}

// This guard checks explicit Rust paths, not macro expansion or symbol resolution.
// Keep it focused on the core dependency direction; cargo checks the actual types.
export function inspectRustBoundaries(root: string, report: RefactorReport): void {
  const base = path.join(root, 'runtime-rs/src');
  if (!fs.existsSync(base)) return;
  const forbidden: Record<string, readonly string[]> = {
    execution: ['generation', 'images', 'video', 'task_runtime', 'storage', 'AppState'],
    task_contract: ['generation', 'images', 'video', 'task_runtime', 'storage', 'AppState'],
    storage: ['generation', 'images', 'video', 'task_runtime', 'AppState'],
    generation: ['images', 'video', 'task_runtime', 'storage'],
    images: ['task_runtime', 'storage'],
    // Video also owns HTTP media delivery and JS-compatible prompt formatting,
    // which currently use storage helpers; the guard only forbids task orchestration.
    video: ['task_runtime'],
  };
  const visit = (absolute: string): void => {
    if (fs.statSync(absolute).isDirectory()) {
      for (const child of fs.readdirSync(absolute)) visit(path.join(absolute, child));
      return;
    }
    if (!absolute.endsWith('.rs')) return;
    const relative = path.relative(base, absolute).replaceAll('\\', '/');
    const owner = relative.split('/')[0].replace(/\.rs$/, '');
    if (!forbidden[owner]) return;
    const source = `runtime-rs/src/${relative}`;
    report.files.push(source);
    const text = fs.readFileSync(absolute, 'utf8');
    // Omit comments and literals before inspecting crate paths (including grouped use).
    const code = rustTokens(text);
    const record = (target: string) => {
      if (!forbidden[owner].includes(target)) return;
      const edge = { source, target: `runtime-rs/src/${target}`, kind: 'import' as const, typeOnly: false };
      report.edges.push(edge);
      report.violations.push({ ...edge, rule: 'rust-core-dependency-direction' });
    };
    const moduleDepth = relative.split('/').length - Number(relative.endsWith('/mod.rs'));
    const braces: boolean[] = [];
    let inlineDepth = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '{') {
        const module = code[i - 2] === 'mod' && /^[A-Za-z_]/.test(code[i - 1]);
        braces.push(module);
        if (module) inlineDepth++;
      } else if (code[i] === '}' && braces.pop()) inlineDepth--;
      let start = i + 2;
      if (code[i] === 'super') {
        let parents = 0;
        start = i;
        while (code[start] === 'super' && code[start + 1] === '::') { parents++; start += 2; }
        if (parents !== moduleDepth + inlineDepth) continue;
      } else if (code[i] !== 'crate' || code[i + 1] !== '::') continue;
      if (code[start] !== '{') { record(code[start]); continue; }
      let depth = 1;
      let member = true;
      for (let j = start + 1; j < code.length && depth; j++) {
        const token = code[j];
        if (depth === 1 && member && /^[A-Za-z_]/.test(token)) { record(token); member = false; }
        if (token === '{') depth++;
        if (token === '}') depth--;
        if (token === ',' && depth === 1) member = true;
      }
    }
  };
  visit(base);
}
