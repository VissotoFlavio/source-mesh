import {
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  lstat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {
  discoverSourceFiles,
  type DiscoveryFileSystem,
  type DiscoveryStats,
} from '../src/discovery.js';
import { discoverSourceFiles as discoverFromIndex } from '../src/index.js';

const fixtures: string[] = [];

const nativeFileSystem: DiscoveryFileSystem = {
  realpath,
  stat,
  lstat,
  readdir: async (directory) => readdir(directory, { withFileTypes: true }),
};

function fakeStats(
  kind: 'directory' | 'file',
  size = 0,
  ino = 1,
): DiscoveryStats {
  return {
    dev: 1,
    ino,
    size,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sourcemesh-discovery-'));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

describe('discoverSourceFiles', () => {
  it('is exported from the package entrypoint', () => {
    assert.equal(discoverFromIndex, discoverSourceFiles);
  });

  it('returns deterministic portable source paths and the canonical root', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'z.js'), '');
    await writeFile(path.join(root, 'a.ts'), '');
    await writeFile(path.join(root, 'nested.tsx'), '');
    const result = await discoverSourceFiles(root);

    assert.equal(result.repositoryRoot, await realpath(root));
    assert.deepEqual(result.sources, ['a.ts', 'nested.tsx', 'z.js']);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(await discoverSourceFiles(root), result);
  });

  it('applies exact extensions, declaration exclusions, reserved directories, and secrets', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'ok.mts'), '');
    await writeFile(path.join(root, 'ok.cjs'), '');
    await writeFile(path.join(root, 'types.d.ts'), '');
    await writeFile(path.join(root, 'notes.txt'), '');
    await writeFile(path.join(root, '.env.ts'), '');
    await writeFile(path.join(root, 'token.key'), '');
    for (const directory of [
      '.git',
      'node_modules',
      'dist',
      'generated',
      '.sourcemesh',
    ]) {
      await mkdir(path.join(root, directory));
      await writeFile(path.join(root, directory, 'ignored.ts'), '');
    }

    const result = await discoverSourceFiles(root);
    assert.deepEqual(result.sources, ['ok.cjs', 'ok.mts']);
  });

  it('skips dangling and contained/outside symlinks without traversing them', async (t) => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(path.join(root, 'real.ts'), '');
    await writeFile(path.join(outside, 'escape.ts'), '');
    try {
      await symlink(path.join(root, 'real.ts'), path.join(root, 'inside.ts'));
      await symlink(
        path.join(outside, 'escape.ts'),
        path.join(root, 'outside.ts'),
      );
      await symlink(
        path.join(root, 'missing.ts'),
        path.join(root, 'dangling.ts'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('symlink fixtures are unavailable on this host');
        return;
      }
      throw error;
    }

    const result = await discoverSourceFiles(root);
    assert.deepEqual(result.sources, ['real.ts']);
    assert.deepEqual(
      result.diagnostics.map(({ path: itemPath, reason }) => [
        itemPath,
        reason,
      ]),
      [
        ['dangling.ts', 'symlink_skipped'],
        ['inside.ts', 'symlink_skipped'],
        ['outside.ts', 'symlink_skipped'],
      ],
    );
  });

  it('rejects invalid roots with sanitized diagnostics', async () => {
    const root = await fixture();
    const file = path.join(root, 'file.ts');
    await writeFile(file, '');
    assert.deepEqual(
      (await discoverSourceFiles(path.join(root, 'missing'))).diagnostics,
      [
        {
          code: 'path_invalid',
          severity: 'error',
          message: 'Repository-relative path is invalid.',
          reason: 'root_missing',
        },
      ],
    );
    assert.deepEqual((await discoverSourceFiles(file)).diagnostics, [
      {
        code: 'path_invalid',
        severity: 'error',
        message: 'Repository-relative path is invalid.',
        reason: 'root_not_directory',
      },
    ]);
  });

  it('rejects UNC and remote roots before calling the filesystem', async () => {
    let calls = 0;
    const forbiddenFileSystem: DiscoveryFileSystem = {
      realpath: async () => {
        calls += 1;
        throw new Error('filesystem must not be called');
      },
      stat: async () => {
        calls += 1;
        throw new Error('filesystem must not be called');
      },
      lstat: async () => {
        calls += 1;
        throw new Error('filesystem must not be called');
      },
      readdir: async () => {
        calls += 1;
        throw new Error('filesystem must not be called');
      },
    };

    for (const root of [
      '\\\\server\\share',
      '//server/share',
      'smb://server/share',
    ]) {
      const result = await discoverSourceFiles(root, {
        filesystem: forbiddenFileSystem,
      });
      assert.equal(result.repositoryRoot, undefined);
      assert.deepEqual(result.sources, []);
      assert.deepEqual(result.diagnostics, [
        {
          code: 'path_invalid',
          severity: 'error',
          message: 'Repository-relative path is invalid.',
          reason: 'path_escape',
        },
      ]);
    }
    assert.equal(calls, 0);
  });

  it('distinguishes missing and inaccessible roots and entries', async () => {
    const root = await fixture();
    const inaccessibleRootFileSystem: DiscoveryFileSystem = {
      ...nativeFileSystem,
      realpath: async () => {
        const error = new Error('denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
    };
    const missingRootFileSystem: DiscoveryFileSystem = {
      ...nativeFileSystem,
      realpath: async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    };
    assert.equal(
      (
        await discoverSourceFiles(root, {
          filesystem: inaccessibleRootFileSystem,
        })
      ).diagnostics[0]?.reason,
      'root_inaccessible',
    );
    assert.equal(
      (await discoverSourceFiles(root, { filesystem: missingRootFileSystem }))
        .diagnostics[0]?.reason,
      'root_missing',
    );

    const entry = path.join(root, 'missing.ts');
    await writeFile(entry, '');
    const inaccessibleEntryFileSystem: DiscoveryFileSystem = {
      ...nativeFileSystem,
      lstat: async (candidate) => {
        if (candidate === entry) {
          const error = new Error('denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return lstat(candidate);
      },
    };
    const missingEntryFileSystem: DiscoveryFileSystem = {
      ...nativeFileSystem,
      lstat: async (candidate) => {
        if (candidate === entry) {
          const error = new Error('missing') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return lstat(candidate);
      },
    };
    assert.equal(
      (
        await discoverSourceFiles(root, {
          filesystem: inaccessibleEntryFileSystem,
        })
      ).diagnostics[0]?.reason,
      'entry_inaccessible',
    );
    assert.equal(
      (await discoverSourceFiles(root, { filesystem: missingEntryFileSystem }))
        .diagnostics[0]?.reason,
      'entry_missing',
    );
  });

  it('discards all sources when a directory is replaced during inspection', async () => {
    const root = path.join(os.tmpdir(), 'mock-discovery-root');
    const nested = path.join(root, 'nested');
    const source = path.join(root, 'a.ts');
    const nestedSource = path.join(nested, 'b.ts');
    let nestedLstatCalls = 0;
    const replacingFileSystem: DiscoveryFileSystem = {
      realpath: async (candidate) => candidate,
      stat: async (candidate) => {
        assert.equal(candidate, root);
        return fakeStats('directory', 0, 1);
      },
      readdir: async (directory) => {
        if (directory === root) {
          return [
            {
              name: 'a.ts',
              isDirectory: () => false,
              isSymbolicLink: () => false,
            },
            {
              name: 'nested',
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        assert.equal(directory, nested);
        return [
          {
            name: 'b.ts',
            isDirectory: () => false,
            isSymbolicLink: () => false,
          },
        ];
      },
      lstat: async (candidate) => {
        if (candidate === root) return fakeStats('directory', 0, 1);
        if (candidate === nested) {
          nestedLstatCalls += 1;
          return fakeStats('directory', 0, nestedLstatCalls === 4 ? 2 : 1);
        }
        if (candidate === source || candidate === nestedSource) {
          return fakeStats('file', 0, candidate === source ? 2 : 3);
        }
        throw new Error(`Unexpected path: ${candidate}`);
      },
    };

    const result = await discoverSourceFiles(root, {
      filesystem: replacingFileSystem,
    });
    assert.equal(nestedLstatCalls, 4);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.diagnostics, [
      {
        code: 'path_invalid',
        severity: 'error',
        message: 'Repository-relative path is invalid.',
        reason: 'entry_replaced',
        path: 'nested',
      },
    ]);
  });

  it('returns resource_limit and no partial sources for entry and byte caps', async () => {
    const root = await fixture();
    const tooManyEntries: DiscoveryFileSystem = {
      ...nativeFileSystem,
      readdir: async (directory) => {
        if (directory === root) {
          return Array.from({ length: 100_001 }, (_, index) => ({
            name: `entry-${index}.ts`,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          }));
        }
        return readdir(directory, { withFileTypes: true });
      },
    };
    const entryLimitResult = await discoverSourceFiles(root, {
      filesystem: tooManyEntries,
    });
    assert.deepEqual(entryLimitResult.sources, []);
    assert.equal(entryLimitResult.diagnostics[0]?.code, 'resource_limit');
    assert.equal(
      entryLimitResult.diagnostics[0]?.reason,
      'directory_entries_exceeded',
    );

    const largeFile = path.join(root, 'large.ts');
    await writeFile(largeFile, '');
    await truncate(largeFile, 4 * 1024 * 1024 + 1);
    const byteLimitResult = await discoverSourceFiles(root);
    assert.deepEqual(byteLimitResult.sources, []);
    assert.equal(byteLimitResult.diagnostics[0]?.code, 'resource_limit');
    assert.equal(
      byteLimitResult.diagnostics[0]?.reason,
      'source_size_exceeded',
    );
  });

  it('returns resource_limit and no partial sources when path depth exceeds the cap', async () => {
    const root = await fixture();
    let current = root;
    for (let index = 0; index < 256; index += 1) {
      current = path.join(current, `level-${index}`);
      await mkdir(current);
    }
    await writeFile(path.join(current, 'too-deep.ts'), '');

    const result = await discoverSourceFiles(root);
    assert.deepEqual(result.sources, []);
    assert.equal(result.diagnostics[0]?.code, 'resource_limit');
    assert.equal(result.diagnostics[0]?.reason, 'path_depth_exceeded');
  });
});
