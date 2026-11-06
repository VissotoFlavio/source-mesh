import {
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
  MAX_PACK_METADATA_BYTES,
  MAX_PACK_PROVENANCE_TEXT_BYTES,
  MAX_V3_NODE_TEXT_BYTES,
  openValidatedSnapshot,
  snapshotDigest,
  writeSnapshot,
  type SnapshotV1,
  type SnapshotV2,
  type SnapshotV3,
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
import { createSnapshotWriterForTesting } from '../src/snapshot/writer.js';

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
  return path.join(root, '.sourcemesh', 'snapshots', 'test.json');
}
async function withWriterOverrides<T>(
  overrides: Parameters<typeof createSnapshotWriterForTesting>[0],
  platform: NodeJS.Platform,
  run: (writer: typeof writeSnapshot) => Promise<T>,
): Promise<T> {
  return run(createSnapshotWriterForTesting(overrides, platform));
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
    if (
      !String(file).endsWith(path.join('.sourcemesh', 'snapshots', 'test.json'))
    )
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

  it('writes and loads only versioned create-only snapshots', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.snapshot-test-'));
    roots.push(root);
    const first = await writeSnapshot(root, snapshot(), {
      path: '.sourcemesh/snapshots/replace.json',
    });
    assert.equal(
      first.path,
      path.join(root, '.sourcemesh', 'snapshots', 'replace.json'),
    );
    const emptyRoot = await mkdtemp(
      path.join(process.cwd(), '.snapshot-create-only-'),
    );
    roots.push(emptyRoot);
    const created = await writeSnapshot(emptyRoot, snapshot(), {
      path: '.sourcemesh/snapshots/test.json',
    });
    assert.equal(
      (
        await openValidatedSnapshot(
          emptyRoot,
          '.sourcemesh/snapshots/test.json',
        )
      ).schemaVersion,
      1,
    );
    assert.equal(
      created.path.endsWith(path.join('.sourcemesh', 'snapshots', 'test.json')),
      true,
    );
    const createOnlyBytes = await readFile(created.path);
    await assert.rejects(
      () =>
        writeSnapshot(emptyRoot, snapshot('other'), {
          path: '.sourcemesh/snapshots/test.json',
        }),
      { code: 'snapshot_conflict' },
    );
    assert.deepEqual(await readFile(created.path), createOnlyBytes);
    await assert.rejects(
      () =>
        writeSnapshot(emptyRoot, snapshot(), {
          path: '.sourcemesh/snapshots/replace.json',
          mode: 'replace',
        } as never),
      { code: 'path_invalid' },
    );
    await assert.rejects(
      () =>
        writeSnapshot(emptyRoot, snapshot(), {
          path: '.sourcemesh/graph.json',
        }),
      { code: 'path_invalid' },
    );
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
      path: '.sourcemesh/snapshots/custom.json',
    });
    assert.equal(
      custom.path,
      path.join(customRoot, '.sourcemesh', 'snapshots', 'custom.json'),
    );
    assert.equal(
      (
        await openValidatedSnapshot(
          customRoot,
          '.sourcemesh/snapshots/custom.json',
        )
      ).schemaVersion,
      1,
    );
    await writeSnapshot(root, snapshot('other'), {
      path: '.sourcemesh/snapshots/test.json',
    });
    await assert.rejects(
      () =>
        writeSnapshot(root, snapshot('other'), {
          path: '.sourcemesh/snapshots/replace.json',
        }),
      { code: 'snapshot_conflict' },
    );
    await assert.rejects(
      () => writeSnapshot(root, snapshot(), { path: '../escape.json' }),
      { code: 'path_invalid' },
    );
    await mkdir(path.join(root, 'outside'), { recursive: true });
    await writeFile(path.join(root, 'outside', 'graph.json'), 'source');
    await assert.rejects(
      () => openValidatedSnapshot(root, 'outside/graph.json'),
      { code: 'path_invalid' },
    );
    await writeFile(
      path.join(root, '.sourcemesh', 'graph.json'),
      encodeSnapshot(snapshot('legacy')),
    );
    assert.equal(
      (await openValidatedSnapshot(root, '.sourcemesh/graph.json')).repository
        .name,
      'legacy',
    );
    assert.equal(
      (await readFile(first.path))
        .toString('utf8')
        .includes('"name":"repository"'),
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
          writeSnapshot(root, snapshot(), { path: '.sourcemesh/link.json' }),
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
        async (writer) => {
          const created = await writer(root, snapshot(), {
            path: '.sourcemesh/snapshots/test.json',
          });
          const original = await readFile(created.path);
          await assert.rejects(
            () =>
              writer(root, snapshot('other'), {
                path: '.sourcemesh/snapshots/test.json',
              }),
            { code: 'snapshot_conflict' },
          );
          assert.deepEqual(await readFile(created.path), original);
        },
      );
      assert.equal(links, 1);
      assert.equal(
        (await readdir(path.join(root, '.sourcemesh', 'snapshots'))).length,
        1,
      );
    }
  });

  it('does not announce invalid or tampered hard-link publications', async () => {
    for (const [name, published, code] of [
      ['invalid', Buffer.from('{'), 'invalid_snapshot'],
      ['tampered', encodeSnapshot(snapshot('tampered')), 'snapshot_io'],
    ] as const) {
      const root = await mkdtemp(path.join(process.cwd(), '.snapshot-link-'));
      roots.push(root);
      await withWriterOverrides(
        {
          link: async (_existingPath, newPath) => {
            await writeFile(newPath, published, { flag: 'wx', mode: 0o600 });
          },
        },
        process.platform,
        async (writer) => {
          await assert.rejects(
            () =>
              writer(root, snapshot(), {
                path: '.sourcemesh/snapshots/test.json',
              }),
            { code },
            `${name} publication must not be announced`,
          );
        },
      );
      assert.equal((await lstat(graphPath(root))).isFile(), true);
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
        async (writer) => {
          await assert.rejects(
            () =>
              writer(root, snapshot(), {
                path: '.sourcemesh/snapshots/test.json',
              }),
            { code: 'snapshot_io' },
          );
        },
      );
      await assert.rejects(() => lstat(graphPath(root)), { code: 'ENOENT' });
      assert.equal(
        (await readdir(path.join(root, '.sourcemesh', 'snapshots'))).length,
        0,
      );
    }
  });

  it('retains an invalid failed Windows fallback without replacement recovery', async () => {
    for (const method of ['writeFile', 'chmod'] as const) {
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
        async (writer) => {
          await assert.rejects(
            () =>
              writer(root, snapshot(), {
                path: '.sourcemesh/snapshots/test.json',
              }),
            { code: 'snapshot_io' },
          );
        },
      );
      assert.equal((await lstat(graphPath(root))).isFile(), true);
      assert.equal((await readdir(path.join(root, '.sourcemesh'))).length, 1);
      await assert.rejects(() =>
        openValidatedSnapshot(root, '.sourcemesh/snapshots/test.json'),
      );
      await assert.rejects(
        () =>
          writeSnapshot(root, snapshot(), {
            path: '.sourcemesh/snapshots/test.json',
          }),
        { code: 'snapshot_conflict' },
      );
      await assert.rejects(
        () =>
          writeSnapshot(root, snapshot('recovered'), {
            path: '.sourcemesh/snapshots/test.json',
          }),
        { code: 'snapshot_conflict' },
      );
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
          // Model successful exclusive publication without volume hard-link support.
          await writeFile(newPath, await readFile(existingPath), {
            flag: 'wx',
            mode: 0o600,
          });
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
      async (writer) => {
        await assert.rejects(
          () =>
            writer(root, snapshot(), {
              path: '.sourcemesh/snapshots/test.json',
            }),
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

function snapshotV3(): SnapshotV3 {
  const v2 = snapshotV2();
  return {
    schemaVersion: 3,
    completeness: v2.completeness,
    repository: v2.repository,
    metadata: {
      verification: 'unverified',
      packs: [
        {
          id: 'csharp-pack',
          language: 'csharp',
          version: '1.0.0',
          capabilities: ['semantic-relations', 'source-analysis'],
        },
      ],
    },
    nodes: v2.nodes.map((node) =>
      node.kind === 'repository'
        ? node
        : { ...node, packId: 'csharp-pack', language: 'csharp' },
    ) as SnapshotV3['nodes'],
    edges: v2.edges.map((edge) =>
      edge.kind === 'contains'
        ? edge
        : { ...edge, packId: 'csharp-pack', evidence: 'semantic' as const },
    ) as SnapshotV3['edges'],
    diagnostics: v2.diagnostics,
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
      () => decodeSnapshot(Buffer.from('{"schemaVersion":4}')),
      (error: unknown) =>
        (error as { code?: string; supportedVersions?: readonly number[] })
          .code === 'unsupported_schema' &&
        (
          error as { supportedVersions?: readonly number[] }
        ).supportedVersions?.join(',') === '1,2,3',
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
    await writeSnapshot(root, snapshotV2(), {
      path: '.sourcemesh/snapshots/replace.json',
    });
    const loaded = await openValidatedSnapshot(
      root,
      '.sourcemesh/snapshots/replace.json',
    );
    assert.equal(loaded.schemaVersion, 2);
  });
});

describe('schema-v3 pack metadata snapshots', () => {
  it('accepts UTF-8 node text through the v3 transport budget', () => {
    const text = 'é'.repeat(MAX_V3_NODE_TEXT_BYTES / 2);
    const pathText = 's'.repeat(MAX_V3_NODE_TEXT_BYTES);
    const repository = {
      id: repositoryIdV2(),
      kind: 'repository' as const,
      root: '.' as const,
      name: 'repository',
    };
    const project = {
      id: nodeIdV2(
        'project',
        pathText,
        `${repository.id}#scope=root`,
        text,
        text,
        'none',
      ),
      kind: 'project' as const,
      name: text,
      path: pathText,
      qualifiedName: text,
      memberRole: 'none' as const,
      locations: [
        {
          path: pathText,
          start: { line: 1, column: 1 },
          end: { line: 1, column: 2 },
        },
      ],
      packId: 'csharp-pack',
      language: 'csharp',
    };
    const graph: SnapshotV3 = {
      schemaVersion: 3,
      completeness: 'complete',
      repository: { root: '.', name: 'repository' },
      metadata: {
        verification: 'unverified',
        packs: [
          {
            id: 'csharp-pack',
            language: 'csharp',
            version: '1.0.0',
            capabilities: [],
          },
        ],
      },
      nodes: [repository, project],
      edges: [
        {
          id: edgeIdV2('contains', repository.id, project.id),
          kind: 'contains',
          from: repository.id,
          to: project.id,
          resolutionStatus: 'resolved',
        },
      ],
      diagnostics: [],
    };
    assert.equal(Buffer.byteLength(text, 'utf8'), MAX_V3_NODE_TEXT_BYTES);
    assert.equal(Buffer.byteLength(pathText, 'utf8'), MAX_V3_NODE_TEXT_BYTES);
    const decoded = decodeSnapshot(encodeSnapshot(graph), 3) as SnapshotV3;
    const result = decoded.nodes.find((node) => node.kind === 'project');
    if (result === undefined || result.kind !== 'project')
      throw new Error('missing project node');
    assert.equal(result.name, text);
    assert.equal(result.path, pathText);
    assert.equal(result.qualifiedName, text);
    assert.equal(result.locations?.[0]?.path, pathText);
  });

  it('rejects v3 node text above the UTF-8 transport budget', () => {
    const graph = snapshotV3();
    const overBudget = 'é'.repeat(MAX_V3_NODE_TEXT_BYTES / 2 + 1);
    const projectIndex = graph.nodes.findIndex(
      (node) => node.kind === 'project',
    );
    assert.notEqual(projectIndex, -1);
    for (const patch of [
      { name: overBudget },
      { path: overBudget },
      { qualifiedName: overBudget },
      {
        locations: [
          {
            path: overBudget,
            start: { line: 1, column: 1 },
            end: { line: 1, column: 2 },
          },
        ],
      },
    ]) {
      const nodes = graph.nodes.map((node, index) =>
        index === projectIndex ? { ...node, ...patch } : node,
      );
      assert.throws(
        () => encodeSnapshot({ ...graph, nodes }),
        (error: unknown) =>
          (error as { code?: string }).code === 'invalid_snapshot',
      );
    }
  });

  it('canonicalizes pack metadata and validates provenance without rewriting v1/v2', () => {
    const graph = snapshotV3();
    const bytes = encodeSnapshot({
      ...graph,
      metadata: {
        verification: graph.metadata.verification,
        packs: graph.metadata.packs.map((pack) => ({
          ...pack,
          capabilities: [...pack.capabilities].reverse(),
        })),
      },
      nodes: [...graph.nodes].reverse(),
    });
    const decoded = decodeSnapshot(bytes, 3) as SnapshotV3;
    assert.equal(decoded.schemaVersion, 3);
    assert.deepEqual(decoded.metadata.packs[0]?.capabilities, [
      'semantic-relations',
      'source-analysis',
    ]);
    assert.deepEqual(encodeSnapshot(decoded), bytes);
    assert.throws(
      () =>
        encodeSnapshot({
          ...graph,
          nodes: graph.nodes.map((node) =>
            node.kind === 'repository' ? node : { ...node, packId: 'unknown' },
          ),
        }),
      /attribution/i,
    );
    assert.equal(decodeSnapshot(encodeSnapshot(snapshot())).schemaVersion, 1);
    assert.equal(decodeSnapshot(encodeSnapshot(snapshotV2())).schemaVersion, 2);
  });

  it('bounds unverified metadata for MCP-safe v3 responses', () => {
    const graph = snapshotV3();
    const maxVersion = 'v'.repeat(1024);
    const largeMetadata = {
      verification: 'unverified' as const,
      packs: [
        ...graph.metadata.packs,
        ...Array.from({ length: 7 }, (_, index) => ({
          id: `large-pack-${index}`,
          language: `language-${index}`,
          version: maxVersion,
          capabilities: [],
        })),
      ],
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(largeMetadata.packs), 'utf8') <=
        MAX_PACK_METADATA_BYTES,
    );
    const decoded = decodeSnapshot(
      encodeSnapshot({ ...graph, metadata: largeMetadata }),
      3,
    ) as SnapshotV3;
    assert.equal(decoded.metadata.verification, 'unverified');
    assert.throws(
      () =>
        encodeSnapshot({
          ...graph,
          metadata: {
            ...largeMetadata,
            packs: [
              ...largeMetadata.packs,
              ...Array.from({ length: 2 }, (_, index) => ({
                id: `overflow-pack-${index}`,
                language: `overflow-language-${index}`,
                version: maxVersion,
                capabilities: [],
              })),
            ],
          },
        }),
      /metadata size/i,
    );
    assert.throws(
      () =>
        encodeSnapshot({
          ...graph,
          metadata: {
            ...graph.metadata,
            verification: 'verified' as unknown as 'unverified',
          },
        }),
      /verification/i,
    );
    assert.throws(
      () =>
        encodeSnapshot({
          ...graph,
          metadata: {
            ...graph.metadata,
            packs: [
              {
                ...graph.metadata.packs[0]!,
                id: 'p'.repeat(MAX_PACK_PROVENANCE_TEXT_BYTES + 1),
              },
            ],
          },
        }),
      /pack id/i,
    );
    assert.throws(
      () =>
        encodeSnapshot({
          ...graph,
          nodes: graph.nodes.map((node) =>
            node.kind === 'repository'
              ? node
              : { ...node, name: 'n'.repeat(MAX_V3_NODE_TEXT_BYTES + 1) },
          ),
        }),
      /v3 node name/i,
    );
    assert.throws(
      () =>
        encodeSnapshot({
          ...graph,
          metadata: {
            ...graph.metadata,
            packs: [
              {
                ...graph.metadata.packs[0]!,
                language: '\0'.repeat(64),
              },
            ],
          },
        }),
      /pack language/i,
    );
  });
});
