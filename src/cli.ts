#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createGraphQueryService,
  csharpPack,
  discoverSourceFiles,
  typescriptPack,
  openValidatedSnapshot,
  writeSnapshot,
} from './index.js';
import { isWindowsUnsafePath } from './discovery.js';
import type {
  FileRelationResponseV1,
  FileRelationResponseV2,
  FileRelationResponseV3,
  CSharpManifest,
  FunctionSelectorV1,
  GetSymbolResponseV1,
  GetSymbolResponseV2,
  GetSymbolResponseV3,
  GraphQueryService,
  GraphQueryServiceV2,
  GraphQueryServiceV3,
  NodeSummaryV1,
  NodeSummaryV2,
  NodeSummaryV3,
  QueryErrorV1,
  QueryErrorV2,
  QueryErrorV3,
  QueryResponseV1,
  QueryResponseV2,
  QueryResponseV3,
  SearchResponseV1,
  SearchResponseV2,
  SearchResponseV3,
  SearchSymbolKindV2,
  Snapshot,
  SnapshotV1,
  SnapshotWriteResult,
} from './index.js';
import { SnapshotError } from './snapshot/types.js';
import { isReadableSnapshotPath, snapshotPathForId } from './snapshot/path.js';
import { runMcpStdio } from './mcp/run-stdio.js';
import { composeMultiPackSnapshot } from './multi-pack.js';

type CommandName =
  | 'analyze'
  | 'mcp'
  | 'symbol'
  | 'details'
  | 'dependencies'
  | 'dependents'
  | 'callers'
  | 'callees';
type OutputFormat = 'human' | 'json';
type QueryCommand = Exclude<CommandName, 'analyze' | 'mcp'>;

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
  readonly language?: 'csharp';
  readonly solution?: string;
  readonly project?: string;
  readonly sourceEncoding?: 'windows-1252';
  readonly maxDiagnostics?: number;
  readonly output: OutputFormat;
}

interface McpCommand {
  readonly command: 'mcp';
  readonly root: string;
  readonly snapshot: string;
}

interface SymbolCommand extends CommonOptions {
  readonly command: 'symbol';
  readonly query: string;
  readonly kind?: SearchSymbolKindV2;
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
  | McpCommand
  | SymbolCommand
  | DetailsCommand
  | FileRelationCommand
  | CallRelationCommand;

interface SnapshotAnalyzeResult {
  readonly kind: 'snapshot';
  readonly schemaVersion: 1 | 2 | 3;
  readonly snapshotPath: string;
  readonly completeness: SnapshotV1['completeness'];
  readonly digest: string;
  readonly bytes: number;
  readonly compilerDiagnostics?: {
    readonly total: number;
    readonly errors: number;
    readonly warnings: number;
  };
}

interface CSharpManifestAnalyzeResult {
  readonly kind: 'csharp-manifest';
  readonly manifest: CSharpManifest;
}

type AnalyzeResult = SnapshotAnalyzeResult | CSharpManifestAnalyzeResult;

export interface CliIO {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface CliServices {
  readonly discoverCSharpManifest: typeof csharpPack.discover;
  readonly analyzeCSharpManifest?: typeof csharpPack.analyzeManifest;
  readonly extractCSharpDeclarationGraph?: typeof csharpPack.extract;
  readonly discoverSourceFiles: typeof discoverSourceFiles;
  readonly writeSnapshot: typeof writeSnapshot;
  readonly openValidatedSnapshot: typeof openValidatedSnapshot;
  readonly createGraphQueryService: (
    snapshot: Snapshot,
  ) => GraphQueryService | GraphQueryServiceV2 | GraphQueryServiceV3;
}

const productionServices: CliServices = {
  discoverCSharpManifest: csharpPack.discover,
  analyzeCSharpManifest: csharpPack.analyzeManifest,
  extractCSharpDeclarationGraph: csharpPack.extract,
  discoverSourceFiles,
  writeSnapshot,
  openValidatedSnapshot,
  createGraphQueryService,
};

const processIO: CliIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const NODE_ID = /^n:[0-9a-f]{64}$/u;
const COMMANDS = new Set<CommandName>([
  'analyze',
  'mcp',
  'symbol',
  'details',
  'dependencies',
  'dependents',
  'callers',
  'callees',
]);
const SEARCH_KINDS = new Set<SearchSymbolKindV2>([
  'solution',
  'project',
  'module',
  'namespace',
  'class',
  'interface',
  'function',
  'variable',
  'type',
  'parameter',
]);
const MEMBER_ROLES = new Set(['none', 'static', 'instance']);

type QueryService =
  GraphQueryService | GraphQueryServiceV2 | GraphQueryServiceV3;
type QueryResponse = QueryResponseV1 | QueryResponseV2 | QueryResponseV3;
type QueryError = QueryErrorV1 | QueryErrorV2 | QueryErrorV3;
type NodeSummary = NodeSummaryV1 | NodeSummaryV2 | NodeSummaryV3;

const QUERY_MESSAGES: Record<QueryError['code'], string> = {
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
  readonly candidates: QueryError['candidates'];
  readonly totalCandidates: number | undefined;
  readonly schemaVersion: 1 | 2 | 3 | undefined;

  constructor(
    code: string,
    message: string,
    exitCode: 1 | 2 | 3 | 4,
    field?: string,
    options?: {
      readonly candidates?: QueryError['candidates'];
      readonly totalCandidates?: number;
      readonly schemaVersion?: 1 | 2 | 3;
    },
  ) {
    super(message);
    this.name = 'CliFailure';
    this.code = code;
    this.exitCode = exitCode;
    this.field = field;
    this.candidates = options?.candidates;
    this.totalCandidates = options?.totalCandidates;
    this.schemaVersion = options?.schemaVersion;
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
    isWindowsUnsafePath(value) ||
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
  if (!isReadableSnapshotPath(normalized)) throw invalid('snapshot');
  return normalized;
}

function normalizeSnapshotId(value: string): string {
  try {
    snapshotPathForId(value);
    return value;
  } catch {
    throw invalid('snapshot-id');
  }
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
      'Commands: analyze, mcp, symbol, details, dependencies, dependents, callers, callees',
      'Use "sourcemesh <command> --help" for command syntax.',
      '',
      'Exit codes: 0 success/help, 1 operational failure, 2 invalid arguments,',
      '3 query target/request failure, 4 snapshot conflict.',
    ].join('\n');
  const usage: Record<CommandName, string> = {
    analyze:
      'sourcemesh analyze --root <path> --snapshot-id <id> [--tsconfig <relative>] [--language csharp --solution <relative>|--project <relative> [--source-encoding windows-1252] [--max-diagnostics <1..100000>]] [--output human|json]',
    mcp: 'sourcemesh mcp --root <path> --snapshot <relative>',
    symbol:
      'sourcemesh symbol --root <path> --snapshot <relative> --query <text> [--kind <kind>] [--path <relative>] [--container-id <node-id>] [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    details:
      'sourcemesh details --root <path> --snapshot <relative> --id <node-id> [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    dependencies:
      'sourcemesh dependencies --root <path> --snapshot <relative> --file-id <file-id> [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    dependents:
      'sourcemesh dependents --root <path> --snapshot <relative> --file-id <file-id> [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    callers:
      'sourcemesh callers --root <path> --snapshot <relative> --name <function-name> [--qualified-name <name>] [--path <relative>] [--member-role <none|static|instance>] [--container-id <node-id>] [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
    callees:
      'sourcemesh callees --root <path> --snapshot <relative> --name <function-name> [--qualified-name <name>] [--path <relative>] [--member-role <none|static|instance>] [--container-id <node-id>] [--limit <1..100>] [--cursor <token>] [--allow-partial] [--output human|json]',
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
  if (command === 'mcp')
    return new Map([
      ['--root', 'value'],
      ['--snapshot', 'value'],
    ]);
  if (command === 'analyze')
    return new Map([
      ['--root', 'value'],
      ['--output', 'value'],
      ['--snapshot-id', 'value'],
      ['--tsconfig', 'value'],
      ['--language', 'value'],
      ['--solution', 'value'],
      ['--project', 'value'],
      ['--source-encoding', 'value'],
      ['--max-diagnostics', 'value'],
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
  const snapshot = normalizeSnapshotPath(
    requiredValue(values, '--snapshot', 'snapshot'),
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
    const snapshotId = normalizeSnapshotId(
      requiredValue(values, '--snapshot-id', 'snapshot-id'),
    );
    const snapshot = snapshotPathForId(snapshotId);
    const outputValue = valueOf(values, '--output') ?? 'human';
    if (outputValue !== 'human' && outputValue !== 'json')
      throw invalid('output');
    const tsconfigValue = valueOf(values, '--tsconfig');
    const tsconfig =
      tsconfigValue === undefined
        ? undefined
        : normalizeRelativePath(tsconfigValue, 'tsconfig');
    const languageValue = valueOf(values, '--language');
    const solutionValue = valueOf(values, '--solution');
    const projectValue = valueOf(values, '--project');
    const sourceEncodingValue = valueOf(values, '--source-encoding');
    const maxDiagnosticsValue = valueOf(values, '--max-diagnostics');
    if (languageValue === undefined) {
      if (
        solutionValue !== undefined ||
        projectValue !== undefined ||
        sourceEncodingValue !== undefined ||
        maxDiagnosticsValue !== undefined
      )
        throw invalid('language');
    } else {
      if (languageValue !== 'csharp') throw invalid('language');
      if ((solutionValue === undefined) === (projectValue === undefined))
        throw invalid('selection');
    }
    if (
      sourceEncodingValue !== undefined &&
      sourceEncodingValue !== 'windows-1252'
    )
      throw invalid('source-encoding');
    let maxDiagnostics: number | undefined;
    if (maxDiagnosticsValue !== undefined) {
      if (!/^[0-9]+$/u.test(maxDiagnosticsValue))
        throw invalid('max-diagnostics');
      maxDiagnostics = Number(maxDiagnosticsValue);
      if (
        !Number.isSafeInteger(maxDiagnostics) ||
        maxDiagnostics < 1 ||
        maxDiagnostics > 100_000
      )
        throw invalid('max-diagnostics');
    }
    const solution =
      solutionValue === undefined
        ? undefined
        : normalizeRelativePath(solutionValue, 'solution');
    const project =
      projectValue === undefined
        ? undefined
        : normalizeRelativePath(projectValue, 'project');
    return {
      command,
      root,
      snapshot,
      ...(tsconfig === undefined ? {} : { tsconfig }),
      ...(languageValue === undefined ? {} : { language: 'csharp' as const }),
      ...(solution === undefined ? {} : { solution }),
      ...(project === undefined ? {} : { project }),
      ...(sourceEncodingValue === undefined
        ? {}
        : { sourceEncoding: sourceEncodingValue }),
      ...(maxDiagnostics === undefined ? {} : { maxDiagnostics }),
      output: outputValue,
    };
  }

  if (command === 'mcp') {
    const root = requiredValue(values, '--root', 'root');
    const snapshotValue = requiredValue(values, '--snapshot', 'snapshot');
    return {
      command,
      root,
      snapshot: normalizeSnapshotPath(snapshotValue),
    };
  }

  const common = parseCommon(command, values);
  if (command === 'symbol') {
    const query = requiredValue(values, '--query', 'query')
      .normalize('NFC')
      .trim();
    if (query.length === 0 || query.length > 256) throw invalid('query');
    const kindValue = valueOf(values, '--kind');
    if (
      kindValue !== undefined &&
      !SEARCH_KINDS.has(kindValue as SearchSymbolKindV2)
    )
      throw invalid('kind');
    const kind =
      kindValue === undefined ? undefined : (kindValue as SearchSymbolKindV2);
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

function queryFailure(
  error: QueryError,
  schemaVersion?: 1 | 2 | 3,
): CliFailure {
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
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
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

function isQueryError(value: QueryResponse | QueryError): value is QueryError {
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
): Promise<AnalyzeResult> {
  try {
    if (command.language === 'csharp') {
      const manifest = await services.discoverCSharpManifest(command.root, {
        ...(command.solution === undefined
          ? {}
          : { solution: command.solution }),
        ...(command.project === undefined ? {} : { project: command.project }),
      });
      if (manifest.manifest === undefined || manifest.diagnostics.length > 0)
        throw analysisFailure();
      if (
        services.analyzeCSharpManifest === undefined ||
        services.extractCSharpDeclarationGraph === undefined
      )
        return { kind: 'csharp-manifest', manifest: manifest.manifest };
      const worker = await services.analyzeCSharpManifest(
        command.root,
        manifest.manifest,
        {
          ...(command.sourceEncoding === undefined
            ? {}
            : { sourceEncoding: command.sourceEncoding }),
          ...(command.maxDiagnostics === undefined
            ? {}
            : { maxDiagnostics: command.maxDiagnostics }),
        },
      );
      const csharpSnapshot = services.extractCSharpDeclarationGraph({
        repositoryRoot: command.root,
        manifest: manifest.manifest,
        worker,
      });
      const typescript =
        command.tsconfig === undefined
          ? undefined
          : await analyzeTypeScript(command.root, command.tsconfig, services);
      const snapshot =
        typescript === undefined
          ? csharpSnapshot
          : composeMultiPackSnapshot(typescript.snapshot, csharpSnapshot);
      let result: SnapshotWriteResult;
      try {
        result = await services.writeSnapshot(
          typescript?.repositoryRoot ?? command.root,
          snapshot,
          {
            path: command.snapshot,
          },
        );
      } catch (error) {
        if (error instanceof SnapshotError) throw snapshotFailure(error);
        throw analysisFailure();
      }
      return {
        kind: 'snapshot',
        schemaVersion: snapshot.schemaVersion,
        snapshotPath: command.snapshot,
        completeness: snapshot.completeness,
        digest: result.digest,
        bytes: result.bytes,
        compilerDiagnostics: {
          total: worker.diagnostics.length,
          errors: worker.diagnostics.filter(
            (diagnostic) => diagnostic.severity === 'error',
          ).length,
          warnings: worker.diagnostics.filter(
            (diagnostic) => diagnostic.severity === 'warning',
          ).length,
        },
      };
    }
    const typescript = await analyzeTypeScript(
      command.root,
      command.tsconfig,
      services,
    );
    let result: SnapshotWriteResult;
    try {
      result = await services.writeSnapshot(
        typescript.repositoryRoot,
        typescript.snapshot,
        {
          path: command.snapshot,
        },
      );
    } catch (error) {
      if (error instanceof SnapshotError) throw snapshotFailure(error);
      throw analysisFailure();
    }
    return {
      kind: 'snapshot',
      schemaVersion: 1,
      snapshotPath: command.snapshot,
      completeness: typescript.snapshot.completeness,
      digest: result.digest,
      bytes: result.bytes,
    };
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    if (error instanceof SnapshotError) throw snapshotFailure(error);
    throw analysisFailure();
  }
}

async function analyzeTypeScript(
  root: string,
  tsconfig: string | undefined,
  services: CliServices,
): Promise<{ readonly repositoryRoot: string; readonly snapshot: SnapshotV1 }> {
  const discovery = await services.discoverSourceFiles(root, {
    extensions: typescriptPack.manifest.extensions,
  });
  if (
    discovery.repositoryRoot === undefined ||
    discovery.diagnostics.length > 0
  )
    throw analysisFailure();
  const repositoryRoot = discovery.repositoryRoot;
  const approvedFiles = discovery.sources.map((source) => ({
    path: source,
    // Discovery supplied the canonical root and relative allow-list. Core
    // reads each member once; the pack receives bytes only, never this root.
    contents: new Uint8Array(
      fs.readFileSync(path.join(repositoryRoot, source)),
    ),
  }));
  const configuration: Record<string, string> = {};
  if (tsconfig !== undefined) {
    const candidate = path.resolve(repositoryRoot, tsconfig);
    const relative = path.relative(repositoryRoot, candidate);
    if (
      relative === '' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw analysisFailure();
    configuration['typescript.tsconfig'] = fs.readFileSync(candidate, 'utf8');
  }
  const analysis = await typescriptPack.analyze({
    contractVersion: 1,
    repository: { name: 'repository', root: '.' },
    files: approvedFiles,
    limits: {
      maxFiles: 10_000,
      maxBytes: 128 * 1024 * 1024,
      maxNodes: 1_000_000,
      maxEdges: 1_000_000,
      maxDiagnostics: 100_000,
    },
    configuration,
  });
  return {
    repositoryRoot,
    snapshot: { ...analysis.graph, completeness: analysis.completeness },
  };
}

async function executeQuery(
  command: Exclude<ParsedCommand, AnalyzeCommand | McpCommand>,
  services: CliServices,
): Promise<QueryResponse> {
  let snapshot: Snapshot;
  try {
    snapshot = await services.openValidatedSnapshot(
      command.root,
      command.snapshot,
    );
  } catch (error) {
    if (error instanceof SnapshotError) throw snapshotFailure(error);
    throw new CliFailure('internal', QUERY_MESSAGES.internal, 1);
  }
  const service: QueryService = services.createGraphQueryService(snapshot);
  let result: QueryResponse | QueryError;
  const options = queryOptions(command);
  if (command.command === 'symbol') {
    const searchSymbols =
      service.searchSymbols as GraphQueryServiceV2['searchSymbols'];
    result = searchSymbols({
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
  if (isQueryError(result)) throw queryFailure(result, snapshot.schemaVersion);
  return result;
}

async function executeMcp(command: McpCommand): Promise<void> {
  await runMcpStdio(command.root, command.snapshot);
}

function summaryLine(item: NodeSummary): string {
  if (item.kind === 'file') return `${item.kind} ${item.path} [${item.id}]`;
  return `${item.kind} ${item.qualifiedName} (${item.path}) [${item.id}]`;
}

function pageLines(items: readonly NodeSummary[]): string[] {
  return items.map(summaryLine);
}

function humanQuery(command: QueryCommand, response: QueryResponse): string {
  if (response.operation === 'getSymbol') {
    const details = response as
      GetSymbolResponseV1 | GetSymbolResponseV2 | GetSymbolResponseV3;
    return [
      summaryLine(details.symbol),
      `children: ${details.children.items.length}/${details.children.total}`,
      ...pageLines(details.children.items),
    ].join('\n');
  }
  const page = response.page as
    | SearchResponseV1['page']
    | SearchResponseV2['page']
    | SearchResponseV3['page']
    | FileRelationResponseV1['page']
    | FileRelationResponseV2['page']
    | FileRelationResponseV3['page'];
  const items =
    page.schemaVersion === 3 &&
    (response.operation === 'listFileDependencies' ||
      response.operation === 'listFileDependents' ||
      response.operation === 'listCallers' ||
      response.operation === 'listCallees')
      ? (page.items as FileRelationResponseV3['page']['items']).map(
          (item) => item.node,
        )
      : (page.items as readonly NodeSummary[]);
  return [
    `${command}: ${page.items.length}/${page.total}`,
    ...pageLines(items),
  ].join('\n');
}

function querySchemaVersion(response: QueryResponse): 1 | 2 | 3 {
  return response.operation === 'getSymbol'
    ? response.schemaVersion
    : response.page.schemaVersion;
}

function emitSuccess(
  command: Exclude<ParsedCommand, McpCommand>,
  result: unknown,
  io: CliIO,
): void {
  if (command.output === 'json') {
    const analysis = result as AnalyzeResult;
    const jsonResult =
      command.command === 'analyze' && analysis.kind === 'snapshot'
        ? {
            snapshotPath: analysis.snapshotPath,
            completeness: analysis.completeness,
            digest: analysis.digest,
            bytes: analysis.bytes,
            handover: `Start a new MCP process with --snapshot ${analysis.snapshotPath}; existing MCP processes remain pinned to their original snapshot.`,
            ...(analysis.compilerDiagnostics === undefined
              ? {}
              : { compilerDiagnostics: analysis.compilerDiagnostics }),
          }
        : result;
    const schemaVersion =
      command.command === 'analyze'
        ? (result as AnalyzeResult).kind === 'snapshot'
          ? (result as SnapshotAnalyzeResult).schemaVersion
          : 1
        : querySchemaVersion(result as QueryResponse);
    io.stdout(
      `${JSON.stringify({
        schemaVersion,
        command: command.command,
        result: jsonResult,
      })}\n`,
    );
    return;
  }
  if (command.command === 'analyze') {
    const analysis = result as AnalyzeResult;
    if (analysis.kind === 'csharp-manifest') {
      io.stdout(
        `C# manifest discovery completed (${analysis.manifest.projects.length} projects)\n`,
      );
      return;
    }
    const compilerDiagnostics = analysis.compilerDiagnostics;
    io.stdout(
      `Snapshot written to ${analysis.snapshotPath} (${analysis.completeness}; ${analysis.bytes} bytes; ${analysis.digest}). Start a new MCP process with --snapshot ${analysis.snapshotPath}; existing MCP processes remain pinned to their original snapshot.${
        compilerDiagnostics === undefined
          ? ''
          : `; compiler diagnostics: ${compilerDiagnostics.total} (${compilerDiagnostics.errors} errors, ${compilerDiagnostics.warnings} warnings)`
      }\n`,
    );
  } else {
    io.stdout(`${humanQuery(command.command, result as QueryResponse)}\n`);
  }
}

function errorEnvelope(
  command: string,
  failure: CliFailure,
): Record<string, unknown> {
  return {
    schemaVersion:
      failure.schemaVersion ?? failure.candidates?.schemaVersion ?? 1,
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
    if (parsed.command === 'mcp') {
      await executeMcp(parsed);
      return 0;
    }
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
