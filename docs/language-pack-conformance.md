# Language-pack conformance

Every bundled language pack must be added to the source-owned
`BUNDLED_LANGUAGE_PACKS` list in `src/bundled-packs.ts`. CI always traverses
that list through `registerConformantBundledLanguagePacks(...)` in
`test/helpers/language-pack-conformance.ts`; that registration path excludes a
candidate whose mandatory profile fails.

SourceMesh has no bundled implementation yet. The TypeScript and C# migrations
must add their packs to this list before adding their application bootstrap;
there is deliberately no unguarded bundled-pack registration helper.

The profile supplies an immutable Core-owned request, compares two raw pack
responses before the registry can normalize them, then registers and invokes
the candidate through `LanguagePackRegistry`. It checks the manifest and
request boundary, fragment identity, deterministic ordering, sanitized
diagnostics, and declared resource limits through the same validation boundary
used at runtime.

The fixture matrix in `test/packs-conformance.test.ts` must remain in CI. It
proves that malformed output, absolute or unapproved paths, unsupported
relation evidence, responses beyond resource limits, and nondeterministic
results are rejected as `pack_response_invalid`.

The profile is local and offline. It never grants a pack repository-root,
filesystem, network, process, or package-install authority. Future bundled
TypeScript and C# packs must be added to the source-owned list when introduced.
