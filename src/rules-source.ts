import type { Node } from 'web-tree-sitter';
import type { Finding } from './analyzer';

interface Binding {
  bounds: (bigint | null)[];
}

interface Scope {
  parent?: Scope;
  bindings: Map<string, Binding>;
}

const unknown: Binding = { bounds: [] };

const conditionalDirectives = new Set(['preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_elifdef', 'preproc_else']);
const unevaluatedExpressions = new Set(['sizeof_expression', 'alignof_expression', 'generic_expression', 'typeof_specifier']);
const declaratorWrappers = new Set(['parenthesized_declarator', 'attributed_declarator']);

export function isConditionalDirective(type: string): boolean {
  return conditionalDirectives.has(type);
}

export function analyzeSource(root: Node, findings: Finding[]): void {
  const macros = new Set(
    root.descendantsOfType(['preproc_def', 'preproc_function_def'])
      .map((directive) => directive.childForFieldName('name')?.text)
      .filter((name): name is string => name !== undefined),
  );

  function visit(node: Node, scope: Scope): void {
    if (node.isError || node.isMissing || unevaluatedExpressions.has(node.type)) {
      return;
    }
    if (isConditionalDirective(node.type)) {
      hideConditionalDeclarations(node, scope);
      return;
    }
    if (node.type.startsWith('preproc_')) {
      return;
    }
    if (node.type === 'function_definition') {
      visitFunction(node, scope);
      return;
    }
    if (node.type === 'compound_statement') {
      visitBlock(node, newScope(scope));
      return;
    }
    if (node.type === 'declaration' || node.type === 'type_definition') {
      visitDeclaration(node, scope);
      return;
    }
    if (node.type === 'enum_specifier') {
      hideEnumerators(node, scope);
    }
    if (node.type === 'subscript_expression' && !node.hasError) {
      checkSubscript(node, scope, macros, findings);
    }
    if (node.type === 'call_expression' && macros.has(node.childForFieldName('function')?.text ?? '')) {
      return;
    }
    const childScope = node.type === 'for_statement' ? newScope(scope) : scope;
    for (const child of node.namedChildren) {
      visit(child, childScope);
    }
  }

  function visitFunction(node: Node, scope: Scope): void {
    const declarator = node.childForFieldName('declarator');
    const { name, layers } = describeDeclarator(declarator);
    if (name) {
      scope.bindings.set(name.text, unknown);
    }

    const parameters = layers.find((layer) => layer.type === 'function_declarator')
      ?.childForFieldName('parameters');
    const localScope = newScope(scope);
    for (const parameter of parameters?.namedChildren ?? []) {
      const parameterName = parameter.type === 'identifier'
        ? parameter
        : describeDeclarator(parameter.childForFieldName('declarator')).name;
      if (parameterName) {
        localScope.bindings.set(parameterName.text, unknown);
      }
    }
    const body = node.childForFieldName('body');
    if (body) {
      visitBlock(body, localScope);
    }
  }

  function visitBlock(block: Node, scope: Scope): void {
    // Each candidate is a scalar declared in this block since its last
    // statement with effects or uncertain control flow.
    const candidates = new Set<string>();
    for (const statement of block.namedChildren) {
      if (statement.type === 'comment') {
        continue;
      }
      if (statement.type === 'declaration' && !statement.hasError) {
        visitDeclaration(statement, scope, candidates);
        continue;
      }
      if (statement.type === 'return_statement' && !statement.hasError) {
        const name = unwrapExpression(firstCodeChild(statement));
        if (name?.type === 'identifier' && candidates.has(name.text)) {
          findings.push({
            rule: 'uninitialized-read',
            severity: 'warning',
            message: `${name.text} is returned before it is initialized.`,
            advice: `Initialize ${name.text} at its declaration or assign it a value before returning it.`,
            start: name.startIndex,
            end: name.endIndex,
          });
        }
      }
      candidates.clear();
      visit(statement, scope);
    }
  }

  function visitDeclaration(node: Node, scope: Scope, candidates?: Set<string>): void {
    const type = node.childForFieldName('type');
    if (type) {
      visit(type, scope);
    }
    for (const declarator of node.childrenForFieldName('declarator')) {
      const { name, layers } = describeDeclarator(declarator);
      if (!name) {
        continue;
      }

      const bounds: Binding['bounds'] = [];
      if (!node.hasError && node.type === 'declaration' && !macros.has(name.text)) {
        for (const layer of layers) {
          if (layer.type !== 'array_declarator') {
            break;
          }
          const size = integerLiteral(layer.childForFieldName('size'));
          bounds.push(size !== null && size > 0n ? size : null);
        }
      }
      scope.bindings.set(name.text, { bounds });

      const initializer = declarator.childForFieldName('value');
      if (initializer) {
        visit(initializer, scope);
      }
      if (!candidates) {
        continue;
      }
      // An initializer or a complex declaration may change another local
      // through an assignment, a call, a VLA bound, or a macro.
      if (layers.length || (initializer && !isLiteral(initializer))) {
        candidates.clear();
      }
      candidates.delete(name.text);
      if (!initializer && !layers.length && isPlainScalar(node, type) && !macros.has(name.text)) {
        candidates.add(name.text);
      }
    }
  }

  visit(root, newScope());
}

function newScope(parent?: Scope): Scope {
  return { parent, bindings: new Map() };
}

function lookup(name: string, scope: Scope): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) {
      return binding;
    }
  }
  return undefined;
}

function hideConditionalDeclarations(directive: Node, scope: Scope): void {
  for (const child of directive.namedChildren) {
    if (isConditionalDirective(child.type)) {
      hideConditionalDeclarations(child, scope);
    } else if (child.type === 'declaration' || child.type === 'type_definition' || child.type === 'function_definition') {
      for (const declarator of child.childrenForFieldName('declarator')) {
        const { name } = describeDeclarator(declarator);
        if (name) {
          scope.bindings.set(name.text, unknown);
        }
      }
      hideEnumerators(child.childForFieldName('type'), scope);
    } else if (child.type === 'enum_specifier') {
      hideEnumerators(child, scope);
    }
  }
}

function hideEnumerators(node: Node | null, scope: Scope): void {
  if (node?.type !== 'enum_specifier') {
    return;
  }
  const enumerators = node.childForFieldName('body');
  for (const enumerator of enumerators?.namedChildren ?? []) {
    const name = enumerator.childForFieldName('name');
    if (enumerator.type === 'enumerator' && name) {
      scope.bindings.set(name.text, unknown);
    }
  }
}

function describeDeclarator(declarator: Node | null): { name: Node | null; layers: Node[] } {
  const layers: Node[] = [];
  while (declarator && declarator.type !== 'identifier' && declarator.type !== 'type_identifier') {
    if (declaratorWrappers.has(declarator.type)) {
      declarator = firstCodeChild(declarator);
    } else {
      if (declarator.type !== 'init_declarator') {
        layers.push(declarator);
      }
      declarator = declarator.childForFieldName('declarator');
    }
  }
  return { name: declarator, layers: layers.reverse() };
}

function checkSubscript(node: Node, scope: Scope, macros: Set<string>, findings: Finding[]): void {
  const argument = unwrapExpression(node.childForFieldName('argument'));
  const index = node.childForFieldName('index');
  if (!argument || !index) {
    return;
  }

  const indexValue = integerLiteral(index);
  const reversed = indexValue === null;
  const value = reversed ? integerLiteral(argument) : indexValue;
  if (value === null) {
    return;
  }

  let base = reversed ? unwrapExpression(index) : argument;
  let dimension = 0;
  while (base?.type === 'subscript_expression') {
    const outer = unwrapExpression(base.childForFieldName('argument'));
    base = outer && integerLiteral(outer) !== null
      ? unwrapExpression(base.childForFieldName('index'))
      : outer;
    dimension++;
  }
  if (base?.type !== 'identifier' || macros.has(base.text)) {
    return;
  }

  const size = lookup(base.text, scope)?.bounds[dimension];
  if (size == null) {
    return;
  }
  const address = parentOutsideParens(node);
  const formsAddress = address?.type === 'pointer_expression' && address.childForFieldName('operator')?.type === '&';
  const maxIndex = formsAddress ? size : size - 1n;
  if (value >= 0n && value <= maxIndex) {
    return;
  }
  const offendingIndex = reversed ? argument : index;
  findings.push({
    rule: 'array-index-out-of-bounds',
    severity: 'error',
    message: `Index ${value} is outside the bounds of ${base.text} (size ${size}).`,
    advice: `Use an index from 0 to ${maxIndex}, or correct the array size if it should contain more elements.`,
    start: offendingIndex.startIndex,
    end: offendingIndex.endIndex,
  });
}

function parentOutsideParens(node: Node): Node | null {
  let parent = node.parent;
  while (parent?.type === 'parenthesized_expression') {
    parent = parent.parent;
  }
  return parent;
}

function unwrapExpression(node: Node | null): Node | null {
  while (node?.type === 'parenthesized_expression') {
    node = firstCodeChild(node);
  }
  return node;
}

function firstCodeChild(node: Node): Node | null {
  return node.namedChildren.find((child) => child.type !== 'comment') ?? null;
}

function integerLiteral(node: Node | null): bigint | null {
  node = unwrapExpression(node);
  let hasMinus = false;
  let negative = false;
  while (node?.type === 'unary_expression') {
    const operator = node.childForFieldName('operator')?.text;
    if (operator !== '+' && operator !== '-') {
      return null;
    }
    if (operator === '-') {
      hasMinus = true;
      negative = !negative;
    }
    node = unwrapExpression(node.childForFieldName('argument'));
  }
  if (node?.type !== 'number_literal') {
    return null;
  }
  const match = /^([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([uU](?:ll|LL|[lL])?|(?:ll|LL|[lL])[uU]?)?$/.exec(node.text);
  if (!match) {
    return null;
  }
  const [, literalSign, digits, suffix] = match;
  if (literalSign === '-') {
    hasMinus = true;
    negative = !negative;
  }
  if (digits.length > 66) {
    return null;
  }
  const octal = /^0[0-7]+$/.test(digits);
  const magnitude = BigInt(octal ? `0o${digits.slice(1)}` : digits);
  const unsignedSuffix = /u/i.test(suffix ?? '');
  const nonDecimal = octal || /^0[xb]/i.test(digits);
  const maxUnsigned = 0xffff_ffff_ffff_ffffn;
  const maxSigned = 0x7fff_ffff_ffff_ffffn;
  if (magnitude > maxUnsigned || (!nonDecimal && !unsignedSuffix && magnitude > maxSigned)) {
    return null;
  }
  // A non-decimal literal may have an unsigned type depending on the target.
  if (hasMinus && (unsignedSuffix || magnitude > maxSigned || (nonDecimal && magnitude > 32_767n))) {
    return null;
  }
  return negative ? -magnitude : magnitude;
}

function isPlainScalar(declaration: Node, type: Node | null): boolean {
  if (type?.type !== 'primitive_type' && type?.type !== 'sized_type_specifier') {
    return false;
  }
  if (type.text === 'void') {
    return false;
  }
  return declaration.namedChildren.every((child) => ![
    'attribute_specifier', 'attribute_declaration', 'type_qualifier',
  ].includes(child.type) && (child.type !== 'storage_class_specifier' || ['auto', 'register'].includes(child.text)));
}

function isLiteral(node: Node): boolean {
  const expression = unwrapExpression(node);
  return !!expression && ['number_literal', 'char_literal', 'string_literal', 'true', 'false', 'null'].includes(expression.type);
}
