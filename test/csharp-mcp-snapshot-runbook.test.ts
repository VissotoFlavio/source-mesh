import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const runbook = new URL(
  '../docs/csharp-mcp-snapshot-runbook.md',
  import.meta.url,
);

test('C# MCP snapshot runbook documents the bounded generic and Velocy flows', async () => {
  const content = await readFile(runbook, 'utf8');

  assert.match(
    content,
    /it does not run C# analysis, create a\s+snapshot, or replace one/u,
  );
  assert.match(
    content,
    /--language csharp --solution <relative-solution-path> --snapshot \.sourcemesh\/graph\.json/u,
  );
  assert.match(
    content,
    /--language csharp --project <relative-project-path> --snapshot \.sourcemesh\/graph\.json/u,
  );
  assert.match(content, /exactly one repository-relative selector/u);
  assert.match(content, /Analysis is create-only by default/u);
  assert.match(content, /same repository root and snapshot path/u);
  assert.match(content, /UTF-8 is the normal source policy/u);
  assert.match(content, /it is not an automatic fallback/u);
  assert.match(content, /maximum of 4096 compiler diagnostics/u);
  assert.match(content, /from `1` to\n`100000`/u);
  assert.match(
    content,
    /--solution src\/Velocy\.API\.sln --snapshot \.sourcemesh\/graph\.json --source-encoding windows-1252 --max-diagnostics 100000/u,
  );
  assert.equal(/[A-Za-z]:[\\/]/u.test(content), false);
  assert.equal(content.includes('E2E_SOURCE_TEXT_MARKER'), false);
  assert.equal(content.includes('E2E_SECRET_VALUE_MARKER'), false);
});
