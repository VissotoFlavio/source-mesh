import type {
  BenchmarkReport,
  ImportedTokenMetric,
  ScenarioRun,
  TimingSample,
} from './contracts.js';

function percentile(
  values: readonly number[],
  fraction: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarizeRuns(
  runs: readonly TimingSample[],
  scenarios: readonly ScenarioRun[],
): Readonly<Record<string, number>> {
  const warmQueries = runs.flatMap((run) => run.warmQueryMs);
  const allResults = scenarios.flatMap((scenario) => [
    scenario.baseline,
    scenario.sourceMesh,
  ]);
  const sourceMeshResults = scenarios.map((scenario) => scenario.sourceMesh);
  const baselineResults = scenarios.map((scenario) => scenario.baseline);
  const numeric = (value: number | null): number => value ?? 0;
  return Object.freeze({
    runs: runs.length,
    scenarios: scenarios.length,
    'discovery.medianMs': numeric(median(runs.map((run) => run.discoveryMs))),
    'analysisAndSnapshot.medianMs': numeric(
      median(runs.map((run) => run.analysisAndSnapshotMs)),
    ),
    'mcpInitialization.medianMs': numeric(
      median(runs.map((run) => run.mcpInitializationMs)),
    ),
    'warmQuery.medianMs': numeric(median(warmQueries)),
    'warmQuery.p95Ms': numeric(percentile(warmQueries, 0.95)),
    'snapshot.medianBytes': numeric(
      median(runs.map((run) => run.snapshotBytes)),
    ),
    'baseline.operations.mean': numeric(
      mean(
        baselineResults.map(
          (result) => result.operations + result.preparationOperations,
        ),
      ),
    ),
    'sourceMesh.operations.mean': numeric(
      mean(
        sourceMeshResults.map(
          (result) => result.operations + result.preparationOperations,
        ),
      ),
    ),
    'baseline.precision.mean': numeric(
      mean(baselineResults.map((result) => result.accuracy.precision ?? 0)),
    ),
    'sourceMesh.precision.mean': numeric(
      mean(sourceMeshResults.map((result) => result.accuracy.precision ?? 0)),
    ),
    'sourceMesh.recall.mean': numeric(
      mean(sourceMeshResults.map((result) => result.accuracy.recall ?? 0)),
    ),
    failures: allResults.filter((result) => result.status === 'failed').length,
  });
}

export function renderJson(report: BenchmarkReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function escapeCsv(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderCsv(report: BenchmarkReport): string {
  const rows: Array<Array<string | number | null | undefined>> = [
    [
      'scenarioId',
      'strategy',
      'status',
      'elapsedMs',
      'operations',
      'preparationOperations',
      'filesExamined',
      'returnedBytes',
      'expected',
      'returned',
      'correct',
      'falsePositives',
      'falseNegatives',
      'precision',
      'recall',
      'failure',
    ],
  ];
  for (const scenario of report.scenarios) {
    for (const [strategy, result] of [
      ['baseline', scenario.baseline],
      ['sourceMesh', scenario.sourceMesh],
    ] as const) {
      rows.push([
        scenario.scenarioId,
        strategy,
        result.status,
        result.elapsedMs,
        result.operations,
        result.preparationOperations,
        result.filesExamined,
        result.returnedBytes,
        result.accuracy.expected,
        result.accuracy.returned,
        result.accuracy.correct,
        result.accuracy.falsePositives,
        result.accuracy.falseNegatives,
        result.accuracy.precision,
        result.accuracy.recall,
        result.failure,
      ]);
    }
  }
  return `${rows.map((row) => row.map(escapeCsv).join(',')).join('\n')}\n`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validateImportedTokenMetrics(
  value: unknown,
): asserts value is readonly ImportedTokenMetric[] {
  if (!Array.isArray(value)) throw new TypeError('token metrics');
  for (const metric of value) {
    if (
      metric === null ||
      typeof metric !== 'object' ||
      typeof metric.scenarioId !== 'string' ||
      !['baseline', 'sourceMesh'].includes(metric.mode) ||
      !['provider', 'tokenizer-estimate', 'unknown'].includes(metric.origin)
    ) {
      throw new TypeError('token metrics');
    }
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'reasoningTokens',
      'totalTokens',
      'toolCalls',
      'elapsedMs',
    ] as const) {
      if (metric[key] !== undefined && !isNonNegativeInteger(metric[key]))
        throw new TypeError('token metrics');
    }
  }
}
