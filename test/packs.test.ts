import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {
  LanguagePackRegistry,
  type AnalysisRequest,
  type LanguagePack,
  type LanguagePackSelection,
} from '../src/packs.js';

const request: AnalysisRequest = {
  contractVersion: 1,
  repository: { name: 'fixture', root: '.' },
  files: [
    { path: 'src/main.fake', contents: new TextEncoder().encode('fake') },
  ],
  limits: {
    maxFiles: 1,
    maxBytes: 4,
    maxNodes: 2,
    maxEdges: 1,
    maxDiagnostics: 1,
  },
  configuration: { strict: true },
};
const pack: LanguagePack = {
  manifest: {
    contractVersion: 1,
    id: 'fake',
    version: '1.0.0',
    extensions: ['.fake'],
    executionMode: 'in-process',
    capabilities: ['source-analysis'],
  },
  analyze: (input) => ({
    pack: { id: 'fake', version: '1.0.0' },
    nodes: [
      { key: 'z', kind: 'module', path: input.files[0]!.path, name: 'z' },
      { key: 'a', kind: 'module', path: input.files[0]!.path, name: 'a' },
    ],
    edges: [{ kind: 'contains', from: 'a', to: 'z', confidence: 'syntactic' }],
    diagnostics: [],
  }),
};

function localPack(id: string, extensions: readonly string[]): LanguagePack {
  return {
    manifest: {
      contractVersion: 1,
      id,
      version: '1.0.0',
      extensions,
      executionMode: 'in-process',
      capabilities: ['source-analysis'],
    },
    analyze: () => ({
      pack: { id, version: '1.0.0' },
      nodes: [],
      edges: [],
      diagnostics: [],
    }),
  };
}

test('a registered fake pack receives only approved files and returns a deterministic fragment', async () => {
  const registry = new LanguagePackRegistry();
  registry.register(pack);
  registry.configure({ enabledPackIds: ['fake'] });
  const result = await registry.analyze('fake', request);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.fragment?.nodes.map((node) => node.key),
    ['a', 'z'],
  );
});

test('malformed responses fail closed with a sanitized diagnostic', async () => {
  const registry = new LanguagePackRegistry();
  registry.register({
    ...pack,
    manifest: { ...pack.manifest, id: 'broken' },
    analyze: () => ({
      pack: { id: 'broken', version: '1.0.0' },
      nodes: [{ key: 'x', kind: 'module', path: '../outside.fake', name: 'x' }],
      edges: [],
      diagnostics: [],
    }),
  });
  registry.configure({ enabledPackIds: ['broken'] });
  const result = await registry.analyze('broken', request);
  assert.equal(result.fragment, undefined);
  assert.deepEqual(result.diagnostics, [
    {
      code: 'pack_response_invalid',
      severity: 'error',
      message: 'Language pack response is invalid.',
    },
  ]);
});

test('structurally malformed responses cannot escape the Core boundary', async () => {
  const registry = new LanguagePackRegistry();
  registry.register({
    ...pack,
    manifest: { ...pack.manifest, id: 'unsafe' },
    analyze: () => undefined as never,
  });
  registry.configure({ enabledPackIds: ['unsafe'] });
  const result = await registry.analyze('unsafe', request);
  assert.equal(result.fragment, undefined);
  assert.equal(result.diagnostics[0]?.code, 'pack_response_invalid');
});

test('requests reject arbitrary repository-root authority before a pack runs', async () => {
  const registry = new LanguagePackRegistry();
  registry.register(pack);
  registry.configure({ enabledPackIds: ['fake'] });
  const result = await registry.analyze('fake', {
    ...request,
    repository: { name: 'fixture', root: 'C:/outside' as '.' },
  });
  assert.equal(result.fragment, undefined);
  assert.equal(result.diagnostics[0]?.code, 'pack_request_invalid');
});

test('an unconfigured registry fails closed before pack or filesystem access', async () => {
  let invocations = 0;
  const registry = new LanguagePackRegistry();
  registry.register({
    ...pack,
    analyze: () => {
      invocations += 1;
      return {
        pack: { id: 'fake', version: '1.0.0' },
        nodes: [],
        edges: [],
        diagnostics: [],
      };
    },
  });
  assert.equal(
    registry.discoveryPlan().diagnostics[0]?.code,
    'pack_selection_ambiguous',
  );
  const analysis = await registry.analyze('fake', request);
  assert.equal(analysis.diagnostics[0]?.code, 'pack_selection_ambiguous');
  assert.equal(invocations, 0);

  let filesystemAccessed = false;
  const discovery = await registry.discover('unused', {
    filesystem: new Proxy(
      {},
      {
        get: () => {
          filesystemAccessed = true;
          throw new Error('filesystem must not be accessed');
        },
      },
    ) as never,
  });
  assert.equal(filesystemAccessed, false);
  assert.equal(discovery.discovery, undefined);
  assert.equal(discovery.diagnostics[0]?.code, 'pack_selection_ambiguous');
});

test('enabled local packs provide the deterministic discovery extension union and dispatch', async () => {
  const registry = new LanguagePackRegistry();
  registry.register(localPack('typescript', ['.ts', '.tsx']));
  registry.register(localPack('csharp', ['.cs']));
  const plan = registry.configure({
    enabledPackIds: ['typescript', 'csharp'],
  });
  assert.deepEqual(plan.extensions, ['.cs', '.ts', '.tsx']);
  assert.deepEqual(plan.owners, [
    { extension: '.cs', packId: 'csharp' },
    { extension: '.ts', packId: 'typescript' },
    { extension: '.tsx', packId: 'typescript' },
  ]);

  const root = await mkdtemp(path.join(os.tmpdir(), 'sourcemesh-pack-'));
  try {
    await writeFile(path.join(root, 'app.ts'), 'export {};');
    await writeFile(path.join(root, 'library.cs'), 'class Library {}');
    await writeFile(path.join(root, 'notes.txt'), 'not source');
    const result = await registry.discover(root);
    assert.deepEqual(result.dispatches, [
      { path: 'app.ts', packId: 'typescript' },
      { path: 'library.cs', packId: 'csharp' },
    ]);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shared extensions require an explicit enabled-pack owner', () => {
  const registry = new LanguagePackRegistry();
  registry.register(localPack('first', ['.shared']));
  registry.register(localPack('second', ['.shared']));

  const ambiguous = registry.configure({
    enabledPackIds: ['first', 'second'],
  });
  assert.deepEqual(ambiguous.extensions, []);
  assert.deepEqual(
    ambiguous.diagnostics.map((item) => item.code),
    ['pack_duplicate_extension'],
  );

  const configured = registry.configure({
    enabledPackIds: ['first', 'second'],
    extensionOwners: { '.shared': 'second' },
  });
  assert.deepEqual(configured.owners, [
    { extension: '.shared', packId: 'second' },
  ]);
  assert.deepEqual(registry.dispatch('src/value.shared'), {
    dispatch: { path: 'src/value.shared', packId: 'second' },
    diagnostics: [],
  });
  assert.equal(
    registry.dispatch('src/value.unsupported').diagnostics[0]?.code,
    'pack_unsupported_extension',
  );
});

test('disabled, unavailable, and incompatible packs fail closed with stable diagnostics', async () => {
  const registry = new LanguagePackRegistry();
  registry.register(pack);
  registry.configure({ enabledPackIds: [] });
  const disabled = await registry.analyze('fake', request);
  assert.equal(disabled.diagnostics[0]?.code, 'pack_disabled');

  const candidate = registry.registerCandidate({
    ...pack,
    manifest: { ...pack.manifest, id: 'incompatible', contractVersion: 2 },
  });
  assert.deepEqual(
    candidate.diagnostics.map((item) => item.code),
    ['pack_incompatible'],
  );
  const unavailable = registry.configure({
    enabledPackIds: ['incompatible', 'missing'],
  });
  assert.deepEqual(
    unavailable.diagnostics.map((item) => item.code),
    ['pack_incompatible', 'pack_unavailable'],
  );
});

test('a valid duplicate candidate reports a registration conflict, not incompatibility', () => {
  const registry = new LanguagePackRegistry();
  assert.deepEqual(
    registry.registerCandidate(localPack('duplicate', ['.dup'])),
    {
      diagnostics: [],
    },
  );
  assert.deepEqual(
    registry.registerCandidate(localPack('duplicate', ['.dup'])).diagnostics,
    [
      {
        code: 'pack_already_registered',
        severity: 'error',
        message: 'Language pack is already registered.',
      },
    ],
  );
  const plan = registry.configure({ enabledPackIds: ['duplicate'] });
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.extensions, ['.dup']);
});

test('analyze and discovery stop before pack or filesystem access for an invalid plan', async () => {
  let invocations = 0;
  const registry = new LanguagePackRegistry();
  registry.register({
    ...localPack('first', ['.shared']),
    analyze: () => {
      invocations += 1;
      return {
        pack: { id: 'first', version: '1.0.0' },
        nodes: [],
        edges: [],
        diagnostics: [],
      };
    },
  });
  registry.register(localPack('second', ['.shared']));
  registry.configure({ enabledPackIds: ['first', 'second'] });

  const analysis = await registry.analyze('first', request);
  assert.deepEqual(
    analysis.diagnostics.map((item) => item.code),
    ['pack_duplicate_extension'],
  );
  assert.equal(invocations, 0);

  let filesystemAccessed = false;
  const result = await registry.discover('unused', {
    filesystem: new Proxy(
      {},
      {
        get: () => {
          filesystemAccessed = true;
          throw new Error('filesystem must not be accessed');
        },
      },
    ) as never,
  });
  assert.equal(filesystemAccessed, false);
  assert.equal(result.discovery, undefined);
  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    ['pack_duplicate_extension'],
  );
});

test('empty enabled-pack union returns without filesystem traversal', async () => {
  const registry = new LanguagePackRegistry();
  registry.configure({ enabledPackIds: [] });
  let filesystemAccessed = false;
  const result = await registry.discover('unused', {
    filesystem: new Proxy(
      {},
      {
        get: () => {
          filesystemAccessed = true;
          throw new Error('filesystem must not be accessed');
        },
      },
    ) as never,
  });
  assert.equal(filesystemAccessed, false);
  assert.equal(result.discovery, undefined);
  assert.deepEqual(result.dispatches, []);
  assert.deepEqual(result.diagnostics, []);
});

test('malformed and stale selection configuration returns stable diagnostics', async () => {
  const registry = new LanguagePackRegistry();
  registry.register(localPack('first', ['.first']));
  registry.register(localPack('second', ['.second']));
  const throwingConfiguration = new Proxy(
    {},
    {
      get: () => {
        throw new Error('configuration getter must not escape');
      },
    },
  );
  const malformed: unknown[] = [
    {},
    { enabledPackIds: {} },
    { enabledPackIds: ['first'], extensionOwners: [] },
    throwingConfiguration,
  ];
  for (const value of malformed) {
    const plan = registry.configure(value as LanguagePackSelection);
    assert.deepEqual(
      plan.diagnostics.map((item) => item.code),
      ['pack_selection_ambiguous'],
    );
  }
  let filesystemAccessed = false;
  const malformedDiscovery = await registry.discover('unused', {
    filesystem: new Proxy(
      {},
      {
        get: () => {
          filesystemAccessed = true;
          throw new Error('filesystem must not be accessed');
        },
      },
    ) as never,
  });
  assert.equal(filesystemAccessed, false);
  assert.equal(malformedDiscovery.discovery, undefined);
  assert.equal(
    malformedDiscovery.diagnostics[0]?.code,
    'pack_selection_ambiguous',
  );

  const orphan = registry.configure({
    enabledPackIds: ['first'],
    extensionOwners: { '.missing': 'first' },
  });
  assert.equal(orphan.diagnostics[0]?.code, 'pack_selection_ambiguous');
  const stale = registry.configure({
    enabledPackIds: ['first'],
    extensionOwners: { '.first': 'second' },
  });
  assert.equal(stale.diagnostics[0]?.code, 'pack_selection_ambiguous');
});

test('a candidate with a throwing manifest getter is contained as incompatible', () => {
  const registry = new LanguagePackRegistry();
  const candidate = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'manifest')
          throw new Error('manifest getter must not escape');
        return undefined;
      },
    },
  );
  assert.deepEqual(registry.registerCandidate(candidate).diagnostics, [
    {
      code: 'pack_incompatible',
      severity: 'error',
      message: 'Language pack is incompatible with the Core contract.',
    },
  ]);
});

test('a registered manifest is snapshotted before later mutation or getter replacement', async () => {
  const manifest = {
    contractVersion: 1 as const,
    id: 'stable',
    version: '1.0.0',
    extensions: ['.stable'],
    executionMode: 'in-process' as const,
    capabilities: ['source-analysis'] as const,
  };
  const local: LanguagePack = {
    manifest,
    analyze: () => ({
      pack: { id: 'stable', version: '1.0.0' },
      nodes: [],
      edges: [],
      diagnostics: [],
    }),
  };
  const registry = new LanguagePackRegistry();
  registry.register(local);
  manifest.id = 'changed';
  manifest.version = '2.0.0';
  manifest.extensions = ['.changed'];
  Object.defineProperty(local, 'manifest', {
    get: () => {
      throw new Error('registered manifest must not be read again');
    },
  });

  const plan = registry.configure({ enabledPackIds: ['stable'] });
  assert.deepEqual(plan.extensions, ['.stable']);
  const result = await registry.analyze('stable', request);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.fragment?.pack.id, 'stable');
});
