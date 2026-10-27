import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
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
  type SnapshotV2,
} from '../src/index.js';
import {
  edgeId,
  edgeIdV2,
  fileId,
  fileIdV2,
  nodeId,
  nodeIdV2,
  repositoryId,
  repositoryIdV2,
} from '../src/graph.js';
import { resolveSnapshotPath } from '../src/snapshot/path.js';
import {
  configureSnapshotWriterForTesting,
  type SnapshotWriterFileSystem,
} from '../src/snapshot/writer.js';

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

function error(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
function graphPath(root: string): string {
  return path.join(root, '.sourcemesh', 'graph.json');
}
async function withWriterOverrides<T>(
  overrides: Partial<SnapshotWriterFileSystem>,
  platform: NodeJS.Platform,
  run: () => Promise<T>,
): Promise<T> {
  const reset = configureSnapshotWriterForTesting(overrides, platform);
  try {
    return await run();
  } finally {
    reset();
  }
}
function failFinalHandleMethod(
  method: 'writeFile' | 'sync' | 'close' | 'chmod',
) {
  return async (
    file: Parameters<typeof open>[0],
    flags: Parameters<typeof open>[1],
    mode?: Parameters<typeof open>[2],
  ) => {
    const handle = await open(file, flags, mode);
    if (!String(file).endsWith(path.join('.sourcemesh', 'graph.json')))
      return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property !== method) {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          if (method === 'close') await target.close();
          void args;
          throw error('EIO');
        };
      },
    }) as typeof handle;
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
    const created = await writeSnapshot(emptyRoot, snapshot(), {
      mode: 'create-only',
    });
    assert.equal((await openValidatedSnapshot(emptyRoot)).schemaVersion, 1);
    assert.equal(
      created.path.endsWith(path.join('.sourcemesh', 'graph.json')),
      true,
    );
    const createOnlyBytes = await readFile(created.path);
    await assert.rejects(
      () =>
        writeSnapshot(emptyRoot, snapshot('other'), { mode: 'create-only' }),
      { code: 'snapshot_conflict' },
    );
    assert.deepEqual(await readFile(created.path), createOnlyBytes);
    assert.equal(
      (await readdir(path.join(emptyRoot, '.sourcemesh'))).some((item) =>
        item.endsWith('.tmp'),
      ),
      false,
    );
    const customRoot = await mkdtemp(
      path.join(process.cwd(), '.snapshot-custom-path-'),
    );
    roots.push(customRoot);
    const custom = await writeSnapshot(customRoot, snapshot(), {
      path: '.sourcemesh/custom.json',
      mode: 'replace',
    });
    assert.equal(
      custom.path,
      path.join(customRoot, '.sourcemesh', 'custom.json'),
    );
    assert.equal(
      (await openValidatedSnapshot(customRoot, '.sourcemesh/custom.json'))
        .schemaVersion,
      1,
    );
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
    if (process.platform === 'win32') {
      await assert.rejects(
        () => resolveSnapshotPath(root, '.sourcemesh/graph.json:stream'),
        { code: 'path_invalid' },
      );
      await assert.rejects(() => resolveSnapshotPath(root, '.sourcemesh/CON'), {
        code: 'path_invalid',
      });
    }
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

  it('uses exclusive Windows fallback only for supported link failures', async () => {
    for (const code of ['EPERM', 'EOPNOTSUPP', 'ENOSYS']) {
      const root = await mkdtemp(path.join(process.cwd(), '.snapshot-link-'));
      roots.push(root);
      let links = 0;
      await withWriterOverrides(
        {
          link: async () => {
            links += 1;
            throw error(code);
          },
        },
        'win32',
        async () => {
          const created = await writeSnapshot(root, snapshot(), {
            mode: 'create-only',
          });
          const original = await readFile(created.path);
          await assert.rejects(
            () =>
              writeSnapshot(root, snapshot('other'), { mode: 'create-only' }),
            { code: 'snapshot_conflict' },
          );
          assert.deepEqual(await readFile(created.path), original);
        },
      );
      assert.equal(links, 1);
      assert.equal((await readdir(path.join(root, '.sourcemesh'))).length, 1);
    }
  });

  it('fails closed when the link fallback is unavailable', async () => {
    for (const [platform, code] of [
      ['linux', 'EPERM'],
      ['win32', 'EACCES'],
    ] as const) {
      const root = await mkdtemp(path.join(process.cwd(), '.snapshot-link-'));
      roots.push(root);
      await withWriterOverrides(
        { link: async () => Promise.reject(error(code)) },
        platform,
        async () => {
          await assert.rejects(
            () => writeSnapshot(root, snapshot(), { mode: 'create-only' }),
            { code: 'snapshot_io' },
          );
        },
      );
      await assert.rejects(() => lstat(graphPath(root)), { code: 'ENOENT' });
      assert.equal((await readdir(path.join(root, '.sourcemesh'))).length, 0);
    }
  });

  it('cleans up a failed Windows fallback so a retry can succeed', async () => {
    for (const method of ['writeFile', 'sync', 'close', 'chmod'] as const) {
      const root = await mkdtemp(
        path.join(process.cwd(), '.snapshot-fallback-'),
      );
      roots.push(root);
      await withWriterOverrides(
        {
          link: async () => Promise.reject(error('EPERM')),
          open: failFinalHandleMethod(method),
        },
        'win32',
        async () => {
          await assert.rejects(
            () => writeSnapshot(root, snapshot(), { mode: 'create-only' }),
            { code: 'snapshot_io' },
          );
        },
      );
      await assert.rejects(() => lstat(graphPath(root)), { code: 'ENOENT' });
      assert.equal((await readdir(path.join(root, '.sourcemesh'))).length, 0);
      await writeSnapshot(root, snapshot(), { mode: 'create-only' });
    }
  });

  it('does not fall back after hard-link publication cleanup fails', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.snapshot-link-'));
    roots.push(root);
    let links = 0;
    let finalOpens = 0;
    let unlinks = 0;
    await withWriterOverrides(
      {
        link: async (existingPath, newPath) => {
          links += 1;
          return link(existingPath, newPath);
        },
        open: async (file, flags, mode) => {
          if (String(file) === graphPath(root)) finalOpens += 1;
          return open(file, flags, mode);
        },
        unlink: async (file) => {
          unlinks += 1;
          if (unlinks === 1) throw error('EIO');
          return unlink(file);
        },
      },
      'win32',
      async () => {
        await assert.rejects(
          () => writeSnapshot(root, snapshot(), { mode: 'create-only' }),
          { code: 'snapshot_io' },
        );
      },
    );
    assert.equal(links, 1);
    assert.equal(finalOpens, 0);
    assert.equal((await lstat(graphPath(root))).isFile(), true);
    assert.equal((await readdir(path.join(root, '.sourcemesh'))).length, 1);
  });
});

function snapshotV2(): SnapshotV2 {
  const repository = {
    id: repositoryIdV2(),
    kind: 'repository' as const,
    root: '.' as const,
    name: 'repository',
  };
  const solution = {
    id: nodeIdV2(
      'solution',
      'src/App.sln',
      `${repository.id}#scope=root`,
      'App',
      'App',
      'none',
    ),
    kind: 'solution' as const,
    name: 'App',
    path: 'src/App.sln',
    qualifiedName: 'App',
    memberRole: 'none' as const,
  };
  const project = {
    id: nodeIdV2(
      'project',
      'src/App/App.csproj',
      `${solution.id}#scope=solution:${solution.qualifiedName}`,
      'App',
      'App',
      'none',
    ),
    kind: 'project' as const,
    name: 'App',
    path: 'src/App/App.csproj',
    qualifiedName: 'App',
    memberRole: 'none' as const,
  };
  const library = {
    id: nodeIdV2(
      'project',
      'src/Library/Library.csproj',
      `${solution.id}#scope=solution:${solution.qualifiedName}`,
      'Library',
      'Library',
      'none',
    ),
    kind: 'project' as const,
    name: 'Library',
    path: 'src/Library/Library.csproj',
    qualifiedName: 'Library',
    memberRole: 'none' as const,
  };
  const file = {
    id: fileIdV2('src/App/Program.cs'),
    kind: 'file' as const,
    name: 'Program.cs',
    path: 'src/App/Program.cs',
  };
  const module = {
    id: nodeIdV2(
      'module',
      file.path,
      `${file.id}#scope=root`,
      file.path,
      file.path,
      'none',
    ),
    kind: 'module' as const,
    name: file.path,
    path: file.path,
    qualifiedName: file.path,
    memberRole: 'none' as const,
  };
  const namespace = {
    id: nodeIdV2(
      'namespace',
      file.path,
      `${module.id}#scope=module:${module.qualifiedName}`,
      'App',
      'App',
      'none',
    ),
    kind: 'namespace' as const,
    name: 'App',
    path: file.path,
    qualifiedName: 'App',
    memberRole: 'none' as const,
  };
  const contains = (
    from: { readonly id: string },
    to: { readonly id: string },
  ) => ({
    id: edgeIdV2('contains', from.id, to.id),
    kind: 'contains' as const,
    from: from.id,
    to: to.id,
    resolutionStatus: 'resolved' as const,
  });
  return {
    schemaVersion: 2,
    completeness: 'complete',
    repository: { root: '.', name: 'repository' },
    nodes: [repository, solution, project, library, file, module, namespace],
    edges: [
      contains(repository, solution),
      contains(solution, project),
      contains(solution, library),
      contains(project, file),
      contains(file, module),
      contains(module, namespace),
      {
        id: edgeIdV2('references', project.id, library.id),
        kind: 'references',
        from: project.id,
        to: library.id,
        resolutionStatus: 'resolved',
      },
      {
        id: edgeIdV2('uses', module.id, namespace.id),
        kind: 'uses',
        from: module.id,
        to: namespace.id,
        resolutionStatus: 'resolved',
      },
    ],
    diagnostics: [],
  };
}

describe('schema-v2 snapshots', () => {
  it('round-trips canonical solution/project/namespace graphs and new edges', () => {
    const graph = snapshotV2();
    const bytes = encodeSnapshot(graph);
    const decoded = decodeSnapshot(bytes, 2) as SnapshotV2;
    assert.equal(decoded.schemaVersion, 2);
    assert.deepEqual(encodeSnapshot(decoded), bytes);
    const edgeShape = (edge: SnapshotV2['edges'][number]) =>
      `${edge.kind}\0${edge.from}\0${edge.to}`;
    assert.deepEqual(
      decoded.edges.map(edgeShape).sort(),
      graph.edges.map(edgeShape).sort(),
    );
    assert.notEqual(repositoryId(), graph.nodes[0]!.id);
    assert.equal(
      graph.nodes.some((node) => node.kind === 'namespace'),
      true,
    );
  });

  it('rejects an invalid v2 endpoint and reports unknown versions distinctly', () => {
    const graph = snapshotV2();
    const broken = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          id: edgeIdV2('references', graph.nodes[0]!.id, graph.nodes[1]!.id),
          kind: 'references' as const,
          from: graph.nodes[0]!.id,
          to: graph.nodes[1]!.id,
          resolutionStatus: 'resolved' as const,
        },
      ],
    };
    assert.throws(() => encodeSnapshot(broken), /endpoint/i);
    assert.throws(
      () => decodeSnapshot(Buffer.from('{"schemaVersion":3}')),
      (error: unknown) =>
        (error as { code?: string; supportedVersions?: readonly number[] })
          .code === 'unsupported_schema' &&
        (
          error as { supportedVersions?: readonly number[] }
        ).supportedVersions?.join(',') === '1,2',
    );
    assert.throws(() => fileIdV2('../outside.cs'), /relative/i);
    assert.throws(() => fileIdV2(String.fromCharCode(0xd800)), /Unicode/i);
    assert.throws(
      () =>
        nodeIdV2(
          'project',
          'App.csproj',
          'root',
          String.fromCharCode(0xd800),
          'App',
          'none',
        ),
      /Unicode/i,
    );
    assert.equal(
      nodeIdV2('project', 'App.csproj', 'root', 'Cafe\u0301', 'Café', 'none'),
      nodeIdV2('project', 'App.csproj', 'root', 'Café', 'Café', 'none'),
    );
    assert.notEqual(
      nodeIdV2('project', 'App.csproj', 'root', 'App', 'App', 'none'),
      nodeIdV2('project', 'App.csproj', 'root', 'App', 'App.Main', 'none'),
    );
    assert.throws(
      () =>
        nodeIdV2(
          'project',
          'App.csproj',
          'root/../outside',
          'App',
          'App',
          'none',
        ),
      /canonical/i,
    );
    assert.throws(() => edgeIdV2('bogus' as never, 'n:1', 'n:2'), /edge kind/i);
    assert.throws(
      () =>
        nodeIdV2('project', 'C:/outside.csproj', 'root', 'App', 'App', 'none'),
      /relative/i,
    );
  });

  it('loads v2 through the validated bootstrap boundary', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.snapshot-v2-'));
    roots.push(root);
    await writeSnapshot(root, snapshotV2(), { mode: 'replace' });
    const loaded = await openValidatedSnapshot(root);
    assert.equal(loaded.schemaVersion, 2);
  });
});
