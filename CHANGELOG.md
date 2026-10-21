# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to use [Semantic Versioning](https://semver.org/) when releases begin.

## [Unreleased]

### Added

- Accepted the source graph MVP architecture and schema/query contract in ADR 0002.
- Initial TypeScript project scaffold and local quality commands.
- Repository purpose, privacy boundary, and contribution workflow documentation.
- CI validation for supported Node.js versions and the offline runtime boundary.
- Automated reconciliation of merged release and hotfix pull requests from `master` into `develop`.
- Documentation of the first protected, governed delivery-path validation.

### Changed

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
