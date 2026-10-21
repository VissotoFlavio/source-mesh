# ADR 0002: Source graph MVP architecture and contract

- Status: Accepted
- Date: 2026-10-21
- Issue: [#17](https://github.com/VissotoFlavio/source-mesh/issues/17)
- Supersedes: none

## Context

SourceMesh needs one versioned contract for the first local TypeScript and
JavaScript implementation. Discovery, project loading, extraction, graph
construction, snapshot storage, queries, the CLI, and MCP must evolve
independently without inventing incompatible representations. The contract also
preserves the local-only privacy boundary established by [ADR 0001](0001-technical-baseline.md).

The MVP is a semantic structural graph, not a stored AST or a complete JavaScript
execution model. It must be reproducible across operating systems and runs, and it
must distinguish confidently resolved relationships from those that are unresolved,
external, dynamic, ambiguous, unsupported, or missing their local source.

## Decision

The MVP uses a ports-and-adapters flow:

```text
discovery -> project loader -> extractor -> graph builder -> snapshot codec
                                                        -> query service
                                                        -> CLI adapter
                                                        -> MCP adapter
```

The arrows describe data ownership, not a required package layout. Domain
contracts are shared by the query service and both presentation adapters. CLI and
MCP may parse transport input and format output, but may not add graph semantics,
filesystem authority, or duplicate query behavior.

### Runtime and parser boundary

- Supported source languages are TypeScript and JavaScript. Discovery recognizes
  exactly `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs`.
  Declaration files ending in `.d.ts` are never discovery roots.
- The implementation uses the TypeScript Compiler API already pinned by the
  repository. No second parser, code execution, or runtime JavaScript analysis is
  introduced for the MVP.
- Discovery returns a deterministic set of repository-relative source roots and a
  selected repository root. It never creates roots, nodes, or edges for
  dependencies, generated output, VCS metadata, declarations, or files outside
  the repository.
- The extractor consumes compiler symbols and syntax and emits semantic candidates;
  it does not persist the full AST or source text.

### Loading and isolation

The loader accepts a repository root and at most one explicit `tsconfigPath`.
`tsconfigPath` is never autodiscovered, merged, or selected from multiple files.
`undefined` means the documented no-config fallback below. A malformed,
unsupported, external, or otherwise invalid config, `extends` target, or project
reference is a deterministic error. It never falls back to another config or to the
no-config mode.

When `tsconfigPath` is undefined, the loader uses these exact compiler options:

```text
target: ES2022
module: NodeNext
moduleResolution: NodeNext
jsx: Preserve
allowJs: true
checkJs: false
noEmit: true
resolveJsonModule: false
skipLibCheck: true
types: []
```

In configured mode, valid project `allowJs` and `checkJs` are honored, but
`noEmit` is always forced to `true`. The loader does not infer options from the
host Node version. Under NodeNext, `.mts`/`.mjs` are ESM, `.cts`/`.cjs` are
CommonJS, and the remaining supported forms use the nearest contained
`package.json` `type` field. Only the strings `"module"` and `"commonjs"` are
valid; absent means `"commonjs"`. Every other value is a configuration error.

TypeScript standard libraries selected by the compiler are trusted compiler
context only. They are never graph nodes, endpoints, or diagnostic sources. An
in-root `node_modules` declaration or project declaration may be compiler context
only when it is contained and allowed by the rules below; it is never a discovery
root, graph node, edge endpoint, or diagnostic source. External declarations are
not trusted and cannot be read. No absolute installation path is serialized.

The loader establishes the repository canonical root with `realpath` before
resolving input. All config files, `extends` targets, project references,
`files`/`include` results, source files, declarations, and module-resolution
candidates must have a successful realpath contained by that root. Containment uses
path segments, not string prefixes. An explicit config or context resolution may
follow a symlink or junction only when its resolved realpath is contained by the
root; discovery never traverses symlinks or junctions, even when their targets are
contained. Resolution keeps visited realpath/file-identity state and fails closed
on cycles.

If realpath, stat, open, or read reveals disappearance, target change, invalid
identity, or escape, the operation fails closed and never retries a different
target. An `include`/`files` match or module resolution outside the root is not
followed to create graph objects. These guarantees describe a best-effort Node host
boundary, not an adversarial sandbox against a hostile kernel or filesystem.

#### Exclusions and generated-file classification

Exclusion matching applies to both the normalized lexical path and the canonical
real path. Reserved exclusions are `node_modules`, `.git`, `.hg`, `.svn`, `.bzr`,
`.sourcemesh`, `build`, `coverage`, `dist`, `generated`, `out`, `.next`, and
`storybook-static`, plus validated `outDir`, `declarationDir`, `outFile` parent,
and explicit output roots. Matching is segment-aware and platform-independent;
serialized paths retain their discovered case. An excluded path is not rescued by
`include` or `files`.

Configured output roots are canonicalized and containment-checked before use. An
authoritative generated/output root wins over a source-looking extension. File
names, extensions, comments such as `@generated`, timestamps, and ignore files are
not generated-file authority. If authoritative rules conflict or a root cannot be
normalized or realpathed, generated classification is ambiguous and fails closed:
no node, endpoint, or diagnostic sourced from that file is emitted.

Classification precedence is: excluded path, generated/output, eligible project
source, compiler context-only, then invalid/ambiguous. A source relationship whose
context-only target is rejected receives the normal local-source relationship
diagnostic; it is never attributed to the context file.

#### Normative resource limits

The following are hard caps, not implementation hints:

| Resource                                    | Maximum |
| ------------------------------------------- | ------: |
| Discovery roots                             |  10,000 |
| Bytes in one source file                    |   4 MiB |
| Aggregate source and compiler-context bytes | 256 MiB |
| Analysis diagnostics                        |  10,000 |
| Snapshot bytes                              |  64 MiB |
| Snapshot nesting depth                      |      64 |
| Graph nodes                                 | 100,000 |
| Graph edges                                 | 200,000 |
| Snapshot diagnostics                        |  10,000 |
| Any serialized string field                 |  16 KiB |
| Cursor bytes                                |   4 KiB |

Exceeding an analysis limit yields a deterministic error diagnostic and a partial
result. Exceeding a decode limit rejects with `invalid_snapshot`; decode limits are
checked before `JSON.parse` where applicable. There is no silent truncation.

### Repository-relative paths and locations

All serialized paths are repository-relative UTF-8 strings using `/`.
Canonicalization removes redundant `.` segments and separators while preserving
discovered case; it never blindly lowercases Windows paths. `..`, empty segments
after canonicalization, drive letters, UNC prefixes, absolute paths, and paths
escaping the repository are invalid. A collision after canonicalization is a
deterministic diagnostic and prevents a valid snapshot.

Source locations are optional metadata, not identity. `LocationV1` is:

```json
{
  "path": "src/example.ts",
  "start": { "line": 1, "column": 1 },
  "end": { "line": 1, "column": 20 }
}
```

Lines and columns are one-based and end-exclusive. Node and edge locations are
`LocationV1[]`, sorted lexicographically and deduplicated. Diagnostics retain one
optional `LocationV1`. Absolute paths, source text, timestamps, and host metadata
are never serialized.

### Schema version 1

Every snapshot has this closed top-level shape:

```text
SnapshotV1 {
  schemaVersion: 1
  completeness: "complete" | "partial"
  repository: { root: ".", name: string }
  nodes: NodeV1[]
  edges: EdgeV1[]
  diagnostics: DiagnosticV1[]
}
```

Unknown fields, kinds, statuses, and required-field omissions are invalid. The
repository node is part of the graph and has identity `(schemaVersion,
"repository", ".")`. `repository.name` is display-only: a valid non-empty root
`package.json` name without slash, backslash, or control characters is normalized
to Unicode NFC; otherwise the literal `repository` is used.

#### Closed node kinds and declaration identity

Node kinds are exactly `repository`, `file`, `module`, `class`, `interface`,
`function`, `variable`, `type`, and `parameter`. Methods are `function` nodes.
Every discovered source file has exactly one source-scope `module` node. Nested
namespaces/modules are `module` nodes.

Each node has `id`, `kind`, `name`, and optional `locations`; non-repository nodes
also carry the required path/qualified-name fields for their kind. Declaration
nodes carry `memberRole`, exactly `none`, `static`, or `instance`; this value is
both serialized data and part of identity.

Anonymous declarations are omitted except an anonymous export-default function or
class, represented as a named and qualified `default`. A variable-bound arrow
function or class expression produces a `function` or `class` node without a
duplicate binding or expression node. Unbound anonymous declarations do not
receive guessed identity.

Legal overload declarations merge into one node with all declaration spans as
locations.
Same-kind `interface`/`interface` and `namespace`/`namespace` declarations merge;
cross-kind declarations remain separate. Duplicate identical signatures are
diagnosed and omitted. There is no ordinal identity.

#### Containment and relationship edges

`contains` is the only structural hierarchy edge and always points to the direct
parent. Its closed endpoint matrix is:

| From                   | To                                                                |
| ---------------------- | ----------------------------------------------------------------- |
| `repository`           | `file`                                                            |
| `file`                 | `module`                                                          |
| `module`               | `module`, `class`, `interface`, `function`, `variable`, `type`    |
| `class` or `interface` | `function`, `variable`                                            |
| `function`             | `class`, `interface`, `function`, `variable`, `type`, `parameter` |

The emitted semantic edge kinds and endpoints are also closed:

| Kind         | Endpoints                                                                  |
| ------------ | -------------------------------------------------------------------------- |
| `imports`    | `module` -> `module`                                                       |
| `exports`    | `module` -> `module`, `class`, `interface`, `function`, `variable`, `type` |
| `extends`    | `class` or `interface` -> `class` or `interface`                           |
| `implements` | `class` -> `interface`                                                     |
| `calls`      | `function` -> `function`                                                   |

Top-level module calls, references, and types are reserved and are not emitted in
the MVP; they become diagnostics when a closed diagnostic rule applies or remain
out of scope. No guessed edge is allowed. Every emitted edge has
`resolutionStatus: "resolved"`. External, unresolved, ambiguous, dynamic, and
unsupported relationships are diagnostic outcomes, never edge values.

Each edge has one identity per `(schemaVersion, kind, from, to)` and aggregates
all sorted unique occurrence locations. Distinct relationship occurrences remain
distinct entries in that location array. Traversal order cannot change identity or
location order. An edge location is the local import, export, inheritance, or call
span when trustworthy; it is absent otherwise.

### Canonical identity, serialization, and diagnostics

Canonical hashing is executable, not prose shorthand. For a field sequence, the
byte frame is:

```text
u32be(fieldCount)
for each field:
  u32be(byteLength)
  UTF-8 bytes of the field after Unicode NFC normalization
```

Node IDs hash the frame with domain `sourcemesh-node-v1` and fields
`schemaVersion`, `nodeKind`, `canonicalRelativePath`, `semanticParentPath`,
`declaredName`, and `memberRole`, producing lowercase hexadecimal `n:` IDs. Edge
IDs hash domain `sourcemesh-edge-v1` and fields `schemaVersion`, `edgeKind`,
`fromNodeId`, and `toNodeId`, producing lowercase hexadecimal `e:` IDs. The
repository and file special tuples remain `(schemaVersion, "repository", ".")`
and `(schemaVersion, "file", canonicalRelativePath)` respectively.

Nodes sort by `(kind, id)`, edges by `(kind, from, to, id)`, and locations by
`(path, start.line, start.column, end.line, end.column)`. Canonical snapshot bytes
are compact UTF-8 JSON, fixed key order, and one trailing newline. Optional fields
are omitted, never `null`; no new envelope or indentation is added. The fixed key
order is:

```text
snapshot: schemaVersion, completeness, repository, nodes, edges, diagnostics
repository: root, name
node: id, kind, name, path, qualifiedName, memberRole, locations
edge: id, kind, from, to, resolutionStatus, locations
diagnostic: id, code, severity, message, path, location, relatedNodeIds
location: path, start, end
position: line, column
```

Diagnostic codes, severities, and messages are closed and stable. Messages never
contain compiler wording, source excerpts, paths, or absolute machine data:

| Code                          | Severity | Exact message                                             |
| ----------------------------- | -------- | --------------------------------------------------------- |
| `configuration_invalid`       | error    | `Project configuration is invalid.`                       |
| `configuration_external`      | error    | `Project configuration escapes the repository.`           |
| `path_invalid`                | error    | `Repository-relative path is invalid.`                    |
| `generated_file_ambiguous`    | error    | `Generated-file classification is ambiguous.`             |
| `resource_limit`              | error    | `Analysis resource limit was exceeded.`                   |
| `unsupported_declaration`     | warning  | `Declaration kind is unsupported in the MVP.`             |
| `duplicate_declaration`       | error    | `Duplicate declaration signature was omitted.`            |
| `unstable_declaration`        | error    | `Declaration identity could not be stabilized.`           |
| `relationship_external`       | warning  | `Relationship targets an external module or declaration.` |
| `relationship_unresolved`     | warning  | `Relationship could not be resolved.`                     |
| `relationship_ambiguous`      | warning  | `Relationship target is ambiguous.`                       |
| `relationship_dynamic`        | warning  | `Relationship is dynamic and was not emitted.`            |
| `relationship_unsupported`    | warning  | `Relationship kind is unsupported in the MVP.`            |
| `relationship_missing_source` | error    | `Relationship source is not an eligible local source.`    |
| `node_collision`              | error    | `Graph node identity collision prevented node emission.`  |
| `edge_collision`              | error    | `Graph edge identity collision prevented edge emission.`  |

Diagnostics have `id`, `code`, `severity`, and `message`, plus optional `location`,
`relatedNodeIds`, and `path`. The ID hashes schema version, producer rule ID,
normalized diagnostic fields, and an occurrence key. The occurrence key is based
on source path/span, producer rule ID, compiler category, and a deterministic
same-anchor occurrence index; it is never the serialized array position.

Diagnostic ordering is the total lexicographic order:

```text
(pathKey, locationKey, code, severity, message, relatedNodeIdsKey, id)
```

Present path/location values sort before absent values. Related IDs are sorted by
node ID; an explicitly empty list is invalid. The final ID tie-breaker is always
used. `completeness` is `complete` only when there are no error diagnostics;
otherwise it is `partial`.

### Snapshot codec and atomic replacement

The codec exposes `encode(snapshot: SnapshotV1) -> UTF-8 bytes` and
`decode(bytes) -> SnapshotV1 | SnapshotError`. Decode accepts semantically valid
non-canonical collection order, validates the closed schema and all invariants,
normalizes the result to canonical in memory, and re-emits canonical bytes. It
rejects malformed JSON, unsupported schema, unknown fields, invalid paths,
duplicate IDs, broken endpoints, invalid locations, invalid identities, and
invariant violations. It has no migrations; unsupported versions are rejected.

For #22, create/replace is atomic by contract: validate the complete snapshot
before touching the destination; write one exact temporary file in the same
directory; complete the write, sync, close, and rename only at the end. The
destination is the old complete snapshot or the new complete snapshot, never a
partial one. There is no delete-then-rename. Cleanup may remove only that exact
temporary path. This does not promise power-loss or concurrent-locking guarantees
beyond the host filesystem's normal behavior.

### Query service and adapters

The transport-neutral query surface has exactly six operations:

```text
searchSymbols
getSymbol
listFileDependencies
listFileDependents
listCallers
listCallees
```

Diagnostics remain snapshot/analyzer data and are not a seventh CLI or MCP tool.
All operations share closed discriminated request/response DTO unions and the
stable error union. Optional fields are omitted, never `null`.

The unions are transport-neutral and closed. In notation shorthand, their
operation discriminants and required shape are:

```text
QueryRequestV1 =
  | { operation: "searchSymbols", query, kind?, path?, limit?, cursor?, allowPartial? }
  | { operation: "getSymbol", nodeId? | selector?, limit?, cursor?, allowPartial? }
  | { operation: "listFileDependencies", file, limit?, cursor?, allowPartial? }
  | { operation: "listFileDependents", file, limit?, cursor?, allowPartial? }
  | { operation: "listCallers", function, limit?, cursor?, allowPartial? }
  | { operation: "listCallees", function, limit?, cursor?, allowPartial? }

QueryResponseV1 =
  | { operation: "searchSymbols", items: SymbolV1[], total, truncated, continuation? }
  | { operation: "getSymbol", symbol, container?, children: PageV1<SymbolV1> }
  | { operation: "listFileDependencies" | "listFileDependents" |
      "listCallers" | "listCallees", items: SymbolV1[], total, truncated, continuation? }

QueryErrorV1 = {
  code: "invalid_request" | "limit_exceeded" | "not_found" | "ambiguous" |
    "entity_type_mismatch" | "unsupported_schema" | "invalid_snapshot" |
    "partial_not_allowed" | "internal",
  message, field?, candidates?, totalCandidates?, truncated?, continuation?
}
```

`nodeId` and `selector` are mutually exclusive and exactly one is required for
`getSymbol`; `file` and `function` are structured selectors constrained to their
operation's entity type. `PageV1` carries exact `total`, `truncated`, and an
optional continuation. The notation does not permit additional fields.

`searchSymbols` performs a literal, case-sensitive substring search over `name` or
`qualifiedName`. `query` is required, trimmed, and 1..256 UTF-16 code units.
Only `kind` and repository-relative `path` are filters. `getSymbol` accepts a
unique `nodeId` or structured selector. A found result includes the symbol, its
immediate container, and paged direct children. Ambiguity never chooses a symbol;
it returns deterministically ordered candidates. Relationship operations return
unique one-hop counterpart nodes.

File dependencies and dependents use only resolved `imports` and `exports`
relationships projected between the files that own their module endpoints.
Callers and callees use only resolved `calls` relationships. Directions are fixed
by operation name: dependencies and callees read outgoing edges; dependents and
callers read incoming edges. Adapters never reverse or infer a direction.

Every paged operation uses an opaque cursor, never an offset. The default limit is
25, the maximum is 100, and the minimum is 1. Results are fully sorted before the
limit is applied; `total` is exact; `truncated` is explicit; and a continuation is
present only when more results remain. A cursor is base64url canonical JSON that
binds the operation, filter fingerprint, and last sort tuple. Malformed,
mismatched, changed, or snapshot-incompatible cursors are `invalid_request`.
Cursor bytes are subject to the 4 KiB hard cap.

The stable public error codes are:
`invalid_request`, `limit_exceeded`, `not_found`, `ambiguous`,
`entity_type_mismatch`, `unsupported_schema`, `invalid_snapshot`,
`partial_not_allowed`, and `internal`. Internal error classes map only to these
codes. `allowPartial` defaults to `false`; a partial snapshot returns
`partial_not_allowed` before query evaluation unless the request explicitly opts
in.

The adapter names are fixed:

| Operation              | CLI            | MCP                |
| ---------------------- | -------------- | ------------------ |
| `searchSymbols`        | `symbol`       | `search_symbols`   |
| `getSymbol`            | `details`      | `get_symbol`       |
| `listFileDependencies` | `dependencies` | `get_dependencies` |
| `listFileDependents`   | `dependents`   | `get_dependents`   |
| `listCallers`          | `callers`      | `get_callers`      |
| `listCallees`          | `callees`      | `get_callees`      |

The CLI adds `--cursor` and `--allow-partial` and rejects `--offset`. MCP schemas
are closed with `additionalProperties: false`; they accept no filesystem, root,
snapshot, URI, command, or environment inputs. Both adapters use the shared DTOs,
errors, sorting, cursor semantics, and direction semantics without adding meaning.

CLI and MCP remain stdio-only, local-only, read-only, and network-free. They do
not write source files or snapshots, do not access the filesystem/compiler/graph
outside shared ports, and keep diagnostics and protocol output isolated from
stderr. No source text, absolute path, timestamp, telemetry, prompt, or graph
result is sent to an external service.

### Deterministic fixture and test requirements

Before implementation is considered contract-complete, synthetic fixtures and
assertions must cover:

1. Multiple explicit `tsconfigPath` inputs, refusal to autodiscover/merge/select,
   configured `allowJs`/`checkJs`, exact no-config options, and `types: []`/
   `@types` isolation.
2. Reserved and configured output exclusions, lexical/canonical disagreement,
   symlink and junction cycles, contained target swaps, disappearance, and
   fail-closed behavior.
3. Every normative resource limit, deterministic limit diagnostics, decode
   rejection before parsing, and no silent truncation.
4. Non-canonical collection order decoding, invariant validation, normalization,
   and exact canonical re-emission.
5. Atomic snapshot create/replace behavior, including validation-before-touch,
   same-directory exact temporary path, write/sync/close/rename ordering, and
   cleanup scope.
6. Overload merging, interface/namespace merging, cross-kind separation,
   anonymous/default handling, variable-bound expressions, `memberRole`, and
   multiple edge occurrence locations.
7. Canonical hash vectors for node and edge framing, repository/file special
   tuples, fixed key order, compact UTF-8 bytes, and trailing newline.
8. Closed diagnostics, stable messages, occurrence keys, collision handling, and
   total diagnostic ordering.
9. All six query operations, exact totals, cursor binding/invalidity,
   ambiguity/entity-type errors, partial opt-in, and dependency/dependent and
   caller/callee direction mappings.
10. CLI/MCP DTO and error equivalence, closed MCP schemas, `--cursor`,
    `--allow-partial`, and `--offset` rejection.

Issue #26 remains the end-to-end proof of the complete contract. This ADR does not
add its runtime implementation.

## Privacy, runtime, and security boundaries

Analysis, snapshot encoding, query execution, CLI, and MCP operate locally without
runtime network access. MCP is a local stdio server, not an HTTP, remote, or hosted
transport. The read-only query service never mutates source files or snapshots.
Input paths, selectors, and limits are validated before use; errors do not echo
sensitive local data. A connected AI client is a separate data-processing boundary
and must be assessed independently.

## Rejected alternatives

### Persisting the full AST

Rejected because it increases snapshot size, couples the contract to compiler
internals, and can retain source text. The semantic graph plus diagnostics is
sufficient for the first query workflows.

### A generic graph database or remote store

Rejected because it adds dependencies and an operational boundary before the local
contract is validated. Canonical JSON snapshots provide portable, reviewable,
offline storage.

### A second parser or runtime JavaScript analysis

Rejected because it would create conflicting semantics and cannot make dynamic
relationships deterministic without executing user code. The TypeScript Compiler
API is the single source of syntax and symbol information.

### Treating names as relationships

Rejected because name matching invents edges for unresolved, overloaded, external,
or dynamic relationships. Those cases remain diagnostics.

### Transport-specific query models

Rejected because separate CLI and MCP models would drift. Both adapters use the
same bounded query service DTOs and typed errors.

## Consequences

- Issues #18–#26 have explicit interfaces and deterministic boundaries for
  incremental implementation.
- Node and edge identities do not depend on absolute checkout roots, traversal
  order, source locations, timestamps, or ordinal overload membership.
- Consumers must reject unsupported schema versions; migrations remain out of
  scope.
- The contract intentionally omits external nodes, guessed relationships, full
  dynamic-JavaScript completeness, databases, embeddings, and remote MCP.
- TypeScript must be available at runtime once loader/extractor work begins; issue
  #19 must decide whether the existing package moves from development-only to
  runtime dependencies without adding a package in this ADR.

## Validation examples

1. A TypeScript `class User` and `function loadUser` in `src/users.ts` produce
   `class` and `function` nodes, repository/file/module containment, and a `calls`
   edge only when the compiler resolves the call to `loadUser`.
2. A JavaScript `run(name)` calling `registry[name]()` produces a dynamic
   relationship diagnostic and no guessed `calls` edge.
3. An import from an external package produces a relationship-external diagnostic;
   it creates no external node or edge endpoint.
4. Two legal overload declarations merge locations into one function node. A
   duplicate normalized signature is diagnosed and omitted; no ordinal is used.
5. A snapshot with only warnings is complete and queryable by default. A snapshot
   with an error is partial and returns `partial_not_allowed` unless explicitly
   allowed.
6. A structured selector matching two declarations returns ordered candidates and
   never silently chooses one.
7. A `.d.ts` reached for NodeNext resolution can affect checking when contained,
   but never becomes a root, node, endpoint, or diagnostic source.
