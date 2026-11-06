import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import {
  BENCHMARK_SCHEMA_VERSION,
  calculateAccuracy,
  validateBenchmarkManifest,
  type BenchmarkReport,
} from '../src/benchmarks/contracts.js';
import {
  renderCsv,
  summarizeRuns,
  validateImportedTokenMetrics,
} from '../src/benchmarks/report.js';
import { stageExternalCSharpProject } from '../src/benchmarks/external-csharp.js';
import { sanitizeExternalReport } from '../src/benchmarks/cli.js';
import { OFFICIAL_SYNTHETIC_MANIFEST } from '../src/benchmarks/scenarios.js';
import path from 'node:path';

async function fileTree(
  root: string,
  relative = '',
): Promise<readonly string[]> {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const tree: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) tree.push(...(await fileTree(root, child)));
    else if (entry.isFile()) {
      const contents = await fs.readFile(path.join(root, child));
      tree.push(
        `${child.replaceAll(path.sep, '/')}=${contents.toString('base64')}`,
      );
    }
  }
  return tree;
}

test('benchmark manifests reject duplicate scenario ids and invalid analyses', () => {
  validateBenchmarkManifest(OFFICIAL_SYNTHETIC_MANIFEST);
  assert.throws(() =>
    validateBenchmarkManifest({
      ...OFFICIAL_SYNTHETIC_MANIFEST,
      scenarios: [
        ...OFFICIAL_SYNTHETIC_MANIFEST.scenarios,
        OFFICIAL_SYNTHETIC_MANIFEST.scenarios[0],
      ],
    }),
  );
  assert.throws(() =>
    validateBenchmarkManifest({
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      id: 'invalid',
      fixture: 'fixture',
      analysis: { language: 'typescript' },
      scenarios: [],
    }),
  );
});

test('benchmark accuracy keeps partial results distinct from complete results', () => {
  assert.deepEqual(calculateAccuracy(['a', 'b'], ['a', 'unexpected']), {
    expected: 2,
    returned: 2,
    correct: 1,
    falsePositives: 1,
    falseNegatives: 1,
    precision: 0.5,
    recall: 0.5,
  });
  assert.deepEqual(calculateAccuracy(['a'], []), {
    expected: 1,
    returned: 0,
    correct: 0,
    falsePositives: 0,
    falseNegatives: 1,
    precision: null,
    recall: 0,
  });
});

test('benchmark summaries use medians and percentiles instead of only an average', () => {
  const summaries = summarizeRuns(
    [
      {
        run: 1,
        discoveryMs: 1,
        analysisAndSnapshotMs: 10,
        snapshotBytes: 100,
        mcpInitializationMs: 5,
        baselineQueryMs: [2],
        warmQueryMs: [1, 5],
      },
      {
        run: 2,
        discoveryMs: 3,
        analysisAndSnapshotMs: 30,
        snapshotBytes: 300,
        mcpInitializationMs: 7,
        baselineQueryMs: [4],
        warmQueryMs: [2, 10],
      },
    ],
    [],
  );
  assert.equal(summaries['analysisAndSnapshot.medianMs'], 20);
  assert.equal(summaries['warmQuery.medianMs'], 3.5);
  assert.equal(summaries['warmQuery.p95Ms'], 10);
});

test('token metrics require a declared source and CSV keeps failures visible', () => {
  const metrics: unknown = [
    {
      scenarioId: 'sample',
      mode: 'baseline',
      origin: 'provider',
      totalTokens: 12,
    },
  ];
  validateImportedTokenMetrics(metrics);
  assert.throws(() =>
    validateImportedTokenMetrics([
      { scenarioId: 'sample', mode: 'baseline', origin: 'made-up' },
    ]),
  );
  const report = {
    schemaVersion: 1,
    benchmark: 'test',
    generatedAt: '2026-01-01T00:00:00.000Z',
    environment: {
      node: 'v24',
      os: 'test',
      sourceMeshCommit: 'commit',
      fixtureCommit: 'commit',
    },
    manifest: { id: 'test', fixture: 'fixture', languages: ['typescript'] },
    runs: [],
    scenarioRuns: [],
    scenarios: [
      {
        scenarioId: 'sample',
        baseline: {
          elapsedMs: 1,
          preparationOperations: 0,
          operations: 1,
          filesExamined: 1,
          returnedBytes: 1,
          values: [],
          accuracy: calculateAccuracy([], []),
          status: 'failed' as const,
          failure: 'failed, safely',
        },
        sourceMesh: {
          elapsedMs: 1,
          preparationOperations: 0,
          operations: 1,
          filesExamined: 0,
          returnedBytes: 1,
          values: [],
          accuracy: calculateAccuracy([], []),
          status: 'complete' as const,
        },
      },
    ],
    summaries: {},
    tokenMetrics: [],
    limitations: [],
  } satisfies BenchmarkReport;
  assert.match(renderCsv(report), /"failed, safely"/u);
});

test('external C# staging copies only the explicit selection into a temporary root', async () => {
  const source = path.join(process.cwd(), 'test', 'fixtures', 'csharp-project');
  const before = await fileTree(source);
  await assert.rejects(
    () =>
      stageExternalCSharpProject({
        targetRoot: source,
        projects: ['../outside.csproj'],
      }),
    /path_invalid/u,
  );
  const staged = await stageExternalCSharpProject({
    targetRoot: source,
    projects: ['App.csproj'],
  });
  try {
    assert.notEqual(staged.root, source);
    assert.deepEqual(staged.projects, ['App.csproj']);
    await assert.doesNotReject(() =>
      fs.access(path.join(staged.root, 'Library.csproj')),
    );
  } finally {
    await staged.cleanup();
  }
  assert.deepEqual(await fileTree(source), before);
});

test('external C# public reports retain only sanitized aggregate data', () => {
  const report = {
    schemaVersion: 1,
    benchmark: 'SourceMesh official synthetic benchmark',
    generatedAt: '2026-01-01T00:00:00.000Z',
    environment: {
      node: 'v24',
      os: 'test',
      sourceMeshCommit: 'commit',
      fixtureCommit: 'private-fixture-commit',
    },
    manifest: {
      id: 'private-manifest',
      fixture: 'private-fixture',
      languages: ['csharp'] as const,
    },
    runs: [
      {
        run: 1,
        discoveryMs: 1,
        analysisAndSnapshotMs: 2,
        snapshotBytes: 3,
        mcpInitializationMs: 4,
        baselineQueryMs: [5],
        warmQueryMs: [6],
      },
    ],
    scenarioRuns: [],
    scenarios: [],
    summaries: { runs: 1 },
    tokenMetrics: [],
    limitations: [],
  } satisfies BenchmarkReport;
  const sanitized = JSON.stringify(sanitizeExternalReport(report));
  assert.equal(sanitized.includes('private-manifest'), false);
  assert.equal(sanitized.includes('private-fixture'), false);
  assert.equal(sanitized.includes('private-fixture-commit'), false);
  assert.equal(sanitized.includes('baselineQueryMs'), false);
  assert.equal(sanitized.includes('warmQueryMs'), false);
  assert.match(sanitized, /external-csharp-medium/u);
});
