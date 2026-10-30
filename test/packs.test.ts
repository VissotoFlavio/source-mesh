import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LanguagePackRegistry,
  type AnalysisRequest,
  type LanguagePack,
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

test('a registered fake pack receives only approved files and returns a deterministic fragment', async () => {
  const registry = new LanguagePackRegistry();
  registry.register(pack);
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
  const result = await registry.analyze('unsafe', request);
  assert.equal(result.fragment, undefined);
  assert.equal(result.diagnostics[0]?.code, 'pack_response_invalid');
});

test('requests reject arbitrary repository-root authority before a pack runs', async () => {
  const registry = new LanguagePackRegistry();
  registry.register(pack);
  const result = await registry.analyze('fake', {
    ...request,
    repository: { name: 'fixture', root: 'C:/outside' as '.' },
  });
  assert.equal(result.fragment, undefined);
  assert.equal(result.diagnostics[0]?.code, 'pack_request_invalid');
});
