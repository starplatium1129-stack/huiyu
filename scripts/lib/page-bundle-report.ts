import ts = require('typescript');
import path = require('node:path');

export interface PageMapping { route: string; sources: string[]; unknown: string[] }
type Manifest = Record<string, { file?: string; src?: string; name?: string; isEntry?: boolean; imports?: string[] }>;

/** Read actual router nesting without importing browser code or guessing layout names. */
export function readPageMappings(source: string): PageMapping[] {
  const file = ts.createSourceFile('router.ts', source, ts.ScriptTarget.Latest, true);
  const pages: PageMapping[] = [];
  function property(node: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
    const value = node.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(file).replace(/['"]/g, '') === key);
    return value && ts.isPropertyAssignment(value) ? value.initializer : undefined;
  }
  function componentSource(value: ts.Expression | undefined): string | null {
    if (!value || !ts.isArrowFunction(value) || !ts.isCallExpression(value.body)
      || value.body.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
    const target = value.body.arguments[0];
    if (!target || !ts.isStringLiteral(target)) return null;
    if (target.text.startsWith('@/')) return 'src/' + target.text.slice(2);
    if (target.text.startsWith('.')) return path.posix.normalize('src/router/' + target.text);
    return null;
  }
  function walk(routes: ts.ArrayLiteralExpression, parentPath = '', ancestors: string[] = [], inheritedUnknown: string[] = []) {
    for (const item of routes.elements) {
      if (!ts.isObjectLiteralExpression(item)) {
        pages.push({ route: '(unresolved route)', sources: ancestors, unknown: [...inheritedUnknown, 'non-literal route record'] });
        continue;
      }
      const routePath = property(item, 'path');
      const route = routePath && ts.isStringLiteral(routePath)
        ? (routePath.text.startsWith('/') ? routePath.text : `${parentPath}/${routePath.text}`).replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
        : '(unresolved path)';
      const component = property(item, 'component');
      const resolved = componentSource(component);
      const sources = resolved ? [...ancestors, resolved] : [...ancestors];
      const unknown = [...inheritedUnknown];
      if (route === '(unresolved path)') unknown.push('non-literal route path');
      if (component && !resolved) unknown.push('unresolved component import');
      if (property(item, 'components')) unknown.push('named views require explicit resolution');
      const children = property(item, 'children');
      if (children && ts.isArrayLiteralExpression(children)) walk(children, route, sources, unknown);
      else if (!property(item, 'redirect')) {
        if (children) unknown.push('non-literal child routes');
        if (!sources.length) unknown.push('no resolved route component');
        pages.push({ route, sources, unknown });
      }
    }
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createRouter') {
      const config = node.arguments[0];
      const routes = config && ts.isObjectLiteralExpression(config) ? property(config, 'routes') : undefined;
      if (routes && ts.isArrayLiteralExpression(routes)) walk(routes);
      else pages.push({ route: '(unresolved router)', sources: [], unknown: ['non-literal router configuration'] });
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return pages.length ? pages : [{ route: '(unresolved router)', sources: [], unknown: ['createRouter routes not found'] }];
}

export function pageBundleReport(manifest: Manifest, mappings: PageMapping[], sizeOf: (file: string) => number) {
  const entries = Object.keys(manifest).filter(key => manifest[key].isEntry);
  return mappings.map(mapping => {
    const unknown = [...mapping.unknown];
    const roots = [...entries];
    if (entries.length !== 1) unknown.push(`expected one application entry, found ${entries.length}`);
    for (const source of mapping.sources) {
      const exact = Object.keys(manifest).filter(key => key === source || manifest[key].src === source);
      // Rollup can omit src for facade-free named chunks. Accept only a unique
      // explicit name match, never a fuzzy key substring or an arbitrary fallback.
      const candidates = exact.length ? exact : Object.keys(manifest).filter(key =>
        !manifest[key].src && manifest[key].name === path.posix.basename(source, '.vue'));
      if (candidates.length === 1) roots.push(candidates[0]);
      else unknown.push(`${source}: ${candidates.length ? 'ambiguous' : 'missing'} manifest mapping`);
    }
    const seen = new Set<string>();
    const files = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const key = queue.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = manifest[key];
      if (!entry) { unknown.push(`missing static dependency: ${key}`); continue; }
      if (entry.file?.endsWith('.js')) files.add(entry.file);
      else if (!entry.file) unknown.push(`missing output file: ${key}`);
      queue.push(...(entry.imports || []));
    }
    const javascriptFiles = [...files].sort();
    const knownJavaScript = javascriptFiles.reduce((total, file) => total + sizeOf(file), 0);
    return { route: mapping.route, sources: mapping.sources, roots: [...new Set(roots)],
      status: unknown.length ? 'unknown' : 'measured', pageJavaScript: unknown.length ? null : knownJavaScript,
      knownJavaScript, javascriptFiles, unknown };
  });
}
