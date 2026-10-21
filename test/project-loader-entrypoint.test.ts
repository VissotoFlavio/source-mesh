import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, PROJECT_LOADER_FALLBACK_OPTIONS } from '../src/index.js';
import type { LoadProjectResult } from '../src/index.js';

test('package entrypoint exports the stable project loader contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemesh-entrypoint-'));
  const sourcePath = path.join(root, 'source.ts');
  fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');

  try {
    const result: LoadProjectResult = loadProject({
      repositoryRoot: root,
      approvedFiles: ['source.ts'],
    });

    assert.ok(result.project);
    assert.equal(result.project.options, PROJECT_LOADER_FALLBACK_OPTIONS);
    assert.deepEqual(result.project.rootNames, ['source.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
