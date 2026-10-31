import { type LanguagePack } from './packs.js';
import { csharpPack } from './packs/csharp.js';
import { typescriptPack } from './packs/typescript.js';

/**
 * The sole source-owned list of packs available on this host. The Roslyn
 * helper is Windows-only, so it cannot enter a cross-platform conformance run.
 */
export const BUNDLED_LANGUAGE_PACKS: readonly LanguagePack[] = Object.freeze([
  typescriptPack,
  ...(process.platform === 'win32' ? [csharpPack] : []),
]);
