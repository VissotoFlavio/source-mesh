import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LanguagePack } from '../src/packs.js';
import { BUNDLED_LANGUAGE_PACKS } from '../src/bundled-packs.js';
import {
  analyzeConformanceFixture,
  assertLanguagePackConforms,
  registerConformantBundledLanguagePacks,
} from './helpers/language-pack-conformance.js';

const compliantPack: LanguagePack = {
  manifest: {
    contractVersion: 1,
    id: 'conformance-fixture',
    version: '1.0.0',
    extensions: ['.fixture'],
    executionMode: 'in-process',
    capabilities: ['source-analysis'],
  },
  analyze: (request) => ({
    pack: { id: 'conformance-fixture', version: '1.0.0' },
    nodes: [
      {
        key: 'module',
        kind: 'module',
        path: request.files[0]!.path,
        name: 'module',
      },
    ],
    edges: [],
    diagnostics: [],
  }),
};

function fixture(id: string, analyze: LanguagePack['analyze']): LanguagePack {
  return {
    manifest: { ...compliantPack.manifest, id },
    analyze,
  };
}

test('mandatory language-pack conformance profile accepts a compliant bundled pack', async () => {
  const fragment = await assertLanguagePackConforms(compliantPack);
  assert.deepEqual(
    fragment.nodes.map((node) => node.key),
    ['module'],
  );
});

test('CI traverses the authoritative source-owned bundled-pack list', async () => {
  const result = await registerConformantBundledLanguagePacks(
    BUNDLED_LANGUAGE_PACKS,
  );
  assert.deepEqual(
    result.registeredPackIds,
    BUNDLED_LANGUAGE_PACKS.map((pack) => pack.manifest.id),
  );
  assert.deepEqual(result.excludedPackIds, []);
});

test('the bundled-pack CI matrix excludes a candidate that fails the profile', async () => {
  const nonconforming = fixture('excluded', () => ({
    pack: { id: 'excluded', version: '1.0.0' },
    nodes: [
      { key: 'outside', kind: 'module', path: '/outside.fixture', name: 'x' },
    ],
    edges: [],
    diagnostics: [],
  }));
  const result = await registerConformantBundledLanguagePacks([
    compliantPack,
    nonconforming,
  ]);
  assert.deepEqual(result.registeredPackIds, ['conformance-fixture']);
  assert.deepEqual(result.excludedPackIds, ['excluded']);
  result.registry.configure({ enabledPackIds: ['excluded'] });
  assert.equal(
    result.registry.discoveryPlan().diagnostics[0]?.code,
    'pack_unavailable',
  );
});

test('conformance fixtures reject malformed, unauthorized, and over-limit fragments', async () => {
  const malformed = await analyzeConformanceFixture(
    fixture('malformed', () => undefined as never),
  );
  const unauthorized = await analyzeConformanceFixture(
    fixture('unauthorized', () => ({
      pack: { id: 'unauthorized', version: '1.0.0' },
      nodes: [
        { key: 'outside', kind: 'module', path: '/outside.fixture', name: 'x' },
      ],
      edges: [],
      diagnostics: [],
    })),
  );
  const overLimit = await analyzeConformanceFixture(
    fixture('over-limit', () => ({
      pack: { id: 'over-limit', version: '1.0.0' },
      nodes: [
        { key: 'a', kind: 'module', path: 'src/approved.fixture', name: 'a' },
        { key: 'b', kind: 'module', path: 'src/approved.fixture', name: 'b' },
      ],
      edges: [],
      diagnostics: [],
    })),
  );

  for (const result of [malformed, unauthorized, overLimit]) {
    assert.equal(result.fragment, undefined);
    assert.equal(result.diagnostics[0]?.code, 'pack_response_invalid');
  }
});

test('a pack cannot mutate its closed request to approve an absolute path', async () => {
  const result = await analyzeConformanceFixture(
    fixture('mutating-request', (request) => {
      (request.files[0] as { path: string }).path = '/outside.fixture';
      return {
        pack: { id: 'mutating-request', version: '1.0.0' },
        nodes: [
          {
            key: 'outside',
            kind: 'module',
            path: '/outside.fixture',
            name: 'outside',
          },
        ],
        edges: [],
        diagnostics: [],
      };
    }),
  );
  assert.equal(result.fragment, undefined);
  assert.equal(result.diagnostics[0]?.code, 'pack_response_invalid');
});

test('conformance fixtures reject unsupported evidence values', async () => {
  const result = await analyzeConformanceFixture(
    fixture('unsupported-evidence', () => ({
      pack: { id: 'unsupported-evidence', version: '1.0.0' },
      nodes: [
        { key: 'a', kind: 'module', path: 'src/approved.fixture', name: 'a' },
      ],
      edges: [
        { kind: 'uses', from: 'a', to: 'a', confidence: 'guessed' as never },
      ],
      diagnostics: [],
    })),
  );
  assert.equal(result.diagnostics[0]?.code, 'pack_response_invalid');
});

test('the mandatory profile detects nondeterministic pack output', async () => {
  let invocation = 0;
  const nondeterministic = fixture('nondeterministic', (request) => ({
    pack: { id: 'nondeterministic', version: '1.0.0' },
    nodes: [
      {
        key: invocation++ % 2 === 0 ? 'first' : 'second',
        kind: 'module',
        path: request.files[0]!.path,
        name: 'module',
      },
    ],
    edges: [],
    diagnostics: [],
  }));
  await assert.rejects(() => assertLanguagePackConforms(nondeterministic));
});

test('the mandatory profile detects nondeterministic raw ordering', async () => {
  let invocation = 0;
  const reordered = fixture('reordered', (request) => {
    const nodes = [
      { key: 'a', kind: 'module', path: request.files[0]!.path, name: 'a' },
      { key: 'b', kind: 'module', path: request.files[0]!.path, name: 'b' },
    ];
    if (invocation++ % 2 === 1) nodes.reverse();
    return {
      pack: { id: 'reordered', version: '1.0.0' },
      nodes,
      edges: [],
      diagnostics: [],
    };
  });
  await assert.rejects(() => assertLanguagePackConforms(reordered));
});
