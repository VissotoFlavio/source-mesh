# ADR 0005: Local language-pack architecture and isolation

## Status

Accepted for the extensible language-pack work.

## Context

SourceMesh currently has TypeScript/JavaScript analysis and a local C# Roslyn
boundary. Future Java, Go, Kotlin, and Swift support must not make the Core
depend on each language's compiler APIs, project formats, or graph-extraction
rules. At the same time, every analysis must preserve the existing local-first
boundary: no repository data, derived graph data, or metadata may leave the
machine.

Language tooling is not trusted merely because it is installed locally. A pack
must not widen the Core-selected file set, execute project-controlled commands,
or turn an untrusted project manifest into arbitrary code execution. Snapshots
and MCP already form stable, versioned public contracts, so a pack cannot
silently reinterpret their meaning.

## Decision

SourceMesh will use local, versioned language packs. The Core owns discovery,
resource accounting, local isolation, graph identity and normalization,
snapshots, queries, CLI, and MCP. A pack owns only language-specific parsing and
the production of a normalized graph fragment for the closed input it receives.

### Pack manifest and registry

Every pack has a checked, local manifest. The manifest is data, not executable
configuration, and has a versioned closed schema. Its v1 shape declares:

- a stable `packId`, package version, and supported pack-contract major;
- recognized source and manifest extensions;
- capabilities, including project-manifest support and whether the extractor is
  in-process or a local worker;
- an extractor name and extractor version;
- every node kind and relation kind it may emit; and
- each emitted relation's allowed confidence: `semantic`, `syntactic`, or
  `inferred`.

The registry is owned by the Core and lists the enabled local packs explicitly.
It resolves one compatible pack version deterministically before discovery. It
does not scan arbitrary directories, load a repository-supplied plugin, install
anything, query a registry, or select a version from the network. A new pack is
added by registering a compatible manifest and implementation; it does not
require changing the Core public CLI, MCP, query, or snapshot contracts.

The Core uses manifest extensions and capabilities only to decide which pack is
eligible. It performs path containment, regular-file checks, ignore rules,
ordering, count and byte limits, and source-root overlap checks before a pack is
invoked. A pack receives an immutable `AnalysisRequest` containing only the
Core-approved relative paths, bounded file contents or staged copies, the
validated language manifest data it needs, and finite limits. It receives no
repository-root authority and cannot add paths to the request.

### Fragment contract and ownership

A pack returns a closed, bounded graph fragment. It may return declared node
and relation candidates, their approved relative locations, language metadata,
and sanitized diagnostic records. It never returns source text, absolute paths,
environment values, compiler objects, stacks, command lines, or arbitrary error
text.

The Core validates every fragment before it becomes graph data. It rejects
unknown fields, undeclared node or relation kinds, paths outside the approved
set, invalid locations, over-limit responses, and confidence values not allowed
by the manifest. The Core creates canonical graph and diagnostic identities,
deduplicates and orders output, validates relation endpoints, applies the
resource policy, and determines completeness. A fragment cannot write a
snapshot or query MCP directly.

`semantic` means the pack resolved the relation with its language semantic
model; `syntactic` means it was directly present in supported syntax; and
`inferred` means it follows from a documented conservative rule. The confidence
is evidence, not a request for the Core to guess a relationship. Unresolved,
external, ambiguous, dynamic, unsupported, or out-of-scope relations remain
sanitized diagnostics rather than invented edges.

### Execution models

The registry supports these local models:

1. **In-process pack.** A Core-owned adapter invokes a bundled library through
   the `AnalysisRequest` and has no independent file-discovery API. This is the
   initial model for the TypeScript/JavaScript pack.
2. **Local worker pack.** The Core runs a fixed, preinstalled executable with
   no shell. It supplies a closed request over `stdin` and accepts a bounded,
   closed response over `stdout`. This is the model for the C# Roslyn pack when
   compiler/runtime isolation is needed.
3. **Hybrid pack.** A small in-process adapter performs Core-facing validation
   and stages the approved inputs, then invokes a local worker for the
   language-specific operation. The adapter and worker together still expose
   exactly one pack manifest and fragment contract.

All three models have the same Core-facing contract. The model is an
implementation choice in the manifest, not a change to public graph, snapshot,
CLI, or MCP behavior.

### Local-worker protocol

The worker protocol is a separately versioned, `stdio`-only protocol. Its major
version is selected by the Core before spawn and must match exactly; a worker
with an unknown major is rejected. Additive protocol changes require a new minor
version with explicit optional-field handling, while incompatible changes
require a new major.

The C# implementation uses one bounded JSONL request and one bounded JSONL
response for an invocation. The Core starts only the registered helper at its
fixed local path with `shell: false`, a controlled working directory, and a
minimal environment. It caps request, response, stderr, diagnostics, process
time, source bytes, and aggregate bytes; timeout or limit failures terminate
the child and discard accumulated graph data. `stdout` carries protocol frames
only and capped `stderr` is converted to sanitized diagnostics. The Core parses
the response as a closed schema and rejects trailing frames, malformed JSON,
unknown fields, paths not in the approved set, and response values beyond the
declared limits.

For worker packs, the Core stages copies of the approved source files under
generated names. It supplies the staged mapping and validated manifest rather
than a repository path. The worker must neither enumerate the repository nor
open files outside that staging directory. It may not access the network,
download packages, restore dependencies, invoke a build, run MSBuild, launch
project tasks, execute scripts, or start a listener. A future worker sandbox may
strengthen this boundary, but it may not weaken these protocol and capability
rules.

### Untrusted .NET solution and project metadata

`.sln` and `.csproj` files are untrusted declarative inputs, never commands.
The Core selects an explicit contained solution or project and parses only the
documented, bounded subset necessary to construct the C# pack's manifest:
contained project references, supported compile items and removals, and the
approved language options. It validates every resulting path as a canonical,
regular repository-relative file and charges parsing, project, reference, file,
and byte limits before extraction.

SourceMesh never passes a repository `.sln` or `.csproj` to `dotnet`, MSBuild,
NuGet, a shell, or a project task. It does not evaluate imports, SDK resolution,
targets, properties with executable effects, conditions that require host
evaluation, wildcards beyond the explicitly supported literal rules, generated
items, or package restores. Unsupported or malformed metadata produces a
sanitized, fail-closed discovery result: no unapproved file reaches the worker.
The validated manifest is the only project metadata the C# worker receives.

### Compatibility and versioning

The Core, pack manifest, local-worker protocol, and snapshot each have an
explicit version boundary:

| Boundary                     | Compatibility rule                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pack contract                | Core accepts only known compatible majors; a new major requires an explicit Core/pack compatibility decision.                                       |
| Pack manifest                | A manifest has a closed schema. Unknown required fields or an unsupported version disable that pack rather than being ignored.                      |
| Worker protocol              | The Core and worker must agree on a known major before analysis; malformed or incompatible messages fail closed.                                    |
| Snapshot                     | Readers validate the declared snapshot schema and reject unsupported versions. Existing snapshots retain their prior interpretation and identities. |
| Relation confidence/evidence | New confidence values or evidence shapes require a versioned snapshot-contract change; existing readers never reinterpret them.                     |

Snapshot metadata will record the participating pack identities, extractor
versions, capabilities, and relation confidence/evidence in a later additive
schema decision. Until that schema is implemented, a pack must not claim that
new metadata is persisted. MCP remains local, read-only, and `stdio`-only; it
opens one already validated snapshot and never discovers packs, analyzes a
repository, or writes a snapshot.

### Installation and offline operation

Packs and workers are installed before analysis through a local, explicit,
exact-version-resolved process. Runtime mapping never downloads a pack,
language runtime, compiler, SDK, package, model, or update. The registry
validates the local pack's manifest and declared compatibility before it is
enabled. The closed configuration schema, source-owned bootstrap model,
compatibility matrix, integrity/update procedure, and offline validation are
defined in [the local language-pack installation guide](../local-language-pack-installation.md).

## Consequences

- Java, Go, Kotlin, and Swift packs can be designed against the manifest,
  request, fragment, resource, and version rules above without new product
  decisions.
- TypeScript/JavaScript can move behind an in-process pack adapter without
  changing its external behavior.
- The C# Roslyn helper has an implementable boundary: a validated Core manifest
  and staged approved files in, one closed bounded fragment out over `stdio`.
- New language-specific graph information remains subject to Core validation and
  versioned snapshot evolution.
- A pack that cannot operate under these constraints is unsupported; convenience
  execution of project tooling is not an alternative.

## Rejected alternatives

### Core adapters for every language

Rejected because each language would require cross-cutting Core changes and
would couple the stable query and snapshot layers to compiler-specific APIs.

### Repository-installed or remotely downloaded plugins

Rejected because the repository would gain code-execution and dependency
authority, and runtime analysis could transmit metadata or become
non-deterministic.

### Giving packs a repository root

Rejected because an allowed extension is not authority to discover arbitrary
files. The Core-approved list is the complete input authority.

### Running .NET project evaluation or builds for discovery

Rejected because imports, SDK resolution, targets, restores, and tasks turn
untrusted project metadata into executable behavior and can require network
access.
