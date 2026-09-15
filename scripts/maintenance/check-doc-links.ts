'use strict';
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const root = path.resolve(__dirname, '../..');

function documents(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? documents(file) : /\.(md|html)$/.test(entry.name) ? [file] : [];
  });
}
function check() {
  const files = [...documents(path.join(root, 'docs')), ...documents(path.join(root, 'plans')),
    ...['README.md', 'README_zh.md', 'DESIGN.md', 'AGENTS.md', 'STARTUP.md'].map((file: any) => path.join(root, file))];
  const errors: string[] = [];
  const appPaths = new Set([...fs.readFileSync(path.join(root, 'src/router/index.ts'), 'utf8').matchAll(/path:\s*['"]([^'"]*)['"]/g)].map((match: any) => '/' + match[1].replace(/^\//, '')));
  let links = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
    const urls = [...text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map((match: any) => match[1]);
    urls.push(...[...text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map((match: any) => match[1]));
    for (let url of urls) {
      if (/^(?:[\w+.-]+:|\/\/|#)/.test(url)) continue;
      url = url.replace(/^<|>$/g, '').split(/[?#]/)[0];
      if (!url || /[{}<>*]/.test(url) || (url.startsWith('/') && !/\.[a-z0-9]+$/i.test(url))) continue;
      try { url = decodeURIComponent(url); } catch { /* Report the original malformed path. */ }
      const target = url.startsWith('/') ? path.join(root, url.slice(1)) : path.resolve(path.dirname(file), url);
      links += 1;
      const route = '/' + path.relative(root, target).replaceAll('\\', '/');
      if (!fs.existsSync(target) && !appPaths.has(route)) errors.push(path.relative(root, file).replaceAll('\\', '/') + ': ' + url);
    }
  }
  const redirects: Record<string, any> = JSON.parse(fs.readFileSync(path.join(root, 'docs/redirects.json'), 'utf8'));
  for (const [old, target] of Object.entries(redirects)) {
    if (!old.startsWith('/docs/') || typeof target !== 'string' || !target.startsWith('/docs/') || target.includes('..') || !fs.existsSync(path.join(root, target.slice(1)))) errors.push('Invalid document redirect: ' + old + ' -> ' + String(target));
  }
  console.log(`Documentation: ${files.length} files, ${links} local links, ${Object.keys(redirects).length} redirects, ${errors.length} broken links.`);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
}
if (require.main === module) check();
export = { check };
