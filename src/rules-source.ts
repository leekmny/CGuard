import type { Node } from 'web-tree-sitter';
import type { Finding } from './analyzer';

interface ArrayDimension {
  bound: bigint | null;
  variable: boolean;
}

interface Binding {
  dimensions: ArrayDimension[];
  linked?: boolean;
  runtimeInteger?: boolean;
}

interface Scope {
  parent?: Scope;
  bindings: Map<string, Binding>;
}

const unknown: Binding = { dimensions: [] };

const conditionalDirectives = new Set(['preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_elifdef', 'preproc_else']);
const unevaluatedExpressions = new Set(['alignof_expression', 'typeof_specifier', 'macro_type_specifier']);
const declaratorWrappers = new Set(['parenthesized_declarator', 'abstract_parenthesized_declarator', 'attributed_declarator']);

export function isConditionalDirective(type: string): boolean {
  return conditionalDirectives.has(type);
}

export function analyzeSource(root: Node, findings: Finding[]): void {
  const macros = new Set(
    root.descendantsOfType(['preproc_def', 'preproc_function_def'])
      .map((directive) => directive.childForFieldName('name')?.text)
      .filter((name): name is string => name !== undefined),
  );

  const truthCache = new Map<number, boolean | null>();

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
    if (node.type === 'sizeof_expression') {
      visitSizeof(node, scope);
      return;
    }
    if (node.type === 'generic_expression') {
      const selected = selectedGenericExpression(node);
      if (selected) {
        visit(selected, scope);
      }
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
    for (const child of evaluatedChildren(node, truthCache)) {
      visit(child, childScope);
    }
  }

  function visitSizeof(node: Node, scope: Scope): void {
    if (node.hasError) {
      return;
    }
    const type = node.childForFieldName('type');
    if (type) {
      const { layers } = describeDeclarator(type.childForFieldName('declarator'));
      for (const layer of layers) {
        // Dimensions behind a pointer do not affect the result of sizeof.
        if (layer.type !== 'abstract_array_declarator') {
          break;
        }
        const size = layer.childForFieldName('size');
        if (size) {
          visit(size, scope);
        }
      }
      return;
    }
    const value = node.childForFieldName('value');
    const reference = arrayReference(value);
    if (value && reference && !macros.has(reference.base.text) &&
        lookup(reference.base.text, scope)?.dimensions.slice(reference.depth).some(({ variable }) => variable)) {
      visit(value, scope);
    }
  }

  function visitDeclaratorSizes(layers: Node[], scope: Scope): void {
    for (const layer of layers) {
      if (layer.type === 'array_declarator') {
        const size = layer.childForFieldName('size');
        if (size) {
          visit(size, scope);
        }
      }
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
      const { name: parameterName, layers: parameterLayers } = describeDeclarator(
        parameter.type === 'identifier' ? parameter : parameter.childForFieldName('declarator'),
      );
      const parameterType = parameter.childForFieldName('type');
      if (parameterType) {
        visit(parameterType, localScope);
      }
      if (!parameter.hasError) {
        visitDeclaratorSizes(parameterLayers, localScope);
      }
      if (parameterName) {
        localScope.bindings.set(parameterName.text, {
          dimensions: [],
          runtimeInteger: !parameter.hasError && parameterLayers.length === 0 && isRuntimeInteger(parameter, parameterType),
        });
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
    const linked = !scope.parent || node.namedChildren.some(
      (child) => child.type === 'storage_class_specifier' && child.text === 'extern',
    );
    for (const declarator of node.childrenForFieldName('declarator')) {
      const { name, layers } = describeDeclarator(declarator);
      if (!name) {
        continue;
      }

      if (!node.hasError) {
        // The new name is in scope after its complete declarator, including its sizes.
        visitDeclaratorSizes(layers, scope);
      }
      const dimensions: ArrayDimension[] = [];
      let runtimeInteger = false;
      if (!node.hasError && node.type === 'declaration' && !macros.has(name.text)) {
        const previous = linked ? lookup(name.text, scope) : undefined;
        for (const layer of layers) {
          if (layer.type !== 'array_declarator') {
            break;
          }
          const size = layer.childForFieldName('size');
          const literal = integerLiteral(size);
          const identifier = unwrapExpression(size);
          const variable = identifier?.type === 'identifier' && !macros.has(identifier.text) &&
            lookup(identifier.text, scope)?.runtimeInteger === true;
          let bound = literal !== null && literal > 0n ? literal : null;
          if (!size && previous?.linked) {
            bound = previous.dimensions[dimensions.length]?.bound ?? null;
          }
          dimensions.push({ bound, variable });
        }
        runtimeInteger = layers.length === 0 && isRuntimeInteger(node, type);
      }
      scope.bindings.set(name.text, { dimensions, linked, runtimeInteger });

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

  const reference = arrayReference(reversed ? index : argument);
  if (!reference || macros.has(reference.base.text)) {
    return;
  }
  const { base, depth } = reference;
  const size = lookup(base.text, scope)?.dimensions[depth]?.bound;
  if (size == null) {
    return;
  }
  const address = parentOutsideTransparentExpressions(node);
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

function arrayReference(node: Node | null): { base: Node; depth: number } | null {
  let base = unwrapExpression(node);
  let depth = 0;
  while (base?.type === 'subscript_expression') {
    const argument = unwrapExpression(base.childForFieldName('argument'));
    base = argument && integerLiteral(argument) !== null
      ? unwrapExpression(base.childForFieldName('index'))
      : argument;
    depth++;
  }
  return base?.type === 'identifier' ? { base, depth } : null;
}

function parentOutsideTransparentExpressions(node: Node): Node | null {
  let parent = node.parent;
  // A visited generic arm is the selected result, which preserves its lvalue.
  while (parent?.type === 'parenthesized_expression' || parent?.type === 'generic_expression') {
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

function evaluatedChildren(node: Node, truthCache: Map<number, boolean | null>): Node[] {
  if (node.type === 'conditional_expression') {
    const condition = node.childForFieldName('condition');
    const truth = constantTruth(condition, truthCache);
    if (condition && truth !== undefined) {
      const branch = node.childForFieldName(truth ? 'consequence' : 'alternative');
      return branch ? [condition, branch] : [condition];
    }
  }
  if (node.type === 'binary_expression') {
    const operator = node.childForFieldName('operator')?.type;
    const left = node.childForFieldName('left');
    if (left && (operator === '&&' || operator === '||') && constantTruth(left, truthCache) === (operator === '||')) {
      return [left];
    }
  }
  return node.namedChildren;
}

function constantTruth(node: Node | null, cache: Map<number, boolean | null>): boolean | undefined {
  node = unwrapExpression(node);
  if (!node) {
    return undefined;
  }
  const cached = cache.get(node.id);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let truth: boolean | undefined;
  const operator = node.childForFieldName('operator')?.type;
  if (node.type === 'unary_expression' && operator === '!') {
    const argument = constantTruth(node.childForFieldName('argument'), cache);
    truth = argument === undefined ? undefined : !argument;
  } else if (node.type === 'binary_expression' && (operator === '&&' || operator === '||')) {
    const left = constantTruth(node.childForFieldName('left'), cache);
    if (left !== undefined) {
      truth = left === (operator === '||') ? left : constantTruth(node.childForFieldName('right'), cache);
    }
  } else {
    const value = integerLiteral(node);
    truth = value === null ? undefined : value !== 0n;
  }
  // The tree walk also visits nested logical expressions. Cache known and unknown
  // results so each condition is calculated only once in this syntax tree.
  cache.set(node.id, truth ?? null);
  return truth;
}

function selectedGenericExpression(node: Node): Node | undefined {
  if (node.hasError) {
    return undefined;
  }
  const [control, ...associations] = node.namedChildren.filter((child) => child.type !== 'comment');
  const literal = unwrapExpression(control ?? null);
  const value = integerLiteral(literal);
  // Unsuffixed literals in this range have type int even when int is 16 bits.
  const knownInt = literal?.type === 'number_literal' && !/[ul]$/i.test(literal.text) &&
    value !== null && value >= -32_767n && value <= 32_767n;
  let fallback: Node | undefined;
  let mayMatch = false;
  for (let i = 0; i < associations.length; i += 2) {
    const type = associations[i];
    if (type.text === 'default') {
      fallback = associations[i + 1];
      continue;
    }
    const plain = type.namedChildren.filter((child) => child.type !== 'comment').length === 1
      ? type.childForFieldName('type')
      : null;
    const spelling = plain?.type === 'sized_type_specifier'
      ? plain.children.filter((child) => child.type !== 'comment').map((child) => child.text).join(' ')
      : plain?.text ?? '';
    if (knownInt && /^(int|signed( int)?|int signed)$/.test(spelling)) {
      return associations[i + 1];
    }
    // An unresolved association, for example through a typedef or enum, may match int.
    if (!knownInt || !plain || !/^(?:(?:signed|unsigned|long|short|int) )*(?:float|double|char|bool|_Bool|unsigned|long|short|int|signed)$/.test(spelling) ||
        (plain.type !== 'primitive_type' && plain.type !== 'sized_type_specifier')) {
      mayMatch = true;
    }
  }
  return mayMatch ? undefined : fallback;
}

function isRuntimeInteger(declaration: Node, type: Node | null): boolean {
  return !!type && /^(?:(?:int|long|short|signed|unsigned|char)\s+)*(?:int|long|short|signed|unsigned|char|_Bool)$/.test(type.text) &&
    !declaration.namedChildren.some((child) => child.type === 'type_qualifier' && child.text === 'constexpr');
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
