import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const runbook = new URL(
  '../docs/csharp-mcp-snapshot-runbook.md',
  import.meta.url,
);
const packageGuide = new URL(
  '../docs/csharp-mcp-snapshot-package-guide.md',
  import.meta.url,
);

test('C# MCP snapshot runbook documents the bounded generic flow', async () => {
  const content = await readFile(runbook, 'utf8');

  assert.match(
    content,
    /does not run C# analysis, create a snapshot, or replace one/u,
  );
  assert.match(
    content,
    /--language csharp --solution <relative-solution-path> --snapshot-id csharp-<run-id>/u,
  );
  assert.match(
    content,
    /--language csharp --project <relative-project-path> --snapshot-id csharp-<run-id>/u,
  );
  assert.match(content, /exactly one repository-relative selector/u);
  assert.match(content, /Creation is create-only/u);
  assert.match(content, /same repository root and snapshot path/u);
  assert.match(content, /UTF-8 is the normal source policy/u);
  assert.match(content, /it is not an automatic fallback/u);
  assert.match(content, /maximum of 4096\s+compiler diagnostics/u);
  assert.match(content, /from `1` to `100000`/u);
  assert.equal(/[A-Za-z]:[\\/]/u.test(content), false);
  assert.equal(content.includes('E2E_SOURCE_TEXT_MARKER'), false);
  assert.equal(content.includes('E2E_SECRET_VALUE_MARKER'), false);
});

test('installed C# MCP snapshot guide gives a generic user and AI-host flow', async () => {
  const content = await readFile(packageGuide, 'utf8');

  assert.match(content, /never analyzes a\s+repository or creates a snapshot/u);
  assert.match(
    content,
    /--language csharp --solution <relative-solution-path> --snapshot-id csharp-<run-id>/u,
  );
  assert.match(
    content,
    /--language csharp --project <relative-project-path> --snapshot-id csharp-<run-id>/u,
  );
  assert.match(content, /exactly one repository-relative selector/u);
  assert.match(content, /Creation is create-only/u);
  assert.match(content, /UTF-8 is the normal source policy/u);
  assert.match(content, /maximum of 4096\s+compiler diagnostics/u);
  assert.match(content, /from `1` to `100000`/u);
  assert.match(content, /npm install --global --ignore-scripts/u);
  assert.match(content, /npm uninstall --global/u);
  assert.match(content, /"command": "<absolute-node-path>"/u);
  assert.match(content, /sourcemesh analyze/u);
  assert.equal(/[A-Za-z]:[\\/]/u.test(content), false);
  assert.equal(content.includes('E2E_SOURCE_TEXT_MARKER'), false);
  assert.equal(content.includes('E2E_SECRET_VALUE_MARKER'), false);
});
