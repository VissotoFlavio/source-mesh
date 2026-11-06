export const BENCHMARK_SCHEMA_VERSION = 1 as const;

export type BenchmarkLanguage = 'typescript' | 'csharp';
export type BenchmarkCategory =
  'symbol-discovery' | 'call-relationships' | 'file-dependencies';
export type BenchmarkStrategy =
  | 'search-symbol'
  | 'list-callers'
  | 'list-file-dependencies'
  | 'list-file-dependents';

export interface ExpectedResult {
  readonly values: readonly string[];
  readonly knownLimitations?: readonly string[];
}

export interface BenchmarkScenario {
  readonly id: string;
  readonly language: BenchmarkLanguage;
  readonly category: BenchmarkCategory;
  readonly question: string;
  readonly strategy: BenchmarkStrategy;
  readonly target: string;
  readonly kind?: 'class' | 'interface' | 'function';
  readonly qualifiedName?: string;
  readonly expected: ExpectedResult;
}

export interface BenchmarkManifest {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly id: string;
  readonly fixture: string;
  readonly analysis:
    | { readonly language: 'typescript'; readonly tsconfig: string }
    | {
        readonly language: 'csharp';
        readonly solution?: string;
        readonly projects?: readonly string[];
      };
  readonly scenarios: readonly BenchmarkScenario[];
}

export interface AccuracyMetrics {
  readonly expected: number;
  readonly returned: number;
  readonly correct: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number | null;
  readonly recall: number | null;
}

export interface OperationMetrics {
  readonly elapsedMs: number;
  readonly preparationOperations: number;
  readonly operations: number;
  readonly filesExamined: number;
  readonly returnedBytes: number;
}

export interface StrategyResult extends OperationMetrics {
  readonly values: readonly string[];
  readonly accuracy: AccuracyMetrics;
  readonly status: 'complete' | 'partial' | 'failed';
  readonly failure?: string;
}

export interface ScenarioRun {
  readonly scenarioId: string;
  readonly baseline: StrategyResult;
  readonly sourceMesh: StrategyResult;
}

export interface TimingSample {
  readonly run: number;
  readonly discoveryMs: number;
  readonly analysisAndSnapshotMs: number;
  readonly snapshotBytes: number;
  readonly mcpInitializationMs: number;
  readonly baselineQueryMs: readonly number[];
  readonly warmQueryMs: readonly number[];
}

export type TokenMetricOrigin = 'provider' | 'tokenizer-estimate' | 'unknown';

export interface ImportedTokenMetric {
  readonly scenarioId: string;
  readonly mode: 'baseline' | 'sourceMesh';
  readonly origin: TokenMetricOrigin;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly toolCalls?: number;
  readonly elapsedMs?: number;
}

export interface BenchmarkEnvironment {
  readonly node: string;
  readonly os: string;
  readonly sourceMeshCommit: string;
  readonly fixtureCommit: string;
}

export interface BenchmarkReport {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly benchmark: string;
  readonly generatedAt: string;
  readonly environment: BenchmarkEnvironment;
  readonly manifest: {
    readonly id: string;
    readonly fixture: string;
    readonly languages: readonly BenchmarkLanguage[];
  };
  readonly runs: readonly TimingSample[];
  readonly scenarioRuns: readonly (readonly ScenarioRun[])[];
  readonly scenarios: readonly ScenarioRun[];
  readonly summaries: Readonly<Record<string, number>>;
  readonly tokenMetrics: readonly ImportedTokenMetric[];
  readonly limitations: readonly string[];
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function validateBenchmarkManifest(
  value: unknown,
): asserts value is BenchmarkManifest {
  if (value === null || typeof value !== 'object')
    throw new TypeError('manifest');
  const manifest = value as Partial<BenchmarkManifest>;
  if (
    manifest.schemaVersion !== BENCHMARK_SCHEMA_VERSION ||
    !nonEmptyText(manifest.id)
  )
    throw new TypeError('manifest');
  if (
    !nonEmptyText(manifest.fixture) ||
    manifest.analysis === undefined ||
    !Array.isArray(manifest.scenarios)
  )
    throw new TypeError('manifest');
  if (!(
    (manifest.analysis.language === 'typescript' &&
      nonEmptyText(manifest.analysis.tsconfig)) ||
      (manifest.analysis.language === 'csharp' &&
        ((manifest.analysis.solution !== undefined &&
          nonEmptyText(manifest.analysis.solution) &&
          manifest.analysis.projects === undefined) ||
          (manifest.analysis.projects !== undefined &&
            manifest.analysis.projects.length > 0 &&
            manifest.analysis.projects.every(nonEmptyText) &&
            manifest.analysis.solution === undefined)))
  ))
    throw new TypeError('manifest');
  const ids = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (
      scenario === null ||
      typeof scenario !== 'object' ||
      !nonEmptyText(scenario.id) ||
      ids.has(scenario.id) ||
      !['typescript', 'csharp'].includes(scenario.language) ||
      !['symbol-discovery', 'call-relationships', 'file-dependencies'].includes(
        scenario.category,
      ) ||
      ![
        'search-symbol',
        'list-callers',
        'list-file-dependencies',
        'list-file-dependents',
      ].includes(scenario.strategy) ||
      !nonEmptyText(scenario.question) ||
      !nonEmptyText(scenario.target) ||
      (scenario.kind !== undefined &&
        !['class', 'interface', 'function'].includes(scenario.kind)) ||
      (scenario.qualifiedName !== undefined &&
        !nonEmptyText(scenario.qualifiedName)) ||
      scenario.expected === null ||
      typeof scenario.expected !== 'object' ||
      !Array.isArray(scenario.expected.values) ||
      !scenario.expected.values.every(nonEmptyText)
    ) {
      throw new TypeError('manifest');
    }
    ids.add(scenario.id);
  }
}

export function calculateAccuracy(
  expectedValues: readonly string[],
  actualValues: readonly string[],
): AccuracyMetrics {
  const expected = new Set(expectedValues);
  const actual = new Set(actualValues);
  const correct = [...actual].filter((value) => expected.has(value)).length;
  const falsePositives = [...actual].filter(
    (value) => !expected.has(value),
  ).length;
  const falseNegatives = [...expected].filter(
    (value) => !actual.has(value),
  ).length;
  return {
    expected: expected.size,
    returned: actual.size,
    correct,
    falsePositives,
    falseNegatives,
    precision: actual.size === 0 ? null : correct / actual.size,
    recall: expected.size === 0 ? null : correct / expected.size,
  };
}
