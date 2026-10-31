import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BUNDLED_LANGUAGE_PACKS } from '../src/bundled-packs.js';
import { csharpPack } from '../src/packs/csharp.js';
import { LanguagePackRegistry } from '../src/packs.js';

test(
  'the C# pack reaches the Roslyn worker only through the static local-worker registry',
  { skip: process.platform !== 'win32' },
  async () => {
    const registry = new LanguagePackRegistry();
    registry.register(csharpPack);
    assert.deepEqual(
      registry.configure({ enabledPackIds: ['csharp'] }).diagnostics,
      [],
    );

    const result = await registry.analyze('csharp', {
      contractVersion: 1,
      repository: { name: 'worker-integration', root: '.' },
      files: [
        {
          path: 'src/App.cs',
          contents: new TextEncoder().encode(
            'namespace WorkerIntegration; public class App { public void Run() {} }\n',
          ),
        },
      ],
      limits: {
        maxFiles: 1,
        maxBytes: 128,
        maxNodes: 32,
        maxEdges: 32,
        maxDiagnostics: 32,
      },
      configuration: {},
    });

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.fragment?.pack.id, 'csharp');
    assert.ok(result.fragment?.nodes.some((node) => node.name === 'App'));
  },
);

test('the C# pack is part of the authoritative bundled-pack registry', () => {
  assert.equal(
    BUNDLED_LANGUAGE_PACKS.includes(csharpPack),
    process.platform === 'win32',
  );
});

test(
  'the C# manifest facade uses the same static local-worker protocol',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'csharp-pack-manifest-'));
    try {
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(
        path.join(root, 'src', 'App.cs'),
        'public class App {}\n',
      );
      const worker = await csharpPack.analyzeManifest(root, {
        language: 'csharp',
        selection: { kind: 'project', path: 'App.csproj' },
        projects: [
          { path: 'App.csproj', references: [], files: ['src/App.cs'] },
        ],
      });
      assert.deepEqual(worker.diagnostics, []);
      assert.equal(worker.projects[0]?.declarations?.[0]?.name, 'App');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
