import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCAL_WORKER_PROTOCOL_VERSION } from '../src/local-worker.js';
import { resolveLocalPackInstallation } from '../src/pack-installation.js';
import {
  LanguagePackRegistry,
  type AnalysisRequest,
  type LanguagePack,
} from '../src/packs.js';

function pack(
  id: string,
  version = '1.0.0',
  executionMode: 'in-process' | 'local-worker' = 'in-process',
): LanguagePack {
  return {
    manifest: {
      contractVersion: 1,
      id,
      version,
      extensions: [`.${id}`],
      executionMode,
      ...(executionMode === 'local-worker'
        ? { workerProtocolVersion: LOCAL_WORKER_PROTOCOL_VERSION }
        : {}),
      capabilities: ['source-analysis'],
    },
    analyze: () => ({
      pack: { id, version },
      nodes: [],
      edges: [],
      diagnostics: [],
    }),
  };
}

const configuration = {
  version: 1,
  core: { packContractVersion: 1 },
  packs: [
    { id: 'disabled', version: '1.0.0', enabled: false },
    { id: 'enabled', version: '1.0.0', enabled: true },
  ],
} as const;

const request: AnalysisRequest = {
  contractVersion: 1,
  repository: { name: 'fixture', root: '.' },
  files: [],
  limits: {
    maxFiles: 1,
    maxBytes: 1,
    maxNodes: 1,
    maxEdges: 1,
    maxDiagnostics: 1,
  },
  configuration: {},
};

test('resolves only exact, explicitly enabled local pack versions', async () => {
  const disabled = pack('disabled');
  const enabled = pack('enabled');
  const result = resolveLocalPackInstallation(configuration, [
    enabled,
    disabled,
  ]);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.packs.map((candidate) => candidate.manifest.id),
    ['disabled', 'enabled'],
  );
  assert.deepEqual(result.selection, { enabledPackIds: ['enabled'] });

  const registry = new LanguagePackRegistry();
  for (const candidate of result.packs) registry.register(candidate);
  registry.configure(result.selection);
  assert.equal(registry.discoveryPlan().diagnostics.length, 0);
  assert.equal(
    (await registry.analyze('disabled', request)).diagnostics[0]?.code,
    'pack_disabled',
  );
});

test('reports unavailable and incompatible installed packs before configuration can enable them', async () => {
  const missing = resolveLocalPackInstallation(
    {
      version: 1,
      core: { packContractVersion: 1 },
      packs: [{ id: 'missing', version: '1.0.0', enabled: true }],
    },
    [],
  );
  assert.deepEqual(
    missing.diagnostics.map((item) => item.code),
    ['pack_unavailable'],
  );
  assert.deepEqual(missing.selection, { enabledPackIds: [] });

  const incompatible = resolveLocalPackInstallation(
    {
      version: 1,
      core: { packContractVersion: 1 },
      packs: [{ id: 'installed', version: '2.0.0', enabled: true }],
    },
    [pack('installed', '1.0.0')],
  );
  assert.deepEqual(
    incompatible.diagnostics.map((item) => item.code),
    ['pack_incompatible'],
  );
  assert.deepEqual(incompatible.packs, []);

  let invocations = 0;
  const rejected = pack('rejected', '1.0.0');
  const candidate: LanguagePack = {
    ...rejected,
    analyze: () => {
      invocations += 1;
      return rejected.analyze(request);
    },
  };
  const result = resolveLocalPackInstallation(
    {
      version: 1,
      core: { packContractVersion: 1 },
      packs: [{ id: 'rejected', version: '2.0.0', enabled: true }],
    },
    [candidate],
  );
  const registry = new LanguagePackRegistry();
  for (const accepted of result.packs) registry.register(accepted);
  registry.configure(result.selection);
  await registry.analyze('rejected', request);
  assert.equal(invocations, 0);
});

test('requires the configured local-worker protocol before accepting a worker pack', () => {
  const installed = pack('worker', '1.0.0', 'local-worker');
  const missing = resolveLocalPackInstallation(
    {
      version: 1,
      core: { packContractVersion: 1 },
      packs: [{ id: 'worker', version: '1.0.0', enabled: true }],
    },
    [installed],
  );
  assert.deepEqual(
    missing.diagnostics.map((item) => item.code),
    ['pack_incompatible'],
  );
  assert.deepEqual(missing.selection, { enabledPackIds: [] });

  const incompatible = resolveLocalPackInstallation(
    {
      version: 1,
      core: { packContractVersion: 1 },
      packs: [
        {
          id: 'worker',
          version: '1.0.0',
          enabled: true,
          workerProtocolVersion: LOCAL_WORKER_PROTOCOL_VERSION + 1,
        },
      ],
    },
    [installed],
  );
  assert.deepEqual(
    incompatible.diagnostics.map((item) => item.code),
    ['pack_incompatible'],
  );
  assert.deepEqual(incompatible.selection, { enabledPackIds: [] });

  const compatible = resolveLocalPackInstallation(
    {
      version: 1,
      core: { packContractVersion: 1 },
      packs: [
        {
          id: 'worker',
          version: '1.0.0',
          enabled: true,
          workerProtocolVersion: LOCAL_WORKER_PROTOCOL_VERSION,
        },
      ],
    },
    [installed],
  );
  assert.deepEqual(compatible.diagnostics, []);
  assert.deepEqual(compatible.selection, { enabledPackIds: ['worker'] });
});

test('rejects malformed or unsupported local installation configuration without selecting a pack', () => {
  for (const configuration of [
    {},
    { version: 2, core: { packContractVersion: 1 }, packs: [] },
    { version: 1, core: { packContractVersion: 2 }, packs: [] },
    {
      version: 1,
      core: { packContractVersion: 1 },
      packs: [
        { id: 'same', version: '1.0.0', enabled: true },
        { id: 'same', version: '1.0.0', enabled: true },
      ],
    },
  ]) {
    const result = resolveLocalPackInstallation(configuration, [pack('same')]);
    assert.deepEqual(
      result.diagnostics.map((item) => item.code),
      ['pack_installation_invalid'],
    );
    assert.deepEqual(result.packs, []);
    assert.deepEqual(result.selection, { enabledPackIds: [] });
  }
});
