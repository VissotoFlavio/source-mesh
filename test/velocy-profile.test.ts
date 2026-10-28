import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  runVelocyLocalAcceptance,
  VelocyAcceptanceError,
  VELOCY_SOLUTION_PATH,
  VELOCY_SNAPSHOT_PATH,
} from '../src/csharp/velocy-profile.js';
import type { CSharpManifest } from '../src/csharp/contracts.js';
import type { CSharpWorkerResult } from '../src/csharp/worker.js';
import type { SnapshotV2 } from '../src/snapshot/types.js';

const snapshot: SnapshotV2 = {
  schemaVersion: 2,
  completeness: 'complete',
  repository: { root: '.', name: 'repository' },
  nodes: [],
  edges: [],
  diagnostics: [],
};

const manifest: CSharpManifest = {
  language: 'csharp',
  selection: { kind: 'solution', path: VELOCY_SOLUTION_PATH },
  solution: { path: VELOCY_SOLUTION_PATH, projects: ['src/App.csproj'] },
  projects: [
    {
      path: 'src/App.csproj',
      references: [],
      files: ['src/App.cs', 'src/Other.cs'],
    },
  ],
};

const worker: CSharpWorkerResult = { projects: [], diagnostics: [] };

async function rootFixture(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sourcemesh-velocy-profile-'));
}

test('Velocy profile is a no-op without an explicit root', async () => {
  const result = await runVelocyLocalAcceptance(undefined, false, {
    discoverCSharpManifest: async () => {
      throw new Error('must not inspect a root');
    },
    analyzeCSharpManifest: async () => worker,
    extractCSharpDeclarationGraph: () => snapshot,
    writeSnapshot: async () => ({ path: '', digest: '', bytes: 0 }),
  });
  assert.deepEqual(result, { status: 'skipped' });
});

test('Velocy profile fails closed for missing roots and missing confirmation', async () => {
  await assert.rejects(
    runVelocyLocalAcceptance(
      path.join(os.tmpdir(), 'sourcemesh-velocy-profile-missing'),
      true,
    ),
    (error: unknown) =>
      error instanceof VelocyAcceptanceError && error.code === 'root_missing',
  );

  const root = await rootFixture();
  try {
    await assert.rejects(
      runVelocyLocalAcceptance(root, false),
      (error: unknown) =>
        error instanceof VelocyAcceptanceError &&
        error.code === 'confirmation_required',
    );

    const file = path.join(root, 'not-a-root');
    await fs.writeFile(file, 'not a directory');
    await assert.rejects(
      runVelocyLocalAcceptance(file, true),
      (error: unknown) =>
        error instanceof VelocyAcceptanceError &&
        error.code === 'root_not_directory',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Velocy profile reports sanitized preflight codes', async () => {
  const root = await rootFixture();
  try {
    await assert.rejects(
      runVelocyLocalAcceptance(root, true, {
        discoverCSharpManifest: async () => ({
          diagnostics: [
            {
              code: 'unsupported_construct' as const,
              severity: 'error' as const,
              message: 'untrusted detail must not escape',
              path: 'private.csproj',
            },
          ],
        }),
        analyzeCSharpManifest: async () => worker,
        extractCSharpDeclarationGraph: () => snapshot,
        writeSnapshot: async () => ({ path: '', digest: '', bytes: 0 }),
      }),
      (error: unknown) =>
        error instanceof VelocyAcceptanceError &&
        error.code === 'preflight_failed' &&
        error.detailCodes.length === 1 &&
        error.detailCodes[0] === 'unsupported_construct',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Velocy profile writes only its contained create-only snapshot and summarizes aggregates', async () => {
  const root = await rootFixture();
  const writes: { root: string; path: string }[] = [];
  try {
    const result = await runVelocyLocalAcceptance(root, true, {
      discoverCSharpManifest: async (selectedRoot, selection) => {
        assert.equal(selectedRoot, root);
        assert.deepEqual(selection, { solution: VELOCY_SOLUTION_PATH });
        return { manifest, diagnostics: [] };
      },
      analyzeCSharpManifest: async (
        selectedRoot,
        selectedManifest,
        options,
      ) => {
        assert.equal(selectedRoot, root);
        assert.equal(selectedManifest, manifest);
        assert.deepEqual(options, {
          sourceEncoding: 'windows-1252',
          maxDiagnostics: 100_000,
        });
        return worker;
      },
      extractCSharpDeclarationGraph: ({ repositoryRoot, manifest: value }) => {
        assert.equal(repositoryRoot, root);
        assert.equal(value, manifest);
        return snapshot;
      },
      writeSnapshot: async (selectedRoot, value, options) => {
        assert.equal(selectedRoot, root);
        assert.equal(value, snapshot);
        writes.push({
          root: selectedRoot,
          path: options.path,
        });
        return { path: VELOCY_SNAPSHOT_PATH, digest: 'ignored', bytes: 12 };
      },
    });

    assert.deepEqual(result, {
      status: 'completed',
      schemaVersion: 2,
      completeness: 'complete',
      projects: 1,
      files: 2,
      nodes: 0,
      edges: 0,
      diagnostics: 0,
      diagnosticCodes: [],
    });
    assert.deepEqual(writes, [{ root, path: VELOCY_SNAPSHOT_PATH }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
