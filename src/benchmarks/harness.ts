import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { discoverSourceFiles } from '../discovery.js';
import { discoverCSharpManifest } from '../csharp/discovery.js';
import { createCSharpExplicitProjectSelection } from '../csharp/contracts.js';
import { discoverCSharpExplicitProjectManifest } from '../csharp/discovery.js';
import { openValidatedSnapshot } from '../snapshot/bootstrap.js';
import type { Snapshot } from '../snapshot/types.js';
import {
  calculateAccuracy,
  type BenchmarkEnvironment,
  type BenchmarkManifest,
  type BenchmarkReport,
  type BenchmarkScenario,
  type ScenarioRun,
  type StrategyResult,
  type TimingSample,
} from './contracts.js';
import { summarizeRuns } from './report.js';

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
}

export type BenchmarkDiagnostic = (
  event: string,
  details: Readonly<Record<string, number | string>>,
) => void;

interface MeasuredStrategy {
  readonly result: StrategyResult;
  readonly elapsedMs: number;
}

export interface RunBenchmarkOptions {
  readonly repository: string;
  readonly manifest: BenchmarkManifest;
  readonly runs: number;
  readonly fixtureRoot?: string;
  readonly tokenMetrics?: BenchmarkReport['tokenMetrics'];
  readonly onDiagnostic?: BenchmarkDiagnostic;
}

function diagnostic(
  options: RunBenchmarkOptions,
  event: string,
  details: Readonly<Record<string, number | string>> = {},
): void {
  options.onDiagnostic?.(event, details);
}

function childDiagnosticCodes(stderr: string): string {
  const codes = new Set<string>();
  for (const line of stderr.split(/\r?\n/u)) {
    const diagnosticMatch = /^\[diagnostic\] [a-z.]+: ([a-z_,-]+)$/u.exec(line);
    if (diagnosticMatch?.[1] !== undefined) codes.add(diagnosticMatch[1]);
    try {
      const parsed: unknown = JSON.parse(line);
      const code =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as { readonly error?: { readonly code?: unknown } }).error
              ?.code
          : undefined;
      if (typeof code === 'string' && /^[a-z_]{1,64}$/u.test(code))
        codes.add(code);
    } catch {
      // Child stderr is untrusted; only recognized, bounded diagnostic codes
      // are surfaced to the caller.
    }
  }
  return [...codes].sort().join(',') || 'unclassified';
}

function failureResult(
  scenario: BenchmarkScenario,
  elapsedMs: number,
  operations: number,
  failure: string,
): StrategyResult {
  return {
    elapsedMs,
    preparationOperations: 0,
    operations,
    filesExamined: 0,
    returnedBytes: 0,
    values: [],
    accuracy: calculateAccuracy(scenario.expected.values, []),
    status: 'failed',
    failure,
  };
}

function result(
  scenario: BenchmarkScenario,
  metrics: Omit<StrategyResult, 'accuracy' | 'status'>,
  status: StrategyResult['status'] = 'complete',
): StrategyResult {
  return {
    ...metrics,
    accuracy: calculateAccuracy(scenario.expected.values, metrics.values),
    status,
  };
}

function spawnNode(
  repository: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repository,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

async function analyzeFixture(
  repository: string,
  root: string,
  snapshotId: string,
  manifest: BenchmarkManifest,
  diagnostics: RunBenchmarkOptions['onDiagnostic'],
  run: number,
): Promise<void> {
  const cli = path.join(repository, 'dist', 'cli.js');
  const denyNetwork = path.join(repository, 'scripts', 'deny-network.mjs');
  const execution = await spawnNode(repository, [
    '--import',
    pathToFileURL(denyNetwork).href,
    cli,
    'analyze',
    '--root',
    root,
    '--snapshot-id',
    snapshotId,
    ...(diagnostics === undefined ? [] : ['--diagnostics']),
    ...(manifest.analysis.language === 'typescript'
      ? ['--tsconfig', manifest.analysis.tsconfig]
      : [
          '--language',
          'csharp',
          ...(manifest.analysis.solution === undefined
            ? manifest.analysis.projects!.flatMap((project) => [
                '--project',
                project,
              ])
            : ['--solution', manifest.analysis.solution]),
        ]),
    '--output',
    'json',
  ]);
  if (execution.code !== 0) {
    const codes = childDiagnosticCodes(execution.stderr);
    diagnostics?.('analysis.failed', {
      run,
      exitCode: execution.code === null ? 'signal' : execution.code,
      codes,
    });
    throw new Error(`SourceMesh analysis failed (${codes}).`);
  }
}

function pageItems(value: unknown): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== 'object') return [];
  const page = (value as { readonly page?: unknown }).page;
  if (page === null || typeof page !== 'object') return [];
  const items = (page as { readonly items?: unknown }).items;
  return Array.isArray(items)
    ? items.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      )
    : [];
}

function valueForNode(item: Record<string, unknown>): string | undefined {
  const node =
    item.node !== null && typeof item.node === 'object'
      ? (item.node as Record<string, unknown>)
      : item;
  return typeof node.name === 'string' && typeof node.path === 'string'
    ? `${node.name}|${node.path}`
    : undefined;
}

async function call(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  const response = await client.callTool({ name, arguments: argumentsValue });
  if (response.isError) throw new Error('SourceMesh query failed.');
  return response.structuredContent;
}

function sourceFileId(snapshot: Snapshot, relativePath: string): string {
  const node = snapshot.nodes.find(
    (candidate) => candidate.kind === 'file' && candidate.path === relativePath,
  );
  if (node === undefined) throw new Error('Benchmark fixture file is missing.');
  return node.id;
}

async function sourceMeshScenario(
  client: Client,
  snapshot: Snapshot,
  scenario: BenchmarkScenario,
): Promise<MeasuredStrategy> {
  const started = performance.now();
  let operations = 0;
  const responses: unknown[] = [];
  try {
    if (scenario.strategy === 'search-symbol') {
      responses.push(
        await call(client, 'searchSymbols', {
          query: scenario.target,
          ...(scenario.kind === undefined ? {} : { kind: scenario.kind }),
          limit: 100,
          allowPartial: true,
        }),
      );
      operations += 1;
    } else if (scenario.strategy === 'list-callers') {
      responses.push(
        await call(client, 'searchSymbols', {
          query: scenario.target,
          kind: 'function',
          limit: 100,
          allowPartial: true,
        }),
      );
      responses.push(
        await call(client, 'listCallers', {
          function: {
            name: scenario.target,
            ...(scenario.qualifiedName === undefined
              ? {}
              : { qualifiedName: scenario.qualifiedName }),
          },
          limit: 100,
          allowPartial: true,
        }),
      );
      operations += 2;
    } else {
      const tool =
        scenario.strategy === 'list-file-dependencies'
          ? 'listFileDependencies'
          : 'listFileDependents';
      responses.push(
        await call(client, tool, {
          fileId: sourceFileId(snapshot, scenario.target),
          limit: 100,
          allowPartial: true,
        }),
      );
      operations += 1;
    }
    const values = pageItems(responses.at(-1))
      .map(valueForNode)
      .filter((value): value is string => value !== undefined);
    const elapsedMs = performance.now() - started;
    return {
      elapsedMs,
      result: result(
        scenario,
        {
          elapsedMs,
          preparationOperations: scenario.strategy.startsWith('list-file-')
            ? 1
            : 0,
          operations,
          filesExamined: 0,
          returnedBytes: Buffer.byteLength(JSON.stringify(responses)),
          values,
        },
        snapshot.completeness === 'partial' ? 'partial' : 'complete',
      ),
    };
  } catch {
    const elapsedMs = performance.now() - started;
    return {
      elapsedMs,
      result: failureResult(
        scenario,
        elapsedMs,
        operations,
        'SourceMesh query failed.',
      ),
    };
  }
}

async function listSourceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(relative = ''): Promise<void> {
    const directory = path.join(root, relative);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      if (entry.name === '.sourcemesh' || entry.name === 'node_modules')
        continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|cs)$/u.test(entry.name))
        files.push(child.replaceAll(path.sep, '/'));
    }
  }
  await visit();
  return files;
}

function importsIn(text: string): readonly string[] {
  return [...text.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(
    (match) => match[1] ?? '',
  );
}

function importedPath(source: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const normalized = path
    .normalize(path.join(path.dirname(source), specifier))
    .replaceAll('\\', '/');
  const extension = path.extname(normalized);
  return extension === '.js' ? `${normalized.slice(0, -3)}.ts` : normalized;
}

async function baselineScenario(
  root: string,
  scenario: BenchmarkScenario,
): Promise<MeasuredStrategy> {
  const started = performance.now();
  try {
    const files = await listSourceFiles(root);
    const content = new Map<string, string>();
    for (const file of files)
      content.set(file, await readFile(path.join(root, file), 'utf8'));
    let values: readonly string[];
    if (scenario.strategy === 'search-symbol') {
      const declaration = new RegExp(
        `${scenario.kind ?? '(?:class|interface|function)'}\\s+${scenario.target}\\b`,
        'u',
      );
      values = files.flatMap((file) =>
        declaration.test(content.get(file) ?? '')
          ? [`${scenario.target}|${file}`]
          : [],
      );
    } else if (scenario.strategy === 'list-callers') {
      const caller = new RegExp(
        `(?:function\\s+([A-Za-z_$][\\w$]*)|(?:public|private|protected|internal)\\s+(?!interface\\b)[A-Za-z_$][\\w$<>?, ]*\\s+([A-Za-z_$][\\w$]*))[^{}]*\\{[^{}]*\\b${scenario.target}\\s*\\(`,
        'gu',
      );
      values = files.flatMap((file) =>
        [...(content.get(file) ?? '').matchAll(caller)].flatMap((match) =>
          match[1] === undefined && match[2] === undefined
            ? []
            : [`${match[1] ?? match[2]}|${file}`],
        ),
      );
    } else {
      const target = scenario.target;
      values = files.flatMap((file) => {
        const dependencies = importsIn(content.get(file) ?? '')
          .map((specifier) => importedPath(file, specifier))
          .filter(
            (dependency): dependency is string => dependency !== undefined,
          );
        if (scenario.strategy === 'list-file-dependencies' && file === target)
          return dependencies.map(
            (dependency) => `${path.posix.basename(dependency)}|${dependency}`,
          );
        if (
          scenario.strategy === 'list-file-dependents' &&
          dependencies.includes(target)
        )
          return [`${path.posix.basename(file)}|${file}`];
        return [];
      });
    }
    const elapsedMs = performance.now() - started;
    return {
      elapsedMs,
      result: result(scenario, {
        elapsedMs,
        preparationOperations: 0,
        operations: files.length + 1,
        filesExamined: files.length,
        returnedBytes: Buffer.byteLength(JSON.stringify(values)),
        values,
      }),
    };
  } catch {
    const elapsedMs = performance.now() - started;
    return {
      elapsedMs,
      result: failureResult(
        scenario,
        elapsedMs,
        0,
        'Conventional baseline failed.',
      ),
    };
  }
}

async function startMcp(
  repository: string,
  root: string,
  snapshot: string,
): Promise<{
  readonly client: Client;
  readonly transport: StdioClientTransport;
}> {
  const cli = path.join(repository, 'dist', 'cli.js');
  const denyNetwork = path.join(repository, 'scripts', 'deny-network.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      pathToFileURL(denyNetwork).href,
      cli,
      'mcp',
      '--root',
      root,
      '--snapshot',
      snapshot,
    ],
    cwd: repository,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'SourceMesh benchmark', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function revision(repository: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return 'unavailable';
  }
}

function environment(repository: string): BenchmarkEnvironment {
  const commit = revision(repository);
  return {
    node: process.version,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    sourceMeshCommit: commit,
    fixtureCommit: commit,
  };
}

export async function runBenchmark(
  options: RunBenchmarkOptions,
): Promise<BenchmarkReport> {
  if (
    !Number.isSafeInteger(options.runs) ||
    options.runs < 1 ||
    options.runs > 20
  )
    throw new TypeError('runs');
  const fixture =
    options.fixtureRoot ??
    path.resolve(options.repository, options.manifest.fixture);
  const fixtureInfo = await stat(fixture);
  if (!fixtureInfo.isDirectory())
    throw new Error('Benchmark fixture is missing.');
  const samples: TimingSample[] = [];
  const scenarioRuns: ScenarioRun[][] = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sourcemesh-benchmark-'));
    try {
      await cp(fixture, root, { recursive: true });
      diagnostic(options, 'fixture.copied', { run });
      const discoveryStarted = performance.now();
      if (options.manifest.analysis.language === 'typescript')
        await discoverSourceFiles(root);
      else if (options.manifest.analysis.solution !== undefined)
        await discoverCSharpManifest(root, {
          solution: options.manifest.analysis.solution,
        });
      else {
        const selection = createCSharpExplicitProjectSelection(
          options.manifest.analysis.projects!,
        );
        if (selection.selection === undefined)
          throw new Error('Benchmark C# project selection is invalid.');
        const discovered = await discoverCSharpExplicitProjectManifest(
          root,
          selection.selection,
        );
        if (discovered.manifest === undefined) {
          const codes =
            discovered.diagnostics.map((item) => item.code).join(',') ||
            'failed';
          diagnostic(options, 'csharp.discovery.failed', { run, codes });
          throw new Error(`Benchmark C# project discovery failed (${codes}).`);
        }
      }
      const discoveryMs = performance.now() - discoveryStarted;
      diagnostic(options, 'discovery.completed', { run });
      const snapshotId = `benchmark-${run}`;
      const analysisStarted = performance.now();
      await analyzeFixture(
        options.repository,
        root,
        snapshotId,
        options.manifest,
        options.onDiagnostic,
        run,
      );
      const analysisAndSnapshotMs = performance.now() - analysisStarted;
      const snapshotPath = `.sourcemesh/snapshots/${snapshotId}.json`;
      const bytes = await readFile(path.join(root, snapshotPath));
      const snapshot = await openValidatedSnapshot(root, snapshotPath);
      diagnostic(options, 'snapshot.completed', { run });
      const initializationStarted = performance.now();
      const mcp = await startMcp(options.repository, root, snapshotPath);
      const mcpInitializationMs = performance.now() - initializationStarted;
      diagnostic(options, 'mcp.connected', { run });
      try {
        const current: ScenarioRun[] = [];
        const baselineQueryMs: number[] = [];
        const warmQueryMs: number[] = [];
        for (const scenario of options.manifest.scenarios) {
          const baseline = await baselineScenario(root, scenario);
          const sourceMesh = await sourceMeshScenario(
            mcp.client,
            snapshot,
            scenario,
          );
          baselineQueryMs.push(baseline.elapsedMs);
          warmQueryMs.push(sourceMesh.elapsedMs);
          current.push({
            scenarioId: scenario.id,
            baseline: baseline.result,
            sourceMesh: sourceMesh.result,
          });
        }
        scenarioRuns.push(current);
        samples.push({
          run,
          discoveryMs,
          analysisAndSnapshotMs,
          snapshotBytes: bytes.length,
          mcpInitializationMs,
          baselineQueryMs,
          warmQueryMs,
        });
      } finally {
        await mcp.client.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const languages = [
    ...new Set(options.manifest.scenarios.map((item) => item.language)),
  ];
  const scenarioResults = scenarioRuns.at(-1) ?? [];
  return {
    schemaVersion: 1,
    benchmark: 'SourceMesh official synthetic benchmark',
    generatedAt: new Date().toISOString(),
    environment: environment(options.repository),
    manifest: {
      id: options.manifest.id,
      fixture: options.manifest.fixture,
      languages,
    },
    runs: samples,
    scenarioRuns,
    scenarios: scenarioResults,
    summaries: summarizeRuns(samples, scenarioRuns.flat()),
    tokenMetrics: options.tokenMetrics ?? [],
    limitations: [
      'Timing is host-specific and is not a latency SLO or a production-capacity claim.',
      'The baseline is a documented textual search and file-inspection procedure, not every possible agent workflow.',
      'File-relation scenarios use a fixture-known file ID because the current MCP surface accepts file IDs for those operations.',
      'No hosted model is invoked and no token metric is inferred when no imported telemetry is supplied.',
    ],
  };
}
