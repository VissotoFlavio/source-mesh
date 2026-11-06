import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  validateBenchmarkManifest,
  type BenchmarkManifest,
} from './contracts.js';
import { stageExternalCSharpProject } from './external-csharp.js';
import { runBenchmark } from './harness.js';
import {
  renderCsv,
  renderJson,
  validateImportedTokenMetrics,
} from './report.js';
import {
  OFFICIAL_CSHARP_MANIFEST,
  OFFICIAL_SYNTHETIC_MANIFEST,
} from './scenarios.js';

type Format = 'json' | 'csv';

interface Options {
  readonly runs: number;
  readonly format: Format;
  readonly suite: 'typescript' | 'csharp' | 'external-csharp';
  readonly output?: string;
  readonly localOutput?: string;
  readonly targetRoot?: string;
  readonly projects: readonly string[];
  readonly scenarioFile?: string;
  readonly tokenMetrics?: string;
  readonly diagnostics: boolean;
}

function usage(): string {
  return [
    'Usage: npm run benchmark -- [--runs <1..20>] [--suite typescript|csharp|external-csharp] [--format json|csv] [--output <relative-path>] [--token-metrics <relative-path>] [--diagnostics]',
    'Runs one versioned synthetic suite. Output defaults to stdout.',
  ].join('\n');
}

function relativePath(value: string, field: string): string {
  if (
    value.trim() === '' ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/u).includes('..')
  )
    throw new Error(`Invalid ${field}.`);
  return value;
}

function options(argv: readonly string[]): Options {
  let runs = 5;
  let format: Format = 'json';
  let suite: Options['suite'] = 'typescript';
  let output: string | undefined;
  let localOutput: string | undefined;
  let targetRoot: string | undefined;
  const projects: string[] = [];
  let scenarioFile: string | undefined;
  let tokenMetrics: string | undefined;
  let diagnostics = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') throw new Error('help');
    if (argument === '--diagnostics') {
      diagnostics = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error('Missing option value.');
    if (argument === '--runs') {
      runs = Number(value);
      index += 1;
    } else if (argument === '--format') {
      if (value !== 'json' && value !== 'csv')
        throw new Error('Invalid format.');
      format = value;
      index += 1;
    } else if (argument === '--suite') {
      if (
        value !== 'typescript' &&
        value !== 'csharp' &&
        value !== 'external-csharp'
      )
        throw new Error('Invalid suite.');
      suite = value;
      index += 1;
    } else if (argument === '--output') {
      output = relativePath(value, 'output path');
      index += 1;
    } else if (argument === '--local-output') {
      localOutput = relativePath(value, 'local output path');
      index += 1;
    } else if (argument === '--target-root') {
      if (!path.isAbsolute(value)) throw new Error('Invalid target root.');
      targetRoot = value;
      index += 1;
    } else if (argument === '--project') {
      projects.push(value);
      index += 1;
    } else if (argument === '--scenario-file') {
      scenarioFile = relativePath(value, 'scenario file path');
      index += 1;
    } else if (argument === '--token-metrics') {
      tokenMetrics = relativePath(value, 'token metrics path');
      index += 1;
    } else {
      throw new Error('Unknown option.');
    }
  }
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20)
    throw new Error('Runs must be an integer from 1 through 20.');
  return {
    runs,
    format,
    suite,
    projects,
    diagnostics,
    ...(output === undefined ? {} : { output }),
    ...(localOutput === undefined ? {} : { localOutput }),
    ...(targetRoot === undefined ? {} : { targetRoot }),
    ...(scenarioFile === undefined ? {} : { scenarioFile }),
    ...(tokenMetrics === undefined ? {} : { tokenMetrics }),
  };
}

function diagnostic(
  enabled: boolean,
  event: string,
  details: Readonly<Record<string, number | string>> = {},
): void {
  if (!enabled) return;
  const suffix = Object.entries(details)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  process.stderr.write(
    `[benchmark] ${event}${suffix === '' ? '' : ` ${suffix}`}\n`,
  );
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unclassified';
  const match = /\(([a-z_.:,-]+)\)\.?$/u.exec(error.message);
  return match?.[1] ?? 'unclassified';
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let parsed: Options;
  try {
    parsed = options(argv);
  } catch (error) {
    if (error instanceof Error && error.message === 'help') {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    throw error;
  }
  let tokenMetrics: Parameters<typeof runBenchmark>[0]['tokenMetrics'];
  if (parsed.tokenMetrics !== undefined) {
    const imported: unknown = JSON.parse(
      await readFile(path.join(process.cwd(), parsed.tokenMetrics), 'utf8'),
    );
    validateImportedTokenMetrics(imported);
    tokenMetrics = imported;
  }
  if (parsed.suite === 'external-csharp') {
    if (
      parsed.targetRoot === undefined ||
      parsed.scenarioFile === undefined ||
      parsed.output === undefined ||
      parsed.localOutput === undefined ||
      parsed.projects.length === 0 ||
      !parsed.localOutput.startsWith('benchmarks/local/')
    )
      throw new Error(
        'External C# benchmarks require explicit target, projects, scenario, public output, and ignored local output.',
      );
    const scenarioInput: unknown = JSON.parse(
      await readFile(path.join(process.cwd(), parsed.scenarioFile), 'utf8'),
    );
    validateBenchmarkManifest(scenarioInput);
    const manifest: BenchmarkManifest = {
      ...scenarioInput,
      id: 'external-csharp-medium',
      fixture: 'external-csharp-medium',
      analysis: { language: 'csharp', projects: parsed.projects },
    };
    let stage = 'external-csharp.staging';
    let staged:
      Awaited<ReturnType<typeof stageExternalCSharpProject>> | undefined;
    try {
      diagnostic(parsed.diagnostics, `${stage}.started`);
      staged = await stageExternalCSharpProject({
        targetRoot: parsed.targetRoot,
        projects: parsed.projects,
      });
      diagnostic(parsed.diagnostics, `${stage}.completed`, {
        projects: staged.projects.length,
      });
      stage = 'benchmark';
      const report = await runBenchmark({
        repository: process.cwd(),
        manifest,
        fixtureRoot: staged.root,
        runs: parsed.runs,
        ...(tokenMetrics === undefined ? {} : { tokenMetrics }),
        ...(parsed.diagnostics
          ? {
              onDiagnostic: (event, details) =>
                diagnostic(true, event, details),
            }
          : {}),
      });
      await mkdir(path.dirname(path.join(process.cwd(), parsed.localOutput)), {
        recursive: true,
      });
      await writeFile(
        path.join(process.cwd(), parsed.localOutput),
        renderJson(report),
        'utf8',
      );
      const sanitized = sanitizeExternalReport(report);
      await mkdir(path.dirname(path.join(process.cwd(), parsed.output)), {
        recursive: true,
      });
      await writeFile(
        path.join(process.cwd(), parsed.output),
        parsed.format === 'json'
          ? `${JSON.stringify(sanitized, null, 2)}\n`
          : sanitizeExternalCsv(report),
        'utf8',
      );
      process.stdout.write(
        `External benchmark report written to ${parsed.output}\n`,
      );
    } catch (error) {
      diagnostic(parsed.diagnostics, `${stage}.failed`, {
        code: errorCode(error),
      });
      throw error;
    } finally {
      await staged?.cleanup();
    }
    return;
  }
  const report = await runBenchmark({
    repository: process.cwd(),
    manifest:
      parsed.suite === 'typescript'
        ? OFFICIAL_SYNTHETIC_MANIFEST
        : OFFICIAL_CSHARP_MANIFEST,
    runs: parsed.runs,
    ...(tokenMetrics === undefined ? {} : { tokenMetrics }),
    ...(parsed.diagnostics
      ? { onDiagnostic: (event, details) => diagnostic(true, event, details) }
      : {}),
  });
  const rendered =
    parsed.format === 'json' ? renderJson(report) : renderCsv(report);
  if (parsed.output === undefined) {
    process.stdout.write(rendered);
    return;
  }
  const destination = path.join(process.cwd(), parsed.output);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, rendered, 'utf8');
  process.stdout.write(`Benchmark report written to ${parsed.output}\n`);
}

export function sanitizeExternalReport(
  report: Awaited<ReturnType<typeof runBenchmark>>,
) {
  const sanitizeStrategy = (
    result: (typeof report.scenarios)[number]['baseline'],
  ) => ({
    elapsedMs: result.elapsedMs,
    preparationOperations: result.preparationOperations,
    operations: result.operations,
    filesExamined: result.filesExamined,
    returnedBytes: result.returnedBytes,
    accuracy: result.accuracy,
    status: result.status,
  });
  return {
    schemaVersion: report.schemaVersion,
    benchmark: 'SourceMesh external C# benchmark',
    generatedAt: report.generatedAt,
    environment: {
      node: report.environment.node,
      os: report.environment.os,
      sourceMeshCommit: report.environment.sourceMeshCommit,
    },
    manifest: {
      id: 'external-csharp-medium',
      fixture: 'external-csharp-medium',
      languages: ['csharp'],
    },
    scenarios: report.scenarios.map((scenario, index) => ({
      scenarioId: `scenario-${index + 1}`,
      baseline: sanitizeStrategy(scenario.baseline),
      sourceMesh: sanitizeStrategy(scenario.sourceMesh),
    })),
    summaries: report.summaries,
    tokenMetrics: report.tokenMetrics.map((metric, index) => ({
      scenarioId: `scenario-${index + 1}`,
      mode: metric.mode,
      origin: metric.origin,
      ...(metric.inputTokens === undefined
        ? {}
        : { inputTokens: metric.inputTokens }),
      ...(metric.outputTokens === undefined
        ? {}
        : { outputTokens: metric.outputTokens }),
      ...(metric.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: metric.cachedInputTokens }),
      ...(metric.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: metric.reasoningTokens }),
      ...(metric.totalTokens === undefined
        ? {}
        : { totalTokens: metric.totalTokens }),
      ...(metric.toolCalls === undefined
        ? {}
        : { toolCalls: metric.toolCalls }),
      ...(metric.elapsedMs === undefined
        ? {}
        : { elapsedMs: metric.elapsedMs }),
    })),
    limitations: report.limitations,
  };
}

function sanitizeExternalCsv(
  report: Awaited<ReturnType<typeof runBenchmark>>,
): string {
  const rows = [
    'scenarioId,strategy,status,elapsedMs,preparationOperations,operations,filesExamined,returnedBytes,precision,recall',
  ];
  for (const [index, scenario] of report.scenarios.entries()) {
    for (const [strategy, result] of [
      ['baseline', scenario.baseline],
      ['sourceMesh', scenario.sourceMesh],
    ] as const) {
      rows.push(
        [
          `scenario-${index + 1}`,
          strategy,
          result.status,
          result.elapsedMs,
          result.preparationOperations,
          result.operations,
          result.filesExamined,
          result.returnedBytes,
          result.accuracy.precision ?? '',
          result.accuracy.recall ?? '',
        ].join(','),
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

const directExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (directExecution) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
