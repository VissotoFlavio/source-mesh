import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { edgeId, extractDeclarationGraph, loadProject } from '../src/index.js';

function graph(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemesh-relations-'));
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  const loaded = loadProject({
    repositoryRoot: root,
    approvedFiles: Object.keys(files).sort(),
  });
  assert.ok(loaded.project, JSON.stringify(loaded.diagnostics));
  return extractDeclarationGraph({
    repositoryRoot: root,
    project: loaded.project,
  });
}

test('extracts local imports, exports, heritage, and direct calls deterministically', () => {
  const result = graph({
    'src/base.ts': `export interface Contract { run(): void }\nexport class Base {}`,
    'src/app.ts': `
      import { Base as Parent, Contract as Shape } from './base.js';
      export class Child extends Parent implements Shape { run() { helper(); } }
      export function helper() {}
      export { Parent as ReExport } from './base.js';
    `,
  });
  const kinds = result.edges.map((edge) => edge.kind);
  assert.ok(kinds.includes('imports'));
  assert.ok(kinds.includes('exports'));
  assert.ok(kinds.includes('extends'));
  assert.ok(kinds.includes('implements'));
  assert.ok(kinds.includes('calls'));
  assert.ok(
    result.edges.every(
      (edge) => edge.id === edgeId(edge.kind, edge.from, edge.to),
    ),
  );
  assert.deepEqual(
    result,
    graph({
      'src/base.ts': `export interface Contract { run(): void }\nexport class Base {}`,
      'src/app.ts': `
      import { Base as Parent, Contract as Shape } from './base.js';
      export class Child extends Parent implements Shape { run() { helper(); } }
      export function helper() {}
      export { Parent as ReExport } from './base.js';
    `,
    }),
  );
});

test('does not fabricate external or dynamic relationships', () => {
  const result = graph({
    'src/app.ts': `import fs from 'node:fs'; export function run(name: string) { require(name); return registry[name](); } const registry = {};`,
  });
  assert.equal(
    result.edges.some((edge) => edge.kind === 'imports'),
    false,
  );
  assert.equal(
    result.edges.some((edge) => edge.kind === 'calls'),
    false,
  );
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.code === 'relationship_external' ||
        item.code === 'relationship_dynamic',
    ),
  );
  assert.ok(
    result.diagnostics.every((item) => !item.message.includes('node:')),
  );
});
