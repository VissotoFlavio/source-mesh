# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to use [Semantic Versioning](https://semver.org/) when releases begin.

## [Unreleased]

### Added

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

### Changed

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
