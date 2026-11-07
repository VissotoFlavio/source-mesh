import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOKEN_BENCHMARK_MANIFEST_VERSION,
  TOKEN_BENCHMARK_SCHEMA_VERSION,
  validateTokenBenchmarkManifest,
} from '../src/benchmarks/token-consumption/contracts.js';
import {
  TOKEN_BENCHMARK_MANIFEST,
  TOKEN_TYPESCRIPT_BENCHMARK_MANIFEST,
} from '../src/benchmarks/token-consumption/manifests.js';

test('token benchmark manifest freezes the C# declaration, four callers, and direct calls', () => {
  validateTokenBenchmarkManifest(TOKEN_BENCHMARK_MANIFEST);
  assert.equal(
    TOKEN_BENCHMARK_MANIFEST.schemaVersion,
    TOKEN_BENCHMARK_SCHEMA_VERSION,
  );
  assert.equal(
    TOKEN_BENCHMARK_MANIFEST.manifestVersion,
    TOKEN_BENCHMARK_MANIFEST_VERSION,
  );
  const scenario = TOKEN_BENCHMARK_MANIFEST.scenarios[0];
  assert.ok(scenario);
  assert.equal(scenario.language, 'csharp');
  assert.equal(scenario.prompts.length, 3);
  assert.equal(
    scenario.groundTruth.filter((fact) => fact.kind === 'direct-caller').length,
    4,
  );
  assert.deepEqual(
    scenario.groundTruth
      .filter((fact) => fact.kind === 'direct-call')
      .map((fact) => fact.id),
    ['callee-cancellation', 'callee-map', 'callee-normalize'],
  );
  assert.equal(
    scenario.prompts.every((prompt) => prompt.text.length > 0),
    true,
  );
});

test('token benchmark validation rejects ambiguous or unsafe contracts', () => {
  assert.throws(() =>
    validateTokenBenchmarkManifest({
      ...TOKEN_BENCHMARK_MANIFEST,
      tokenizer: {
        ...TOKEN_BENCHMARK_MANIFEST.tokenizer,
        defaultEncoding: 'unsupported',
      },
    }),
  );
  assert.throws(() =>
    validateTokenBenchmarkManifest({
      ...TOKEN_BENCHMARK_MANIFEST,
      snapshot: {
        ...TOKEN_BENCHMARK_MANIFEST.snapshot,
        verification: 'partial',
      },
    }),
  );
  assert.throws(() =>
    validateTokenBenchmarkManifest({
      ...TOKEN_BENCHMARK_MANIFEST,
      scenarios: [
        ...TOKEN_BENCHMARK_MANIFEST.scenarios,
        TOKEN_BENCHMARK_MANIFEST.scenarios[0],
      ],
    }),
  );
  assert.throws(() =>
    validateTokenBenchmarkManifest({
      ...TOKEN_BENCHMARK_MANIFEST,
      qualityGate: {
        ...TOKEN_BENCHMARK_MANIFEST.qualityGate,
        allowPartialForSavings: true,
      },
    }),
  );
});

test('token benchmark also freezes an independent TypeScript fixture scenario', () => {
  validateTokenBenchmarkManifest(TOKEN_TYPESCRIPT_BENCHMARK_MANIFEST);
  assert.equal(
    TOKEN_TYPESCRIPT_BENCHMARK_MANIFEST.scenarios[0]?.language,
    'typescript',
  );
  assert.equal(
    TOKEN_TYPESCRIPT_BENCHMARK_MANIFEST.scenarios[0]?.groundTruth.length,
    2,
  );
});
