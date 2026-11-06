export const AGENT_BENCHMARK_SCHEMA_VERSION = 1 as const;

export type AgentBenchmarkMode = 'baseline' | 'sourceMesh';
export type AgentBenchmarkWorkflow = 'cold' | 'warm';
export type AgentTelemetryOrigin =
  'codex-otel' | 'codex-session' | 'provider-export';

export interface AgentBenchmarkScenario {
  readonly id: string;
  readonly category:
    | 'feature-investigation'
    | 'implementation-location'
    | 'caller-analysis'
    | 'impact-analysis'
    | 'flow-investigation';
  readonly difficulty: 'simple' | 'medium' | 'complex';
  readonly expectedChecks: readonly string[];
}

export interface AgentBenchmarkManifest {
  readonly schemaVersion: typeof AGENT_BENCHMARK_SCHEMA_VERSION;
  readonly id: string;
  readonly targetCommit: string;
  readonly model: string;
  readonly reasoning: string | null;
  readonly conventionalTools: readonly string[];
  readonly scenarios: readonly AgentBenchmarkScenario[];
}

export interface AgentUsageMetrics {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly elapsedMs?: number;
  readonly toolCalls?: number;
  readonly filesRead?: number;
  readonly informationBytes?: number;
}

export interface AgentQualityMetrics {
  readonly expectedChecks: number;
  readonly satisfiedChecks: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly unsupportedClaims: number;
  readonly evidencedChecks: number;
}

/** One independently completed session. It deliberately has no fields for
 * prompts, answers, paths, source code, raw traces, or credentials. */
export interface AgentBenchmarkExecution {
  readonly scenarioId: string;
  readonly mode: AgentBenchmarkMode;
  readonly workflow: AgentBenchmarkWorkflow;
  readonly repetition: number;
  readonly model: string;
  readonly reasoning: string | null;
  readonly targetCommit: string;
  readonly telemetryOrigin: AgentTelemetryOrigin;
  readonly metrics: AgentUsageMetrics;
  readonly quality?: AgentQualityMetrics;
}

export interface AggregatedAgentMetrics {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly elapsedMs: number | null;
  readonly toolCalls: number | null;
  readonly filesRead: number | null;
  readonly informationBytes: number | null;
}

export interface AggregatedAgentQuality extends AgentQualityMetrics {
  readonly available: true;
}

export interface AgentModeAggregate {
  readonly executions: number;
  readonly metrics: AggregatedAgentMetrics;
  readonly quality: AggregatedAgentQuality | null;
}

export interface AgentScenarioAggregate {
  readonly scenarioId: string;
  readonly workflow: AgentBenchmarkWorkflow;
  readonly baseline: AgentModeAggregate;
  readonly sourceMesh: AgentModeAggregate;
}

export type AgentComparisonClassification =
  | 'unavailable'
  | 'quality-not-equivalent'
  | 'sourceMesh-lower'
  | 'equal'
  | 'sourceMesh-higher';

export interface AgentMetricComparison {
  readonly baseline: number | null;
  readonly sourceMesh: number | null;
  readonly difference: number | null;
  readonly percentSavings: number | null;
  readonly classification: AgentComparisonClassification;
}

const metricKeys = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'totalTokens',
  'elapsedMs',
  'toolCalls',
  'filesRead',
  'informationBytes',
] as const;
const qualityKeys = [
  'expectedChecks',
  'satisfiedChecks',
  'falsePositives',
  'falseNegatives',
  'unsupportedClaims',
  'evidencedChecks',
] as const;

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

export function validateAgentBenchmarkManifest(
  value: unknown,
): asserts value is AgentBenchmarkManifest {
  if (value === null || typeof value !== 'object')
    throw new TypeError('manifest');
  const manifest = value as Partial<AgentBenchmarkManifest>;
  if (
    manifest.schemaVersion !== AGENT_BENCHMARK_SCHEMA_VERSION ||
    !nonEmptyText(manifest.id) ||
    !nonEmptyText(manifest.targetCommit) ||
    !nonEmptyText(manifest.model) ||
    (manifest.reasoning !== null && !nonEmptyText(manifest.reasoning)) ||
    !Array.isArray(manifest.conventionalTools) ||
    manifest.conventionalTools.length === 0 ||
    !manifest.conventionalTools.every(nonEmptyText) ||
    !Array.isArray(manifest.scenarios) ||
    manifest.scenarios.length === 0
  )
    throw new TypeError('manifest');
  const ids = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (
      scenario === null ||
      typeof scenario !== 'object' ||
      !nonEmptyText(scenario.id) ||
      ids.has(scenario.id) ||
      ![
        'feature-investigation',
        'implementation-location',
        'caller-analysis',
        'impact-analysis',
        'flow-investigation',
      ].includes(scenario.category) ||
      !['simple', 'medium', 'complex'].includes(scenario.difficulty) ||
      !Array.isArray(scenario.expectedChecks) ||
      scenario.expectedChecks.length === 0 ||
      !scenario.expectedChecks.every(nonEmptyText)
    )
      throw new TypeError('manifest');
    ids.add(scenario.id);
  }
}

export function validateAgentBenchmarkExecutions(
  manifest: AgentBenchmarkManifest,
  value: unknown,
): asserts value is readonly AgentBenchmarkExecution[] {
  validateAgentBenchmarkManifest(manifest);
  if (!Array.isArray(value)) throw new TypeError('agent executions');
  const scenarioIds = new Set(
    manifest.scenarios.map((scenario) => scenario.id),
  );
  const expectedCheckCounts = new Map(
    manifest.scenarios.map((scenario) => [
      scenario.id,
      scenario.expectedChecks.length,
    ]),
  );
  const seen = new Set<string>();
  for (const execution of value) {
    if (execution === null || typeof execution !== 'object')
      throw new TypeError('agent executions');
    const item = execution as Partial<AgentBenchmarkExecution>;
    if (
      !nonEmptyText(item.scenarioId) ||
      !scenarioIds.has(item.scenarioId) ||
      (item.mode !== 'baseline' && item.mode !== 'sourceMesh') ||
      (item.workflow !== 'cold' && item.workflow !== 'warm') ||
      !nonNegativeInteger(item.repetition) ||
      item.repetition < 1 ||
      item.model !== manifest.model ||
      item.reasoning !== manifest.reasoning ||
      item.targetCommit !== manifest.targetCommit ||
      (item.telemetryOrigin !== 'codex-otel' &&
        item.telemetryOrigin !== 'codex-session' &&
        item.telemetryOrigin !== 'provider-export') ||
      item.metrics === null ||
      typeof item.metrics !== 'object'
    )
      throw new TypeError('agent executions');
    const key = `${item.scenarioId}\u0000${item.mode}\u0000${item.workflow}\u0000${item.repetition}`;
    if (seen.has(key)) throw new TypeError('agent executions');
    seen.add(key);
    for (const name of metricKeys) {
      const metric = (item.metrics as Record<string, unknown>)[name];
      if (metric !== undefined && !nonNegativeInteger(metric))
        throw new TypeError('agent executions');
    }
    if (item.quality !== undefined) {
      if (item.quality === null || typeof item.quality !== 'object')
        throw new TypeError('agent executions');
      for (const name of qualityKeys)
        if (
          !nonNegativeInteger(
            (item.quality as unknown as Record<string, unknown>)[name],
          )
        )
          throw new TypeError('agent executions');
      if (
        item.quality.expectedChecks !==
          expectedCheckCounts.get(item.scenarioId) ||
        item.quality.satisfiedChecks > item.quality.expectedChecks ||
        item.quality.evidencedChecks > item.quality.satisfiedChecks
      )
        throw new TypeError('agent executions');
    }
  }
}

function aggregateMetrics(
  executions: readonly AgentBenchmarkExecution[],
): AggregatedAgentMetrics {
  return Object.fromEntries(
    metricKeys.map((key) => [
      key,
      median(
        executions.flatMap((execution) => {
          const value = execution.metrics[key];
          return value === undefined ? [] : [value];
        }),
      ),
    ]),
  ) as unknown as AggregatedAgentMetrics;
}

function aggregateQuality(
  executions: readonly AgentBenchmarkExecution[],
): AggregatedAgentQuality | null {
  if (
    executions.length === 0 ||
    executions.some((execution) => execution.quality === undefined)
  )
    return null;
  const values = executions.flatMap((execution) =>
    execution.quality === undefined ? [] : [execution.quality],
  );
  if (values.length === 0) return null;
  return {
    available: true,
    expectedChecks: median(values.map((value) => value.expectedChecks)) ?? 0,
    satisfiedChecks: median(values.map((value) => value.satisfiedChecks)) ?? 0,
    falsePositives: median(values.map((value) => value.falsePositives)) ?? 0,
    falseNegatives: median(values.map((value) => value.falseNegatives)) ?? 0,
    unsupportedClaims:
      median(values.map((value) => value.unsupportedClaims)) ?? 0,
    evidencedChecks: median(values.map((value) => value.evidencedChecks)) ?? 0,
  };
}
function aggregateMode(
  executions: readonly AgentBenchmarkExecution[],
): AgentModeAggregate {
  return {
    executions: executions.length,
    metrics: aggregateMetrics(executions),
    quality: aggregateQuality(executions),
  };
}

export function aggregateAgentBenchmark(
  manifest: AgentBenchmarkManifest,
  executions: readonly AgentBenchmarkExecution[],
): readonly AgentScenarioAggregate[] {
  validateAgentBenchmarkExecutions(manifest, executions);
  return manifest.scenarios.flatMap((scenario) =>
    (['cold', 'warm'] as const).flatMap((workflow) => {
      const matches = executions.filter(
        (item) => item.scenarioId === scenario.id && item.workflow === workflow,
      );
      if (matches.length === 0) return [];
      return [
        {
          scenarioId: scenario.id,
          workflow,
          baseline: aggregateMode(
            matches.filter((item) => item.mode === 'baseline'),
          ),
          sourceMesh: aggregateMode(
            matches.filter((item) => item.mode === 'sourceMesh'),
          ),
        },
      ];
    }),
  );
}

function qualityEquivalent(
  baseline: AggregatedAgentQuality | null,
  sourceMesh: AggregatedAgentQuality | null,
): boolean {
  return (
    baseline !== null &&
    sourceMesh !== null &&
    sourceMesh.expectedChecks === baseline.expectedChecks &&
    sourceMesh.satisfiedChecks >= baseline.satisfiedChecks &&
    sourceMesh.evidencedChecks >= baseline.evidencedChecks &&
    sourceMesh.falsePositives <= baseline.falsePositives &&
    sourceMesh.falseNegatives <= baseline.falseNegatives &&
    sourceMesh.unsupportedClaims <= baseline.unsupportedClaims
  );
}

export function compareAgentMetric(
  baseline: number | null,
  sourceMesh: number | null,
  baselineQuality: AggregatedAgentQuality | null,
  sourceMeshQuality: AggregatedAgentQuality | null,
): AgentMetricComparison {
  if (baseline === null || sourceMesh === null)
    return {
      baseline,
      sourceMesh,
      difference: null,
      percentSavings: null,
      classification: 'unavailable',
    };
  const difference = sourceMesh - baseline;
  const percentSavings =
    baseline === 0 ? null : ((baseline - sourceMesh) / baseline) * 100;
  if (!qualityEquivalent(baselineQuality, sourceMeshQuality))
    return {
      baseline,
      sourceMesh,
      difference,
      percentSavings,
      classification: 'quality-not-equivalent',
    };
  return {
    baseline,
    sourceMesh,
    difference,
    percentSavings,
    classification:
      difference < 0
        ? 'sourceMesh-lower'
        : difference > 0
          ? 'sourceMesh-higher'
          : 'equal',
  };
}

/** Removes target identifiers, prompts, answers, paths, raw traces and individual runs. */
export function sanitizeAgentBenchmarkReport(
  manifest: AgentBenchmarkManifest,
  executions: readonly AgentBenchmarkExecution[],
) {
  const indexes = new Map(
    manifest.scenarios.map((scenario, index) => [scenario.id, index + 1]),
  );
  return {
    schemaVersion: AGENT_BENCHMARK_SCHEMA_VERSION,
    benchmark: 'SourceMesh AI agent A/B benchmark',
    configuration: {
      model: manifest.model,
      reasoning: manifest.reasoning,
      conventionalTools: manifest.conventionalTools,
    },
    scenarios: aggregateAgentBenchmark(manifest, executions).map(
      (aggregate) => ({
        scenarioId: `scenario-${indexes.get(aggregate.scenarioId)}`,
        workflow: aggregate.workflow,
        baseline: aggregate.baseline,
        sourceMesh: aggregate.sourceMesh,
        comparisons: Object.fromEntries(
          metricKeys.map((key) => [
            key,
            compareAgentMetric(
              aggregate.baseline.metrics[key],
              aggregate.sourceMesh.metrics[key],
              aggregate.baseline.quality,
              aggregate.sourceMesh.quality,
            ),
          ]),
        ),
      }),
    ),
    limitations: [
      'Metrics are imported observations; unavailable values remain unavailable.',
      'A lower metric is not classified as an improvement unless aggregate quality is equivalent or better.',
      'Cold workflow includes SourceMesh preparation; warm workflow excludes preparation only when an existing snapshot and MCP process are stated.',
    ],
  };
}
