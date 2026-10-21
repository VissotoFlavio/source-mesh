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
  program from the eight discovered extensions with exactly these compiler options:
  `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`,
  `jsx: Preserve`, `allowJs: true`, `checkJs: false`, `noEmit: true`,
  `resolveJsonModule: false`, and `skipLibCheck: true`. The loader does not infer
  options from the host Node version. Under TypeScript's NodeNext rules, `.mts` and
  `.mjs` are ESM, `.cts` and `.cjs` are CommonJS, and `.ts`, `.tsx`, `.js`, and
  `.jsx` use the nearest repository-contained `package.json` `type` field. The only
  valid `type` values are the strings `"module"` and `"commonjs"`; an absent field
  means `"commonjs"`. Any other value, including another string, `null`, or a
  non-string JSON value, is invalid and is a configuration error. The loader does
  not silently treat an invalid value as CommonJS. Mixed local ESM/CommonJS imports
  use the compiler's NodeNext resolution and module-compatibility diagnostics; the graph
  records only relationships the checker resolves and never applies a filename or
  extension heuristic of its own.
- A malformed or unsupported configuration is a deterministic diagnostic and does
  not silently fall back to a different project. A missing configuration is the only
  case that uses the configuration-free program.
- The loader establishes the repository's canonical root with `realpath` before
  resolving any input. Every `tsconfig.json`, `extends` target, project reference,
  `files`/`include` result, source file, declaration file, and module-resolution
  candidate must have a successful realpath contained by that root. The only
  intentional exception is a compiler-selected trusted standard library, which is
  read as context-only and remains excluded from graph and diagnostic output.
  Containment uses path-segment boundaries, not string prefixes. A symlink or
  junction is accepted only when its resolved target is verifiably inside the root,
  and that realpath containment is revalidated immediately before every file read.
  A broken link, unresolved realpath, or non-library target outside the root is a
  fail-closed error diagnostic.
  An `extends` chain or project reference outside the root invalidates the loaded
  project. An `include`/`files` match or module/source resolution outside the root is
  excluded from the graph and recorded as an error diagnostic; it is never followed
  to create nodes or edges. These containment cases require negative tests.
- The extractor consumes compiler symbols and syntax and emits semantic candidates;
  it does not persist the full AST or source text.

Discovery roots and compiler context are separate sets. Only discovered files with
the eight supported extensions can become `file` nodes. `node_modules`, VCS
metadata, generated files, configured output directories, and declaration files are
never graph roots. A declaration file or any other compiler-context file may support
type/module resolution, but it can never become a node, edge endpoint, or source
diagnostic. A local source relationship that cannot be resolved because its
context-only target is rejected becomes the normal unresolved-relationship diagnostic
on the local source; diagnostics are never attributed to the context file. If a
symlink or junction cannot be revalidated as contained at read time, it is rejected
fail-closed rather than read.

#### Exclusions and generated-file classification

Exclusion matching is performed twice, with path-segment boundaries in both cases:
first on the normalized lexical path supplied by discovery, then on the canonical
`realpath` of every path component and its final target. Matching folds Unicode
letters to the platform-independent simple case-folded form for exclusion checks;
serialized paths retain their discovered case. A candidate is excluded when either
view is under `node_modules`, `.git`, `.hg`, `.svn`, or `.bzr`, or under an
authoritative generated/output root. This rejects a symlink or junction whose
target is in one of those directories even when its lexical path is elsewhere, and
also rejects a lexical path that enters one of those directories before resolving
the link.

The v1 authoritative generated/output roots are the validated TypeScript
`outDir`, `declarationDir`, and the parent directory of `outFile`, any explicit
generated/output roots supplied by the project loader, and the repository-relative
reserved roots `build`, `coverage`, `dist`, `generated`, `out`, `.next`, and
`storybook-static`. A configured root is canonicalized and containment-checked
before it is accepted. A file under an authoritative root is generated/output even
when its extension looks like source; it is never a graph root, node, edge
endpoint, or diagnostic source. File names, extensions, comments such as
`@generated`, timestamps, and ignore files are not generated-file authority.

Classification has this precedence: excluded path, generated/output, eligible
project source, compiler context-only, then invalid/ambiguous. If two
authoritative rules assign conflicting classifications to the same path, or an
authoritative root cannot be normalized or realpathed, classification is ambiguous.
The loader fails closed, emits a `generated_file_ambiguous` error diagnostic with
the safest eligible local path (or no path when attribution is unsafe), and does
not create a node, endpoint, or diagnostic sourced from the ambiguous file. An
excluded or generated file is not rescued by an `include` or `files` entry.

#### Trusted standard libraries and compiler context

TypeScript standard-library declarations selected by the compiler (`noLib`, the
explicit `lib` list, or the target's default libraries) are a separate trusted
standard-library set. They are compiler context only: they never become graph
nodes, edge endpoints, or diagnostics, and their absolute installation paths are
never serialized. Project declaration files and external declarations are also
context-only, but they are not trusted standard libraries and may influence
resolution only when the containment and exclusion rules allow them to be read.
No external or context-only file can be a diagnostic source.

When `noLib: true` is selected, the loader loads no standard-library set and does
not synthesize a replacement. Eligible project source files are still analyzed;
missing global types may make a relationship unresolved and produce a diagnostic
on the eligible local source, but the absent libraries themselves produce no graph
objects or diagnostics. A standard-library diagnostic from the compiler is
discarded rather than attributed to a library file.

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

The location object above is `LocationV1`.

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

`repository.name` is a display value only and must not be used for identity. It is
derived without the absolute root: when the repository-root `package.json` has a
non-empty string `name` containing no slash, backslash, or control character, that
name is used after Unicode NFC normalization; otherwise the literal `repository` is
used. The derivation never uses an absolute path, hostname, git remote, timestamp,
or random value, so the same repository metadata produces the same name when
checked out at different absolute roots. An invalid package name falls back to
`repository` and does not change repository identity. The repository identity tuple remains
`(schemaVersion, "repository", ".")`.

The schema is a closed union: unknown node or edge kinds are invalid, and
additional required fields cannot be inferred by consumers.

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

Each edge has `id`, `kind`, `from`, `to`, and `resolutionStatus`, with an optional
`location`. Both endpoints are node IDs and `id` is a string with the prefix `e:`.
Only edges whose endpoints and relationship semantics are confidently resolved are
allowed.

| Kind         | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `imports`    | A module imports a local module or symbol                      |
| `exports`    | A module exports a local declaration or module                 |
| `contains`   | The single structural parent-child hierarchy                   |
| `calls`      | A function or method calls a resolved local function or method |
| `references` | A declaration or expression references a resolved local symbol |
| `extends`    | A class or interface extends a resolved local class/interface  |
| `implements` | A class implements a resolved local interface                  |
| `types`      | A declaration uses a resolved local type                       |

`contains` is the only structural hierarchy edge. Its allowed parent-child forms
are repository -> file, file -> module, module -> nested declaration, and class or
function -> nested declaration or parameter, as applicable to the compiler's
semantic nesting. A declaration has at most one `contains` parent. `contains` is
emitted for the direct parent only; transitive ancestry is obtained by traversal.
There is no `defines` edge in schema v1. Declaration provenance and ownership are
represented by `contains`, while `imports`, `exports`, `calls`, `references`, and
the other semantic edges describe relationships that are not parent-child.

Edges do not carry confidence scores. If confidence is insufficient, there is no
edge; the event is represented by a diagnostic instead. In schema v1 every emitted
edge has `resolutionStatus: "resolved"`; the closed union rejects any other edge
status. `unresolved`, `external`, `dynamic`, and `ambiguous` are diagnostic
outcomes, never edge values. An edge `location`, when present, is the local source
span that caused or declared the relationship. For `contains` it is the child
declaration span when trustworthy; for other kinds it is the import, export, call,
reference, inheritance, or type-use span. It uses the same repository-relative,
one-based, end-exclusive `LocationV1` rules as node locations, is omitted when no
trustworthy local span exists, and is never used in edge identity.

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

Every declaration, including a declaration that is the only overload, has a
non-empty discriminator: `sha256("decl\\0" + signature)`. `signature` is a
declaration-specific compiler-derived normalized signature containing declaration
kind, generic parameter count and normalized constraints, parameter count and each
parameter's optional/rest marker and normalized type, normalized return type when
applicable, and the normalized declared type for variables, properties, aliases,
and enum-like declarations. Normalization removes whitespace, source positions,
declaration order, and aliases that resolve to the same compiler type; it preserves
explicit type structure and distinguishes declarations with different semantics.
The digest is independent of the ordinal or membership of the full overload set, so
adding an unrelated overload cannot change an existing declaration ID. A duplicate
identical normalized signature at the same semantic path is an ambiguity diagnostic;
both colliding declarations are omitted rather than merged or assigned a set-position
ordinal. If the compiler cannot provide a stable normalized signature, the
declaration is diagnosed rather than assigned a line-based, random, or ordinal
identity.

Nodes sort by `(kind, id)`; edges sort by `(kind, from, to, id)`; diagnostics use the
explicit diagnostic key below. Every serialized object has a fixed key order:
snapshot `schemaVersion`, `completeness`,
`repository`, `nodes`, `edges`, `diagnostics`; repository `root`, `name`; node `id`,
`kind`, `name`, `path`, `qualifiedName`, `location`; edge `id`, `kind`, `from`,
`to`, `resolutionStatus`, `location`; diagnostic `id`, `code`, `severity`, `message`,
`path`, `location`, `relatedNodeIds`; location `path`, `start`, `end`; and positions
`line`, `column`.
Optional fields that have no value are absent, never `null`; required fields are
always present. Arrays use the ordering above, and `relatedNodeIds` sorts by node ID.
Snapshot encoding is canonical UTF-8 JSON with no insignificant whitespace and one
trailing newline. The repository must maintain at least one synthetic canonical
fixture whose expected bytes are asserted exactly, including key order, omitted
optional fields, array order, and trailing newline. The same repository and compiler
inputs therefore produce byte-for-byte identical snapshots.

### Diagnostics and unsupported relationships

Diagnostics are ordered records with required `id`, `code`, `severity`, and
`message`, plus optional `location`, `relatedNodeIds`, and `path`. MVP severities
are `warning` and `error`; messages must not contain source text or absolute paths.
The diagnostic ID has the prefix `d:` and is the SHA-256 digest of the schema
version, producer rule ID, normalized diagnostic fields, and a deterministic
occurrence key. The occurrence key is assigned by the producer from its stable
source anchor and canonical rule traversal order before final response sorting:
source path and span, then producer rule ID, compiler category, and the producer's
deterministic same-anchor occurrence index. It is never the position in the
serialized array. Thus two duplicate-equivalent diagnostics remain two records
with distinct stable IDs rather than being deduplicated.

Diagnostic ordering is a total lexicographic order over UTF-8 strings and ascending
integers. Its key is:

```text
(
  pathKey,
  locationKey,
  code,
  severity,
  message,
  relatedNodeIdsKey,
  id
)
```

`pathKey` is `[0, path]` when `path` is present and `[1, ""]` when it is absent.
`locationKey` is `[0, path, start.line, start.column, end.line, end.column]`
when `location` is present and `[1, "", 0, 0, 0, 0]` when it is absent.
`relatedNodeIdsKey` is `[0]` when `relatedNodeIds` is absent and
`[1, count, ...sortedIds]` when it is present; an explicitly empty related-ID list
is invalid. These sentinels put present values before absent values and make
absence independent of host-language `null`/`undefined` comparison behavior.
The final `id` tie-breaker is mandatory even when every visible diagnostic field is
equal.

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
  cursor?: string
}
```

`allowPartial` defaults to `false` for every operation. `getNode` requires `nodeId`
and returns one `NodeV1` or the typed `not_found` error; `findNodes` may filter by
kind, name, and path and returns `NodeV1` candidates; `neighbors` requires `nodeId`
and uses `direction` (default `both`) and returns ordered `{ edge, node }` items; and
`diagnostics` may filter by path and severity and returns `DiagnosticV1` items. Each
operation has its own bounded `items` DTO and shares `schemaVersion: 1`,
`completeness`, `total`, `truncated`, and optional `continuation` response fields.
`total` is the exact number of matching items before the limit is applied. Responses
never include source text or an absolute path.

The default limit is 100 and the maximum is 1000. A limit outside `1..1000` is an
`invalid_request`; a result set larger than the limit is sorted completely before a
bounded prefix is returned with `truncated: true`, while a complete result has
`truncated: false` and no continuation. A continuation is a deterministic token
containing the operation, filter fingerprint, and last returned sort tuple; passing
it as `cursor` resumes strictly after that tuple. Tokens use canonical UTF-8 JSON
encoded as base64url and contain no paths outside the response contract or source
text. `findNodes` sorts by `(kind, id)`, neighbors by `(edge.kind, edge.from, edge.to,
edge.id, node.id)`, and diagnostics by the total diagnostic key above before cutting
the prefix. The diagnostic `id` is part of the continuation sort tuple, so a cursor
can resume between duplicate-equivalent diagnostics without skipping or repeating
one. For example, two identical visible diagnostics with IDs `d:a` and `d:b` and
`limit: 1` return the first ID, `truncated: true`, and a cursor after `d:a`; using
that cursor returns the second ID with `truncated: false` and no continuation.
`total` counts both records in this example.

Selectors are never resolved by choosing the first or best name match. An ID is
always unique. If a future selector requires one node but matches multiple nodes, the
service returns `ambiguous` with a bounded, deterministically ordered candidate list,
`totalCandidates`, `truncated`, and `continuation`; `findNodes` is the explicit
operation for retrieving those candidates. No ambiguous selector creates an edge or
silently narrows a result. Candidate lists use the same default/max limits and
sort-before-cut rule as `findNodes`.

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

The logical operation families for issues #23–#25 are explicit aliases over these
shared query operations and DTOs; they are not separate graph semantics:

| Family       | Shared query mapping | Direction and edge filter                                    | Response DTO                                      | CLI/MCP mapping                 |
| ------------ | -------------------- | ------------------------------------------------------------ | ------------------------------------------------- | ------------------------------- |
| Search       | `findNodes`          | Filters from `QueryRequestV1` (`kind`, `name`, `path`)       | `FindNodesResponseV1` with `NodeV1[]` items       | `search` / `search`             |
| Details      | `getNode`            | `nodeId` required; no edge traversal                         | `GetNodeResponseV1` with one `NodeV1`             | `details` / `details`           |
| Dependencies | `neighbors`          | `direction: "out"`; all non-`contains` edge kinds by default | `NeighborsResponseV1` with `{ edge, node }` items | `dependencies` / `dependencies` |
| Dependents   | `neighbors`          | `direction: "in"`; all non-`contains` edge kinds by default  | `NeighborsResponseV1` with `{ edge, node }` items | `dependents` / `dependents`     |
| Callers      | `neighbors`          | `direction: "in"`; `edgeKinds: ["calls"]`                    | `NeighborsResponseV1` with `{ edge, node }` items | `callers` / `callers`           |
| Callees      | `neighbors`          | `direction: "out"`; `edgeKinds: ["calls"]`                   | `NeighborsResponseV1` with `{ edge, node }` items | `callees` / `callees`           |

The CLI command names and MCP method names in the table map to the same
`QueryRequestV1` fields and the same versioned response/error DTOs. Search and
details are the #23 node search/details family; dependencies and dependents are
the #24 relationship-direction family; callers and callees are the #25 call-edge
family. A caller is the `from` endpoint of a resolved `calls` edge and a callee is
its `to` endpoint. Dependencies and dependents use the edge's stored direction;
they never reverse or infer an edge in the adapter. The default non-`contains` set
is `imports`, `exports`, `calls`, `references`, `extends`, `implements`, and
`types`, and callers may narrow it with `edgeKinds`.

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
   `class` and `function` nodes, `contains(repository, file)`,
   `contains(file, module)`, and `contains(module, User)` edges, plus a `calls` edge
   only when the compiler resolves the call to `loadUser`. No `defines` edge is
   emitted in schema v1.
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
7. A file importing `./common.cjs` from an ESM `.mts` file is classified and
   resolved under NodeNext/package `type` rules; a `.d.ts` reached only for that
   resolution can affect checking but never becomes a graph root, node, edge, or
   diagnostic source.

### Deterministic fixture and test requirements

Before implementation is considered contract-complete, the repository must include
small synthetic fixtures and assertions for the following cases:

1. Two duplicate-equivalent diagnostics, requested with `limit: 1`, prove that
   `total`, the diagnostic-ID tie-breaker, `truncated`, and continuation produce
   both records exactly once.
2. Diagnostics with absent path, absent location, and absent related IDs are mixed
   with present values and assert the sentinel ordering and canonical JSON bytes.
3. Lexical paths and symlink/junction targets under `node_modules`, each VCS
   directory, and each reserved/configured output root are rejected, including a
   path whose lexical and real paths classify differently.
4. A generated-file marker or filename alone does not classify a file as generated;
   a conflicting authoritative source/output classification fails closed with no
   generated node or endpoint and a deterministic error diagnostic.
5. A project using trusted standard libraries has no library nodes, endpoints, or
   diagnostics; the same fixture with `noLib: true` has no synthesized library
   objects and records only local-source consequences.
6. The #23–#25 request mappings assert search/details, dependency/dependent, and
   caller/callee directions and shared CLI/MCP DTOs; an edge fixture asserts local
   edge location omission/presence and `resolutionStatus: "resolved"`.
7. The same project loaded from two absolute roots has identical `repository.name`
   and snapshot identity, and `package.json` fixtures cover absent, `"module"`,
   `"commonjs"`, and every invalid `type` value as a configuration error.
