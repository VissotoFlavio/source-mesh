import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { edgeId, fileId, nodeId, repositoryId } from '../src/graph.js';

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

  it('rejects forged symbol identities that cannot be recomputed from containment', () => {
    const repository = {
      id: repositoryId(),
      kind: 'repository' as const,
      root: '.' as const,
      name: 'repository',
    };
    const file = {
      id: fileId('src/index.ts'),
      kind: 'file' as const,
      name: 'index.ts',
      path: 'src/index.ts',
    };
    const scope = `${repository.id}/${file.id}#scope=root`;
    const validModule = {
      id: nodeId('module', file.path, scope, file.path, 'none'),
      kind: 'module' as const,
      name: file.path,
      path: file.path,
      qualifiedName: file.path,
      memberRole: 'none' as const,
    };
    const graph: SnapshotV1 = {
      schemaVersion: 1,
      completeness: 'complete',
      repository: { root: '.', name: 'repository' },
      nodes: [repository, file, validModule],
      edges: [
        {
          id: edgeId('contains', repository.id, file.id),
          kind: 'contains',
          from: repository.id,
          to: file.id,
          resolutionStatus: 'resolved',
        },
        {
          id: edgeId('contains', file.id, validModule.id),
          kind: 'contains',
          from: file.id,
          to: validModule.id,
          resolutionStatus: 'resolved',
        },
      ],
      diagnostics: [],
    };
    assert.doesNotThrow(() => decodeSnapshot(encodeSnapshot(graph)));
    const forged = {
      ...graph,
      nodes: [{ ...validModule, id: `n:${'a'.repeat(64)}` }, repository, file],
      edges: [
        graph.edges[0]!,
        {
          ...graph.edges[1]!,
          id: edgeId('contains', file.id, `n:${'a'.repeat(64)}`),
          to: `n:${'a'.repeat(64)}`,
        },
      ],
    };
    assert.throws(() => decodeSnapshot(encodeSnapshot(forged)), /identity/i);
  });

  it('writes and loads only under .sourcemesh with explicit replacement', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.snapshot-test-'));
    roots.push(root);
    const first = await writeSnapshot(root, snapshot(), { mode: 'replace' });
    assert.equal(first.path, path.join(root, '.sourcemesh', 'graph.json'));
    const emptyRoot = await mkdtemp(
      path.join(process.cwd(), '.snapshot-create-only-'),
    );
    roots.push(emptyRoot);
    try {
      const created = await writeSnapshot(emptyRoot, snapshot(), {
        mode: 'create-only',
      });
      assert.equal((await openValidatedSnapshot(emptyRoot)).schemaVersion, 1);
      assert.equal(
        created.path.endsWith(path.join('.sourcemesh', 'graph.json')),
        true,
      );
    } catch (error) {
      assert.equal((error as { code: string }).code, 'snapshot_io');
      assert.equal(
        (await readdir(path.join(emptyRoot, '.sourcemesh'))).some((item) =>
          item.endsWith('.tmp'),
        ),
        false,
      );
    }
    const createOnly = writeSnapshot(root, snapshot('other'), {
      mode: 'create-only',
    });
    await assert.rejects(
      createOnly,
      (error: unknown) =>
        (error as { code: string }).code === 'snapshot_conflict' ||
        (error as { code: string }).code === 'snapshot_io',
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
    const destination = await lstat(first.path);
    assert.equal(destination.isSymbolicLink(), false);
    if (process.platform !== 'win32') assert.equal(destination.mode & 0o077, 0);
    assert.equal(
      (await readdir(path.join(root, '.sourcemesh'))).some((item) =>
        item.endsWith('.tmp'),
      ),
      false,
    );
    try {
      const outside = path.join(root, 'outside.json');
      await writeFile(outside, 'outside');
      const link = path.join(root, '.sourcemesh', 'link.json');
      await symlink(outside, link);
      await assert.rejects(
        () => openValidatedSnapshot(root, '.sourcemesh/link.json'),
        { code: 'path_invalid' },
      );
      await assert.rejects(
        () =>
          writeSnapshot(root, snapshot(), {
            path: '.sourcemesh/link.json',
            mode: 'replace',
          }),
        { code: 'path_invalid' },
      );
    } catch (error) {
      if (
        !['EPERM', 'EACCES', 'ENOTSUP'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  });
});
