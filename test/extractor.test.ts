import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractDeclarationGraph, loadProject, repositoryId } from '../src/index.js';

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemesh-extractor-'));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  const loaded = loadProject({ repositoryRoot: root, approvedFiles: Object.keys(files).sort() });
  assert.ok(loaded.project, JSON.stringify(loaded.diagnostics));
  return { root, loaded: loaded.project };
}

test('extracts the closed declaration set with direct containment only', () => {
  const { root, loaded } = project({
    'src/index.ts': `
      export interface User { id: string; save(value: string): void; }
      export class Service { static create(value: string) { return value; } run(value: string) { return value; } }
      export function work(value: string): string { return value; }
      export const arrow = (value: string) => value;
      export type Name = string;
      export namespace Api { export function list(value: number) { return value; } }
    `,
    'src/other.js': 'export class Other { method(value) { return value; } }\n',
  });
  const graph = extractDeclarationGraph({ repositoryRoot: root, project: loaded });
  assert.equal(graph.repository.name, 'repository');
  assert.equal(graph.repository.root, '.');
  assert.ok(graph.nodes.some((node) => node.kind === 'interface' && node.name === 'User'));
  assert.ok(graph.nodes.some((node) => node.kind === 'class' && node.name === 'Service'));
  assert.ok(graph.nodes.some((node) => node.kind === 'type' && node.name === 'Name'));
  assert.ok(graph.nodes.some((node) => node.kind === 'parameter' && node.name === 'value'));
  assert.ok(graph.nodes.some((node) => node.kind === 'module' && node.name === 'Api'));
  assert.ok(graph.nodes.some((node) => node.kind === 'function' && node.name === 'create' && node.memberRole === 'static'));
  assert.ok(graph.nodes.some((node) => node.kind === 'function' && node.name === 'run' && node.memberRole === 'instance'));
  assert.ok(graph.nodes.every((node) => !JSON.stringify(node).includes(root)));
  assert.ok(graph.nodes.every((node) => !JSON.stringify(node).includes('export interface')));
  assert.ok(graph.edges.every((edge) => edge.kind === 'contains'));
  assert.equal(graph.nodes.filter((node) => node.kind === 'file').length, 2);
  assert.equal(graph.nodes.filter((node) => node.kind === 'module').length, 3);
  assert.equal(graph.repository.id, repositoryId());
});

test('identity and ordering are independent of approved root order and comments', () => {
  const first = project({ 'src/a.ts': 'export function run(value: string) { return value; }\n', 'src/b.ts': 'export const value = 1;\n' });
  const second = loadProject({ repositoryRoot: first.root, approvedFiles: ['src/b.ts', 'src/a.ts'] });
  assert.ok(second.project);
  const left = extractDeclarationGraph({ repositoryRoot: first.root, project: first.loaded });
  const right = extractDeclarationGraph({ repositoryRoot: first.root, project: { ...second.project, rootNames: [...second.project.rootNames].reverse() } });
  assert.deepEqual(left, right);
  assert.ok(left.nodes.every((node) => !('parent' in node) && !('container' in node)));
  assert.ok(left.nodes.every((node) => !JSON.stringify(node).match(/[A-Z]:\\|\\\\/u)));
});
