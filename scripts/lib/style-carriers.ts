import ts from 'typescript';

/** Follow a style binding's returned values; only literal custom-property keys pass. */
export function bindsOnlyCustomProps(source: string, identifier: string): boolean {
  const tree = ts.createSourceFile('style-carriers.ts', source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  type Definition = ts.VariableDeclaration | ts.FunctionDeclaration | ts.ParameterDeclaration | ts.BindingElement;
  const definitions: Definition[] = [];
  const collect = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
      || ts.isParameter(node) || ts.isBindingElement(node))
      && node.name && ts.isIdentifier(node.name)) definitions.push(node);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const lookup = (name: string, origin: ts.Node): Definition | undefined => {
    const candidates = definitions.filter(node => node.name && ts.isIdentifier(node.name) && node.name.text === name);
    for (let scope: ts.Node | undefined = origin; scope; scope = scope.parent) {
      const local = candidates.find(node => {
        let owner: ts.Node | undefined = node.parent;
        const parameter = ts.isParameter(node) || ts.isBindingElement(node) && (() => {
          let parent: ts.Node | undefined = node.parent;
          while (parent && !ts.isVariableDeclaration(parent) && !ts.isParameter(parent)) parent = parent.parent;
          return Boolean(parent && ts.isParameter(parent));
        })();
        while (owner && !ts.isBlock(owner) && !ts.isSourceFile(owner)
          && !(parameter && ts.isFunctionLike(owner))) owner = owner.parent;
        return owner === scope;
      });
      if (local) return local;
    }
    return undefined;
  };
  const active = new Set<ts.Node>();
  const check = (node: ts.Node | undefined): boolean => {
    if (!node || active.has(node)) return false;
    active.add(node);
    try {
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        || ts.isSatisfiesExpression(node)) return check(node.expression);
      if (ts.isIdentifier(node)) return check(lookup(node.text, node));
      if (ts.isVariableDeclaration(node)) return check(node.initializer);
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        if (!node.body) return false;
        if (!ts.isBlock(node.body)) return check(node.body);
        const returns: ts.ReturnStatement[] = [];
        const visit = (child: ts.Node): void => {
          if (ts.isFunctionLike(child)) return;
          if (ts.isReturnStatement(child)) returns.push(child);
          else ts.forEachChild(child, visit);
        };
        ts.forEachChild(node.body, visit);
        return returns.length > 0 && returns.every(statement => check(statement.expression));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const definition = lookup(node.expression.text, node);
        return node.expression.text === 'computed' && !definition
          ? node.arguments.length === 1 && check(node.arguments[0])
          : check(definition);
      }
      if (!ts.isObjectLiteralExpression(node) || !node.properties.length) return false;
      return node.properties.every(property => {
        if (!ts.isPropertyAssignment(property)) return false;
        const key = ts.isComputedPropertyName(property.name) ? property.name.expression : property.name;
        return ts.isStringLiteralLike(key) && /^--[\w-]+$/.test(key.text);
      });
    } finally { active.delete(node); }
  };
  // The entry may be destructured from a composable in the SFC; locate its
  // actual declaration. Subsequent expressions must resolve lexically.
  const entries = definitions.filter(node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node))
    && node.name && ts.isIdentifier(node.name) && node.name.text === identifier);
  return entries.length === 1 && check(entries[0]);
}
