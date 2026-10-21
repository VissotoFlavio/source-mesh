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

Discovery never traverses a symlink or junction. Source and compiler-context
inputs must be regular files; directories, devices, sockets, FIFOs, and other
special files are rejected. Where the host supports it, opens use a descriptor
with no-follow semantics, and the loader verifies the opened handle's file
identity and regular-file status against the pre-open and post-read checks.
Disappearance, replacement, or a target swap at any point is a fail-closed
operation, not permission to reopen a new target. Context resolution may follow a
symlink or junction only when the resolved realpath is contained and its visited
realpath/file identity has not already occurred; cycles are rejected.

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
| Directory entries inspected                 | 100,000 |
| Eligible source files                       |  10,000 |
| Bytes in one source file                    |   4 MiB |
| Aggregate source and compiler-context bytes | 256 MiB |
| Analysis diagnostics                        |  10,000 |
| Snapshot bytes                              |  64 MiB |
| Snapshot nesting depth                      |      64 |
| Graph nodes                                 | 100,000 |
| Graph edges                                 | 200,000 |
| Snapshot diagnostics                        |  10,000 |
| Path depth                                  |     256 |
| Module-resolution candidates per source     |  10,000 |
| Any serialized string field                 |  16 KiB |
| Cursor bytes                                |   4 KiB |

Analysis also has one cooperative 30-second deadline. The implementation checks
the deadline and cancellation token at every directory, file, compiler, and
serialization boundary; expiry or cancellation fails closed with the bounded
`resource_limit` diagnostic and a partial result. A cancelled operation never
continues in the background. Directory-entry, source-file, path-depth, and
module-candidate counts are charged before opening or following the next item.

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
repository node is part of the graph and uses the exact repository identity
formula in the canonical hashing section. `repository.name` is display-only: a
valid non-empty root
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
both serialized data and part of identity. Overloads and same-kind merges produce
one node whose locations are sorted and unique; no declaration span or traversal
position is an identity component.

Anonymous declarations are omitted except an anonymous export-default function or
class, represented as a named and qualified `default`. A variable-bound arrow
function or class expression produces a `function` or `class` node without a
duplicate binding or expression node. Unbound anonymous declarations do not
receive guessed identity.

Legal overload declarations merge into one node with all declaration spans as
locations. Same-kind `interface`/`interface` and `namespace`/`namespace`
declarations merge likewise. Anonymous default-export functions and classes are
supported as the named and qualified declaration `default`; other unbound
anonymous declarations are omitted. A variable-bound arrow function or class
expression is represented by the binding node and is not duplicated.

For each declaration, the semantic parent path is the root-to-direct-parent
sequence of canonical parent node IDs, joined by `/`, followed by `#scope=` and
a canonical lexical binding scope. The lexical binding scope is a `/`-joined
sequence of NFC-normalized, case-sensitive binding segments in source semantic
scope order (`module:<qualifiedName>`, `class:<qualifiedName>`,
`function:<qualifiedName>`, or `block:<canonicalBindingKey>`). A
`canonicalBindingKey` is the compiler's stable lexical binding identity after
normalization; it never contains an array position, traversal ordinal, timestamp,
or host path. The empty root scope is `#scope=root`. If two block-scoped
same-name declarations cannot be distinguished by that stable binding identity,
both declarations are omitted and exactly one deterministic diagnostic is
emitted with code `graph.node_id_collision` or `declaration.unstable_identity`
as applicable. The implementation never disambiguates them with a traversal
ordinal.

Same-name declarations are emitted only when their canonical lexical scopes are
unique. A collision is ordered by canonical path, qualified name, kind, and
normalized declaration signature before omission, so traversal order cannot
choose a winner. Cross-kind declarations remain separate. Duplicate identical
signatures are diagnosed and omitted. There is no ordinal identity.

#### Containment and relationship edges

`EdgeKindV1` is exactly `contains`, `imports`, `exports`, `extends`,
`implements`, and `calls`. `contains` is the only structural hierarchy edge and
always points to the direct parent. Its closed endpoint matrix is:

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

Every edge uses the serialization keys `id`, `kind`, `from`, `to`,
`resolutionStatus`, and optional `locations`; `resolutionStatus` is always the
literal `resolved`. Locations are sorted unique `LocationV1` values and are
omitted when no trustworthy occurrence span exists. Endpoints must exist in the
same snapshot and satisfy the closed matrix; `contains` is validated exactly like
the semantic kinds. An edge identity is unique per `(schemaVersion, kind, from,
to)` and aggregates all distinct occurrence locations.

Top-level module calls, references, and types are reserved and are not emitted in
the MVP; they become diagnostics when a closed diagnostic rule applies or remain
out of scope. No guessed edge is allowed. External, unresolved, ambiguous,
dynamic, and unsupported relationships are diagnostic outcomes, never edge
values. Traversal order cannot change identity or location order. An edge location
is the local import, export, inheritance, or call span when trustworthy; it is
absent otherwise.

### Canonical identity, serialization, and diagnostics

Canonical hashing is executable, not prose shorthand. All identity hashes are
SHA-256 rendered as exactly 64 lowercase hexadecimal characters. For a field
sequence, the byte frame is:

```text
u32be(fieldCount)
for each field:
  u32be(byteLength)
  UTF-8 bytes of the field after Unicode NFC normalization
```

`schemaVersion` is the UTF-8 decimal string `1`. Domain separators are framed
strings, never raw prefixes or concatenated bytes. The exact identities are:

```text
repository id = n:<sha256(frame([
  "sourcemesh-repository-v1", "1", "repository"
]))>
file id = n:<sha256(frame([
  "sourcemesh-file-v1", "1", canonicalRelativePath
]))>
node id = n:<sha256(frame([
  "sourcemesh-node-v1", "1", nodeKind, canonicalRelativePath,
  semanticParentPath, declaredName, memberRole
]))>
edge id = e:<sha256(frame([
  "sourcemesh-edge-v1", "1", edgeKind, fromNodeId, toNodeId
]))>
```

The repository and file formulas are the only special cases. Every field is a
string, normalized to NFC before its UTF-8 byte length is measured; the frame is
big-endian and has no terminator. The hash result is the lowercase 64-hex digest
only, with the `n:` or `e:` prefix added after hashing.

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
diagnostic: id, code, severity, message, relationKind, reason, path, location,
relatedNodeIds
location: path, start, end
position: line, column
```

The mandatory golden identity vectors include these exact inputs, frame bytes,
and digests (the expected IDs prepend `n:` or `e:` after hashing):

| Fields                                                    | Frame bytes (hex)                                                                                                                | SHA-256                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `sourcemesh-repository-v1`, `1`, `repository`             | `0000000300000018736f757263656d6573682d7265706f7369746f72792d763100000001310000000a7265706f7369746f7279`                         | `0af8d87eaa7ba922ec8b69a7f1a420db22eb5028db32c4e32bce1d3e625faa6c` |
| `sourcemesh-file-v1`, `1`, `src/index.ts`                 | `0000000300000012736f757263656d6573682d66696c652d763100000001310000000c7372632f696e6465782e7473`                                 | `fef22bb3b9e1bbd51e4a293c28c8253ec9b1b91719b5949ec86e1d8063be5111` |
| `sourcemesh-edge-v1`, `1`, `contains`, `n:repo`, `n:file` | `0000000500000012736f757263656d6573682d656467652d7631000000013100000008636f6e7461696e73000000066e3a7265706f000000066e3a66696c65` | `2cac33fff64d932e9ce7b1fb58bb4ec317abfc17f786aaac834f61294f61ddf4` |

The fixture also includes NFC-equivalent fields and asserts identical hashes,
uppercase or non-64-hex digests are rejected, and a reordered field frame is not
accepted as equivalent. A cursor golden vector uses the canonical snapshot bytes
`{"schemaVersion":1,"completeness":"complete","repository":{"root":".","name":"repository"},"nodes":[{"id":"n:0af8d87eaa7ba922ec8b69a7f1a420db22eb5028db32c4e32bce1d3e625faa6c","kind":"repository","name":"repository"}],"edges":[],"diagnostics":[]}` plus one LF, whose snapshot digest is
`24045921f6d284d5dfc562453394b91b50a635a7a5d7b48e0300db1034e44302`. For the
canonical request `{"operation":"searchSymbols","query":"User","kind":"function","path":"src","allowPartial":false}` the filter fingerprint is
`f901f647c7c2601d76a6e010c9058147df69638bd26180f4b264769b2537d337`, and the
exact base64url cursor is:

```text
eyJzY2hlbWFWZXJzaW9uIjoxLCJzbmFwc2hvdERpZ2VzdCI6IjI0MDQ1OTIxZjZkMjg0ZDVkZmM1NjI0NTMzOTRiOTFiNTBhNjM1YTdhNWQ3YjQ4ZTAzMDBkYjEwMzRlNDQzMDIiLCJvcGVyYXRpb24iOiJzZWFyY2hTeW1ib2xzIiwiZmlsdGVyRmluZ2VycHJpbnQiOiJmOTAxZjY0N2M3YzI2MDFkNzZhNmUwMTBjOTA1ODE0N2RmNjk2MzhiZDI2MTgwZjRiMjY0NzY5YjI1MzdkMzM3IiwibGFzdFNvcnRLZXkiOlsic3JjL2luZGV4LnRzIiwibG9hZFVzZXIiLCJmdW5jdGlvbiIsIm46YWJjIl19
```

Diagnostic codes, severities, and messages are closed and stable. Messages never
contain compiler wording, source excerpts, paths, or absolute machine data:

| Code                            | Severity | Exact message                                             |
| ------------------------------- | -------- | --------------------------------------------------------- |
| `configuration_invalid`         | error    | `Project configuration is invalid.`                       |
| `configuration_external`        | error    | `Project configuration escapes the repository.`           |
| `path_invalid`                  | error    | `Repository-relative path is invalid.`                    |
| `generated_file_ambiguous`      | error    | `Generated-file classification is ambiguous.`             |
| `resource_limit`                | error    | `Analysis resource limit was exceeded.`                   |
| `unsupported_declaration`       | warning  | `Declaration kind is unsupported in the MVP.`             |
| `duplicate_declaration`         | error    | `Duplicate declaration signature was omitted.`            |
| `declaration.unstable_identity` | error    | `Declaration identity could not be stabilized.`           |
| `relationship_external`         | warning  | `Relationship targets an external module or declaration.` |
| `relationship_unresolved`       | warning  | `Relationship could not be resolved.`                     |
| `relationship_ambiguous`        | warning  | `Relationship target is ambiguous.`                       |
| `relationship_dynamic`          | warning  | `Relationship is dynamic and was not emitted.`            |
| `relationship_unsupported`      | warning  | `Relationship kind is unsupported in the MVP.`            |
| `relationship_missing_source`   | error    | `Relationship source is not an eligible local source.`    |
| `graph.node_id_collision`       | error    | `Graph node identity collision prevented node emission.`  |
| `graph.edge_id_collision`       | error    | `Graph edge identity collision prevented edge emission.`  |

Diagnostics have the fixed key order `id`, `code`, `severity`, `message`,
`relationKind`, `reason`, `path`, `location`, `relatedNodeIds`; only
`relationKind`, `reason`, `path`, `location`, and `relatedNodeIds` are optional,
and omitted fields are never `null`. `relationKind` is one of the closed edge
kinds when applicable. `reason` is a closed producer reason string, not compiler
text. Messages never contain compiler wording, source excerpts, paths, or
absolute machine data.

The diagnostic ID hashes schema version, producer rule ID, normalized diagnostic
fields, and a canonical `occurrenceKey`. The occurrence key is a canonical frame
of source path/span (when present), producer rule ID, relation kind/reason,
normalized semantic endpoint IDs, and normalized declaration signature. It never
contains traversal order, array position, or a same-anchor occurrence index.
Identical semantic duplicates normalize to one diagnostic; distinct stable keys
remain distinct. Diagnostics are sorted only after this normalization.

Diagnostic ordering is the total lexicographic order:

```text
(pathKey, locationKey, code, severity, message, relatedNodeIdsKey, id)
```

Present path/location values sort before absent values. Related IDs are sorted by
node ID; an explicitly empty list is invalid. The final ID tie-breaker is always
used. `completeness` is `complete` only when there are no error diagnostics;
otherwise it is `partial`.

### Snapshot codec and atomic replacement

The default snapshot path is `.sourcemesh/graph.json`. Snapshot bytes are UTF-8,
have no BOM, use LF line endings, compact canonical JSON, fixed key order, and
one trailing newline. The codec exposes
`encode(snapshot: SnapshotV1) -> UTF-8 bytes` and
`decode(bytes) -> SnapshotV1 | SnapshotError`. Decode accepts semantically valid
non-canonical array order, validates the closed schema and all invariants,
normalizes the result to canonical in memory, and re-emits canonical bytes. It
rejects malformed JSON, unsupported schema, unknown fields, invalid paths,
duplicate IDs, broken endpoints, invalid locations, invalid identities, and
invariant violations. It has no migrations; unsupported versions are rejected.

Snapshot writing has explicit `create-only` and `replace` modes. Both modes
validate the complete normalized snapshot before touching the destination. In
`create-only`, an existing destination is an error; in `replace`, an existing
valid or invalid destination is never deleted before the replacement is ready.
For #22, the writer creates one cryptographically random exact temporary name in
the destination's same directory with exclusive `wx` creation, verifies the
parent identity and temporary handle as regular no-follow files, writes through
the opened handle, syncs, closes, and renames only after complete validation.
The destination is the old complete snapshot or the new complete snapshot, never
a partial one. There is no delete-then-rename. Cleanup may remove only that exact
temporary path, and only after the handle is closed. Target swap, parent change,
disappearance, special-file detection, or rename uncertainty fails closed. This
does not promise power-loss or concurrent-locking guarantees beyond the host
filesystem's normal behavior.

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

The transport-neutral DTOs are closed. Unknown fields are rejected, optional
fields are omitted rather than set to `null`, and the only request discriminants
are these four DTOs:

```text
NodeSummaryV1 = {
  id: string, kind: NodeKindV1, name: string,
  path: string, qualifiedName: string,
  memberRole: "none" | "static" | "instance",
  locations?: LocationV1[]
}

SearchRequestV1 = {
  operation: "searchSymbols", query: string, kind?: NodeKindV1,
  path?: string, limit?: number, cursor?: string, allowPartial?: boolean
}
GetSymbolRequestV1 = {
  operation: "getSymbol", nodeId?: string, selector?: SymbolSelectorV1,
  limit?: number, cursor?: string, allowPartial?: boolean
}
FileRelationRequestV1 = {
  operation: "listFileDependencies" | "listFileDependents", file: FileSelectorV1,
  limit?: number, cursor?: string, allowPartial?: boolean
}
CallRelationRequestV1 = {
  operation: "listCallers" | "listCallees", function: FunctionSelectorV1,
  limit?: number, cursor?: string, allowPartial?: boolean
}
QueryRequestV1 = SearchRequestV1 | GetSymbolRequestV1 |
  FileRelationRequestV1 | CallRelationRequestV1

QueryPageV1<T> = {
  schemaVersion: 1, completeness: "complete" | "partial", items: T[],
  total: number, truncated: boolean, continuation?: string
}

QueryResponseV1 =
  | QueryPageV1<NodeSummaryV1>
  | { operation: "getSymbol", schemaVersion: 1,
      completeness: "complete" | "partial", symbol: NodeSummaryV1,
      container?: NodeSummaryV1, children: QueryPageV1<NodeSummaryV1> }

QueryErrorV1 = {
  code: "invalid_request" | "limit_exceeded" | "not_found" | "ambiguous" |
    "entity_type_mismatch" | "unsupported_schema" | "invalid_snapshot" |
    "partial_not_allowed" | "internal",
  message: string, field?: string,
  candidates?: NodeSummaryV1[], totalCandidates?: number,
  truncated?: boolean, continuation?: string
}
```

`SymbolSelectorV1` is the closed object `{ kind?, name?, qualifiedName?, path?,
memberRole? }`, `FileSelectorV1` is `{ path: string }`, and
`FunctionSelectorV1` is `{ nodeId?: string, qualifiedName?: string, path?: string,
name?: string }`; each rejects unknown fields and must contain enough fields to
identify its operation's entity type. `nodeId` and `selector` are mutually
exclusive and exactly one is required for `getSymbol`. A `QueryPageV1` always has
the same page bounds; an ambiguity error's `candidates` is bounded by the
requested limit and uses `totalCandidates`, `truncated`, and `continuation` to
represent the remainder. No error ever returns an unbounded candidate list.

`searchSymbols` performs a literal, case-sensitive substring search over `name` or
`qualifiedName`. `query` is required, trimmed, and 1..256 UTF-16 code units;
requests outside that range are `invalid_request`.
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
present only when more results remain. A cursor is base64url without padding over
compact canonical UTF-8 JSON with exactly these fields and key order:

```json
{
  "schemaVersion": 1,
  "snapshotDigest": "<lowercase sha256 of canonical snapshot bytes>",
  "operation": "<operation>",
  "filterFingerprint": "<lowercase sha256 of canonical request fields excluding cursor and limit>",
  "lastSortKey": ["<sort field>", "<sort value>"]
}
```

`filterFingerprint` includes the operation and every request field except
`cursor` and `limit`; its canonical JSON uses the same closed-key and NFC rules.
The cursor is rejected as `invalid_request` when malformed, over 4096 bytes,
mismatched to the operation or filter, bound to a different snapshot digest, or
stale. The replacement fixture must prove that a cursor from snapshot A is
rejected after a valid replacement produces snapshot B, even when the request is
otherwise unchanged.

Results use these exact total sort orders, with present path values before the
absent-path sentinel: search and ambiguity candidates `(pathKey,
qualifiedName, kind, id)`; children `(kind, qualifiedName, id)`; file relations
`(path, id)`; and call relations `(qualifiedName, path, kind, id)`. Counterpart
nodes are unique by node ID after projection.

A non-integer or otherwise malformed `limit` is `invalid_request`; a value below
1 or above 100 is `limit_exceeded`. The default 25 is applied only when `limit`
is omitted.

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

This read-only rule applies to every query and MCP path. Analysis is the sole
controlled snapshot-writing path and is delivered by issue #22 under the
create-only/replace contract above; query and MCP never create, replace, or
delete `.sourcemesh/graph.json`. The default path, encoding, line ending, and
canonical JSON rules are identical for analysis output and codec re-emission.

### Deterministic fixture and test requirements

Before implementation is considered contract-complete, synthetic fixtures and
assertions must cover:

1. Multiple explicit `tsconfigPath` inputs, refusal to autodiscover/merge/select,
   configured `allowJs`/`checkJs`, exact no-config options, and `types: []`/
   `@types` isolation.
2. Reserved and configured output exclusions, lexical/canonical disagreement,
   symlink and junction cycles, contained target swaps, disappearance, regular
   file/no-follow checks, visited identities, and fail-closed behavior.
3. Every normative resource limit, including directory entries, source files,
   path depth, module candidates, and the cooperative deadline/cancellation;
   deterministic limit diagnostics and no silent truncation.
4. Non-canonical collection order decoding, unknown-field and invariant
   rejection, normalization, and exact canonical re-emission with UTF-8/no BOM,
   LF, compact JSON, and trailing newline.
5. Atomic snapshot `create-only` and `replace` behavior, including
   validation-before-touch, same-directory random `wx` temporary creation,
   parent/handle identity, write/sync/close/rename ordering, old-or-new
   visibility, and exact-temp cleanup scope.
6. Overload and same-kind merges, cross-kind separation, anonymous/default
   handling, variable-bound expressions, static/instance `memberRole`, lexical
   same-name collisions, direct-parent `contains`, every closed endpoint matrix,
   sorted unique locations, and all six edge kinds.
7. Canonical hash vectors for repository/file/node/edge framing, NFC and
   lowercase-64-hex checks, fixed key order, compact UTF-8 bytes, and trailing
   newline. The vectors in this ADR are literal fixture inputs and expected
   bytes/digests, not illustrative pseudocode.
8. Closed diagnostics with exact code/severity/message tables, optional field
   order, stable occurrence keys, reordered traversal, duplicate normalization,
   distinct semantic occurrences, collision handling, and total ordering.
9. All six query operations, closed `SearchRequestV1`, `GetSymbolRequestV1`,
   `FileRelationRequestV1`, `CallRelationRequestV1`, `NodeSummaryV1`,
   `QueryPageV1`, and bounded `QueryErrorV1`, including UTF-16 trim, limit
   bounds/default, exact totals, and absent-path sort sentinels.
10. Cursor golden and replacement fixtures: canonical compact fields, snapshot
    digest, request fingerprint excluding cursor/limit, last sort key, base64url
    encoding, 4096-byte rejection, malformed/mismatched/stale rejection, and
    the exact vector above.
11. Ambiguity/entity-type errors with the same bounded page bounds as normal
    results, `totalCandidates`, `truncated`, and `continuation`; partial opt-in;
    unique one-hop counterparts; and dependency/dependent and caller/callee
    direction mappings.
12. CLI/MCP DTO and error equivalence, closed MCP schemas,
    `--cursor`/`--allow-partial`, `--offset` rejection, query/MCP read-only
    behavior, and analysis-only snapshot writes through #22.

The minimum named fixture corpus is:

- `identity-v1`: the repository, `src/index.ts` file, one function node, and one
  `contains` edge; it must match every literal framing vector above.
- `scope-collision-v1`: two indistinguishable block-scoped declarations with the
  same name; both are absent and the normalized diagnostic is exactly one
  `graph.node_id_collision` or `declaration.unstable_identity`, never an ordinal
  suffix.
- `merge-and-locations-v1`: overloads, interface/namespace merges,
  static/instance members, default exports, and repeated relationship occurrences;
  each node/edge has sorted unique locations and one stable ID.
- `reordered-traversal-v1`: the same files and semantic candidates delivered in
  forward and reverse traversal order; canonical snapshot bytes, IDs, locations,
  and diagnostics must be byte-identical, including duplicate normalization.
- `query-cursor-replacement-v1`: page snapshot A, its exact golden cursor, a
  validated replacement snapshot B, and the unchanged request; the cursor must
  fail with `invalid_request` after replacement, while a newly issued cursor for B
  succeeds.
- `snapshot-modes-v1`: absent destination in `create-only`, existing destination
  rejected by `create-only`, and old complete bytes retained until a validated
  `replace` completes; injected write/sync/close/rename failures leave only the
  old complete bytes and clean the exact temporary name.

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
