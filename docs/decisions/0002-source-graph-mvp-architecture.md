# ADR 0002: Source graph MVP architecture and contract

- Status: Accepted
- Date: 2026-10-21
- Issue: [#17](https://github.com/VissotoFlavio/source-mesh/issues/17)
- Supersedes: none

## Context

SourceMesh needs one stable contract for the first local TypeScript and JavaScript
implementation. The contract must let discovery, project loading, extraction,
graph construction, snapshot storage, queries, the CLI, and MCP evolve independently
without inventing incompatible representations. It must also preserve the local-only
privacy boundary established by [ADR 0001](0001-technical-baseline.md).

The MVP is a semantic structural graph, not a stored AST or a complete JavaScript
execution model. It must be reproducible across operating systems and runs, and it
must distinguish a confidently resolved relationship from one that is unresolved,
external, dynamic, or ambiguous.

## Decision

The MVP uses a ports-and-adapters flow:

```text
discovery -> project loader -> extractor -> graph builder -> snapshot codec
                                                        -> query service
                                                        -> CLI adapter
                                                        -> MCP adapter
```

The arrows describe data ownership, not a required package layout. Domain contracts
are shared by the query service and both presentation adapters. CLI and MCP adapters
may parse transport input and format output, but may not add graph semantics or
duplicate query behavior.

### Runtime and parser boundary

- The supported source languages are TypeScript and JavaScript. Discovery recognizes
  exactly `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs`, including
  the corresponding JSX/TSX source forms supported by the selected compiler options.
  Declaration files ending in `.d.ts` are not discovery roots, but a `.d.ts` inside
  the repository may be loaded as compiler context when TypeScript resolves it.
- The implementation uses the TypeScript Compiler API already pinned by the
  repository. No second parser is introduced for the MVP.
- Discovery returns a deterministic set of repository-relative candidate source paths
  and the selected project root. It excludes dependencies, generated output, VCS
  metadata, and files outside the repository unless a later decision explicitly
  changes those rules.
- The project loader accepts a repository root and optional `tsconfig.json` path,
  validates that the selected configuration is inside the repository, and returns a
  compiler program plus the normalized source-file set. It does not execute project
  code.
- When no `tsconfig.json` is found, the loader creates a documented configuration-free
  program from the eight discovered extensions using stable MVP defaults: ES2022
  syntax, ES2022 module semantics, Node-style module resolution, JSX preservation,
  and `allowJs` enabled. The exact compiler options remain an implementation detail
  only where they do not change graph identity or supported file selection.
- A malformed or unsupported configuration is a deterministic diagnostic and does
  not silently fall back to a different project. A missing configuration is the only
  case that uses the configuration-free program.
- The loader establishes the repository's canonical root with `realpath` before
  resolving any input. Every `tsconfig.json`, `extends` target, project reference,
  `files`/`include` result, source file, declaration file, and module-resolution
  candidate must have a successful realpath contained by that root. Containment uses
  path-segment boundaries, not string prefixes. A symlink or junction is accepted
  only when its resolved target is verifiably inside the root; a broken link,
  unresolved realpath, or target outside the root is a fail-closed error diagnostic.
  An `extends` chain or project reference outside the root invalidates the loaded
  project. An `include`/`files` match or module/source resolution outside the root is
  excluded from the graph and recorded as an error diagnostic; it is never followed
  to create nodes or edges. These containment cases require negative tests.
- The extractor consumes compiler symbols and syntax and emits semantic candidates;
  it does not persist the full AST or source text.

### Repository-relative paths and source locations

All paths in the contract are repository-relative, UTF-8 strings using `/` as the
separator. Canonicalization removes redundant `.` segments and separators while
preserving case exactly as discovered; it never blindly lowercases a Windows path.
`..`, empty segments after canonicalization, drive letters, UNC prefixes, absolute
paths, and paths that escape the repository are invalid. A path collision after this
case-preserving canonicalization, including a collision that the target filesystem
cannot distinguish, is a diagnostic and prevents a valid snapshot from being
emitted. The repository root is never included in a serialized path.

Source locations are optional metadata, not identity. When present, a location is:

```json
{
  "path": "src/example.ts",
  "start": { "line": 1, "column": 1 },
  "end": { "line": 1, "column": 20 }
}
```

Lines and columns are one-based, end-exclusive, and measured from the compiler source
file. Locations must use the same normalized relative path rules. A location may be
omitted when the compiler cannot provide a trustworthy span. Absolute machine paths,
source text, timestamps, and host-specific metadata are not serialized by default.

### Schema version 1

Every snapshot has `schemaVersion: 1` and this top-level shape:

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

`repository.name` is a display value only and must not be used for identity. The
schema is a closed union: unknown node or edge kinds are invalid, and additional
required fields cannot be inferred by consumers.

#### Node kinds and required fields

Each node has `id`, `kind`, `name`, and optional `location`. `id` is a string with
the prefix `n:` followed by the semantic identity described below. The `repository`
node is part of the graph, not merely snapshot metadata; it is the single graph root.

| Kind         | Meaning                                                | Additional required fields |
| ------------ | ------------------------------------------------------ | -------------------------- |
| `repository` | The analyzed repository graph root                     | `path` (`"."`)             |
| `file`       | A supported source file                                | `path`                     |
| `module`     | A module/declaration namespace                         | `path`, `qualifiedName`    |
| `class`      | A class declaration or expression with a stable symbol | `path`, `qualifiedName`    |
| `interface`  | An interface declaration                               | `path`, `qualifiedName`    |
| `function`   | A function or method with a stable symbol              | `path`, `qualifiedName`    |
| `variable`   | A variable or property with a stable symbol            | `path`, `qualifiedName`    |
| `type`       | A type alias or enum-like type declaration             | `path`, `qualifiedName`    |
| `parameter`  | A named function or method parameter                   | `path`, `qualifiedName`    |

`qualifiedName` is the compiler-symbol name relative to the module, using `.` for
semantic nesting. Anonymous declarations without a stable symbol are not nodes in
schema v1; their relationships become diagnostics when relevant. Declaration kind
names are case-sensitive and cannot be extended by an implementation without a new
schema decision. The repository node has `name` from snapshot metadata and `path: "."`;
its identity tuple is `(schemaVersion, "repository", ".")`. Every source `file` node
has exactly one `contains` edge from the repository node. A module node is contained
by its defining file, and declarations are contained by their defining module or
file according to the semantic nesting available from the compiler. Containment is
structural and does not imply imports, calls, or other semantic relationships.

#### Edge kinds and required fields

Each edge has `id`, `kind`, `from`, and `to`, where both endpoints are node IDs and
`id` is a string with the prefix `e:`. Only edges whose endpoints and relationship
semantics are confidently resolved are allowed.

| Kind         | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `imports`    | A module imports a local module or symbol                      |
| `exports`    | A module exports a local declaration or module                 |
| `defines`    | A file/module defines a declaration                            |
| `contains`   | A declaration contains a named declaration or parameter        |
| `calls`      | A function or method calls a resolved local function or method |
| `references` | A declaration or expression references a resolved local symbol |
| `extends`    | A class or interface extends a resolved local class/interface  |
| `implements` | A class implements a resolved local interface                  |
| `types`      | A declaration uses a resolved local type                       |

Edges do not carry confidence scores. If confidence is insufficient, there is no
edge; the event is represented by a diagnostic instead.

### Deterministic identity and ordering

Node identity is derived from semantic identity, never from an absolute path, source
text, timestamp, or line number. For a named declaration, its identity tuple is:

```text
(schemaVersion, nodeKind, repository-relative path, qualifiedName, overload discriminator)
```

The tuple is encoded with length-delimited UTF-8 components and hashed with SHA-256;
the lowercase hexadecimal digest is appended after `n:`. The file identity tuple is
`(schemaVersion, "file", repository-relative path)`. Edge identity is the SHA-256
digest after `e:` of `(schemaVersion, edgeKind, from, to)`.

The overload discriminator is `""` for a unique declaration. For overloads or
otherwise same-named declarations, it is `sha256("overload\\0" + signature)` where
`signature` is a compiler-derived normalized signature: generic parameter count and
normalized constraints, parameter count and each parameter's optional/rest marker
and normalized type, followed by the normalized return type. Normalization removes
whitespace, source positions, declaration order, and aliases that resolve to the
same compiler type; it preserves explicit type structure and distinguishes overloads
with different semantics. The digest is independent of the overload's ordinal in
the full overload set. A duplicate normalized signature is an ambiguity diagnostic,
not an identity collision to resolve by position. If the compiler cannot provide a
stable normalized signature, the declaration is diagnosed rather than assigned a
line-based, random, or ordinal identity.

Nodes sort by `(kind, id)`; edges sort by `(kind, from, to, id)`; diagnostics sort by
`(path, start line, start column, code, message, related IDs)`. Every serialized
object has a fixed key order: snapshot `schemaVersion`, `completeness`,
`repository`, `nodes`, `edges`, `diagnostics`; repository `root`, `name`; node `id`,
`kind`, `name`, `path`, `qualifiedName`, `location`; edge `id`, `kind`, `from`,
`to`; diagnostic `code`, `severity`, `message`, `path`, `location`,
`relatedNodeIds`; location `path`, `start`, `end`; and positions `line`, `column`.
Optional fields that have no value are absent, never `null`; required fields are
always present. Arrays use the ordering above, and `relatedNodeIds` sorts by node ID.
Snapshot encoding is canonical UTF-8 JSON with no insignificant whitespace and one
trailing newline. The repository must maintain at least one synthetic canonical
fixture whose expected bytes are asserted exactly, including key order, omitted
optional fields, array order, and trailing newline. The same repository and compiler
inputs therefore produce byte-for-byte identical snapshots.

### Diagnostics and unsupported relationships

Diagnostics are ordered records with `code`, `severity`, `message`, optional
`location`, optional `relatedNodeIds`, and optional `path`. MVP severities are
`warning` and `error`; messages must not contain source text or absolute paths.

The following are diagnostics, never guessed edges: unresolved local symbols,
external-module relationships, dynamic imports or calls, computed property access,
ambiguous overload or symbol resolution, unsupported syntax, invalid paths, and
configuration errors. A dynamic JavaScript relationship is not made certain by a
name match. An external relationship may be reported, but no external node is
created. `completeness` is `complete` only when there are no `error` diagnostics;
any snapshot containing an error diagnostic is `partial`. Partial snapshots retain
all valid local nodes and edges but are rejected by query operations unless the
caller explicitly opts in with `allowPartial: true`.

### Snapshot codec port

The snapshot codec exposes two operations conceptually:

```text
encode(snapshot: SnapshotV1) -> UTF-8 bytes
decode(bytes) -> SnapshotV1 | SnapshotError
```

Encoding validates schema, completeness, IDs, paths, endpoints, closed unions, and
ordering before writing. Decoding rejects malformed JSON, unsupported `schemaVersion`,
unknown kinds, invalid paths, duplicate IDs, dangling endpoints, inconsistent
completeness, and non-canonical ordering. The MVP rejects unsupported versions; it
has no migrations. A future schema requires a new ADR and an explicit compatibility
policy.

### Query service port

The query service is read-only and operates on a validated snapshot. The shared
request/response contract is:

```text
query(request: QueryRequestV1) -> QueryResponseV1 | QueryErrorV1

QueryRequestV1 {
  operation: "getNode" | "findNodes" | "neighbors" | "diagnostics"
  nodeId?: string
  kind?: NodeKindV1
  name?: string
  path?: string
  edgeKinds?: EdgeKindV1[]
  direction?: "in" | "out" | "both"
  severity?: "warning" | "error"
  allowPartial?: boolean // default false
  limit?: integer // 1..1000; default 100
}
```

`allowPartial` defaults to `false` for every operation. `getNode` requires `nodeId`
and returns zero or one `NodeV1`; `findNodes` may filter by kind, name, and path and
returns all matching `NodeV1` candidates; `neighbors` requires `nodeId` and uses
`direction` (default `both`) and returns ordered `{ edge, node }` items; and
`diagnostics` may filter by path and severity and returns `DiagnosticV1` items. Each
operation has its own bounded `items` DTO but shares `schemaVersion: 1`,
`completeness`, and `truncated` response fields. Responses never include source text
or an absolute path.

Selectors are never resolved by choosing the first or best name match. An ID is
always unique. If a future selector requires one node but matches multiple nodes, the
service returns `ambiguous` with all bounded, deterministically ordered candidate
nodes; `findNodes` is the explicit operation for retrieving those candidates. No
ambiguous selector creates an edge or silently narrows a result.

The typed error codes are `invalid_request`, `not_found`, `unsupported_schema`,
`invalid_snapshot`, `limit_exceeded`, `ambiguous`, `partial_not_allowed`, and
`internal`. Errors have a stable `code`, a human-readable `message`, optional field
names, and optional `candidates` for `ambiguous`; they do not expose stack traces,
host paths, or source contents. `partial_not_allowed` is returned before any query
against an error-bearing snapshot when `allowPartial` is false. `internal` is for an
unexpected local failure and must be logged only under the repository's local privacy
rules.

The CLI parses arguments and serializes these same DTOs as local stdout/stderr. Its
explicit `--allow-partial` option maps to `allowPartial: true`; without that option
it maps to the default `false` and reports `partial_not_allowed`. MCP uses local
`stdio`, exposes the same operations and `allowPartial` field, and maps the same
error code without changing the default. Neither adapter may access the filesystem,
compiler, or graph directly outside the shared application ports.

### Privacy, runtime, and security boundaries

Analysis, snapshot encoding, query execution, CLI, and MCP are local-only and must
operate without runtime network access. MCP is a local `stdio` server, not an HTTP,
remote, or hosted transport. No source text, absolute path, timestamp, telemetry,
prompt, or graph result is sent to an external service by SourceMesh. A connected AI
client is a separate data-processing boundary and must be assessed independently.

The read-only query service never mutates source files or snapshots. Input paths and
query limits are validated before use, and errors do not echo sensitive local data.

## Rejected alternatives

### Persisting the full AST

Rejected for the MVP because it increases snapshot size, couples the contract to
compiler internals, and can retain source text. The semantic graph plus diagnostics
is sufficient for the first query workflows.

### A generic graph database or remote store

Rejected because it adds dependencies and an operational boundary before the local
contract is validated. Canonical JSON snapshots provide portable, reviewable,
offline storage for the MVP.

### A second parser or runtime JavaScript analysis

Rejected because it would create conflicting semantics and cannot make dynamic
relationships deterministic without executing user code. TypeScript Compiler API
analysis is the single source of syntax and symbol information for this scope.

### Treating names as relationships

Rejected because name matching invents edges for unresolved, overloaded, external, or
dynamic relationships. Such cases must remain diagnostics.

### Transport-specific query models

Rejected because separate CLI and MCP models would drift. Both adapters use the same
bounded query service DTOs and typed errors.

## Consequences

- Issues #18–#26 have explicit boundaries and can implement incrementally without
  changing graph semantics.
- Deterministic IDs do not change when a declaration moves within a file, but a
  semantic rename or path change does change identity.
- The contract intentionally omits anonymous declarations, full dynamic-JavaScript
  completeness, external nodes, databases, embeddings, and remote MCP.
- Source locations help explain findings but are never stable identity.
- TypeScript must be available at runtime once the loader/extractor is implemented;
  issue #19 must decide whether the existing package moves from development-only to
  runtime dependencies without adding a package.
- Consumers must reject schema versions they do not support; migrations remain out
  of scope.

## Validation examples

These synthetic examples are contract walkthroughs, not implementation fixtures:

1. A TypeScript `class User` and `function loadUser` in `src/users.ts` produce
   `class` and `function` nodes, `defines` edges from the file, and a `calls` edge
   only when the compiler resolves the call to `loadUser`.
2. A JavaScript `run(name)` calling `registry[name]()` produces a diagnostic for the
   dynamic relationship; it does not produce a `calls` edge to a node named `name`.
3. `import { external } from "external-package"` produces an ordered external-module
   diagnostic and no external node or `imports` edge.
4. Two same-name overloads receive deterministic discriminators when the compiler
   exposes stable signatures; otherwise both are diagnosed and neither gets an
   invented line-number identity.
5. A snapshot with only warnings is `complete` and is queryable with the default
   `allowPartial: false`; a snapshot with an unresolved configuration error is
   `partial`, returns `partial_not_allowed` by default, and is queryable only when
   the CLI flag or MCP/request field explicitly opts in to partial results.
6. A name selector matching two declarations returns both ordered candidates (or an
   `ambiguous` error with those candidates when a unique selector is required); it
   never chooses one declaration or emits a guessed edge.
