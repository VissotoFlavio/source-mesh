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
import { win32 as win32Path } from 'node:path';
import {
  discoverSourceFiles,
  MAX_DIRECTORY_ENTRIES,
  readFileBounded,
  type DiscoveryDirectory,
  type DiscoveryDirent,
  type DiscoveryFileSystem,
  type DiscoveryStats,
} from '../src/discovery.js';
import { discoverSourceFiles as discoverFromIndex } from '../src/index.js';

const fixtures: string[] = [];

function directoryHandle(
  entries: readonly DiscoveryDirent[],
): DiscoveryDirectory {
  let index = 0;
  return {
    next: async () => entries[index++],
    close: async () => {},
  };
}

const nativeFileSystem: DiscoveryFileSystem = {
  realpath,
  stat,
  lstat,
  openDirectory: async (directory) =>
    directoryHandle(await readdir(directory, { withFileTypes: true })),
  readFile: readFileBounded,
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
  const canonicalRoot = await realpath(root);
  fixtures.push(canonicalRoot);
  return canonicalRoot;
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

  it('rejects a prevalidated file identity before reading bytes', async () => {
    const root = await fixture();
    const file = path.join(root, 'identity.ts');
    await writeFile(file, 'const identity = true;');
    const actual = await lstat(file);

    await assert.rejects(
      () =>
        readFileBounded(file, 1024, {
          ...fakeStats('file', actual.size, actual.ino + 1),
        }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EAGAIN',
    );
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

  it('covers Windows lexical containment and portable path normalization', () => {
    const root = win32Path.normalize('C:\\Repository\\.');
    const portable = (candidate: string): string | undefined => {
      const relative = win32Path.relative(root, candidate);
      if (
        win32Path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith(`..${win32Path.sep}`)
      ) {
        return undefined;
      }
      return relative.split(win32Path.sep).join('/');
    };

    assert.equal(
      portable(win32Path.join(root, 'Src', 'Main.ts')),
      'Src/Main.ts',
    );
    assert.equal(
      portable('C:\\Repository\\src\\.\\nested\\..\\Main.ts'),
      'src/Main.ts',
    );
    assert.equal(portable('C:\\Repository\\..\\outside.ts'), undefined);
    assert.equal(portable('D:\\Repository\\outside.ts'), undefined);
    assert.equal(portable('\\\\server\\share\\outside.ts'), undefined);
  });

  it('produces identical results when directory enumeration is reversed', async () => {
    const root = await fixture();
    const disappearing = path.join(root, 'disappearing.ts');
    await writeFile(path.join(root, 'z.ts'), '');
    await writeFile(path.join(root, 'a.ts'), '');
    await writeFile(disappearing, '');

    const orderedFileSystem = (reverse: boolean): DiscoveryFileSystem => ({
      ...nativeFileSystem,
      openDirectory: async (directory) => {
        const entries = [
          ...(await readdir(directory, { withFileTypes: true })),
        ];
        return directoryHandle(reverse ? entries.reverse() : entries);
      },
      lstat: async (candidate) => {
        if (candidate === disappearing) {
          const error = new Error('disappeared') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return lstat(candidate);
      },
    });

    const forward = await discoverSourceFiles(root, {
      filesystem: orderedFileSystem(false),
    });
    const reversed = await discoverSourceFiles(root, {
      filesystem: orderedFileSystem(true),
    });
    assert.deepEqual(reversed, forward);
    assert.deepEqual(forward.sources, ['a.ts', 'z.ts']);
    assert.deepEqual(forward.diagnostics, [
      {
        code: 'path_invalid',
        severity: 'error',
        message: 'Repository-relative path is invalid.',
        reason: 'entry_missing',
        path: 'disappearing.ts',
      },
    ]);
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
      openDirectory: async () => {
        calls += 1;
        throw new Error('filesystem must not be called');
      },
      readFile: async () => {
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
    const root = await fixture();
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
      openDirectory: async (directory) => {
        if (directory === root) {
          return directoryHandle([
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
          ]);
        }
        assert.equal(directory, nested);
        return directoryHandle([
          {
            name: 'b.ts',
            isDirectory: () => false,
            isSymbolicLink: () => false,
          },
        ]);
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
      readFile: async (candidate) => {
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
    let yieldedEntries = 0;
    let closed = false;
    const tooManyEntries: DiscoveryFileSystem = {
      ...nativeFileSystem,
      openDirectory: async (directory) => {
        if (directory === root) {
          let index = 0;
          return {
            next: async () => {
              if (index > 100_000) return undefined;
              const entry = {
                name: `entry-${index}.ts`,
                isDirectory: () => false,
                isSymbolicLink: () => false,
              };
              index += 1;
              yieldedEntries += 1;
              return entry;
            },
            close: async () => {
              closed = true;
            },
          };
        }
        return directoryHandle(
          await readdir(directory, { withFileTypes: true }),
        );
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
    assert.equal(yieldedEntries, MAX_DIRECTORY_ENTRIES + 1);
    assert.equal(closed, true);

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
