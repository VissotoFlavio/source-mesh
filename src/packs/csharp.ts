import { discoverCSharpManifest } from './csharp/discovery.js';
import { extractCSharpDeclarationGraph } from './csharp/extractor.js';
import { analyzeCSharpManifest } from './csharp/worker.js';

/** The source-owned C# pack boundary used by the CLI. */
export const csharpPack = Object.freeze({
  manifest: Object.freeze({
    contractVersion: 1 as const,
    id: 'csharp',
    version: '1.0.0',
    extensions: Object.freeze(['.cs']),
    executionMode: 'local-worker' as const,
    capabilities: Object.freeze([
      'project-manifest',
      'source-analysis',
      'semantic-relations',
    ] as const),
  }),
  discover: discoverCSharpManifest,
  analyze: analyzeCSharpManifest,
  extract: extractCSharpDeclarationGraph,
});

export {
  discoverCSharpManifest,
  extractCSharpDeclarationGraph,
  analyzeCSharpManifest,
};
