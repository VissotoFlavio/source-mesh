import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkManifest,
  validateBenchmarkManifest,
} from './contracts.js';

export const OFFICIAL_SYNTHETIC_MANIFEST: BenchmarkManifest = {
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  id: 'official-synthetic-v1',
  fixture: 'benchmarks/fixtures/typescript',
  analysis: { language: 'typescript', tsconfig: 'tsconfig.json' },
  scenarios: [
    {
      id: 'ts-symbol-duplicate-name',
      language: 'typescript',
      category: 'symbol-discovery',
      question: 'Where are the two PaymentRecord classes declared?',
      strategy: 'search-symbol',
      target: 'PaymentRecord',
      kind: 'class',
      expected: {
        values: [
          'PaymentRecord|src/models/payment-record.ts',
          'PaymentRecord|src/models/audit-record.ts',
        ],
      },
    },
    {
      id: 'js-symbol-start',
      language: 'typescript',
      category: 'symbol-discovery',
      question: 'Where is the JavaScript start function declared?',
      strategy: 'search-symbol',
      target: 'start',
      kind: 'function',
      expected: { values: ['start|src/entry.js'] },
    },
    {
      id: 'ts-callers-process-payment',
      language: 'typescript',
      category: 'call-relationships',
      question: 'Which functions directly call processPayment?',
      strategy: 'list-callers',
      target: 'processPayment',
      expected: {
        values: [
          'queuePayment|src/workflows/queue.ts',
          'retryPayment|src/workflows/retry.ts',
        ],
        knownLimitations: [
          'Only direct, statically resolved local calls are expected.',
        ],
      },
    },
    {
      id: 'ts-file-dependencies-queue',
      language: 'typescript',
      category: 'file-dependencies',
      question: 'Which direct local files does queue.ts depend on?',
      strategy: 'list-file-dependencies',
      target: 'src/workflows/queue.ts',
      expected: { values: ['processor.ts|src/processor.ts'] },
    },
    {
      id: 'ts-file-dependents-processor',
      language: 'typescript',
      category: 'file-dependencies',
      question: 'Which direct local files depend on processor.ts?',
      strategy: 'list-file-dependents',
      target: 'src/processor.ts',
      expected: {
        values: [
          'queue.ts|src/workflows/queue.ts',
          'retry.ts|src/workflows/retry.ts',
        ],
      },
    },
  ],
};

validateBenchmarkManifest(OFFICIAL_SYNTHETIC_MANIFEST);

export const OFFICIAL_CSHARP_MANIFEST: BenchmarkManifest = {
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  id: 'official-csharp-synthetic-v1',
  fixture: 'test/fixtures/csharp-project',
  analysis: { language: 'csharp', solution: 'Synthetic.sln' },
  scenarios: [
    {
      id: 'csharp-symbol-application',
      language: 'csharp',
      category: 'symbol-discovery',
      question: 'Where is the Application class declared?',
      strategy: 'search-symbol',
      target: 'Application',
      kind: 'class',
      expected: { values: ['Application|src/App/Entry.cs'] },
    },
    {
      id: 'csharp-callers-process',
      language: 'csharp',
      category: 'call-relationships',
      question: 'Which functions directly call Process?',
      strategy: 'list-callers',
      target: 'Process',
      qualifiedName: 'Synthetic.App.Application.Process(int)',
      expected: { values: ['Run|src/App/Entry.cs'] },
    },
  ],
};

validateBenchmarkManifest(OFFICIAL_CSHARP_MANIFEST);
