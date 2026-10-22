#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createGraphQueryService,
  discoverSourceFiles,
  extractDeclarationGraph,
  loadProject,
  openValidatedSnapshot,
  writeSnapshot,
} from './index.js';
import type {
  FileRelationResponseV1,
  FileSummaryV1,
  FunctionSelectorV1,
  GetSymbolResponseV1,
  GraphQueryService,
  NodeSummaryV1,
  QueryErrorV1,
  QueryResponseV1,
  SearchResponseV1,
  SnapshotV1,
  SnapshotWriteResult,
  SymbolSummaryV1,
} from './index.js';
import { SnapshotError } from './snapshot/types.js';

type CommandName =
  | 'analyze'
  | 'symbol'
  | 'details'
  | 'dependencies'
  | 'dependents'
  | 'callers'
  | 'callees';
type OutputFormat = 'human' | 'json';
type QueryCommand = Exclude<CommandName, 'analyze'>;

interface CommonOptions {
  readonly command: QueryCommand;
  readonly root: string;
  readonly snapshot: string;
  readonly output: OutputFormat;
  readonly limit?: number;
  readonly cursor?: string;
  readonly allowPartial: boolean;
}

interface AnalyzeCommand {
  readonly command: 'analyze';
  readonly root: string;
  readonly snapshot: string;
  readonly tsconfig?: string;
  readonly output: OutputFormat;
  readonly overwrite: boolean;
}

interface SymbolCommand extends CommonOptions {
  readonly command: 'symbol';
  readonly query: string;
  readonly kind?:
    'class' | 'interface' | 'function' | 'variable' | 'type' | 'parameter';
  readonly path?: string;
  readonly containerId?: string;
}

interface DetailsCommand extends CommonOptions {
  readonly command: 'details';
  readonly nodeId: string;
}

interface FileRelationCommand extends CommonOptions {
  readonly command: 'dependencies' | 'dependents';
  readonly fileId: string;
}

interface CallRelationCommand extends CommonOptions {
  readonly command: 'callers' | 'callees';
  readonly name: string;
  readonly qualifiedName?: string;
  readonly path?: string;
  readonly memberRole?: 'none' | 'static' | 'instance';
  readonly containerId?: string;
}

type ParsedCommand =
  | AnalyzeCommand
  | SymbolCommand
  | DetailsCommand
  | FileRelationCommand
  | CallRelationCommand;

export interface CliIO {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface CliServices {
  readonly discoverSourceFiles: typeof discoverSourceFiles;
  readonly loadProject: typeof loadProject;
  readonly extractDeclarationGraph: typeof extractDeclarationGraph;
  readonly writeSnapshot: typeof writeSnapshot;
  readonly openValidatedSnapshot: typeof openValidatedSnapshot;
  readonly createGraphQueryService: typeof createGraphQueryService;
}

const productionServices: CliServices = {
  discoverSourceFiles,
  loadProject,
  extractDeclarationGraph,
  writeSnapshot,
  openValidatedSnapshot,
  createGraphQueryService,
};

const processIO: CliIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const DEFAULT_SNAPSHOT = '.sourcemesh/graph.json';
const NODE_ID = /^n:[0-9a-f]{64}$/u;
const COMMANDS = new Set<CommandName>([
  'analyze',
  'symbol',
  'details',
  'dependencies',
  'dependents',
  'callers',
  'callees',
]);
const SEARCH_KINDS = new Set([
  'class',
  'interface',
  'function',
  'variable',
  'type',
  'parameter',
]);
const MEMBER_ROLES = new Set(['none', 'static', 'instance']);

const QUERY_MESSAGES: Record<QueryErrorV1['code'], string> = {
  invalid_request: 'The query request is invalid.',
  limit_exceeded: 'The query limit is outside the allowed range.',
  not_found: 'The requested graph item was not found.',
  ambiguous: 'The selector matches multiple graph items.',
  entity_type_mismatch: 'The requested graph item has the wrong type.',
  unsupported_schema: 'The snapshot schema is unsupported.',
  invalid_snapshot: 'The snapshot is invalid.',
  partial_not_allowed:
    'The snapshot is partial and partial results are disabled.',
  internal: 'The operation could not be completed.',
};

const SNAPSHOT_MESSAGES: Record<SnapshotError['code'], string> = {
  invalid_snapshot: 'The snapshot is invalid.',
  unsupported_schema: 'The snapshot schema is unsupported.',
  path_invalid: 'The snapshot path is invalid.',
  snapshot_conflict: 'The snapshot already exists.',
  snapshot_io: 'The snapshot could not be read or written.',
  missing_snapshot: 'The snapshot could not be found.',
};

class CliFailure extends Error {
  readonly code: string;
  readonly exitCode: 1 | 2 | 3 | 4;
  readonly field: string | undefined;
  readonly candidates: QueryErrorV1['candidates'];
  readonly totalCandidates: number | undefined;

  constructor(
    code: string,
    message: string,
    exitCode: 1 | 2 | 3 | 4,
    field?: string,
    options?: {
      readonly candidates?: QueryErrorV1['candidates'];
      readonly totalCandidates?: number;
    },
  ) {
    super(message);
    this.name = 'CliFailure';
    this.code = code;
    this.exitCode = exitCode;
    this.field = field;
    this.candidates = options?.candidates;
    this.totalCandidates = options?.totalCandidates;
  }
}

function invalid(field?: string): CliFailure {
  return new CliFailure(
    'invalid_arguments',
    'The command arguments are invalid.',
    2,
    field,
  );
}

function analysisFailure(): CliFailure {
  return new CliFailure(
    'analysis_failed',
    'The analysis could not be completed.',
    1,
  );
}

function normalizeRelativePath(value: string, field: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
    throw invalid(field);
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..'))
    throw invalid(field);
  return parts.join('/');
}

function normalizeSnapshotPath(value: string): string {
  const normalized = normalizeRelativePath(value, 'snapshot');
  if (!normalized.startsWith('.sourcemesh/')) throw invalid('snapshot');
  return normalized;
}

function readOutputHint(argv: readonly string[]): OutputFormat {
  const index = argv.indexOf('--output');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value === 'json' ? 'json' : 'human';
}

function commandHint(argv: readonly string[]): string {
  const candidate = argv[0];
  return candidate !== undefined && COMMANDS.has(candidate as CommandName)
    ? candidate
    : 'unknown';
}

function helpText(command?: CommandName): string {
  if (command === undefined)
    return [
      'SourceMesh local analysis CLI',
      '',
      'Commands: analyze, symbol, details, dependencies, dependents, callers, callees',
      'Use "sourcemesh <command> --help" for command syntax.',
      '',
      'Exit codes: 0 success/help, 1 operational failure, 2 invalid arguments,',
      '3 query target/request failure, 4 snapshot conflict.',
    ].join('\n');
  const usage: Record<CommandName, string> = {
    analyze:
      'sourcemesh analyze --root <path> [--snapshot <relative>] [--tsconfig <relative>] [--output human|json] [--overwrite]',
    symbol:
      'sourcemesh symbol --root <path> [--snapshot <relative>] --query <text> [--kind <kind>] [--path <relative>] [--container-id <node-id>] [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    details:
      'sourcemesh details --root <path> [--snapshot <relative>] --id <node-id> [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    dependencies:
      'sourcemesh dependencies --root <path> [--snapshot <relative>] --file-id <file-id> [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    dependents:
      'sourcemesh dependents --root <path> [--snapshot <relative>] --file-id <file-id> [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    callers:
      'sourcemesh callers --root <path> [--snapshot <relative>] --name <function-name> [--qualified-name <name>] [--path <relative>] [--member-role <none|static|instance>] [--container-id <node-id>] [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    callees:
      'sourcemesh callees --root <path> [--snapshot <relative>] --name <function-name> [--qualified-name <name>] [--path <relative>] [--member-role <none|static|instance>] [--container-id <node-id>] [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
  };
  return usage[command];
}

type OptionKind = 'value' | 'flag';

function optionKinds(command: CommandName): ReadonlyMap<string, OptionKind> {
  const common: [string, OptionKind][] = [
    ['--root', 'value'],
    ['--snapshot', 'value'],
    ['--output', 'value'],
  ];
  if (command === 'analyze')
    return new Map([
      ...common,
      ['--tsconfig', 'value'],
      ['--overwrite', 'flag'],
    ]);
  const query: [string, OptionKind][] = [
    ['--limit', 'value'],
    ['--cursor', 'value'],
    ['--allow-partial', 'flag'],
  ];
  if (command === 'symbol')
    return new Map([
      ...common,
      ['--query', 'value'],
      ['--kind', 'value'],
      ['--path', 'value'],
      ['--container-id', 'value'],
      ...query,
    ]);
  if (command === 'details')
    return new Map([...common, ['--id', 'value'], ...query]);
  if (command === 'dependencies' || command === 'dependents')
    return new Map([...common, ['--file-id', 'value'], ...query]);
  return new Map([
    ...common,
    ['--name', 'value'],
    ['--qualified-name', 'value'],
    ['--path', 'value'],
    ['--member-role', 'value'],
    ['--container-id', 'value'],
    ...query,
  ]);
}

function valueOf(
  values: ReadonlyMap<string, string | true>,
  option: string,
): string | undefined {
  const value = values.get(option);
  return typeof value === 'string' ? value : undefined;
}

function requiredValue(
  values: ReadonlyMap<string, string | true>,
  option: string,
  field: string,
): string {
  const value = valueOf(values, option);
  if (value === undefined || value.trim().length === 0) throw invalid(field);
  return value;
}

function optionalText(
  values: ReadonlyMap<string, string | true>,
  option: string,
  field: string,
): string | undefined {
  const value = valueOf(values, option);
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw invalid(field);
  return value.normalize('NFC');
}

function parseLimit(
  values: ReadonlyMap<string, string | true>,
): number | undefined {
  const value = valueOf(values, '--limit');
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/u.test(value)) throw invalid('limit');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw invalid('limit');
  return limit;
}

function parseCommon(
  command: QueryCommand,
  values: ReadonlyMap<string, string | true>,
): CommonOptions {
  const root = requiredValue(values, '--root', 'root');
  const snapshotValue = valueOf(values, '--snapshot');
  const snapshot = normalizeSnapshotPath(
    snapshotValue === undefined ? DEFAULT_SNAPSHOT : snapshotValue,
  );
  const outputValue = valueOf(values, '--output') ?? 'human';
  if (outputValue !== 'human' && outputValue !== 'json')
    throw invalid('output');
  const limit = parseLimit(values);
  const cursor = optionalText(values, '--cursor', 'cursor');
  return {
    command,
    root,
    snapshot,
    output: outputValue,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    allowPartial: values.has('--allow-partial'),
  };
}

function parseArguments(argv: readonly string[]): ParsedCommand {
  const commandValue = argv[0];
  if (commandValue === undefined || !COMMANDS.has(commandValue as CommandName))
    throw invalid('command');
  const command = commandValue as CommandName;
  const kinds = optionKinds(command);
  const values = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option === '--help') throw invalid('help');
    const kind = kinds.get(option);
    if (kind === undefined)
      throw invalid(option.startsWith('--') ? 'option' : 'command');
    if (values.has(option)) throw invalid(option);
    if (kind === 'flag') {
      values.set(option, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw invalid(option);
    values.set(option, value);
    index += 1;
  }

  if (command === 'analyze') {
    const root = requiredValue(values, '--root', 'root');
    const snapshotValue = valueOf(values, '--snapshot');
    const snapshot = normalizeSnapshotPath(
      snapshotValue === undefined ? DEFAULT_SNAPSHOT : snapshotValue,
    );
    const outputValue = valueOf(values, '--output') ?? 'human';
    if (outputValue !== 'human' && outputValue !== 'json')
      throw invalid('output');
    const tsconfigValue = valueOf(values, '--tsconfig');
    const tsconfig =
      tsconfigValue === undefined
        ? undefined
        : normalizeRelativePath(tsconfigValue, 'tsconfig');
    return {
      command,
      root,
      snapshot,
      ...(tsconfig === undefined ? {} : { tsconfig }),
      output: outputValue,
      overwrite: values.has('--overwrite'),
    };
  }

  const common = parseCommon(command, values);
  if (command === 'symbol') {
    const query = requiredValue(values, '--query', 'query')
      .normalize('NFC')
      .trim();
    if (query.length === 0 || query.length > 256) throw invalid('query');
    const kind = valueOf(values, '--kind');
    if (kind !== undefined && !SEARCH_KINDS.has(kind)) throw invalid('kind');
    const pathValue = optionalText(values, '--path', 'path');
    const relativePath =
      pathValue === undefined
        ? undefined
        : normalizeRelativePath(pathValue, 'path');
    const containerId = valueOf(values, '--container-id');
    if (containerId !== undefined && !NODE_ID.test(containerId))
      throw invalid('containerId');
    return {
      ...common,
      command,
      query,
      ...(kind === undefined
        ? {}
        : { kind: kind as NonNullable<SymbolCommand['kind']> }),
      ...(relativePath === undefined ? {} : { path: relativePath }),
      ...(containerId === undefined ? {} : { containerId }),
    };
  }
  if (command === 'details') {
    const nodeId = requiredValue(values, '--id', 'nodeId');
    if (!NODE_ID.test(nodeId)) throw invalid('nodeId');
    return { ...common, command, nodeId };
  }
  if (command === 'dependencies' || command === 'dependents') {
    const fileId = requiredValue(values, '--file-id', 'fileId');
    if (!NODE_ID.test(fileId)) throw invalid('fileId');
    return { ...common, command, fileId };
  }
  const name = requiredValue(values, '--name', 'function').normalize('NFC');
  const qualifiedName = optionalText(
    values,
    '--qualified-name',
    'qualifiedName',
  );
  const pathValue = optionalText(values, '--path', 'path');
  const relativePath =
    pathValue === undefined
      ? undefined
      : normalizeRelativePath(pathValue, 'path');
  const memberRole = valueOf(values, '--member-role');
  if (memberRole !== undefined && !MEMBER_ROLES.has(memberRole))
    throw invalid('memberRole');
  const containerId = valueOf(values, '--container-id');
  if (containerId !== undefined && !NODE_ID.test(containerId))
    throw invalid('containerId');
  return {
    ...common,
    command,
    name,
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    ...(relativePath === undefined ? {} : { path: relativePath }),
    ...(memberRole === undefined
      ? {}
      : {
          memberRole: memberRole as NonNullable<
            CallRelationCommand['memberRole']
          >,
        }),
    ...(containerId === undefined ? {} : { containerId }),
  };
}

function queryOptions(command: CommonOptions): {
  readonly limit?: number;
  readonly cursor?: string;
  readonly allowPartial?: boolean;
} {
  return {
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
    ...(command.allowPartial ? { allowPartial: true } : {}),
  };
}

function queryFailure(error: QueryErrorV1): CliFailure {
  const exitCode: 1 | 3 =
    error.code === 'invalid_request' ||
    error.code === 'limit_exceeded' ||
    error.code === 'not_found' ||
    error.code === 'ambiguous' ||
    error.code === 'entity_type_mismatch' ||
    error.code === 'partial_not_allowed'
      ? 3
      : 1;
  return new CliFailure(
    error.code,
    QUERY_MESSAGES[error.code],
    exitCode,
    error.field,
    {
      ...(error.candidates === undefined
        ? {}
        : { candidates: error.candidates }),
      ...(error.totalCandidates === undefined
        ? {}
        : { totalCandidates: error.totalCandidates }),
    },
  );
}

function snapshotFailure(error: SnapshotError): CliFailure {
  return new CliFailure(
    error.code,
    SNAPSHOT_MESSAGES[error.code],
    error.code === 'snapshot_conflict' ? 4 : 1,
  );
}

function isQueryError(
  value: QueryResponseV1 | QueryErrorV1,
): value is QueryErrorV1 {
  return 'code' in value;
}

function functionSelector(command: CallRelationCommand): FunctionSelectorV1 {
  return {
    kind: 'function',
    name: command.name,
    ...(command.qualifiedName === undefined
      ? {}
      : { qualifiedName: command.qualifiedName }),
    ...(command.path === undefined ? {} : { path: command.path }),
    ...(command.memberRole === undefined
      ? {}
      : { memberRole: command.memberRole }),
    ...(command.containerId === undefined
      ? {}
      : { containerId: command.containerId }),
  };
}

async function executeAnalyze(
  command: AnalyzeCommand,
  services: CliServices,
): Promise<{
  readonly snapshotPath: string;
  readonly completeness: SnapshotV1['completeness'];
  readonly digest: string;
  readonly bytes: number;
}> {
  try {
    const discovery = await services.discoverSourceFiles(command.root);
    if (
      discovery.repositoryRoot === undefined ||
      discovery.diagnostics.length > 0
    )
      throw analysisFailure();
    const loaded = services.loadProject({
      repositoryRoot: discovery.repositoryRoot,
      approvedFiles: discovery.sources,
      ...(command.tsconfig === undefined
        ? {}
        : { tsconfigPath: command.tsconfig }),
    });
    if (loaded.project === null) throw analysisFailure();
    const graph = services.extractDeclarationGraph({
      repositoryRoot: discovery.repositoryRoot,
      project: loaded.project,
    });
    const snapshot: SnapshotV1 = {
      ...graph,
      completeness: loaded.diagnostics.length > 0 ? 'partial' : 'complete',
    };
    let result: SnapshotWriteResult;
    try {
      result = await services.writeSnapshot(
        discovery.repositoryRoot,
        snapshot,
        {
          path: command.snapshot,
          mode: command.overwrite ? 'replace' : 'create-only',
        },
      );
    } catch (error) {
      if (error instanceof SnapshotError) throw snapshotFailure(error);
      throw analysisFailure();
    }
    return {
      snapshotPath: command.snapshot,
      completeness: snapshot.completeness,
      digest: result.digest,
      bytes: result.bytes,
    };
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    if (error instanceof SnapshotError) throw snapshotFailure(error);
    throw analysisFailure();
  }
}

async function executeQuery(
  command: Exclude<ParsedCommand, AnalyzeCommand>,
  services: CliServices,
): Promise<QueryResponseV1> {
  let snapshot: SnapshotV1;
  try {
    snapshot = await services.openValidatedSnapshot(
      command.root,
      command.snapshot,
    );
  } catch (error) {
    if (error instanceof SnapshotError) throw snapshotFailure(error);
    throw new CliFailure('internal', QUERY_MESSAGES.internal, 1);
  }
  const service: GraphQueryService = services.createGraphQueryService(snapshot);
  let result: QueryResponseV1 | QueryErrorV1;
  const options = queryOptions(command);
  if (command.command === 'symbol') {
    result = service.searchSymbols({
      operation: 'searchSymbols',
      query: command.query,
      ...(command.kind === undefined ? {} : { kind: command.kind }),
      ...(command.path === undefined ? {} : { path: command.path }),
      ...(command.containerId === undefined
        ? {}
        : { containerId: command.containerId }),
      ...options,
    });
  } else if (command.command === 'details') {
    result = service.getSymbol({
      operation: 'getSymbol',
      nodeId: command.nodeId,
      ...options,
    });
  } else if (
    command.command === 'dependencies' ||
    command.command === 'dependents'
  ) {
    result =
      command.command === 'dependencies'
        ? service.listFileDependencies({
            operation: 'listFileDependencies',
            fileId: command.fileId,
            ...options,
          })
        : service.listFileDependents({
            operation: 'listFileDependents',
            fileId: command.fileId,
            ...options,
          });
  } else if (command.command === 'callers' || command.command === 'callees') {
    result =
      command.command === 'callers'
        ? service.listCallers({
            operation: 'listCallers',
            function: functionSelector(command),
            ...options,
          })
        : service.listCallees({
            operation: 'listCallees',
            function: functionSelector(command),
            ...options,
          });
  } else {
    throw new CliFailure('internal', QUERY_MESSAGES.internal, 1);
  }
  if (isQueryError(result)) throw queryFailure(result);
  return result;
}

function summaryLine(item: NodeSummaryV1): string {
  if (item.kind === 'file') return `${item.kind} ${item.path} [${item.id}]`;
  return `${item.kind} ${item.qualifiedName} (${item.path}) [${item.id}]`;
}

function pageLines(
  items: readonly (FileSummaryV1 | SymbolSummaryV1)[],
): string[] {
  return items.map(summaryLine);
}

function humanQuery(command: QueryCommand, response: QueryResponseV1): string {
  if (response.operation === 'getSymbol') {
    const details = response as GetSymbolResponseV1;
    return [
      summaryLine(details.symbol),
      `children: ${details.children.items.length}/${details.children.total}`,
      ...pageLines(details.children.items),
    ].join('\n');
  }
  const page = response.page as
    SearchResponseV1['page'] | FileRelationResponseV1['page'];
  return [
    `${command}: ${page.items.length}/${page.total}`,
    ...pageLines(page.items),
  ].join('\n');
}

function emitSuccess(command: ParsedCommand, result: unknown, io: CliIO): void {
  if (command.output === 'json') {
    io.stdout(
      `${JSON.stringify({ schemaVersion: 1, command: command.command, result })}\n`,
    );
    return;
  }
  if (command.command === 'analyze') {
    const analysis = result as Awaited<ReturnType<typeof executeAnalyze>>;
    io.stdout(
      `Snapshot written to ${analysis.snapshotPath} (${analysis.completeness}; ${analysis.bytes} bytes; ${analysis.digest})\n`,
    );
  } else {
    io.stdout(`${humanQuery(command.command, result as QueryResponseV1)}\n`);
  }
}

function errorEnvelope(
  command: string,
  failure: CliFailure,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    command,
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.field === undefined ? {} : { field: failure.field }),
      ...(failure.candidates === undefined
        ? {}
        : { candidates: failure.candidates }),
      ...(failure.totalCandidates === undefined
        ? {}
        : { totalCandidates: failure.totalCandidates }),
    },
  };
}

function emitFailure(
  command: string,
  output: OutputFormat,
  failure: CliFailure,
  io: CliIO,
): number {
  if (output === 'json') {
    io.stderr(`${JSON.stringify(errorEnvelope(command, failure))}\n`);
  } else {
    io.stderr(
      `${failure.message}${failure.field === undefined ? '' : ` (${failure.field})`}\n`,
    );
    if (failure.candidates !== undefined)
      for (const item of failure.candidates.items)
        io.stderr(`${summaryLine(item)}\n`);
  }
  return failure.exitCode;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  services: CliServices = productionServices,
  io: CliIO = processIO,
): Promise<number> {
  const command = commandHint(argv);
  const output = readOutputHint(argv);
  if (argv.length === 1 && argv[0] === '--help') {
    io.stdout(`${helpText()}\n`);
    return 0;
  }
  if (
    argv.length === 2 &&
    COMMANDS.has(argv[0] as CommandName) &&
    argv[1] === '--help'
  ) {
    io.stdout(`${helpText(argv[0] as CommandName)}\n`);
    return 0;
  }
  try {
    const parsed = parseArguments(argv);
    const result =
      parsed.command === 'analyze'
        ? await executeAnalyze(parsed, services)
        : await executeQuery(parsed, services);
    emitSuccess(parsed, result, io);
    return 0;
  } catch (error) {
    const failure =
      error instanceof CliFailure
        ? error
        : error instanceof SnapshotError
          ? snapshotFailure(error)
          : new CliFailure('internal', QUERY_MESSAGES.internal, 1);
    return emitFailure(command, output, failure, io);
  }
}

function realpathUrl(value: string): string | undefined {
  try {
    return pathToFileURL(fs.realpathSync.native(value)).href;
  } catch {
    return undefined;
  }
}

function isDirectExecution(
  entryPath: string | undefined,
  moduleUrl: string,
): boolean {
  if (entryPath === undefined || !moduleUrl.startsWith('file:')) return false;
  const entryUrl = realpathUrl(entryPath);
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const resolvedModuleUrl = realpathUrl(modulePath);
  if (entryUrl !== undefined && resolvedModuleUrl !== undefined)
    return entryUrl === resolvedModuleUrl;
  return (
    pathToFileURL(path.resolve(entryPath)).href ===
    pathToFileURL(path.resolve(modulePath)).href
  );
}

const isDirect = isDirectExecution(process.argv[1], import.meta.url);

if (isDirect) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
