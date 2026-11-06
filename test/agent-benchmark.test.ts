import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_BENCHMARK_SCHEMA_VERSION,
  aggregateAgentBenchmark,
  compareAgentMetric,
  sanitizeAgentBenchmarkReport,
  validateAgentBenchmarkExecutions,
  validateAgentBenchmarkManifest,
  type AgentBenchmarkExecution,
  type AgentBenchmarkManifest,
} from '../src/benchmarks/agent.js';

const manifest: AgentBenchmarkManifest = {
  schemaVersion: AGENT_BENCHMARK_SCHEMA_VERSION,
  id: 'private-target-evaluation',
  targetCommit: 'private-target-commit',
  model: 'codex-test',
  reasoning: 'high',
  conventionalTools: ['rg', 'file reading'],
  scenarios: [
    {
      id: 'private-listing-flow',
      category: 'feature-investigation',
      difficulty: 'medium',
      expectedChecks: ['entry point', 'pagination'],
    },
  ],
};

function execution(
  mode: AgentBenchmarkExecution['mode'],
  repetition: number,
  overrides: Partial<AgentBenchmarkExecution> = {},
): AgentBenchmarkExecution {
  return {
    scenarioId: 'private-listing-flow',
    mode,
    workflow: 'cold',
    repetition,
    model: 'codex-test',
    reasoning: 'high',
    targetCommit: 'private-target-commit',
    telemetryOrigin: 'codex-session',
    metrics: {
      inputTokens: mode === 'baseline' ? 120 : 90,
      outputTokens: 10,
      totalTokens: mode === 'baseline' ? 130 : 100,
      elapsedMs: mode === 'baseline' ? 1000 : 900,
      toolCalls: 4,
      filesRead: 3,
      informationBytes: 400,
    },
    quality: {
      expectedChecks: 2,
      satisfiedChecks: 2,
      falsePositives: 0,
      falseNegatives: 0,
      unsupportedClaims: 0,
      evidencedChecks: 2,
    },
    ...overrides,
  };
}

test('agent manifests and imports require equivalent, bounded executions', () => {
  validateAgentBenchmarkManifest(manifest);
  assert.doesNotThrow(() =>
    validateAgentBenchmarkExecutions(manifest, [
      execution('baseline', 1),
      execution('sourceMesh', 1),
    ]),
  );
  assert.throws(() =>
    validateAgentBenchmarkExecutions(manifest, [
      execution('baseline', 1),
      execution('baseline', 1),
    ]),
  );
  assert.throws(() =>
    validateAgentBenchmarkExecutions(manifest, [
      execution('baseline', 1, { targetCommit: 'different' }),
    ]),
  );
  assert.throws(() =>
    validateAgentBenchmarkExecutions(manifest, [
      execution('baseline', 1, {
        quality: {
          expectedChecks: 1,
          satisfiedChecks: 1,
          falsePositives: 0,
          falseNegatives: 0,
          unsupportedClaims: 0,
          evidencedChecks: 1,
        },
      }),
    ]),
  );
  assert.throws(() =>
    validateAgentBenchmarkManifest({ ...manifest, conventionalTools: [] }),
  );
});

test('agent aggregation preserves missing metrics and separates workflows', () => {
  const executions = [
    execution('baseline', 1),
    execution('baseline', 2, { metrics: { totalTokens: 150 } }),
    execution('sourceMesh', 1),
    execution('sourceMesh', 2, { metrics: { totalTokens: 110 } }),
    execution('baseline', 1, { workflow: 'warm' }),
    execution('sourceMesh', 1, { workflow: 'warm' }),
  ];
  const aggregates = aggregateAgentBenchmark(manifest, executions);
  assert.equal(aggregates.length, 2);
  assert.equal(aggregates[0]?.baseline.metrics.totalTokens, 140);
  assert.equal(aggregates[0]?.sourceMesh.metrics.totalTokens, 105);
  assert.equal(aggregates[0]?.baseline.metrics.inputTokens, 120);
  assert.equal(aggregates[0]?.baseline.metrics.elapsedMs, 1000);
  assert.equal(aggregates[1]?.workflow, 'warm');
});

test('agent comparison refuses an efficiency claim when quality is weaker', () => {
  const report = sanitizeAgentBenchmarkReport(manifest, [
    execution('baseline', 1),
    execution('sourceMesh', 1, {
      quality: {
        expectedChecks: 2,
        satisfiedChecks: 1,
        falsePositives: 0,
        falseNegatives: 1,
        unsupportedClaims: 0,
        evidencedChecks: 1,
      },
    }),
  ]);
  assert.equal(
    report.scenarios[0]?.comparisons.totalTokens?.classification,
    'quality-not-equivalent',
  );
  assert.equal(
    compareAgentMetric(null, 2, null, null).classification,
    'unavailable',
  );
});

test('agent public reports remove private target, scenario, and raw-session data', () => {
  const rendered = JSON.stringify(
    sanitizeAgentBenchmarkReport(manifest, [
      execution('baseline', 1),
      execution('sourceMesh', 1),
    ]),
  );
  assert.equal(rendered.includes('private-target-evaluation'), false);
  assert.equal(rendered.includes('private-target-commit'), false);
  assert.equal(rendered.includes('private-listing-flow'), false);
  assert.equal(rendered.includes('telemetryOrigin'), false);
  assert.match(rendered, /scenario-1/u);
  assert.match(rendered, /sourceMesh-lower/u);
});
