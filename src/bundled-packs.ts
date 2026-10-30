import { type LanguagePack } from './packs.js';
import { typescriptPack } from './packs/typescript.js';

/**
 * The sole source-owned list of packs bundled with SourceMesh. CI imports this
 * list for the mandatory conformance profile before application bootstrap.
 */
export const BUNDLED_LANGUAGE_PACKS: readonly LanguagePack[] = Object.freeze([
  typescriptPack,
]);
