import ts from 'typescript';

/** Follow a style binding's returned values; only literal custom-property keys pass. */
export function bindsOnlyCustomProps(source: string, binding: string): boolean {
  const tree = ts.createSourceFile('style-carriers.ts', source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const expressionTree = ts.createSourceFile('style-binding.ts', `(${binding})`, ts.ScriptTarget.Latest, true);
  const expressionStatement = expressionTree.statements[0];
  if (expressionTree.statements.length !== 1 || !expressionStatement || !ts.isExpressionStatement(expressionStatement)) return false;
  type Definition = ts.VariableDeclaration | ts.FunctionDeclaration | ts.ParameterDeclaration | ts.BindingElement;
  const definitions: Definition[] = [];
  const collect = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
      || ts.isParameter(node) || ts.isBindingElement(node))
      && node.name && ts.isIdentifier(node.name)) definitions.push(node);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  // A template can destructure a composable's result. Resolve only unique entry
  // declarations; references inside each helper must still resolve lexically.
  const entry = (name: string): Definition | undefined => {
    const matches = definitions.filter(node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && node.name.text === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
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
  const check = (node: ts.Node | undefined, properties: string[] = []): boolean => {
    if (!node || active.has(node)) return false;
    active.add(node);
    try {
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        || ts.isSatisfiesExpression(node)) return check(node.expression, properties);
      if (ts.isIdentifier(node)) return check(lookup(node.text, node)
        ?? (node.getSourceFile() === expressionTree ? entry(node.text) : undefined), properties);
      if (ts.isVariableDeclaration(node)) return check(node.initializer, properties);
      if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) return check(node.expression, [node.name.text, ...properties]);
      if (ts.isConditionalExpression(node)) return check(node.whenTrue, properties) && check(node.whenFalse, properties);
      if (ts.isArrayLiteralExpression(node)) return properties.length === 0 && node.elements.length > 0
        && node.getLastToken()?.kind === ts.SyntaxKind.CloseBracketToken
        && node.elements.every(element => check(element));
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        if (!node.body) return false;
        if (!ts.isBlock(node.body)) return check(node.body, properties);
        const returns: ts.ReturnStatement[] = [];
        const visit = (child: ts.Node): void => {
          if (ts.isFunctionLike(child)) return;
          if (ts.isReturnStatement(child)) returns.push(child);
          else ts.forEachChild(child, visit);
        };
        ts.forEachChild(node.body, visit);
        return returns.length > 0 && returns.every(statement => check(statement.expression, properties));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const definition = lookup(node.expression.text, node);
        return node.expression.text === 'computed' && !definition
          ? node.arguments.length === 1 && check(node.arguments[0], properties[0] === 'value' ? properties.slice(1) : properties)
          : check(definition, properties);
      }
      if (!ts.isObjectLiteralExpression(node) || node.getLastToken()?.kind !== ts.SyntaxKind.CloseBraceToken) return false;
      if (properties.length) {
        // Resolve an explicit own member only: spreads, accessors and computed
        // names could override it and must never be treated as known safe data.
        if (node.properties.some(property => !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
          || !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)))) return false;
        const matches = node.properties.filter(property => property.name
          && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === properties[0]);
        if (matches.length !== 1) return false;
        const property = matches[0];
        return check(ts.isPropertyAssignment(property) ? property.initializer : property.name, properties.slice(1));
      }
      return node.properties.every(property => {
        if (!ts.isPropertyAssignment(property) || !property.initializer.getWidth()) return false;
        const key = ts.isComputedPropertyName(property.name) ? property.name.expression : property.name;
        return ts.isStringLiteralLike(key) && /^--[\w-]+$/.test(key.text);
      });
    } finally { active.delete(node); }
  };
  return check(expressionStatement.expression);
}
