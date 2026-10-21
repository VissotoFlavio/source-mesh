import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject } from '../src/project-loader.js';

test('loader executes successfully inside the offline boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemesh-offline-'));
  const sourcePath = path.join(root, 'source.ts');
  fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');

  try {
    const result = loadProject({
      repositoryRoot: root,
      approvedFiles: ['source.ts'],
    });
    assert.ok(result.project);
    assert.deepEqual(result.project.rootNames, ['source.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
