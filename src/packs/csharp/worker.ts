import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSHARP_MAX_SOURCE_BYTES,
  CSHARP_MAX_AGGREGATE_READ_BYTES,
  CSHARP_MAX_PROJECT_FILES,
  CSHARP_MAX_PROJECT_REFERENCES,
  CSHARP_MAX_PROJECTS,
  CSHARP_MAX_READ_OPERATIONS,
  CSHARP_MAX_SOLUTION_PROJECTS,
  CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
  compareCSharpUtf8Ordinal,
  createCSharpExplicitProjectSelection,
  type CSharpAnalysisManifest,
  type CSharpExplicitProjectManifest,
  type CSharpManifest,
  type CSharpProjectManifest,
  type CSharpWorkerDeclaration,
  type CSharpWorkerLocation,
  type CSharpWorkerProjectResult,
  type CSharpWorkerRelationship,
  type CSharpWorkerRelationshipKind,
  type CSharpWorkerRelationshipStatus,
  type CSharpWorkerSymbol,
} from './contracts.js';
import { normalizeRelativePath, readFileBounded } from '../../discovery.js';

export type { CSharpWorkerProjectResult } from './contracts.js';

/** Maximum delay accepted by Node's timer APIs when an automation opts in. */
export const CSHARP_WORKER_MAX_TIMEOUT_MS = 2_147_483_647;
export const CSHARP_WORKER_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const CSHARP_WORKER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const CSHARP_WORKER_MAX_STDERR_BYTES = 64 * 1024;
export const CSHARP_WORKER_MAX_DIAGNOSTICS = 4096;

export type CSharpSourceEncoding = 'windows-1252';

export interface CSharpWorkerOptions {
  readonly sourceEncoding?: CSharpSourceEncoding;
  /**
   * Optional automation deadline. Local analysis deliberately has no implicit
   * wall-clock limit because elapsed time depends on the repository and host.
   */
  readonly timeoutMs?: number;
}

export interface CSharpWorkerDiagnostic {
  readonly project: string;
  readonly code: 'compiler_error' | 'compiler_warning';
  readonly severity: 'error' | 'warning';
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface CSharpWorkerResult {
  readonly projects: readonly CSharpWorkerProjectResult[];
  readonly diagnostics: readonly CSharpWorkerDiagnostic[];
}

export class CSharpWorkerError extends Error {
  constructor(
    readonly code:
      | 'helper_missing'
      | 'input_invalid'
      | 'process_failed'
      | 'protocol_invalid'
      | 'resource_limit'
      | 'source_encoding_invalid',
    readonly relativePath?: string,
  ) {
    super('The local C# analysis helper could not complete.');
    this.name = 'CSharpWorkerError';
  }
}

interface WorkerInvocation {
  readonly command: string;
  readonly args: readonly [string];
  readonly cwd: string;
  readonly input: string;
  readonly timeoutMs?: number;
  readonly shell: false;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface WorkerExecution {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

interface WorkerSource {
  readonly path: string;
  readonly staged: string;
}

interface SourcePlan extends WorkerSource {
  readonly occurrences: number;
}

type WorkerRunner = (invocation: WorkerInvocation) => Promise<WorkerExecution>;
type StagingCreator = (prefix: string) => Promise<string>;

const helperDll = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tools/sourcemesh-roslyn/bin/Release/net10.0/sourcemesh-roslyn.dll',
);
const dotnetHost =
  process.platform === 'win32'
    ? 'C:\\Program Files\\dotnet\\dotnet.exe'
    : undefined;
const windowsDeviceNames = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function fail(code: CSharpWorkerError['code']): never {
  throw new CSharpWorkerError(code);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closedObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    plainObject(value) && Object.keys(value).every((key) => keys.includes(key))
  );
}

function safePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes(':')) return false;
  if (normalizeRelativePath(value) !== value) return false;
  return !value.split('/').some((segment) => {
    const normalized = segment
      .replace(/[ .]+$/u, '')
      .split('.')[0]!
      .toUpperCase();
    return windowsDeviceNames.has(normalized);
  });
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

const ordinal = compareCSharpUtf8Ordinal;

const workerNodeKinds = new Set<CSharpWorkerSymbol['kind']>([
  'module',
  'namespace',
  'class',
  'interface',
  'function',
  'variable',
  'type',
  'parameter',
]);
const workerMemberRoles = new Set<CSharpWorkerSymbol['memberRole']>([
  'none',
  'static',
  'instance',
]);
const workerRelationshipKinds = new Set<CSharpWorkerRelationshipKind>([
  'uses',
  'extends',
  'implements',
  'calls',
]);
const workerRelationshipStatuses = new Set<CSharpWorkerRelationshipStatus>([
  'resolved',
  'external',
  'unresolved',
  'ambiguous',
  'dynamic',
  'unsupported',
  'missing-source',
]);

function safeText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384)
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    else if (code < 0x20) return false;
  }
  return true;
}

function comparePosition(
  left: CSharpWorkerPositionLike,
  right: CSharpWorkerPositionLike,
): number {
  return left.line - right.line || left.column - right.column;
}

interface CSharpWorkerPositionLike {
  readonly line: number;
  readonly column: number;
}

function compareLocation(
  left: CSharpWorkerLocation,
  right: CSharpWorkerLocation,
): number {
  return (
    ordinal(left.path, right.path) ||
    comparePosition(left.start, right.start) ||
    comparePosition(left.end, right.end)
  );
}

function clonePosition(value: unknown): CSharpWorkerPositionLike {
  if (!closedObject(value, ['line', 'column'])) fail('protocol_invalid');
  if (!positiveInteger(value.line) || !positiveInteger(value.column))
    fail('protocol_invalid');
  return Object.freeze({ line: value.line, column: value.column });
}

function cloneLocation(
  value: unknown,
  allowedPaths: ReadonlySet<string>,
): CSharpWorkerLocation {
  if (!closedObject(value, ['path', 'start', 'end'])) fail('protocol_invalid');
  if (!safePath(value.path) || !allowedPaths.has(value.path))
    fail('protocol_invalid');
  const start = clonePosition(value.start);
  const end = clonePosition(value.end);
  if (comparePosition(start, end) > 0) fail('protocol_invalid');
  return Object.freeze({
    path: value.path,
    start,
    end,
  });
}

function cloneSymbol(
  value: unknown,
  allowedPaths: ReadonlySet<string>,
): CSharpWorkerSymbol {
  if (
    !closedObject(value, [
      'kind',
      'path',
      'name',
      'qualifiedName',
      'memberRole',
    ]) ||
    typeof value.kind !== 'string' ||
    !workerNodeKinds.has(value.kind as CSharpWorkerSymbol['kind']) ||
    !safePath(value.path) ||
    !allowedPaths.has(value.path) ||
    !safeText(value.name) ||
    !safeText(value.qualifiedName) ||
    typeof value.memberRole !== 'string' ||
    !workerMemberRoles.has(value.memberRole as CSharpWorkerSymbol['memberRole'])
  )
    fail('protocol_invalid');
  return Object.freeze({
    kind: value.kind as CSharpWorkerSymbol['kind'],
    path: value.path,
    name: value.name,
    qualifiedName: value.qualifiedName,
    memberRole: value.memberRole as CSharpWorkerSymbol['memberRole'],
  });
}

function compareSymbol(
  left: CSharpWorkerSymbol,
  right: CSharpWorkerSymbol,
): number {
  return (
    ordinal(left.path, right.path) ||
    ordinal(left.qualifiedName, right.qualifiedName) ||
    ordinal(left.kind, right.kind) ||
    ordinal(left.memberRole, right.memberRole) ||
    ordinal(left.name, right.name)
  );
}

function cloneDeclaration(
  value: unknown,
  allowedPaths: ReadonlySet<string>,
): CSharpWorkerDeclaration {
  if (
    !closedObject(value, [
      'kind',
      'path',
      'name',
      'qualifiedName',
      'memberRole',
      'parent',
      'locations',
    ])
  )
    fail('protocol_invalid');
  const symbol = cloneSymbol(
    {
      kind: value.kind,
      path: value.path,
      name: value.name,
      qualifiedName: value.qualifiedName,
      memberRole: value.memberRole,
    },
    allowedPaths,
  );
  if (symbol.kind === 'module') fail('protocol_invalid');
  if (
    !closedObject(value.parent, [
      'kind',
      'path',
      'name',
      'qualifiedName',
      'memberRole',
    ])
  )
    fail('protocol_invalid');
  const parent = cloneSymbol(value.parent, allowedPaths);
  if (
    !['module', 'namespace', 'class', 'interface', 'type', 'function'].includes(
      parent.kind,
    )
  )
    fail('protocol_invalid');
  if (
    !Array.isArray(value.locations) ||
    value.locations.length === 0 ||
    value.locations.length > 4096
  )
    fail('protocol_invalid');
  const locations = value.locations.map((item) =>
    cloneLocation(item, allowedPaths),
  );
  if (
    !locations.every(
      (item, index) =>
        index === 0 || compareLocation(locations[index - 1]!, item) <= 0,
    )
  )
    fail('protocol_invalid');
  return Object.freeze({
    ...symbol,
    parent,
    locations: Object.freeze(locations),
  });
}

function cloneRelationship(
  value: unknown,
  allowedPaths: ReadonlySet<string>,
): CSharpWorkerRelationship {
  if (!closedObject(value, ['kind', 'status', 'source', 'target', 'location']))
    fail('protocol_invalid');
  if (
    typeof value.kind !== 'string' ||
    !workerRelationshipKinds.has(value.kind as CSharpWorkerRelationshipKind) ||
    typeof value.status !== 'string' ||
    !workerRelationshipStatuses.has(
      value.status as CSharpWorkerRelationshipStatus,
    )
  )
    fail('protocol_invalid');
  const source = cloneSymbol(value.source, allowedPaths);
  const status = value.status as CSharpWorkerRelationshipStatus;
  const target =
    value.target === undefined
      ? undefined
      : cloneSymbol(value.target, allowedPaths);
  if ((status === 'resolved') !== (target !== undefined))
    fail('protocol_invalid');
  const location =
    value.location === undefined
      ? undefined
      : cloneLocation(value.location, allowedPaths);
  return Object.freeze({
    kind: value.kind as CSharpWorkerRelationshipKind,
    status,
    source,
    ...(target === undefined ? {} : { target }),
    ...(location === undefined ? {} : { location }),
  });
}

function compareDeclaration(
  left: CSharpWorkerDeclaration,
  right: CSharpWorkerDeclaration,
): number {
  return (
    compareSymbol(left, right) ||
    compareSymbol(left.parent, right.parent) ||
    compareLocation(left.locations[0]!, right.locations[0]!)
  );
}

const emptyLocation: CSharpWorkerLocation = {
  path: '',
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 },
};

function compareRelationship(
  left: CSharpWorkerRelationship,
  right: CSharpWorkerRelationship,
): number {
  return (
    ordinal(left.kind, right.kind) ||
    ordinal(left.status, right.status) ||
    compareSymbol(left.source, right.source) ||
    compareSymbol(left.target ?? left.source, right.target ?? right.source) ||
    compareLocation(
      left.location ?? emptyLocation,
      right.location ?? emptyLocation,
    )
  );
}

function sorted<T extends { readonly path: string }>(
  items: readonly T[],
): boolean {
  return items.every(
    (item, index) =>
      index === 0 || ordinal(items[index - 1]!.path, item.path) <= 0,
  );
}

function cloneProject(value: unknown): CSharpProjectManifest {
  if (
    !closedObject(value, [
      'path',
      'targetFramework',
      'langVersion',
      'references',
      'files',
    ])
  )
    fail('input_invalid');
  if (
    !safePath(value.path) ||
    !Array.isArray(value.references) ||
    !Array.isArray(value.files)
  )
    fail('input_invalid');
  if (
    (value.targetFramework !== undefined &&
      typeof value.targetFramework !== 'string') ||
    (value.langVersion !== undefined && typeof value.langVersion !== 'string')
  )
    fail('input_invalid');
  if (!value.references.every(safePath) || !value.files.every(safePath))
    fail('input_invalid');
  if (
    value.references.length > CSHARP_MAX_PROJECT_REFERENCES ||
    value.files.length > CSHARP_MAX_PROJECT_FILES ||
    new Set(value.references).size !== value.references.length ||
    new Set(value.files).size !== value.files.length
  )
    fail('input_invalid');
  return Object.freeze({
    path: value.path,
    ...(value.targetFramework === undefined
      ? {}
      : { targetFramework: value.targetFramework }),
    ...(value.langVersion === undefined
      ? {}
      : { langVersion: value.langVersion }),
    references: Object.freeze([...value.references]),
    files: Object.freeze([...value.files]),
  });
}

function cloneLegacyManifest(value: CSharpManifest): CSharpManifest {
  const candidate: unknown = value;
  if (
    !closedObject(candidate, [
      'language',
      'selection',
      'solution',
      'projects',
    ]) ||
    candidate.language !== 'csharp' ||
    !closedObject(candidate.selection, ['kind', 'path']) ||
    (candidate.selection.kind !== 'solution' &&
      candidate.selection.kind !== 'project') ||
    !safePath(candidate.selection.path) ||
    !Array.isArray(candidate.projects)
  )
    fail('input_invalid');
  if (
    candidate.projects.length === 0 ||
    candidate.projects.length > CSHARP_MAX_PROJECTS
  )
    fail('input_invalid');
  const projects = candidate.projects.map(cloneProject);
  const sourceReferences = projects.reduce(
    (total, project) => total + project.files.length,
    0,
  );
  if (
    sourceReferences > CSHARP_MAX_READ_OPERATIONS ||
    !sorted(projects) ||
    new Set(projects.map((project) => project.path)).size !== projects.length
  )
    fail('input_invalid');
  let solution: CSharpManifest['solution'];
  if (candidate.solution !== undefined) {
    if (
      !closedObject(candidate.solution, ['path', 'projects']) ||
      !safePath(candidate.solution.path) ||
      !Array.isArray(candidate.solution.projects) ||
      candidate.solution.projects.length > CSHARP_MAX_SOLUTION_PROJECTS ||
      !candidate.solution.projects.every(safePath) ||
      new Set(candidate.solution.projects).size !==
        candidate.solution.projects.length
    )
      fail('input_invalid');
    solution = Object.freeze({
      path: candidate.solution.path,
      projects: Object.freeze([...candidate.solution.projects]),
    });
  }
  const paths = new Set(projects.map((project) => project.path));
  if (
    projects.some((project) =>
      project.references.some((reference) => reference === project.path),
    )
  )
    fail('input_invalid');
  if (candidate.selection.kind === 'solution') {
    if (
      solution === undefined ||
      solution.path !== candidate.selection.path ||
      solution.projects.length !== projects.length ||
      solution.projects.some(
        (project, index) => project !== projects[index]!.path,
      )
    )
      fail('input_invalid');
  } else if (solution !== undefined || !paths.has(candidate.selection.path))
    fail('input_invalid');
  return Object.freeze({
    language: 'csharp',
    selection: Object.freeze({
      kind: candidate.selection.kind,
      path: candidate.selection.path,
    }),
    ...(solution === undefined ? {} : { solution }),
    projects: Object.freeze(projects),
  });
}

function cloneExplicitManifest(
  value: CSharpExplicitProjectManifest,
): CSharpExplicitProjectManifest {
  const candidate: unknown = value;
  if (
    !closedObject(candidate, ['language', 'selection', 'projects']) ||
    candidate.language !== 'csharp' ||
    !closedObject(candidate.selection, ['version', 'kind', 'projects']) ||
    candidate.selection.version !== CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION ||
    candidate.selection.kind !== 'explicit-projects' ||
    !Array.isArray(candidate.selection.projects) ||
    !candidate.selection.projects.every(safePath) ||
    !Array.isArray(candidate.projects)
  )
    fail('input_invalid');
  if (
    candidate.projects.length === 0 ||
    candidate.projects.length > CSHARP_MAX_PROJECTS
  )
    fail('input_invalid');
  const selectedProjects = candidate.selection.projects as string[];
  const projects = candidate.projects.map(cloneProject);
  const normalizedSelection =
    createCSharpExplicitProjectSelection(selectedProjects);
  const sourceReferences = projects.reduce(
    (total, project) => total + project.files.length,
    0,
  );
  if (
    sourceReferences > CSHARP_MAX_READ_OPERATIONS ||
    !sorted(projects) ||
    new Set(projects.map((project) => project.path)).size !== projects.length ||
    'diagnostic' in normalizedSelection ||
    selectedProjects.length !== projects.length ||
    !sorted(selectedProjects.map((path) => ({ path }))) ||
    new Set(selectedProjects).size !== selectedProjects.length ||
    selectedProjects.some(
      (project, index) => project !== projects[index]!.path,
    ) ||
    ('selection' in normalizedSelection &&
      normalizedSelection.selection.projects.some(
        (project, index) => project !== selectedProjects[index],
      )) ||
    projects.some((project) =>
      project.references.some((reference) => reference === project.path),
    )
  )
    fail('input_invalid');
  return Object.freeze({
    language: 'csharp',
    selection: Object.freeze({
      version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
      kind: 'explicit-projects',
      projects: Object.freeze([...selectedProjects]),
    }),
    projects: Object.freeze(projects),
  });
}

function cloneManifest(value: CSharpAnalysisManifest): CSharpAnalysisManifest {
  const candidate: unknown = value;
  if (!plainObject(candidate) || !plainObject(candidate.selection))
    fail('input_invalid');
  return candidate.selection.kind === 'explicit-projects'
    ? cloneExplicitManifest(value as CSharpExplicitProjectManifest)
    : cloneLegacyManifest(value as CSharpManifest);
}

function createSourcePlans(
  manifest: CSharpAnalysisManifest,
): readonly SourcePlan[] {
  const occurrences = new Map<string, number>();
  for (const project of manifest.projects)
    for (const file of project.files)
      occurrences.set(file, (occurrences.get(file) ?? 0) + 1);
  return Object.freeze(
    [...occurrences.entries()]
      .sort(([left], [right]) => ordinal(left, right))
      .map(([sourcePath, count], index) =>
        Object.freeze({
          path: sourcePath,
          staged: `source-${index.toString().padStart(6, '0')}.cs`,
          occurrences: count,
        }),
      ),
  );
}

function isContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function copySources(
  repositoryRoot: string,
  staging: string,
  sources: readonly SourcePlan[],
): Promise<void> {
  const root = await fs
    .realpath(repositoryRoot)
    .catch(() => fail('input_invalid'));
  let aggregateBytes = 0;
  for (const sourcePlan of sources) {
    const source = path.resolve(root, ...sourcePlan.path.split('/'));
    if (!isContainedBy(root, source)) fail('input_invalid');
    const sourceStat = await fs
      .lstat(source)
      .catch(() => fail('input_invalid'));
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
      fail('input_invalid');
    const canonical = await fs
      .realpath(source)
      .catch(() => fail('input_invalid'));
    if (!isContainedBy(root, canonical)) fail('input_invalid');
    const stat = await fs.lstat(canonical).catch(() => fail('input_invalid'));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > CSHARP_MAX_SOURCE_BYTES
    )
      fail('input_invalid');
    if (
      stat.size >
      Math.floor(
        (CSHARP_MAX_AGGREGATE_READ_BYTES - aggregateBytes) /
          sourcePlan.occurrences,
      )
    )
      fail('resource_limit');
    aggregateBytes += stat.size * sourcePlan.occurrences;
    const verified = await fs
      .realpath(canonical)
      .catch(() => fail('input_invalid'));
    if (!isContainedBy(root, verified)) fail('input_invalid');
    const contents = await readFileBounded(
      canonical,
      CSHARP_MAX_SOURCE_BYTES,
      stat,
    ).catch(() => fail('input_invalid'));
    // The generated basename has no manifest-controlled ancestor. `wx` makes a
    // same-user replacement fail rather than following a staged symlink.
    const destination = path.join(staging, sourcePlan.staged);
    await fs
      .writeFile(destination, contents, { flag: 'wx' })
      .catch(() => fail('input_invalid'));
  }
}

async function defaultRunner(
  invocation: WorkerInvocation,
): Promise<WorkerExecution> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: invocation.shell,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: null,
        timedOut: false,
      });
      return;
    }
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let timedOut = false;
    let overflow = false;
    const stop = () => {
      timedOut = true;
      child.kill();
    };
    const timer =
      invocation.timeoutMs === undefined
        ? undefined
        : setTimeout(stop, invocation.timeoutMs);
    const append = (
      target: Buffer[],
      chunk: Buffer,
      limit: number,
      current: number,
    ): number => {
      if (chunk.byteLength > limit - current) {
        overflow = true;
        stop();
        return current;
      }
      target.push(Buffer.from(chunk));
      return current + chunk.byteLength;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes = append(
        output,
        chunk,
        CSHARP_WORKER_MAX_RESPONSE_BYTES,
        outputBytes,
      );
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes = append(
        errors,
        chunk,
        CSHARP_WORKER_MAX_STDERR_BYTES,
        errorBytes,
      );
    });
    child.on('error', () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(output),
        stderr: Buffer.concat(errors),
        exitCode: null,
        timedOut: timedOut || overflow,
      });
    });
    child.on('close', (exitCode) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(output),
        stderr: Buffer.concat(errors),
        exitCode,
        timedOut: timedOut || overflow,
      });
    });
    child.stdin.end(invocation.input);
  });
}

const CSHARP_WORKER_MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const CSHARP_WORKER_MAX_CHUNK_MANIFEST_BYTES = 16 * 1024 * 1024;

function parseChunkProject(
  value: unknown,
  expectedProjects: readonly CSharpProjectManifest[],
): CSharpWorkerProjectResult {
  if (
    !closedObject(value, [
      'path',
      'sourceCount',
      'syntaxTreeCount',
      'diagnosticCount',
      'declarations',
      'relationships',
    ]) ||
    !safePath(value.path)
  )
    fail('protocol_invalid');
  const sourceCount = value.sourceCount;
  const syntaxTreeCount = value.syntaxTreeCount;
  const diagnosticCount = value.diagnosticCount;
  if (
    !nonNegativeInteger(sourceCount) ||
    !nonNegativeInteger(syntaxTreeCount) ||
    !nonNegativeInteger(diagnosticCount)
  )
    fail('protocol_invalid');
  const allowedPaths = new Set(expectedProjects.flatMap((item) => item.files));
  const declarations =
    value.declarations === undefined
      ? []
      : Array.isArray(value.declarations)
        ? value.declarations.map((item) => cloneDeclaration(item, allowedPaths))
        : fail('protocol_invalid');
  const relationships =
    value.relationships === undefined
      ? []
      : Array.isArray(value.relationships)
        ? value.relationships.map((item) =>
            cloneRelationship(item, allowedPaths),
          )
        : fail('protocol_invalid');
  if (
    !declarations.every(
      (item, index) =>
        index === 0 || compareDeclaration(declarations[index - 1]!, item) <= 0,
    ) ||
    !relationships.every(
      (item, index) =>
        index === 0 ||
        compareRelationship(relationships[index - 1]!, item) <= 0,
    )
  )
    fail('protocol_invalid');
  return {
    path: value.path,
    sourceCount,
    syntaxTreeCount,
    diagnosticCount,
    declarations,
    relationships,
  };
}

function parseChunkDiagnostic(value: unknown): CSharpWorkerDiagnostic {
  if (
    !closedObject(value, [
      'project',
      'code',
      'severity',
      'path',
      'line',
      'column',
    ]) ||
    !safePath(value.project) ||
    (value.code !== 'compiler_error' && value.code !== 'compiler_warning') ||
    (value.severity !== 'error' && value.severity !== 'warning') ||
    (value.path !== undefined && !safePath(value.path))
  )
    fail('protocol_invalid');
  const line = value.line;
  const column = value.column;
  if (
    (line !== undefined && !positiveInteger(line)) ||
    (column !== undefined && !positiveInteger(column))
  )
    fail('protocol_invalid');
  return {
    project: value.project,
    code: value.code,
    severity: value.severity,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

async function parseChunkResponse(
  value: unknown,
  expectedProjects: readonly CSharpProjectManifest[],
  staging: string,
): Promise<CSharpWorkerResult> {
  let chunksValue: unknown;
  if (closedObject(value, ['version', 'chunks']) && value.version === 2) {
    chunksValue = value.chunks;
  } else if (
    closedObject(value, ['version', 'manifest', 'bytes']) &&
    value.version === 2 &&
    safePath(value.manifest) &&
    value.manifest === 'chunks.json' &&
    positiveInteger(value.bytes) &&
    value.bytes <= CSHARP_WORKER_MAX_CHUNK_MANIFEST_BYTES
  ) {
    const manifest = path.join(staging, value.manifest);
    const stat = await fs.lstat(manifest).catch(() => fail('protocol_invalid'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== value.bytes)
      fail('protocol_invalid');
    const bytes = await fs
      .readFile(manifest)
      .catch(() => fail('protocol_invalid'));
    if (
      bytes.byteLength !== value.bytes ||
      bytes.byteLength > CSHARP_WORKER_MAX_CHUNK_MANIFEST_BYTES
    )
      fail('protocol_invalid');
    try {
      const manifestValue = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
      if (
        !closedObject(manifestValue, ['version', 'chunks']) ||
        manifestValue.version !== 1
      )
        fail('protocol_invalid');
      chunksValue = manifestValue.chunks;
    } catch {
      fail('protocol_invalid');
    }
  } else {
    fail('protocol_invalid');
  }
  if (
    !Array.isArray(chunksValue) ||
    chunksValue.length === 0 ||
    chunksValue.length > expectedProjects.length * 4096
  )
    fail('protocol_invalid');
  const expectedByPath = new Map(
    expectedProjects.map((project) => [project.path, project]),
  );
  const grouped = new Map<
    string,
    {
      project: CSharpWorkerProjectResult;
      diagnostics: CSharpWorkerDiagnostic[];
    }
  >();
  let previousIndex = -1;
  for (const descriptor of chunksValue) {
    if (
      !closedObject(descriptor, ['index', 'project', 'bytes']) ||
      !nonNegativeInteger(descriptor.index) ||
      descriptor.index <= previousIndex ||
      !safePath(descriptor.project) ||
      !positiveInteger(descriptor.bytes) ||
      descriptor.bytes > CSHARP_WORKER_MAX_CHUNK_BYTES ||
      !expectedByPath.has(descriptor.project)
    )
      fail('protocol_invalid');
    previousIndex = descriptor.index;
    const file = path.join(
      staging,
      `chunk-${String(descriptor.index).padStart(6, '0')}.json`,
    );
    const stat = await fs.lstat(file).catch(() => fail('protocol_invalid'));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== descriptor.bytes
    )
      fail('protocol_invalid');
    const bytes = await fs.readFile(file).catch(() => fail('protocol_invalid'));
    if (
      bytes.byteLength !== descriptor.bytes ||
      bytes.byteLength > CSHARP_WORKER_MAX_CHUNK_BYTES
    )
      fail('protocol_invalid');
    let chunkValue: unknown;
    try {
      chunkValue = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      fail('protocol_invalid');
    }
    if (
      !closedObject(chunkValue, ['version', 'project', 'diagnostics']) ||
      chunkValue.version !== 1 ||
      !Array.isArray(chunkValue.diagnostics) ||
      chunkValue.diagnostics.length > CSHARP_WORKER_MAX_DIAGNOSTICS
    )
      fail('protocol_invalid');
    const project = parseChunkProject(chunkValue.project, expectedProjects);
    if (project.path !== descriptor.project) fail('protocol_invalid');
    const diagnostics = chunkValue.diagnostics.map(parseChunkDiagnostic);
    if (
      diagnostics.some(
        (diagnostic) =>
          diagnostic.project !== project.path ||
          (diagnostic.path !== undefined &&
            !expectedByPath.get(project.path)!.files.includes(diagnostic.path)),
      )
    )
      fail('protocol_invalid');
    const current = grouped.get(project.path);
    if (current === undefined) {
      grouped.set(project.path, { project, diagnostics });
    } else {
      if (
        current.project.sourceCount !== project.sourceCount ||
        current.project.syntaxTreeCount !== project.syntaxTreeCount ||
        current.project.diagnosticCount !== project.diagnosticCount
      )
        fail('protocol_invalid');
      current.project = {
        ...current.project,
        declarations: [
          ...(current.project.declarations ?? []),
          ...(project.declarations ?? []),
        ],
        relationships: [
          ...(current.project.relationships ?? []),
          ...(project.relationships ?? []),
        ],
      };
      current.diagnostics.push(...diagnostics);
    }
  }
  if (grouped.size !== expectedProjects.length) fail('protocol_invalid');
  const compareDiagnostics = (
    left: CSharpWorkerDiagnostic,
    right: CSharpWorkerDiagnostic,
  ): number =>
    ordinal(left.project, right.project) ||
    ordinal(left.path ?? '', right.path ?? '') ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    ordinal(left.code, right.code);
  const projects = expectedProjects.map((expected) => {
    const current = grouped.get(expected.path);
    if (current === undefined) fail('protocol_invalid');
    const diagnostics = current.diagnostics.sort(compareDiagnostics);
    const project = current.project;
    if (
      project.sourceCount !== expected.files.length ||
      project.syntaxTreeCount !== expected.files.length ||
      project.diagnosticCount !== diagnostics.length ||
      !project.declarations!.every(
        (item, index) =>
          index === 0 ||
          compareDeclaration(project.declarations![index - 1]!, item) <= 0,
      ) ||
      !project.relationships!.every(
        (item, index) =>
          index === 0 ||
          compareRelationship(project.relationships![index - 1]!, item) <= 0,
      )
    )
      fail('protocol_invalid');
    return Object.freeze({
      ...project,
      declarations: Object.freeze(project.declarations ?? []),
      relationships: Object.freeze(project.relationships ?? []),
    });
  });
  const diagnostics = projects.flatMap(
    (project) => grouped.get(project.path)!.diagnostics,
  );
  return Object.freeze({
    projects: Object.freeze(projects),
    diagnostics: Object.freeze(diagnostics),
  });
}

function parseResponse(
  stdout: Buffer,
  expectedProjects: readonly CSharpProjectManifest[],
  staging?: string,
): CSharpWorkerResult | Promise<CSharpWorkerResult> {
  if (
    stdout.byteLength === 0 ||
    stdout.byteLength > CSHARP_WORKER_MAX_RESPONSE_BYTES
  )
    fail('protocol_invalid');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch {
    fail('protocol_invalid');
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n'))
    fail('protocol_invalid');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('protocol_invalid');
  }
  if (plainObject(value) && value.version === 2 && staging !== undefined)
    return parseChunkResponse(value, expectedProjects, staging);
  if (
    !closedObject(value, ['version', 'projects', 'diagnostics']) ||
    value.version !== 1 ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > CSHARP_WORKER_MAX_DIAGNOSTICS
  )
    fail('protocol_invalid');
  const projects = value.projects.map((project): CSharpWorkerProjectResult => {
    if (
      !closedObject(project, [
        'path',
        'sourceCount',
        'syntaxTreeCount',
        'diagnosticCount',
        'declarations',
        'relationships',
      ]) ||
      !safePath(project.path)
    )
      fail('protocol_invalid');
    const sourceCount = project.sourceCount;
    const syntaxTreeCount = project.syntaxTreeCount;
    const diagnosticCount = project.diagnosticCount;
    if (
      !nonNegativeInteger(sourceCount) ||
      !nonNegativeInteger(syntaxTreeCount) ||
      !nonNegativeInteger(diagnosticCount)
    )
      fail('protocol_invalid');
    const allowedPaths = new Set(
      expectedProjects.flatMap((item) => item.files),
    );
    const declarations =
      project.declarations === undefined
        ? []
        : Array.isArray(project.declarations)
          ? project.declarations.map((item) =>
              cloneDeclaration(item, allowedPaths),
            )
          : fail('protocol_invalid');
    const relationships =
      project.relationships === undefined
        ? []
        : Array.isArray(project.relationships)
          ? project.relationships.map((item) =>
              cloneRelationship(item, allowedPaths),
            )
          : fail('protocol_invalid');
    if (
      !declarations.every(
        (item, index) =>
          index === 0 ||
          compareDeclaration(declarations[index - 1]!, item) <= 0,
      ) ||
      !relationships.every(
        (item, index) =>
          index === 0 ||
          compareRelationship(relationships[index - 1]!, item) <= 0,
      )
    )
      fail('protocol_invalid');
    return Object.freeze({
      path: project.path,
      sourceCount,
      syntaxTreeCount,
      diagnosticCount,
      ...(project.declarations === undefined
        ? {}
        : { declarations: Object.freeze(declarations) }),
      ...(project.relationships === undefined
        ? {}
        : { relationships: Object.freeze(relationships) }),
    });
  });
  const diagnostics = value.diagnostics.map(
    (diagnostic): CSharpWorkerDiagnostic => {
      if (
        !closedObject(diagnostic, [
          'project',
          'code',
          'severity',
          'path',
          'line',
          'column',
        ]) ||
        !safePath(diagnostic.project) ||
        (diagnostic.code !== 'compiler_error' &&
          diagnostic.code !== 'compiler_warning') ||
        (diagnostic.severity !== 'error' &&
          diagnostic.severity !== 'warning') ||
        (diagnostic.path !== undefined && !safePath(diagnostic.path))
      )
        fail('protocol_invalid');
      const line = diagnostic.line;
      const column = diagnostic.column;
      if (
        (line !== undefined && !positiveInteger(line)) ||
        (column !== undefined && !positiveInteger(column))
      )
        fail('protocol_invalid');
      return Object.freeze({
        project: diagnostic.project,
        code: diagnostic.code,
        severity: diagnostic.severity,
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
      });
    },
  );
  if (
    !sorted(projects) ||
    projects.length !== expectedProjects.length ||
    projects.some(
      (project, index) => project.path !== expectedProjects[index]!.path,
    )
  )
    fail('protocol_invalid');
  if (
    diagnostics.some(
      (diagnostic) =>
        !expectedProjects.some(
          (project) =>
            project.path === diagnostic.project &&
            (diagnostic.path === undefined ||
              project.files.includes(diagnostic.path)),
        ),
    )
  )
    fail('protocol_invalid');
  const allowedPaths = new Set(expectedProjects.flatMap((item) => item.files));
  if (
    projects.some((project) =>
      [...(project.declarations ?? []), ...(project.relationships ?? [])].some(
        (item) =>
          'locations' in item
            ? item.locations.some(
                (location) => !allowedPaths.has(location.path),
              )
            : item.location !== undefined &&
              !allowedPaths.has(item.location.path),
      ),
    )
  )
    fail('protocol_invalid');
  if (
    projects.some(
      (project, index) =>
        project.sourceCount !== expectedProjects[index]!.files.length ||
        project.syntaxTreeCount !== expectedProjects[index]!.files.length ||
        project.diagnosticCount !==
          diagnostics.filter(
            (diagnostic) => diagnostic.project === project.path,
          ).length,
    )
  )
    fail('protocol_invalid');
  const compareDiagnostics = (
    left: CSharpWorkerDiagnostic,
    right: CSharpWorkerDiagnostic,
  ): number =>
    ordinal(left.project, right.project) ||
    ordinal(left.path ?? '', right.path ?? '') ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    ordinal(left.code, right.code);
  if (
    !diagnostics.every(
      (diagnostic, index) =>
        index === 0 ||
        compareDiagnostics(diagnostics[index - 1]!, diagnostic) <= 0,
    )
  )
    fail('protocol_invalid');
  return Object.freeze({
    projects: Object.freeze(projects),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function verifyHelperAt(artifact: string): Promise<string> {
  let current = path.resolve(artifact);
  while (true) {
    const ancestor = await fs
      .lstat(current)
      .catch(() => fail('helper_missing'));
    if (ancestor.isSymbolicLink()) fail('helper_missing');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = await fs.lstat(artifact).catch(() => fail('helper_missing'));
  if (!stat.isFile() || stat.isSymbolicLink()) fail('helper_missing');
  return fs.realpath(artifact).catch(() => fail('helper_missing'));
}

async function verifyDotnetHost(host: string | undefined): Promise<string> {
  if (host === undefined || !path.isAbsolute(host)) fail('helper_missing');
  const stat = await fs.lstat(host).catch(() => fail('helper_missing'));
  if (!stat.isFile() || stat.isSymbolicLink()) fail('helper_missing');
  return fs.realpath(host).catch(() => fail('helper_missing'));
}

async function executeWorker(
  repositoryRoot: string,
  manifest: CSharpAnalysisManifest,
  runner: WorkerRunner,
  artifact = helperDll,
  host = dotnetHost,
  createStaging: StagingCreator = fs.mkdtemp,
  options: CSharpWorkerOptions = {},
): Promise<CSharpWorkerResult> {
  const safeManifest = cloneManifest(manifest);
  const sourcePlans = createSourcePlans(safeManifest);
  const helper = await verifyHelperAt(artifact);
  const verifiedHost = await verifyDotnetHost(host);
  if (
    options.timeoutMs !== undefined &&
    (!positiveInteger(options.timeoutMs) ||
      options.timeoutMs > CSHARP_WORKER_MAX_TIMEOUT_MS)
  )
    fail('resource_limit');
  const request =
    JSON.stringify({
      version: 1,
      manifest: safeManifest,
      ...(options.sourceEncoding === undefined
        ? {}
        : { sourceEncoding: options.sourceEncoding }),
      sources: sourcePlans.map(({ path: sourcePath, staged }) => ({
        path: sourcePath,
        staged,
      })),
    }) + '\n';
  if (Buffer.byteLength(request, 'utf8') > CSHARP_WORKER_MAX_REQUEST_BYTES)
    fail('resource_limit');
  const staging = await createStaging(
    path.join(tmpdir(), 'sourcemesh-roslyn-'),
  ).catch(() => fail('process_failed'));
  let result: CSharpWorkerResult | undefined;
  let failure: unknown;
  try {
    await copySources(repositoryRoot, staging, sourcePlans);
    const execution = await runner({
      command: verifiedHost,
      args: [helper],
      cwd: staging,
      input: request,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      shell: false,
      env: {
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: staging,
        TMP: staging,
        DOTNET_NOLOGO: '1',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      },
    });
    if (
      execution.timedOut ||
      execution.exitCode !== 0 ||
      execution.stderr.byteLength !== 0
    )
      fail('process_failed');
    result = await parseResponse(
      execution.stdout,
      safeManifest.projects,
      staging,
    );
  } catch (error) {
    failure =
      error instanceof CSharpWorkerError
        ? error
        : new CSharpWorkerError('process_failed');
  }
  try {
    await fs.rm(staging, { recursive: true, force: true });
  } catch {
    if (failure === undefined)
      failure = new CSharpWorkerError('process_failed');
  }
  if (failure !== undefined) throw failure;
  return result!;
}

/** Runs the repository-owned, offline Roslyn helper over a sanitized manifest. */
export function analyzeCSharpManifest(
  repositoryRoot: string,
  manifest: CSharpAnalysisManifest,
  options?: CSharpWorkerOptions,
): Promise<CSharpWorkerResult> {
  return executeWorker(
    repositoryRoot,
    manifest,
    defaultRunner,
    undefined,
    undefined,
    fs.mkdtemp,
    options,
  );
}

/** Test-only seam; it receives a fixed command and artifact argument. */
export function analyzeCSharpManifestForTest(
  repositoryRoot: string,
  manifest: CSharpAnalysisManifest,
  runner: WorkerRunner,
  artifact: string,
  host: string,
  createStaging?: StagingCreator,
  options?: CSharpWorkerOptions,
): Promise<CSharpWorkerResult> {
  return executeWorker(
    repositoryRoot,
    manifest,
    runner,
    artifact,
    host,
    createStaging,
    options,
  );
}
