import path from 'node:path';
import ts from 'typescript';
import {
  edgeId,
  sortLocations,
  type DiagnosticV1,
  type EdgeKindV1,
  type EdgeV1,
  type LocationV1,
  type NodeKind,
  type NodeV1,
} from '../../graph.js';

export interface RelationshipDeclaration {
  readonly id: string;
  readonly node: ts.Node;
  readonly binding?: ts.Node;
  readonly kind: Exclude<NodeKind, 'repository' | 'file'>;
  readonly path: string;
}

export interface RelationshipContext {
  readonly repositoryRoot: string;
  readonly program: ts.Program;
  readonly sources: ReadonlyMap<string, ts.SourceFile>;
  readonly moduleIds: ReadonlyMap<string, string>;
  readonly defaultIds: ReadonlyMap<string, string>;
  readonly declarations: readonly RelationshipDeclaration[];
  readonly nodes: ReadonlyMap<string, NodeV1>;
}

interface Target {
  readonly ids: readonly string[];
  readonly external: boolean;
}

const messages = {
  relationship_external:
    'Relationship targets an external module or declaration.',
  relationship_unresolved: 'Relationship could not be resolved.',
  relationship_ambiguous: 'Relationship target is ambiguous.',
  relationship_dynamic: 'Relationship is dynamic and was not emitted.',
  relationship_unsupported: 'Relationship kind is unsupported in the MVP.',
  relationship_missing_source:
    'Relationship source is not an eligible local source.',
} as const;

function compare(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function relative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join('/');
}

function location(
  root: string,
  source: ts.SourceFile,
  node: ts.Node,
): LocationV1 {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path: relative(root, source.fileName),
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
}

function declarationSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Symbol | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
    return checker.getSymbolAtLocation(node.name);
  if (ts.isBindingElement(node)) return checker.getSymbolAtLocation(node.name);
  const named = node as ts.NamedDeclaration;
  if (named.name) return checker.getSymbolAtLocation(named.name);
  return checker.getSymbolAtLocation(node);
}

function aliases(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol[] {
  const result: ts.Symbol[] = [];
  const visited = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  while (current && !visited.has(current)) {
    visited.add(current);
    result.push(current);
    current =
      current.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(current)
        : undefined;
  }
  return result;
}

function targetForSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  symbolIds: ReadonlyMap<ts.Symbol, ReadonlySet<string>>,
  context: RelationshipContext,
): Target {
  if (symbol === undefined) return { ids: [], external: false };
  const ids = new Set<string>();
  let hasExternalDeclaration = false;
  for (const item of aliases(checker, symbol)) {
    for (const id of symbolIds.get(item) ?? []) ids.add(id);
    for (const declaration of item.declarations ?? []) {
      const source = declaration.getSourceFile();
      if (
        !context.sources.has(relative(context.repositoryRoot, source.fileName))
      )
        hasExternalDeclaration = true;
    }
  }
  return {
    ids: [...ids].sort(compare),
    external: hasExternalDeclaration && ids.size === 0,
  };
}

function sourceModuleTarget(
  checker: ts.TypeChecker,
  node: ts.Node,
  context: RelationshipContext,
  symbolIds: ReadonlyMap<ts.Symbol, ReadonlySet<string>>,
): Target {
  const symbol = checker.getSymbolAtLocation(node);
  const candidates = new Set<string>();
  for (const item of symbol ? aliases(checker, symbol) : []) {
    for (const declaration of item.declarations ?? []) {
      const source = declaration.getSourceFile();
      const id = context.moduleIds.get(
        relative(context.repositoryRoot, source.fileName),
      );
      if (id) candidates.add(id);
    }
  }
  if (candidates.size)
    return { ids: [...candidates].sort(compare), external: false };
  return targetForSymbol(checker, symbol, symbolIds, context);
}

function defaultTargetForModule(
  checker: ts.TypeChecker,
  moduleNode: ts.Node,
  context: RelationshipContext,
): Target {
  const symbol = checker.getSymbolAtLocation(moduleNode);
  const ids = new Set<string>();
  for (const item of symbol ? aliases(checker, symbol) : []) {
    for (const declaration of item.declarations ?? []) {
      const id = context.defaultIds.get(
        relative(context.repositoryRoot, declaration.getSourceFile().fileName),
      );
      if (id) ids.add(id);
    }
  }
  return { ids: [...ids].sort(compare), external: false };
}

function defaultTargetForSource(
  source: ts.SourceFile,
  context: RelationshipContext,
): Target {
  const id = context.defaultIds.get(
    relative(context.repositoryRoot, source.fileName),
  );
  return id ? { ids: [id], external: false } : { ids: [], external: false };
}

function targetForDeclaration(
  checker: ts.TypeChecker,
  node: ts.Node,
  symbolIds: ReadonlyMap<ts.Symbol, ReadonlySet<string>>,
  context: RelationshipContext,
  nodeIds: ReadonlyMap<ts.Node, string>,
): Target {
  const target = targetForSymbol(
    checker,
    declarationSymbol(checker, node),
    symbolIds,
    context,
  );
  const defaultId = nodeIds.get(node);
  return target.ids.length === 0 && defaultId
    ? { ids: [defaultId], external: false }
    : target;
}

function targetForResolvedDeclaration(
  checker: ts.TypeChecker,
  node: ts.Node,
  symbolIds: ReadonlyMap<ts.Symbol, ReadonlySet<string>>,
  context: RelationshipContext,
  nodeIds: ReadonlyMap<ts.Node, string>,
): Target {
  const id = nodeIds.get(node);
  return id
    ? { ids: [id], external: false }
    : targetForDeclaration(checker, node, symbolIds, context, nodeIds);
}

function diagnostic(
  code: DiagnosticV1['code'],
  relationKind: EdgeKindV1,
  reason: NonNullable<DiagnosticV1['reason']>,
  source: ts.SourceFile,
  node: ts.Node,
  context: RelationshipContext,
  relatedNodeIds?: readonly string[],
): DiagnosticV1 {
  return {
    id: '',
    code,
    severity: code === 'relationship_missing_source' ? 'error' : 'warning',
    message: messages[code as keyof typeof messages],
    relationKind,
    reason,
    path: relative(context.repositoryRoot, source.fileName),
    location: location(context.repositoryRoot, source, node),
    ...(relatedNodeIds?.length
      ? { relatedNodeIds: [...new Set(relatedNodeIds)].sort(compare) }
      : {}),
  };
}

function makeEdge(
  kind: EdgeKindV1,
  from: string,
  to: string,
  occurrences: Map<string, LocationV1[]>,
): EdgeV1 {
  const key = `${kind}\0${from}\0${to}`;
  const locations = sortLocations(occurrences.get(key) ?? []);
  return {
    id: edgeId(kind, from, to),
    kind,
    from,
    to,
    resolutionStatus: 'resolved',
    ...(locations.length ? { locations } : {}),
  };
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

function addDiagnostic(
  diagnostics: DiagnosticV1[],
  code: DiagnosticV1['code'],
  kind: EdgeKindV1,
  reason: NonNullable<DiagnosticV1['reason']>,
  source: ts.SourceFile,
  node: ts.Node,
  context: RelationshipContext,
  related?: readonly string[],
): void {
  diagnostics.push(
    diagnostic(code, kind, reason, source, node, context, related),
  );
}

function isPrimitivePropertyAccess(
  checker: ts.TypeChecker,
  expression: ts.PropertyAccessExpression,
): boolean {
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike;
  return (
    (checker.getTypeAtLocation(expression.expression).flags & primitive) !== 0
  );
}

export function extractRelationships(context: RelationshipContext): {
  readonly edges: readonly EdgeV1[];
  readonly diagnostics: readonly DiagnosticV1[];
} {
  const checker = context.program.getTypeChecker();
  const symbolIds = new Map<ts.Symbol, Set<string>>();
  const nodeIds = new Map<ts.Node, string>();
  for (const declaration of context.declarations) {
    nodeIds.set(declaration.node, declaration.id);
    if (declaration.binding) nodeIds.set(declaration.binding, declaration.id);
    for (const symbol of [
      declarationSymbol(checker, declaration.node),
      declaration.binding
        ? declarationSymbol(checker, declaration.binding)
        : undefined,
    ]) {
      if (!symbol) continue;
      for (const item of aliases(checker, symbol)) {
        const ids = symbolIds.get(item) ?? new Set<string>();
        ids.add(declaration.id);
        symbolIds.set(item, ids);
      }
    }
  }

  const occurrences = new Map<string, LocationV1[]>();
  const diagnostics: DiagnosticV1[] = [];
  const add = (
    kind: EdgeKindV1,
    from: string | undefined,
    target: Target,
    source: ts.SourceFile,
    syntax: ts.Node,
  ): void => {
    if (!from) {
      addDiagnostic(
        diagnostics,
        'relationship_missing_source',
        kind,
        'missing-source-node',
        source,
        syntax,
        context,
      );
      return;
    }
    if (target.ids.length !== 1) {
      const code = target.external
        ? 'relationship_external'
        : target.ids.length > 1
          ? 'relationship_ambiguous'
          : 'relationship_unresolved';
      const reason = target.external
        ? 'external-target'
        : target.ids.length > 1
          ? 'ambiguous-target'
          : 'unresolved-target';
      addDiagnostic(
        diagnostics,
        code,
        kind,
        reason,
        source,
        syntax,
        context,
        target.ids,
      );
      return;
    }
    const to = target.ids[0]!;
    const fromNode = context.nodes.get(from);
    const toNode = context.nodes.get(to);
    if (!fromNode || !toNode) {
      addDiagnostic(
        diagnostics,
        'relationship_missing_source',
        kind,
        'missing-source-node',
        source,
        syntax,
        context,
      );
      return;
    }
    const valid =
      (kind === 'imports' &&
        fromNode.kind === 'module' &&
        toNode.kind === 'module') ||
      (kind === 'exports' &&
        fromNode.kind === 'module' &&
        [
          'module',
          'class',
          'interface',
          'function',
          'variable',
          'type',
        ].includes(toNode.kind)) ||
      (kind === 'extends' &&
        ['class', 'interface'].includes(fromNode.kind) &&
        ['class', 'interface'].includes(toNode.kind)) ||
      (kind === 'implements' &&
        fromNode.kind === 'class' &&
        toNode.kind === 'interface') ||
      (kind === 'calls' &&
        fromNode.kind === 'function' &&
        toNode.kind === 'function');
    if (!valid) {
      addDiagnostic(
        diagnostics,
        'relationship_unsupported',
        kind,
        'unsupported-relation',
        source,
        syntax,
        context,
        [to],
      );
      return;
    }
    const key = `${kind}\0${from}\0${to}`;
    const list = occurrences.get(key) ?? [];
    list.push(location(context.repositoryRoot, source, syntax));
    occurrences.set(key, list);
  };

  const moduleFor = (source: ts.SourceFile): string | undefined =>
    context.moduleIds.get(relative(context.repositoryRoot, source.fileName));
  const functionFor = (node: ts.Node): string | undefined => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      const id = nodeIds.get(current);
      if (id && context.nodes.get(id)?.kind === 'function') return id;
      current = current.parent;
    }
    return undefined;
  };

  const visit = (source: ts.SourceFile, node: ts.Node): void => {
    const moduleId = moduleFor(source);
    if (
      moduleId &&
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableStatement(node)) &&
      isExported(node)
    ) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          add(
            'exports',
            moduleId,
            targetForDeclaration(
              checker,
              declaration,
              symbolIds,
              context,
              nodeIds,
            ),
            source,
            declaration,
          );
        }
      } else {
        add(
          'exports',
          moduleId,
          targetForDeclaration(checker, node, symbolIds, context, nodeIds),
          source,
          node,
        );
      }
    } else if (ts.isImportDeclaration(node)) {
      add(
        'imports',
        moduleId,
        sourceModuleTarget(checker, node.moduleSpecifier, context, symbolIds),
        source,
        node,
      );
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression) {
        add(
          'imports',
          moduleId,
          sourceModuleTarget(checker, reference.expression, context, symbolIds),
          source,
          node,
        );
      } else {
        addDiagnostic(
          diagnostics,
          'relationship_unsupported',
          'imports',
          'unsupported-relation',
          source,
          node,
          context,
        );
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        const targetModule = sourceModuleTarget(
          checker,
          node.moduleSpecifier,
          context,
          symbolIds,
        );
        if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          add('exports', moduleId, targetModule, source, node);
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const specifier of node.exportClause.elements) {
            add(
              'exports',
              moduleId,
              specifier.propertyName?.text === 'default'
                ? defaultTargetForModule(checker, node.moduleSpecifier, context)
                : targetForSymbol(
                    checker,
                    checker.getSymbolAtLocation(
                      specifier.propertyName ?? specifier.name,
                    ),
                    symbolIds,
                    context,
                  ),
              source,
              specifier,
            );
          }
        } else {
          const targetSymbol = checker.getSymbolAtLocation(
            node.moduleSpecifier,
          );
          const exports = targetSymbol
            ? checker.getExportsOfModule(targetSymbol)
            : [];
          for (const item of exports)
            add(
              'exports',
              moduleId,
              targetForSymbol(checker, item, symbolIds, context),
              source,
              node,
            );
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const specifier of node.exportClause.elements)
          add(
            'exports',
            moduleId,
            specifier.name.text === 'default'
              ? defaultTargetForSource(source, context)
              : targetForSymbol(
                  checker,
                  checker.getSymbolAtLocation(specifier.name),
                  symbolIds,
                  context,
                ),
            source,
            specifier,
          );
      }
    } else if (ts.isExportAssignment(node)) {
      add(
        'exports',
        moduleId,
        targetForSymbol(
          checker,
          checker.getSymbolAtLocation(node.expression),
          symbolIds,
          context,
        ),
        source,
        node,
      );
    } else if (ts.isHeritageClause(node)) {
      const owner = node.parent;
      const ownerId = nodeIds.get(owner);
      const kind =
        node.token === ts.SyntaxKind.ImplementsKeyword
          ? 'implements'
          : 'extends';
      for (const type of node.types) {
        if (ts.isCallExpression(type.expression)) {
          addDiagnostic(
            diagnostics,
            'relationship_dynamic',
            kind,
            'dynamic-target',
            source,
            type,
            context,
          );
          continue;
        }
        const symbol = checker.getTypeAtLocation(type.expression).symbol;
        add(
          kind,
          ownerId,
          targetForSymbol(checker, symbol, symbolIds, context),
          source,
          type,
        );
      }
    } else if (ts.isCallExpression(node)) {
      const caller = functionFor(node);
      if (!caller) {
        addDiagnostic(
          diagnostics,
          'relationship_unsupported',
          'calls',
          'unsupported-relation',
          source,
          node,
          context,
        );
      } else if (
        ts.isIdentifier(node.expression) ||
        ts.isPropertyAccessExpression(node.expression)
      ) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'
        ) {
          addDiagnostic(
            diagnostics,
            'relationship_dynamic',
            'calls',
            'dynamic-target',
            source,
            node,
            context,
          );
        } else {
          const signature = checker.getResolvedSignature(node);
          const declaration = signature?.declaration;
          add(
            'calls',
            caller,
            declaration
              ? targetForResolvedDeclaration(
                  checker,
                  declaration,
                  symbolIds,
                  context,
                  nodeIds,
                )
              : ts.isPropertyAccessExpression(node.expression) &&
                  isPrimitivePropertyAccess(checker, node.expression)
                ? { ids: [], external: true }
                : { ids: [], external: false },
            source,
            node,
          );
        }
      } else {
        addDiagnostic(
          diagnostics,
          'relationship_dynamic',
          'calls',
          'dynamic-target',
          source,
          node,
          context,
        );
      }
    }
    ts.forEachChild(node, (child) => visit(source, child));
  };

  for (const source of context.sources.values()) visit(source, source);
  const edges = [...occurrences.keys()].sort(compare).map((key) => {
    const [kind, from, to] = key.split('\0');
    return makeEdge(kind as EdgeKindV1, from!, to!, occurrences);
  });
  return { edges, diagnostics };
}
