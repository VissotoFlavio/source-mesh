import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
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
  readonly suite: 'typescript' | 'csharp';
  readonly output?: string;
  readonly tokenMetrics?: string;
}

function usage(): string {
  return [
    'Usage: npm run benchmark -- [--runs <1..20>] [--suite typescript|csharp] [--format json|csv] [--output <relative-path>] [--token-metrics <relative-path>]',
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
  let tokenMetrics: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') throw new Error('help');
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
      if (value !== 'typescript' && value !== 'csharp')
        throw new Error('Invalid suite.');
      suite = value;
      index += 1;
    } else if (argument === '--output') {
      output = relativePath(value, 'output path');
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
    ...(output === undefined ? {} : { output }),
    ...(tokenMetrics === undefined ? {} : { tokenMetrics }),
  };
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
  const report = await runBenchmark({
    repository: process.cwd(),
    manifest:
      parsed.suite === 'typescript'
        ? OFFICIAL_SYNTHETIC_MANIFEST
        : OFFICIAL_CSHARP_MANIFEST,
    runs: parsed.runs,
    ...(tokenMetrics === undefined ? {} : { tokenMetrics }),
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
