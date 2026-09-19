import ts from 'typescript';

export interface SourceDependency {
  specifier: string | null;
  kind: 'import' | 'export' | 'import-equals' | 'type-query' | 'require' | 'dynamic';
  typeOnly: boolean;
}

/** Shared AST reader. Computed paths remain null so graph checks cannot silently accept them. */
export function sourceDependencies(source: string, filename = 'module.ts'): SourceDependency[] {
  const result: SourceDependency[] = [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (node: ts.Node | undefined, kind: SourceDependency['kind'], typeOnly: boolean) => {
    result.push({ specifier: node && ts.isStringLiteralLike(node) ? node.text : null, kind, typeOnly });
  };
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      add(node.moduleSpecifier, 'import', Boolean(clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly))));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const bindings = node.exportClause;
      add(node.moduleSpecifier, 'export', node.isTypeOnly || Boolean(bindings && ts.isNamedExports(bindings)
        && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly)));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, 'import-equals', node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, 'type-query', true);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'dynamic', false);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0], 'require', false);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}

/** Existing page-architecture API keeps its import-only shape and behavior. */
export function sourceImports(source: string) {
  return sourceDependencies(source)
    .filter((edge): edge is SourceDependency & { specifier: string } => edge.specifier !== null
      && (edge.kind === 'import' || edge.kind === 'dynamic'))
    .map(edge => ({ specifier: edge.specifier, dynamic: edge.kind === 'dynamic', typeOnly: edge.typeOnly }));
}
