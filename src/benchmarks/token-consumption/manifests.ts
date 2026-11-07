import {
  TOKEN_BENCHMARK_MANIFEST_VERSION,
  TOKEN_BENCHMARK_SCHEMA_VERSION,
  type TokenBenchmarkManifest,
  validateTokenBenchmarkManifest,
} from './contracts.js';

export const TOKEN_BENCHMARK_MANIFEST: TokenBenchmarkManifest = {
  schemaVersion: TOKEN_BENCHMARK_SCHEMA_VERSION,
  manifestVersion: TOKEN_BENCHMARK_MANIFEST_VERSION,
  id: 'context-token-contracts-v1',
  fixture: {
    root: 'benchmarks/fixtures/token-consumption',
    revision: 'token-consumption-fixture-v1',
    contentFingerprint:
      '36d8015a54efe9479c84a403a656744b9faf43037cf5e80c5ae9dbd920332ae2',
  },
  tokenizer: {
    package: 'tiktoken',
    packageVersion: '1.0.22',
    defaultEncoding: 'o200k_base',
    supportedEncodings: ['o200k_base'],
  },
  limits: {
    maxOperations: 32,
    maxSearchResults: 32,
    maxReadBytes: 64 * 1024,
    maxPayloadBytes: 128 * 1024,
  },
  snapshot: {
    required: true,
    verification: 'verified',
    preparationExcludedFromPrimaryMetric: true,
  },
  qualityGate: {
    requireEquivalentFacts: true,
    allowPartialForSavings: false,
    invalidPairStatuses: [
      'incorrect',
      'incomplete',
      'unsupported',
      'unverified',
    ],
  },
  scenarios: [
    {
      id: 'csharp-lookup-vehicle-plate-handler-v1',
      language: 'csharp',
      question:
        'What is the exact declaration, which four local methods directly call it, and which direct calls does it make?',
      scope: {
        project: 'src/LookupVehiclePlate/LookupVehiclePlate.csproj',
        roots: ['src/LookupVehiclePlate'],
      },
      prompts: [
        {
          id: 'csharp-lookup-declaration-v1',
          text: 'Locate LookupVehiclePlateHandler.ProjectAsync(VehiclePlateEntity, CancellationToken) and return its exact qualified declaration with source evidence.',
          requiredFactIds: ['lookup-declaration'],
          stoppingCriteria: [
            'Stop after the exact declaration and a bounded source read establish the signature.',
          ],
        },
        {
          id: 'csharp-lookup-callers-v1',
          text: 'Identify the four local direct callers of LookupVehiclePlateHandler.ProjectAsync(VehiclePlateEntity, CancellationToken) and provide source evidence for each call.',
          requiredFactIds: [
            'caller-list-1',
            'caller-list-2',
            'caller-list-3',
            'caller-list-4',
          ],
          stoppingCriteria: [
            'Stop only after four distinct local direct call sites are evidenced.',
            'Do not infer indirect, dynamic, extension, or namespace-level relationships.',
          ],
        },
        {
          id: 'csharp-lookup-callees-v1',
          text: 'Identify the direct calls made by LookupVehiclePlateHandler.ProjectAsync(VehiclePlateEntity, CancellationToken) and provide source evidence for each call.',
          requiredFactIds: [
            'callee-cancellation',
            'callee-map',
            'callee-normalize',
          ],
          stoppingCriteria: [
            'Stop only after the method body is read and all direct calls are evidenced.',
            'Do not infer transitive calls or dynamic dispatch.',
          ],
        },
      ],
      groundTruth: [
        {
          id: 'lookup-declaration',
          kind: 'declaration',
          qualifiedName:
            'SourceMesh.TokenFixture.LookupVehiclePlateHandler.ProjectAsync(SourceMesh.TokenFixture.VehiclePlateEntity, System.Threading.CancellationToken)',
          evidence: [
            {
              path: 'src/LookupVehiclePlate/LookupVehiclePlateHandler.cs',
              anchor:
                'ProjectAsync(VehiclePlateEntity entity, CancellationToken cancellationToken)',
              kind: 'declaration',
            },
          ],
        },
        ...(
          [
            'SearchAsync',
            'RetryAsync',
            'PublishAuditAsync',
            'ProjectBatchAsync',
          ] as const
        ).map((name, index) => ({
          id: `caller-list-${index + 1}`,
          kind: 'direct-caller' as const,
          qualifiedName: `SourceMesh.TokenFixture.LookupVehiclePlateHandler.${name}(...)`,
          evidence: [
            {
              path: 'src/LookupVehiclePlate/LookupVehiclePlateHandler.cs',
              anchor: '=> ProjectAsync(entity, cancellationToken)',
              kind: 'direct-caller' as const,
            },
          ],
        })),
        {
          id: 'callee-cancellation',
          kind: 'direct-call',
          qualifiedName:
            'System.Threading.CancellationToken.ThrowIfCancellationRequested()',
          evidence: [
            {
              path: 'src/LookupVehiclePlate/LookupVehiclePlateHandler.cs',
              anchor: 'cancellationToken.ThrowIfCancellationRequested()',
              kind: 'direct-call',
            },
          ],
        },
        {
          id: 'callee-map',
          kind: 'direct-call',
          qualifiedName:
            'SourceMesh.TokenFixture.VehiclePlateProjection.Map(VehiclePlateEntity)',
          evidence: [
            {
              path: 'src/LookupVehiclePlate/LookupVehiclePlateHandler.cs',
              anchor: 'VehiclePlateProjection.Map(entity)',
              kind: 'direct-call',
            },
          ],
        },
        {
          id: 'callee-normalize',
          kind: 'direct-call',
          qualifiedName:
            'SourceMesh.TokenFixture.PlateNormalizer.Normalize(string)',
          evidence: [
            {
              path: 'src/LookupVehiclePlate/LookupVehiclePlateHandler.cs',
              anchor: 'PlateNormalizer.Normalize(entity.Plate)',
              kind: 'direct-call',
            },
          ],
        },
      ],
      unsupportedRelationships: [
        'dynamic dispatch',
        'extension methods',
        'indirect or transitive calls',
        'namespace-level uses edges',
      ],
      status: 'supported',
    },
  ],
};

// The fingerprint is deliberately checked in only after the fixture is finalized.
// Keeping validation here makes accidental edits to the frozen contract fail fast.
validateTokenBenchmarkManifest(TOKEN_BENCHMARK_MANIFEST);

export const TOKEN_TYPESCRIPT_BENCHMARK_MANIFEST: TokenBenchmarkManifest = {
  schemaVersion: TOKEN_BENCHMARK_SCHEMA_VERSION,
  manifestVersion: TOKEN_BENCHMARK_MANIFEST_VERSION,
  id: 'context-token-typescript-contracts-v1',
  fixture: {
    root: 'benchmarks/fixtures/typescript',
    revision: 'official-typescript-fixture-v1',
    contentFingerprint:
      '1bd86510086e3121a95b77a404ce48596eb783736fa58ea2e03c25f702187a44',
  },
  tokenizer: TOKEN_BENCHMARK_MANIFEST.tokenizer,
  limits: TOKEN_BENCHMARK_MANIFEST.limits,
  snapshot: TOKEN_BENCHMARK_MANIFEST.snapshot,
  qualityGate: TOKEN_BENCHMARK_MANIFEST.qualityGate,
  scenarios: [
    {
      id: 'typescript-payment-record-declarations-v1',
      language: 'typescript',
      question: 'Where are the two PaymentRecord classes declared?',
      scope: {
        project: 'tsconfig.json',
        roots: ['src'],
      },
      prompts: [
        {
          id: 'typescript-payment-record-declaration-v1',
          text: 'Locate both PaymentRecord class declarations and return each qualified identity with source evidence.',
          requiredFactIds: ['payment-record-model', 'payment-record-audit'],
          stoppingCriteria: [
            'Stop only after both distinct declarations and bounded source evidence are returned.',
            'Do not treat a substring match without a declaration as a fact.',
          ],
        },
      ],
      groundTruth: [
        {
          id: 'payment-record-model',
          kind: 'declaration',
          qualifiedName: 'PaymentRecord|src/models/payment-record.ts',
          evidence: [
            {
              path: 'src/models/payment-record.ts',
              anchor: 'class PaymentRecord',
              kind: 'declaration',
            },
          ],
        },
        {
          id: 'payment-record-audit',
          kind: 'declaration',
          qualifiedName: 'PaymentRecord|src/models/audit-record.ts',
          evidence: [
            {
              path: 'src/models/audit-record.ts',
              anchor: 'class PaymentRecord',
              kind: 'declaration',
            },
          ],
        },
      ],
      unsupportedRelationships: [],
      status: 'supported',
    },
  ],
};

validateTokenBenchmarkManifest(TOKEN_TYPESCRIPT_BENCHMARK_MANIFEST);
