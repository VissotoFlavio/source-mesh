import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSnapshot,
  encodeSnapshot,
  openValidatedSnapshot,
  snapshotDigest,
  writeSnapshot,
  type SnapshotV1,
} from '../src/index.js';
import { edgeId, fileId, repositoryId } from '../src/graph.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function snapshot(name = 'repository'): SnapshotV1 {
  const repository = {
    id: repositoryId(),
    kind: 'repository' as const,
    root: '.' as const,
    name,
  };
  const file = {
    id: fileId('src/index.ts'),
    kind: 'file' as const,
    name: 'index.ts',
    path: 'src/index.ts',
  };
  return {
    schemaVersion: 1,
    completeness: 'complete',
    repository: { root: '.', name },
    nodes: [file, repository],
    edges: [
      {
        id: edgeId('contains', repository.id, file.id),
        kind: 'contains',
        from: repository.id,
        to: file.id,
        resolutionStatus: 'resolved',
      },
    ],
    diagnostics: [],
  };
}

describe('schema-v1 snapshots', () => {
  it('emits deterministic compact NFC UTF-8 and round-trips', async () => {
    const first = encodeSnapshot(snapshot('e\u0301'));
    const second = encodeSnapshot({
      ...snapshot('é'),
      nodes: [...snapshot('é').nodes].reverse(),
    });
    assert.deepEqual(first, second);
    assert.equal(first.toString('utf8').endsWith('\n'), true);
    assert.equal(
      first
        .toString('utf8')
        .includes('"schemaVersion":1,"completeness":"complete"'),
      true,
    );
    const fixture = await readFile(
      new URL('./fixtures/snapshots/complete-v1.json', import.meta.url),
    );
    assert.deepEqual(encodeSnapshot(snapshot()), fixture);
    assert.deepEqual(encodeSnapshot(decodeSnapshot(first)), first);
    assert.equal(snapshotDigest(first).length, 64);
  });

  it('rejects unsupported, malformed, BOM, unknown and dangling snapshots', () => {
    assert.throws(
      () => decodeSnapshot(Buffer.from('{"schemaVersion":2}')),
      /invalid|unsupported/i,
    );
    assert.throws(
      () => decodeSnapshot(Buffer.from('\ufeff{}')),
      /BOM|invalid/i,
    );
    assert.throws(
      () =>
        decodeSnapshot(
          Buffer.from(JSON.stringify({ ...snapshot(), extra: true })),
        ),
      /invalid/i,
    );
    const broken = snapshot();
    assert.throws(
      () =>
        decodeSnapshot(
          encodeSnapshot({
            ...broken,
            edges: [{ ...broken.edges[0]!, to: repositoryId() }],
          }),
        ),
      /invalid/i,
    );
  });

  it('writes and loads only under .sourcemesh with explicit replacement', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.snapshot-test-'));
    roots.push(root);
    const first = await writeSnapshot(root, snapshot(), {
      mode: 'create-only',
    });
    assert.equal(first.path, path.join(root, '.sourcemesh', 'graph.json'));
    await assert.rejects(
      () => writeSnapshot(root, snapshot('other'), { mode: 'create-only' }),
      { code: 'snapshot_conflict' },
    );
    await writeSnapshot(root, snapshot('other'), { mode: 'replace' });
    assert.equal((await openValidatedSnapshot(root)).repository.name, 'other');
    await assert.rejects(
      () =>
        writeSnapshot(root, snapshot(), {
          path: '../escape.json',
          mode: 'replace',
        }),
      { code: 'path_invalid' },
    );
    await mkdir(path.join(root, 'outside'), { recursive: true });
    await writeFile(path.join(root, 'outside', 'graph.json'), 'source');
    await assert.rejects(
      () => openValidatedSnapshot(root, 'outside/graph.json'),
      { code: 'path_invalid' },
    );
    assert.equal(
      (await readFile(first.path)).toString('utf8').includes('"name":"other"'),
      true,
    );
  });
});
