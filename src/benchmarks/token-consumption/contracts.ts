export const TOKEN_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const TOKEN_BENCHMARK_MANIFEST_VERSION = 1 as const;

export type TokenBenchmarkLanguage = 'typescript' | 'csharp';
export type SnapshotVerification = 'verified' | 'partial' | 'unverified';
export type TokenScenarioStatus =
  'supported' | 'unsupported' | 'not-applicable';
export type EvidenceKind = 'declaration' | 'direct-caller' | 'direct-call';

export interface SourceEvidence {
  readonly path: string;
  readonly anchor: string;
  readonly kind: EvidenceKind;
}

export interface GroundTruthFact {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly qualifiedName: string;
  readonly evidence: readonly SourceEvidence[];
}

export interface FrozenPrompt {
  readonly id: string;
  readonly text: string;
  readonly requiredFactIds: readonly string[];
  readonly stoppingCriteria: readonly string[];
}

export interface TokenScenario {
  readonly id: string;
  readonly language: TokenBenchmarkLanguage;
  readonly question: string;
  readonly scope: {
    readonly project: string;
    readonly roots: readonly string[];
  };
  readonly prompts: readonly FrozenPrompt[];
  readonly groundTruth: readonly GroundTruthFact[];
  readonly unsupportedRelationships: readonly string[];
  readonly status: TokenScenarioStatus;
}

export interface TokenBenchmarkManifest {
  readonly schemaVersion: typeof TOKEN_BENCHMARK_SCHEMA_VERSION;
  readonly manifestVersion: typeof TOKEN_BENCHMARK_MANIFEST_VERSION;
  readonly id: string;
  readonly fixture: {
    readonly root: string;
    readonly revision: string;
    readonly contentFingerprint: string;
  };
  readonly tokenizer: {
    readonly package: 'tiktoken';
    readonly packageVersion: string;
    readonly defaultEncoding: string;
    readonly supportedEncodings: readonly string[];
  };
  readonly limits: {
    readonly maxOperations: number;
    readonly maxSearchResults: number;
    readonly maxReadBytes: number;
    readonly maxPayloadBytes: number;
  };
  readonly snapshot: {
    readonly required: boolean;
    readonly verification: SnapshotVerification;
    readonly preparationExcludedFromPrimaryMetric: boolean;
    readonly partialReason?: string;
  };
  readonly qualityGate: {
    readonly requireEquivalentFacts: boolean;
    readonly allowPartialForSavings: false;
    readonly invalidPairStatuses: readonly (
      'incorrect' | 'incomplete' | 'unsupported' | 'unverified'
    )[];
  };
  readonly scenarios: readonly TokenScenario[];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function pathLike(value: unknown): value is string {
  return (
    nonEmpty(value) &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.includes('..')
  );
}

export function validateTokenBenchmarkManifest(
  value: unknown,
): asserts value is TokenBenchmarkManifest {
  if (value === null || typeof value !== 'object')
    throw new TypeError('token manifest');
  const manifest = value as Partial<TokenBenchmarkManifest>;
  if (
    manifest.schemaVersion !== TOKEN_BENCHMARK_SCHEMA_VERSION ||
    manifest.manifestVersion !== TOKEN_BENCHMARK_MANIFEST_VERSION ||
    !nonEmpty(manifest.id) ||
    manifest.fixture === undefined ||
    !pathLike(manifest.fixture.root) ||
    !nonEmpty(manifest.fixture.revision) ||
    !/^[a-f0-9]{64}$/u.test(manifest.fixture.contentFingerprint) ||
    manifest.tokenizer === undefined ||
    manifest.tokenizer.package !== 'tiktoken' ||
    !nonEmpty(manifest.tokenizer.packageVersion) ||
    !nonEmpty(manifest.tokenizer.defaultEncoding) ||
    !Array.isArray(manifest.tokenizer.supportedEncodings) ||
    manifest.tokenizer.supportedEncodings.length === 0 ||
    !manifest.tokenizer.supportedEncodings.every(nonEmpty) ||
    !manifest.tokenizer.supportedEncodings.includes(
      manifest.tokenizer.defaultEncoding,
    ) ||
    manifest.limits === undefined ||
    !positiveInteger(manifest.limits.maxOperations) ||
    !positiveInteger(manifest.limits.maxSearchResults) ||
    !positiveInteger(manifest.limits.maxReadBytes) ||
    !positiveInteger(manifest.limits.maxPayloadBytes) ||
    manifest.snapshot === undefined ||
    manifest.snapshot.required !== true ||
    !['verified', 'partial', 'unverified'].includes(
      manifest.snapshot.verification,
    ) ||
    manifest.snapshot.preparationExcludedFromPrimaryMetric !== true ||
    (manifest.snapshot.verification === 'partial' &&
      !nonEmpty(manifest.snapshot.partialReason)) ||
    manifest.qualityGate === undefined ||
    manifest.qualityGate.requireEquivalentFacts !== true ||
    manifest.qualityGate.allowPartialForSavings !== false ||
    !Array.isArray(manifest.qualityGate.invalidPairStatuses) ||
    manifest.qualityGate.invalidPairStatuses.length === 0 ||
    !Array.isArray(manifest.scenarios) ||
    manifest.scenarios.length === 0
  )
    throw new TypeError('token manifest');

  const scenarioIds = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (
      scenario === null ||
      typeof scenario !== 'object' ||
      !nonEmpty(scenario.id) ||
      scenarioIds.has(scenario.id) ||
      !['typescript', 'csharp'].includes(scenario.language) ||
      !nonEmpty(scenario.question) ||
      scenario.scope === undefined ||
      !pathLike(scenario.scope.project) ||
      !Array.isArray(scenario.scope.roots) ||
      scenario.scope.roots.length === 0 ||
      !scenario.scope.roots.every(pathLike) ||
      !Array.isArray(scenario.prompts) ||
      scenario.prompts.length === 0 ||
      !Array.isArray(scenario.groundTruth) ||
      scenario.groundTruth.length === 0 ||
      !Array.isArray(scenario.unsupportedRelationships) ||
      !['supported', 'unsupported', 'not-applicable'].includes(scenario.status)
    )
      throw new TypeError('token scenario');
    scenarioIds.add(scenario.id);

    const factIds = new Set<string>();
    for (const fact of scenario.groundTruth) {
      if (
        fact === null ||
        typeof fact !== 'object' ||
        !nonEmpty(fact.id) ||
        factIds.has(fact.id) ||
        !['declaration', 'direct-caller', 'direct-call'].includes(fact.kind) ||
        !nonEmpty(fact.qualifiedName) ||
        !Array.isArray(fact.evidence) ||
        fact.evidence.length === 0 ||
        !fact.evidence.every(
          (evidence: SourceEvidence) =>
            evidence !== null &&
            typeof evidence === 'object' &&
            pathLike(evidence.path) &&
            nonEmpty(evidence.anchor) &&
            evidence.kind === fact.kind,
        )
      )
        throw new TypeError('token ground truth');
      factIds.add(fact.id);
    }

    const promptIds = new Set<string>();
    for (const prompt of scenario.prompts) {
      if (
        prompt === null ||
        typeof prompt !== 'object' ||
        !nonEmpty(prompt.id) ||
        promptIds.has(prompt.id) ||
        !nonEmpty(prompt.text) ||
        !Array.isArray(prompt.requiredFactIds) ||
        prompt.requiredFactIds.length === 0 ||
        !prompt.requiredFactIds.every((id: string) => factIds.has(id)) ||
        !Array.isArray(prompt.stoppingCriteria) ||
        prompt.stoppingCriteria.length === 0 ||
        !prompt.stoppingCriteria.every(nonEmpty)
      )
        throw new TypeError('token prompt');
      promptIds.add(prompt.id);
    }
  }
}
