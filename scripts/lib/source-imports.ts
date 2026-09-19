import ts from 'typescript';

/** Parse imports structurally: comments, quote style, whitespace and local names are irrelevant. */
export function sourceImports(source: string) {
  const result: Array<{ specifier: string; dynamic: boolean; typeOnly: boolean }> = [];
  const tree = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      result.push({ specifier: node.moduleSpecifier.text, dynamic: false,
        typeOnly: Boolean(clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly))) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
      result.push({ specifier: node.arguments[0].text, dynamic: true, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}
