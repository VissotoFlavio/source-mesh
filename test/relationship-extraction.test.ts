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

test('indexes variable bindings for exports, local calls, and aliases', () => {
  const result = graph({
    'src/bindings.ts': `
      export const arrow = () => {};
      export const expression = function () {};
      export const Klass = class {};
      const local = () => {};
      export function invoke() { arrow(); expression(); local(); }
    `,
    'src/consumer.ts': `
      import { arrow as aliased } from './bindings.js';
      export function consume() { aliased(); }
    `,
  });
  const bindingsModule = result.nodes.find(
    (node) => node.kind === 'module' && node.path === 'src/bindings.ts',
  );
  const consumerModule = result.nodes.find(
    (node) => node.kind === 'module' && node.path === 'src/consumer.ts',
  );
  assert.ok(bindingsModule && consumerModule);
  for (const name of ['arrow', 'expression', 'Klass']) {
    const node = result.nodes.find(
      (item) =>
        item.kind === (name === 'Klass' ? 'class' : 'function') &&
        item.name === name,
    );
    assert.ok(node, `missing binding node ${name}`);
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.kind === 'exports' &&
          edge.from === bindingsModule.id &&
          edge.to === node.id,
      ),
      `missing export edge for ${name}`,
    );
  }
  const consume = result.nodes.find(
    (node) => node.kind === 'function' && node.name === 'consume',
  );
  const arrow = result.nodes.find(
    (node) => node.kind === 'function' && node.name === 'arrow',
  );
  assert.ok(consume && arrow);
  assert.ok(
    result.edges.some(
      (edge) =>
        edge.kind === 'calls' &&
        edge.from === consume.id &&
        edge.to === arrow.id,
    ),
  );
  assert.ok(consumerModule);
});

test('resolves anonymous default exports and explicit default re-exports', () => {
  const result = graph({
    'src/default-function.ts': 'export default function () {}\n',
    'src/default-class.ts': 'export default class {}\n',
    'src/reexports.ts': `
      export { default as DefaultFunction } from './default-function.js';
      export { default as DefaultClass } from './default-class.js';
    `,
  });
  const defaults = result.nodes.filter(
    (node) =>
      node.name === 'default' &&
      (node.kind === 'function' || node.kind === 'class'),
  );
  assert.equal(defaults.length, 2);
  for (const target of defaults) {
    const owner = result.nodes.find(
      (node) =>
        node.kind === 'module' &&
        target.kind !== 'repository' &&
        target.kind !== 'file' &&
        node.path === target.path,
    );
    assert.ok(owner);
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.kind === 'exports' &&
          edge.from === owner.id &&
          edge.to === target.id &&
          edge.locations?.length === 1,
      ),
    );
    const reexport = result.nodes.find(
      (node) => node.kind === 'module' && node.path === 'src/reexports.ts',
    );
    assert.ok(reexport);
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.kind === 'exports' &&
          edge.from === reexport.id &&
          edge.to === target.id &&
          edge.locations?.length === 1,
      ),
    );
  }
  assert.equal(
    result.diagnostics.some((item) => item.relationKind === 'exports'),
    false,
  );
});
