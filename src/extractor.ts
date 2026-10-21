import path from 'node:path';
import ts from 'typescript';
import type { LoadedProject } from './project-loader/types.js';
import {
  compareDiagnostics,
  compareEdges,
  compareNodes,
  digest,
  edgeId,
  fileId,
  nodeId,
  repositoryId,
  sortLocations,
  type DeclarationGraph,
  type DiagnosticV1,
  type EdgeV1,
  type FileNodeV1,
  type LocationV1,
  type MemberRole,
  type NodeV1,
  type SymbolNodeV1,
} from './graph.js';

export interface ExtractDeclarationGraphRequest {
  readonly repositoryRoot: string;
  readonly project: LoadedProject;
  readonly repositoryName?: string;
}

interface Candidate {
  readonly kind: SymbolNodeV1['kind'];
  readonly name: string;
  readonly qualifiedName: string;
  readonly path: string;
  readonly memberRole: MemberRole;
  readonly parentId: string;
  readonly scope: string;
  readonly locations: LocationV1[];
  readonly signature: string;
  readonly node: ts.Node;
}

const unsupported = new Set(['Constructor', 'GetAccessor', 'SetAccessor']);

function ordinal(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}
function relative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join('/');
}
function nameOf(node: ts.NamedDeclaration): string | undefined {
  return node.name && ts.isIdentifier(node.name) ? node.name.text.normalize('NFC') : undefined;
}
function typeText(node: ts.Node | undefined): string {
  if (node === undefined) return 'absent';
  return node.getText().replace(/\s+/gu, ' ').trim().normalize('NFC');
}
function signature(node: ts.Node, kind: string, name: string): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
    return JSON.stringify(['function', name, [], node.parameters.map((p) => [nameOf(p) ?? 'parameter', !!p.questionToken, !!p.dotDotDotToken, typeText(p.type)]), typeText(node.type)]);
  if (ts.isVariableDeclaration(node)) return JSON.stringify(['variable', name, typeText(node.type)]);
  if (ts.isParameter(node)) return JSON.stringify(['parameter', name, typeText(node.type)]);
  if (ts.isModuleDeclaration(node)) return JSON.stringify(['module', name]);
  return JSON.stringify(['declaration', kind, name, []]);
}
function location(root: string, source: ts.SourceFile, node: ts.Node): LocationV1 {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return { path: relative(root, source.fileName), start: { line: start.line + 1, column: start.character + 1 }, end: { line: end.line + 1, column: end.character + 1 } };
}
function qualified(parent: string, name: string): string {
  return parent === '' ? name : `${parent}.${name}`;
}
function blockScope(parentId: string, nodes: readonly ts.Node[]): string {
  const bindings: string[] = [];
  const kinds: string[] = [];
  const signatures: string[] = [];
  for (const node of nodes) {
    const declaration = node as ts.NamedDeclaration;
    const name = declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
    if (name !== undefined) {
      bindings.push(name.normalize('NFC'));
      kinds.push(ts.SyntaxKind[node.kind]);
      signatures.push(signature(node, ts.SyntaxKind[node.kind], name));
    }
  }
  bindings.sort(ordinal); kinds.sort(ordinal); signatures.sort(ordinal);
  return `block:${digest('b', ['sourcemesh-block-v1', '1', parentId, 'block', JSON.stringify(bindings), JSON.stringify(kinds), JSON.stringify(signatures)])}`;
}
function scopeForChild(parentScope: string, parentId: string, kind: string, qualifiedName: string): string {
  return `${parentScope.slice(0, parentScope.indexOf('#scope'))}/${parentId}#scope=${kind}:${qualifiedName}`;
}
function scopeForBlock(parentScope: string, descriptor: string): string {
  const marker = parentScope.indexOf('#scope');
  const lexical = parentScope.slice(marker + '#scope='.length);
  return `${parentScope.slice(0, marker)}#scope=${lexical}/${descriptor}`;
}

export function extractDeclarationGraph(request: ExtractDeclarationGraphRequest): DeclarationGraph {
  const requestedName = request.repositoryName?.normalize('NFC');
  const repositoryName = requestedName && !/[\\/\u0000-\u001f]/u.test(requestedName) ? requestedName : 'repository';
  const repository = { id: repositoryId(), kind: 'repository' as const, root: '.' as const, name: repositoryName || 'repository' };
  const nodes: NodeV1[] = [repository];
  const edges: EdgeV1[] = [];
  const diagnostics: DiagnosticV1[] = [];
  const candidates: Candidate[] = [];
  const sourceByPath = new Map<string, ts.SourceFile>();
  for (const relativePath of request.project.rootNames) {
    const canonicalPath = relativePath.replaceAll('\\', '/');
    const source = request.project.program.getSourceFile(path.resolve(request.repositoryRoot, relativePath));
    if (source === undefined) {
      diagnostics.push(makeDiagnostic('declaration.unstable_identity', canonicalPath));
      continue;
    }
    sourceByPath.set(canonicalPath, source);
    const file: FileNodeV1 = { id: fileId(canonicalPath), kind: 'file', name: path.posix.basename(canonicalPath), path: canonicalPath };
    nodes.push(file); edges.push(makeEdge(repository.id, file.id));
    const moduleName = canonicalPath;
    const moduleParentScope = `${repository.id}/${file.id}#scope=root`;
    const module: SymbolNodeV1 = { id: nodeId('module', canonicalPath, moduleParentScope, moduleName, 'none'), kind: 'module', name: moduleName, path: canonicalPath, qualifiedName: moduleName, memberRole: 'none' };
    nodes.push(module); edges.push(makeEdge(file.id, module.id));
    visitSource(request.repositoryRoot, source, module.id, module.qualifiedName, `${repository.id}/${file.id}/${module.id}#scope=module:${module.qualifiedName}`, candidates, diagnostics);
  }

  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}|${candidate.path}|${candidate.parentId}|${candidate.name}|${candidate.memberRole}`;
    const group = grouped.get(key) ?? []; group.push(candidate); grouped.set(key, group);
  }
  const ids = new Map<string, Candidate>();
  for (const group of grouped.values()) {
    const first = group[0]!;
    const duplicates = new Set(group.map((item) => item.signature));
    const mergeable = first.kind === 'interface' || first.kind === 'module';
    if (!mergeable && duplicates.size !== group.length) {
      diagnostics.push(makeDiagnostic('duplicate_declaration', first.path, first.locations[0]));
      continue;
    }
    const locations = sortLocations(group.flatMap((item) => item.locations));
    const id = nodeId(first.kind, first.path, first.scope, first.name, first.memberRole);
    const prior = ids.get(id);
    if (prior !== undefined) {
      diagnostics.push(makeDiagnostic('graph.node_id_collision', first.path, first.locations[0]));
      continue;
    }
    ids.set(id, first);
    const node: SymbolNodeV1 = { id, kind: first.kind, name: first.name, path: first.path, qualifiedName: first.qualifiedName, memberRole: first.memberRole, ...(locations.length ? { locations } : {}) };
    nodes.push(node); edges.push(makeEdge(first.parentId, id, locations));
    if (first.kind === 'function' && isFunctionLikeNode(first.node)) {
      for (const parameter of first.node.parameters) {
        const parameterName = nameOf(parameter) ?? 'parameter';
        const parameterCandidate: Candidate = { kind: 'parameter', name: parameterName, qualifiedName: qualified(first.qualifiedName, parameterName), path: first.path, memberRole: 'none', parentId: id, scope: scopeForChild(first.scope, id, 'function', first.qualifiedName), locations: [location(request.repositoryRoot, sourceByPath.get(first.path)!, parameter)], signature: signature(parameter, 'parameter', parameterName), node: parameter };
        const parameterId = nodeId('parameter', parameterCandidate.path, parameterCandidate.scope, parameterName, 'none');
        if (!ids.has(parameterId)) { ids.set(parameterId, parameterCandidate); nodes.push({ id: parameterId, kind: 'parameter', name: parameterName, path: parameterCandidate.path, qualifiedName: parameterCandidate.qualifiedName, memberRole: 'none', locations: parameterCandidate.locations }); edges.push(makeEdge(id, parameterId, parameterCandidate.locations)); }
      }
    }
  }
  const uniqueDiagnostics = new Map<string, DiagnosticV1>();
  for (const item of diagnostics.map(withDiagnosticId)) uniqueDiagnostics.set(item.id, item);
  return { schemaVersion: 1, repository: { root: '.', name: repository.name }, nodes: nodes.sort(compareNodes), edges: edges.sort(compareEdges), diagnostics: [...uniqueDiagnostics.values()].sort(compareDiagnostics) };
}

function visitSource(root: string, source: ts.SourceFile, parentId: string, parentQualified: string, scope: string, candidates: Candidate[], diagnostics: DiagnosticV1[]): void {
  const visit = (node: ts.Node, parent: string, parentName: string, currentScope: string): void => {
    if (ts.isModuleDeclaration(node)) {
      const name = nameOf(node);
      if (name === undefined) { diagnostics.push(makeDiagnostic('declaration.unstable_identity', relative(root, source.fileName), location(root, source, node))); return; }
      const candidate: Candidate = { kind: 'module', name, qualifiedName: qualified(parentName, name), path: relative(root, source.fileName), memberRole: 'none', parentId: parent, scope: currentScope, locations: [location(root, source, node)], signature: signature(node, 'module', name), node };
      candidates.push(candidate);
      const id = nodeId(candidate.kind, candidate.path, candidate.scope, name, 'none');
      const body = node.body;
      if (body !== undefined) visit(body, id, candidate.qualifiedName, scopeForChild(currentScope, id, 'module', candidate.qualifiedName));
      return;
    }
    if (ts.isModuleBlock(node)) { for (const child of node.statements) visit(child, parent, parentName, currentScope); return; }
    const declaration = node as ts.NamedDeclaration;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = nameOf(declaration) ?? (hasDefaultExport(node) ? 'default' : undefined);
      if (name === undefined) { diagnostics.push(makeDiagnostic('unsupported_declaration', relative(root, source.fileName), location(root, source, node))); return; }
      const kind = ts.isFunctionDeclaration(node) ? 'function' : ts.isClassDeclaration(node) ? 'class' : ts.isInterfaceDeclaration(node) ? 'interface' : 'type';
      const candidate: Candidate = { kind, name, qualifiedName: qualified(parentName, name), path: relative(root, source.fileName), memberRole: 'none', parentId: parent, scope: currentScope, locations: [location(root, source, node)], signature: signature(node, kind, name), node };
      candidates.push(candidate);
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) for (const member of node.members) visitMember(member, candidate, source, root, candidates, diagnostics);
      if (ts.isFunctionDeclaration(node)) { const id = nodeId(candidate.kind, candidate.path, candidate.scope, candidate.name, candidate.memberRole); for (const statement of node.body?.statements ?? []) visit(statement, id, candidate.qualifiedName, scopeForChild(candidate.scope, id, 'function', candidate.qualifiedName)); }
      return;
    }
    if (ts.isVariableStatement(node)) { for (const variable of node.declarationList.declarations) visitVariable(variable, parent, parentName, currentScope, source, root, candidates, diagnostics); return; }
    if (ts.isBlock(node) || ts.isSourceFile(node)) { const next = ts.isBlock(node) ? scopeForBlock(currentScope, blockScope(parent, node.statements)) : currentScope; for (const child of node.statements) visit(child, parent, parentName, next); return; }
    if (ts.isExpressionStatement(node)) visit(node.expression, parent, parentName, currentScope);
  };
  for (const statement of source.statements) visit(statement, parentId, parentQualified, scope);
}

function visitVariable(variable: ts.VariableDeclaration, parent: string, parentName: string, scope: string, source: ts.SourceFile, root: string, candidates: Candidate[], diagnostics: DiagnosticV1[]): void {
  const name = nameOf(variable); if (name === undefined) { diagnostics.push(makeDiagnostic('declaration.unstable_identity', relative(root, source.fileName), location(root, source, variable))); return; }
  const initializer = variable.initializer;
  const kind = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? 'function' : initializer && ts.isClassExpression(initializer) ? 'class' : 'variable';
  const candidate: Candidate = { kind, name, qualifiedName: qualified(parentName, name), path: relative(root, source.fileName), memberRole: 'none', parentId: parent, scope, locations: [location(root, source, variable)], signature: signature(variable, kind, name), node: initializer && (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer) || ts.isClassExpression(initializer)) ? initializer : variable };
  candidates.push(candidate);
  if (kind === 'class' && ts.isClassExpression(initializer)) for (const member of initializer.members) visitMember(member, candidate, source, root, candidates, diagnostics);
}
function visitMember(member: ts.ClassElement | ts.TypeElement, owner: Candidate, source: ts.SourceFile, root: string, candidates: Candidate[], diagnostics: DiagnosticV1[]): void {
  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
    const nameNode = member.name; const name = nameNode && ts.isIdentifier(nameNode) ? nameNode.text.normalize('NFC') : undefined;
    if (name === undefined) { diagnostics.push(makeDiagnostic('unsupported_declaration', relative(root, source.fileName), location(root, source, member))); return; }
    const role: MemberRole = ts.isMethodDeclaration(member) && member.modifiers?.some((item) => item.kind === ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance';
    const ownerId = nodeId(owner.kind, owner.path, owner.scope, owner.name, owner.memberRole);
    candidates.push({ kind: 'function', name, qualifiedName: qualified(owner.qualifiedName, name), path: owner.path, memberRole: role, parentId: ownerId, scope: scopeForChild(owner.scope, ownerId, 'class', owner.qualifiedName), locations: [location(root, source, member)], signature: signature(member, 'function', name), node: member });
    return;
  }
  if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
    const name = member.name && ts.isIdentifier(member.name) ? member.name.text.normalize('NFC') : undefined;
    if (name !== undefined) { const ownerId = nodeId(owner.kind, owner.path, owner.scope, owner.name, owner.memberRole); candidates.push({ kind: 'variable', name, qualifiedName: qualified(owner.qualifiedName, name), path: owner.path, memberRole: 'instance', parentId: ownerId, scope: scopeForChild(owner.scope, ownerId, 'class', owner.qualifiedName), locations: [location(root, source, member)], signature: signature(member, 'variable', name), node: member }); }
    return;
  }
  if (unsupported.has(ts.SyntaxKind[member.kind])) diagnostics.push(makeDiagnostic('unsupported_declaration', relative(root, source.fileName), location(root, source, member)));
}
function hasDefaultExport(node: ts.Node): boolean { return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword) === true; }
function isFunctionLikeNode(node: ts.Node): node is ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature | ts.FunctionExpression | ts.ArrowFunction { return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node); }
function makeEdge(from: string, to: string, locations?: readonly LocationV1[]): EdgeV1 { return { id: edgeId('contains', from, to), kind: 'contains', from, to, resolutionStatus: 'resolved', ...(locations && locations.length ? { locations: sortLocations(locations) } : {}) }; }
function makeDiagnostic(code: DiagnosticV1['code'], pathName: string, item?: LocationV1): DiagnosticV1 { const messages = { unsupported_declaration: 'Declaration kind is unsupported in the MVP.', duplicate_declaration: 'Duplicate declaration signature was omitted.', 'declaration.unstable_identity': 'Declaration identity could not be stabilized.', 'graph.node_id_collision': 'Graph node identity collision prevented node emission.' } as const; return { id: '', code, severity: code === 'unsupported_declaration' ? 'warning' : 'error', message: messages[code], path: pathName, ...(item ? { location: item } : {}) }; }
function withDiagnosticId(item: DiagnosticV1): DiagnosticV1 {
  const locationKey = item.location === undefined ? undefined : `${item.location.path}#${item.location.start.line}:${item.location.start.column}-${item.location.end.line}:${item.location.end.column}`;
  const pathField = item.path === undefined ? 'absent' : `present:${item.path}`;
  const locationField = locationKey === undefined ? 'absent' : `present:${locationKey}`;
  const occurrence = JSON.stringify([pathField, locationField, 'absent', 'absent', 'absent']);
  return { ...item, id: digest('d', ['sourcemesh-diagnostic-v1', '1', item.code, item.severity, item.message, 'absent', 'absent', pathField, locationField, 'absent', occurrence]) };
}
