# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to use [Semantic Versioning](https://semver.org/) when releases begin.

## [Unreleased]

### Added

- Added reproducible synthetic TypeScript and C# benchmark suites, structured
  JSON/CSV reporting, optional imported token telemetry, and benchmark
  methodology/highlights documentation (#161).

- Added an opt-in external C# benchmark mode with isolated source staging,
  sanitized public reports, local diagnostics, and no target-repository writes
  (#163).

- Added a sanitized five-run external C# benchmark observation and its
  reproducible public report (#165).

- Added a sanitized real-world feature-investigation benchmark observation,
  false-positive diagnosis, and staging coverage for declared resources (#165).

### Changed

- Made every C# `--project` selection exact, including a single project, and
  removed the implicit project-reference expansion mode (#163).

## [0.1.0] - 2026-11-06

### Added

- Added an optional, host-agnostic SourceMesh MCP skill for safe incremental
  graph queries; it is versioned separately from the distributed package (#156).

### Changed

- Reworked the public README around installed-package onboarding, the local
  privacy boundary, MCP limits, and a safe incremental workflow for AI agents
  (#155).

## [0.0.1-alpha.1] - 2026-11-06

### Changed

- Restricted official package-candidate generation to an explicit
  `/generate-candidate` comment on an eligible release or hotfix pull request,
  while retaining sanitized success and failure feedback on that pull request
  (#151).

- Replaced C# compilation-backed extraction with deterministic local syntax-tree
  analysis. C# snapshots now use schema v3 provenance and mark resolved local
  relationships as syntactic evidence; package references, target compilation,
  and compiler diagnostics no longer gate snapshot creation (#140).

### Fixed

- Supported bounded long C# paths and qualified names in schema-v3 snapshots,
  including chunked local-worker responses and explicit partial-result handling
  when a declaration exceeds the transport budget (#148).

- Report the repository-relative C# source file when it is not valid UTF-8,
  with guidance for the explicit Windows-1252 compatibility mode (#138).

## [0.1.0-beta.7] - 2026-10-31

### Added

- Added repeatable C# `--project` CLI selection for one explicit, immutable
  selected-project snapshot, with application/test boundary guidance (#117).

### Changed

- Granted the candidate-feedback workflow permission to comment on its
  triggering pull request (#135).

- Extended the C# MCP handover and beta acceptance guidance for explicit
  selected-project snapshots, including separate application/test boundaries
  and offline validation coverage (#118).

## [0.1.0-beta.6] - 2026-10-31

### Added

- Added a closed local pack-installation resolver with exact-version selection,
  explicit enablement, Core/manifest/worker-protocol compatibility checks, and
  offline installation guidance (#59).

- Added deterministic, offline schema-v3 composition of TypeScript/JavaScript
  and C# language packs, with MCP coverage and fail-closed cross-language
  relationship diagnostics (#58).

- Moved C# discovery, worker, and graph extraction behind the `csharp` language
  pack boundary while retaining deprecated compatibility exports (#57).

- Added a versioned, bounded local-worker protocol with static worker selection
  and fail-closed framing for out-of-process language packs (#56).

- Migrated TypeScript and JavaScript analysis through the bundled language-pack
  boundary while preserving deterministic schema-v1 snapshots (#55).

- Added a reusable, offline language-pack conformance suite covering request
  boundaries, fragment validation, determinism, diagnostics, and resource
  limits (#54).

- Added schema-v3 snapshots with deterministic language-pack provenance and
  relation evidence, plus bounded query and MCP projections that keep legacy
  schemas readable (#53).

- Added deterministic local enabled-pack extension discovery and single-owner
  dispatch, with fail-closed compatibility and selection diagnostics (#52).

- Added deterministic offline Roslyn handoff and composition for explicit C#
  project selections without expanding unselected project references (#116).

- Added canonical, selected-only C# project manifests with validated physical
  boundaries and unselected project-reference isolation (#115).

- Defined the versioned, explicit C# project-selection contract that later
  selected-project snapshots will use (#114).

- Added the validated Core-to-pack contract, deterministic fragment boundary,
  and local pack registry foundation (#51).

- Added ADR 0005, defining the local versioned language-pack architecture,
  Core-owned isolation, and the C# worker boundary (#50).

- Added release pull-request feedback for successful and failed immutable package
  candidate generation, with a safe link to the relevant workflow run (#108).

## [0.1.0-beta.5] - 2026-10-29

### Fixed

- Made immutable package candidate publication recognize the current GitHub CLI
  `release not found` response while retaining fail-closed handling for every
  other release lookup failure (#106).

- Made C# discovery and worker test fixtures use canonical Windows paths so
  their adversarial path checks exercise the fail-closed production boundaries
  consistently (#103).

### Changed

- Replaced application-specific validation and documentation with a generic,
  packaged installation and MCP-host guide for independent local use (#101).

- Removed the application-specific C# acceptance profile while retaining the
  synthetic C# and installed-package validation boundaries (#101).

## [0.1.0-beta.4] - 2026-10-29

### Changed

- Replaced mutable default analysis output with explicit, versioned immutable
  snapshots under `.sourcemesh/snapshots/`; MCP now requires an explicitly
  selected snapshot and handover starts a new pinned process (#97).

- Added the guarded GitHub workflow for immutable private package candidates,
  with exact-SHA validation, package checks, checksums, and recovery guidance
  (#84).

- Included generic C# MCP snapshot guidance in the offline package tarball and
  validate its installed link from README and MCP initialization (#94).

- Made the local C# snapshot prerequisite discoverable from MCP initialization
  and the MCP setup documentation, with a generic runbook for selection,
  encoding, and diagnostic budgets (#92).

## [0.1.0-beta.3] - 2026-10-28

### Fixed

- Made the Windows create-only snapshot cleanup regression deterministic by
  simulating successful hard-link publication at the writer boundary (#88).

- C# analysis now accepts the explicit legacy source-encoding and diagnostic
  bound options, retains compiler-diagnostic summaries without marking a
  structurally valid graph partial, and gives overloaded methods distinct
  canonical identities (#86).

## [0.1.0-beta.2] - 2026-10-27

### Added

- Corrected the Windows beta disposable-copy fallback to use supported literal
  path operations for path decomposition and destination creation while
  preserving the fail-closed safety checks (#78).

- Beta versioning and promotion policy covering the recommended
  `0.1.0-beta.1` SemVer, release metadata timing, required gates and reviews,
  evidence, rollback, and authorization limits (#74).

- Operational beta validation runbook covering synthetic, offline helper,
  packaged tarball, and opt-in real C# target gates, safe create-only execution,
  outcomes, and sanitized tester evidence (#73).

- Windows x64 local-checkout beta guide covering offline helper setup,
  create-only analysis, local MCP stdio configuration, and privacy boundaries
  (#72).

- Offline Windows x64 npm package distribution with the prebuilt .NET 10
  Roslyn helper, bundled production dependencies, third-party notices, closed
  payload/integrity validation, and installed tarball C#/MCP coverage (#69).

- Bounded SDK-style C# project metadata support for deterministic recursive
  compile removals and ignored resource/package items, with synthetic graph
  fixture coverage (#65).

- Opt-in local C# acceptance profile with a contained solution preflight,
  create-only local snapshot, aggregate sanitized output, and no
  CI or profile-level network execution (#47).

- Repository-owned synthetic C# solution fixture with offline end-to-end
  coverage for deterministic v2 snapshots, CLI/MCP DTO parity, and fail-closed
  helper and persistence paths (#46).

- Deterministic C# graph extraction from the approved Roslyn DTO, including
  schema-v2 containment, local references/uses/heritage/call edges, and
  fail-closed relationship diagnostics (#45).

- Local offline Roslyn helper boundary with staged C# inputs, a fixed helper
  invocation, and closed JSONL protocol validation (#44).

- Contained C#/.NET solution and project manifest discovery with explicit CLI
  selection, literal project metadata support, deterministic compile-file
  approval, and fail-closed XML/path/resource boundaries (#43).

- Additive schema-v2 snapshot support for local C#/.NET graph contracts,
  including solution/project/namespace nodes, `references`/`uses` edges,
  version-bound identities, v1-compatible queries, and fail-closed MCP startup.

- Repository-owned synthetic fixture and built-runtime end-to-end validation for
  discovery, loading, extraction, relationships, deterministic snapshots,
  bounded CLI queries, local MCP equivalence, malformed input, ignore rules,
  and the guarded offline flow (#26).

- Local read-only MCP `stdio` adapter with six bounded graph-query tools,
  deterministic structured/text results, closed schemas, sanitized diagnostics,
  offline enforcement, and official MCP v2 client integration coverage (#25).

- Local offline analysis and query CLI with deterministic human/JSON output,
  contained schema-v1 snapshots, explicit create-only/overwrite behavior, stable
  exit codes, and sanitized diagnostics (#24).

- Transport-neutral deterministic graph queries for symbol search/details, local
  file dependencies/dependents, and resolved callers/callees with bounded cursor
  pagination and typed errors (#23).

- Versioned schema-v1 local graph snapshots with canonical UTF-8 encoding, validated loading, contained `.sourcemesh` paths, and explicit atomic create-only/replace writes (#22).

- Checker-backed local import, export, inheritance, implementation, and direct-call relationships with deterministic edges and sanitized diagnostics (#21).
- Deterministic repository, file, module, and declaration graph extraction with containment-only edges (#20).
- Bounded local TypeScript/JavaScript project loader for deterministic analysis (#19).
- Accepted the source graph MVP architecture and schema/query contract in ADR 0002.
- Initial TypeScript project scaffold and local quality commands.
- Repository purpose, privacy boundary, and contribution workflow documentation.
- CI validation for supported Node.js versions and the offline runtime boundary.
- Automated reconciliation of merged release and hotfix pull requests from `master` into `develop`.
- Documentation of the first protected, governed delivery-path validation.

### Fixed

- Windows create-only snapshots now fall back to exclusive creation when
  hard-link publication is unavailable; a rare failed first write is retained
  for explicit `--overwrite` recovery (#80).

### Changed

- C# Roslyn analysis now persists bounded project chunks in the private staging
  directory and validates/merges the chunk protocol without a monolithic helper
  response; explicit compatibility mode supports known legacy Windows-1252
  source files (#67).

- C# Roslyn boundary now preserves sanitized compiler diagnostics and valid
  declarations when malformed syntax produces incomplete Roslyn symbols,
  avoiding a protocol-level analysis failure.

- Mantidas raízes canônicas consistentes entre descoberta, carregamento e
  extração no Windows, incluindo regressão para aliases de diretório (#38).

- Clarified ADR 0002 graph roots, module extensions, partial-result opt-in, query
  DTOs, byte determinism, overload identity, and fail-closed path containment.
- Finalized structural edge semantics, NodeNext no-`tsconfig` behavior, compiler
  context exclusions, declaration identity, and bounded query continuation rules.
- Closed the source graph contract gaps for diagnostic identity and pagination,
  exclusion and generated-file authority, standard-library context, #23–#25 query
  mappings, edge locations/status, repository naming, package type validation, and
  deterministic fixture requirements.
- Reconciled ADR 0002 with the expanded #17 contract for strict project loading,
  fail-closed isolation, hard resource caps, canonical snapshot decoding and
  atomic replacement, closed graph relationships, canonical identity hashing,
  stable diagnostics, and the six shared CLI/MCP query operations.
- Closed the remaining ADR 0002 contract gaps with exact SHA-256 framing and
  cursor vectors, lexical-scope collision rules, bounded query DTOs and sorting,
  deterministic diagnostics, regular-file and deadline limits, snapshot
  create-only/replace semantics, and named reordered-traversal and replacement
  fixtures.
- Finalized ADR 0002 with race-safe no-replace snapshot installation, canonical
  snapshot-path containment, an effective analysis worker deadline and bounded
  project metadata, exact cursor tuples and diagnostic IDs, stable lexical
  identity rules, closed file/symbol query DTOs, declaration-root exclusions,
  explicit query/MCP read-only boundaries, and fixtures for each corrected case.
- Reconciled the final issue #17 contract findings: hard count/byte/deadline and
  cancellation limits now discard all accumulated graph data without returning or
  persisting a snapshot; only recoverable compiler diagnostics may produce a
  partial snapshot. Ambiguity uses the ordinary selector request cursor and
  bounded candidate page, lexical blocks use framed descriptors, normalized
  fingerprints bind canonical defaults, and snapshot JSON has exact NFC, escaping,
  integer, UTF-8, and digest rules. The contract also records fail-closed
  snapshot privacy, sanitized compiler/bootstrap errors, `.sourcemesh`-only
  output containment, the closed node/selector matrix, and consistent cursor
  tuples. No unresolved ambiguity is represented as a closed behavior.

[Unreleased]: https://github.com/VissotoFlavio/source-mesh/commits/develop
