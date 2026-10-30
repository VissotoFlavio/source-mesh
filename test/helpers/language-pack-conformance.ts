import assert from 'node:assert/strict';

import {
  LanguagePackRegistry,
  type AnalysisRequest,
  type GraphFragment,
  type LanguagePack,
  type PackAnalysisResult,
} from '../../src/packs.js';

const encoder = new TextEncoder();

function requestFor(pack: LanguagePack): AnalysisRequest {
  const extension = pack.manifest.extensions[0];
  assert.notEqual(extension, undefined, 'a pack needs one source extension');
  return Object.freeze({
    contractVersion: 1,
    repository: Object.freeze({ name: 'conformance', root: '.' as const }),
    files: Object.freeze([
      Object.freeze({
        path: `src/main${extension}`,
        contents: encoder.encode('export const conformance = true;\n'),
      }),
    ]),
    limits: Object.freeze({
      maxFiles: 1,
      maxBytes: 64,
      maxNodes: 4,
      maxEdges: 4,
      maxDiagnostics: 4,
    }),
    configuration: Object.freeze({ conformance: true }),
  });
}

/**
 * Runs the mandatory local conformance profile for one bundled language pack.
 * A pack is exercised only through the Core-owned registry and a closed
 * request; callers should invoke this helper from the CI test for each pack.
 */
export async function assertLanguagePackConforms(
  pack: LanguagePack,
): Promise<GraphFragment> {
  const request = requestFor(pack);
  const rawFirst = await pack.analyze(request);
  const rawSecond = await pack.analyze(request);
  assert.deepEqual(
    rawFirst,
    rawSecond,
    'a pack must return deterministic raw fragment ordering',
  );
  const registry = new LanguagePackRegistry();
  assert.deepEqual(registry.registerCandidate(pack).diagnostics, []);
  assert.deepEqual(
    registry.configure({ enabledPackIds: [pack.manifest.id] }).diagnostics,
    [],
  );

  const first = await registry.analyze(pack.manifest.id, request);
  const second = await registry.analyze(pack.manifest.id, request);
  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(second.diagnostics, []);
  const fragment = first.fragment;
  if (fragment === undefined) throw new Error('a pack must return a fragment');
  assert.notEqual(second.fragment, undefined);
  assert.deepEqual(
    fragment,
    second.fragment,
    'a pack must return deterministic normalized fragments',
  );
  return fragment;
}

export interface BundledLanguagePackRegistration {
  readonly registry: LanguagePackRegistry;
  readonly registeredPackIds: readonly string[];
  readonly excludedPackIds: readonly string[];
}

/**
 * The single CI registration path for a bundled pack: a candidate enters the
 * registry only after its mandatory profile succeeds.
 */
export async function registerConformantBundledLanguagePacks(
  packs: readonly LanguagePack[],
): Promise<BundledLanguagePackRegistration> {
  const registry = new LanguagePackRegistry();
  const registeredPackIds: string[] = [];
  const excludedPackIds: string[] = [];
  for (const pack of packs) {
    try {
      await assertLanguagePackConforms(pack);
      assert.deepEqual(registry.registerCandidate(pack).diagnostics, []);
      registeredPackIds.push(pack.manifest.id);
    } catch {
      excludedPackIds.push(pack.manifest.id);
    }
  }
  return Object.freeze({
    registry,
    registeredPackIds: Object.freeze(registeredPackIds),
    excludedPackIds: Object.freeze(excludedPackIds),
  });
}

/** Exercises the Core boundary used by every malformed conformance fixture. */
export async function analyzeConformanceFixture(
  pack: LanguagePack,
): Promise<PackAnalysisResult> {
  const registry = new LanguagePackRegistry();
  registry.register(pack);
  registry.configure({ enabledPackIds: [pack.manifest.id] });
  return await registry.analyze(pack.manifest.id, {
    contractVersion: 1,
    repository: { name: 'conformance', root: '.' },
    files: [
      {
        path: 'src/approved.fixture',
        contents: encoder.encode('fixture'),
      },
    ],
    limits: {
      maxFiles: 1,
      maxBytes: 7,
      maxNodes: 1,
      maxEdges: 1,
      maxDiagnostics: 1,
    },
    configuration: {},
  });
}
