# SourceMesh

SourceMesh is an experimental, local-first tool that turns an explicitly
selected source-code boundary into a deterministic structural graph. It gives
developers and AI agents a compact way to navigate symbols and inspect direct
local relationships without sending repository data to a hosted analysis
service.

Use it to answer bounded questions such as "where is this symbol declared?",
"which local files directly depend on this file?", and "which proven local
functions call this function?". SourceMesh exposes those queries through a
local CLI and a read-only MCP server over `stdio`. It currently supports
explicit TypeScript/JavaScript and C#/.NET source selections.

## What SourceMesh does and does not prove

SourceMesh analyzes only the repository root and source selection you provide.
It records structural relationships that its local analysis can establish and
returns unresolved or external diagnostics instead of guessing.

- It does not send source code, paths, graph data, prompts, or results over the
  network at runtime.
- It does not provide a complete semantic model of a whole system, dynamic
  runtime behavior, or external dependencies.
- C# analysis parses only selected local source files. It never restores NuGet
  packages, compiles or executes the target, or reports compiler diagnostics.
- A relationship to an unselected project, external package, dynamic target, or
  unresolved target is not a proven local graph edge.

SourceMesh's local boundary does not govern an MCP host, editor, agent, or model
provider. A connected consumer can process or transmit its MCP schemas,
arguments, and results under its own policy. Review that consumer before sharing
repository information with it.

## Quick start: installed package

The supported installed package is a Windows x64 prerelease for a machine with
the .NET 10 runtime, Node.js 22.13+ within Node 22 or Node.js 24, and npm.
Download a matching `.tgz` and `.tgz.sha256` pair from the selected GitHub
[prerelease](https://github.com/VissotoFlavio/source-mesh/releases), then check
the downloaded asset before installing it. The package is not installed from
the npm registry.

```powershell
$tarball = '.\vissotoflavio-source-mesh-<version>.tgz'
$checksum = "$tarball.sha256"
$expected = (Get-Content -LiteralPath $checksum -Raw).Trim().Split(' ')[0]
$actual = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'SourceMesh package checksum mismatch.' }
npm install --global --offline --ignore-scripts $tarball
sourcemesh --help
```

The checksum sidecar detects a corrupted or mismatched download; it is not an
independent authentication mechanism when both assets come from a compromised
release. Obtain the release from a GitHub repository identity you trust before
installing or running the package.

Create a fresh, explicit snapshot before starting MCP. Choose one selection
mode: a legacy solution, one project, or a repeated list of projects. Do not
combine `--solution` and `--project`.

```powershell
sourcemesh analyze --root <repository-root> --language csharp --solution <relative-solution-path> --snapshot-id csharp-<run-id>
```

For one deliberately selected project, replace `--solution` with
`--project <relative-project-path>`. For a bounded multi-project snapshot,
repeat `--project` once per selected root-relative `.csproj`. Use a new,
lowercase snapshot ID for every analysis: snapshot creation is create-only.

Start MCP with the same root and the snapshot just created:

```powershell
sourcemesh mcp --root <repository-root> --snapshot .sourcemesh/snapshots/csharp-<run-id>.json
```

An MCP host should run that command with an explicit Node executable and the
installed CLI path. The full host configuration, supported-environment details,
snapshot selection rules, source-encoding guidance, and handover procedure are
in the packaged [installation and MCP guide](docs/csharp-mcp-snapshot-package-guide.md).

The server opens one immutable snapshot and exposes only six read-only tools:
`searchSymbols`, `getSymbol`, `listFileDependencies`, `listFileDependents`,
`listCallers`, and `listCallees`. It never creates, replaces, or deletes a
snapshot. To use a later analysis, create a different snapshot ID and start a
new MCP process; a running process remains pinned to its original snapshot.

For local language-pack installation and offline compatibility rules, see the
[local language-pack installation guide](docs/local-language-pack-installation.md).

## Guidance for AI agents

Treat the MCP server as a bounded, read-only view of one existing snapshot.
Before querying, confirm that the intended repository root and snapshot were
selected by a local operator or another authorized workflow. Do not ask MCP to
analyze a repository or create a snapshot.

Use an incremental query flow:

1. Start with `searchSymbols` and narrow by `kind`, `path`, or `containerId`
   when the target is not unique.
2. Use a returned symbol `id` as `getSymbol`'s `nodeId`, or provide a
   sufficiently specific selector. If a selector is ambiguous, refine it; do
   not pick a result.
3. Use `listFileDependencies` or `listFileDependents` for direct file
   relationships, and `listCallers` or `listCallees` for direct function-call
   relationships.
4. Keep cursors opaque and use them only with the same query. Results are
   bounded: request a `limit` from 1 through 100 and follow a continuation only
   when more results are needed.
5. `allowPartial` defaults to `false`. Use it only when a partial snapshot is
   acceptable for the question, and report that limitation with the result.

Do not infer compilation success, NuGet/package resolution, external calls,
dynamic dispatch, or relationships that the snapshot does not explicitly
return. An optional, separately installed agent skill may provide this operating
guidance in `SKILL.md` form, but no skill is required to use MCP. The
[SourceMesh skill](https://github.com/VissotoFlavio/source-mesh/blob/d510d70ad21f3808637d0b403d42ac0528a7f59d/skills/sourcemesh/SKILL.md)
is versioned separately from the package and pinned to a reviewed revision.
Install it according to the host's own skill-installation rules; review and
deliberately select a new revision before updating it.

## Maintainer workflow

### Local development

Prerequisites:

- Node.js 22.13 or newer within the 22.x line, or Node.js 24.x
- npm

Install the locked development dependencies:

```sh
npm ci
```

Run the complete local validation gate:

```sh
npm run check
```

The aggregate check verifies formatting, linting, types, tests, build output, and package contents. Individual commands are also available:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run offline:check
npm run pack:check
```

### Verify package distribution from a checkout

The remaining maintainer instructions require a SourceMesh repository checkout.

Maintainers build the helper from the committed offline NuGet feed and validate
the complete package with:

```powershell
dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config
npm run csharp:offline:check
npm run package:check
```

`package:check` installs a real package into an empty local consumer, analyzes
the synthetic C# fixture, and queries the installed MCP over stdio under the
checkout validation guard.

The exact payload allowlist, approved dependency SHA-256 values, package
versions, and size bounds are recorded in
[scripts/package-manifest.json](https://github.com/VissotoFlavio/source-mesh/blob/develop/scripts/package-manifest.json).
The package
build writes a per-tarball integrity manifest for the compiled helper DLL.
Third-party license and integrity inventory is in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). See
[the package-distribution contract](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/package-distribution.md)
for the supported contract and exclusions.

For checkout-only Windows x64 beta validation, see
[the beta checkout guide](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/beta-checkout.md).

For the ordered beta gates, safe execution rules, outcomes, and tester evidence
limits, see the
[beta validation runbook](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/beta-validation-runbook.md).

For SemVer beta candidates, release metadata timing, promotion gates, evidence,
rollback, and authorization limits, see the
[beta versioning and promotion policy](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/beta-version-promotion.md).

For the authorized GitHub workflow that turns an eligible release pull request
into an immutable private package candidate, see
[immutable package candidates](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/package-candidate-recovery.md).

From a checkout after a build, analyze and query a repository locally:

```sh
node dist/cli.js analyze --root /path/to/repository --snapshot-id run-20261028
node dist/cli.js symbol --root /path/to/repository --snapshot .sourcemesh/snapshots/run-20261028.json --query Widget --output json
```

Each analysis requires a new explicit snapshot ID. IDs use only lowercase ASCII
letters, digits, and hyphens, start with a letter, and are 1–64 characters. The
derived path is always `.sourcemesh/snapshots/<id>.json`; creation is atomic and
create-only, so `--overwrite` is not available. The other commands are `details`,
`dependencies`, `dependents`, `callers`, and `callees`. Query commands
accept `--limit 1..100`, `--cursor`, and `--allow-partial`; selectors are explicit
and do not guess when they are ambiguous. Use `<command> --help` for the exact
grammar.

`.sourcemesh/graph.json` is a legacy location. It is never an analysis target;
it can only be read when an operator explicitly supplies it to a read command.
Do not delete snapshots automatically. Clean up manually only after confirming
that no configured MCP process still uses the selected snapshot.

JSON output is a deterministic versioned envelope on stdout:

```json
{ "schemaVersion": 1, "command": "symbol", "result": {} }
```

JSON failures use the same envelope on stderr. Successful commands return `0`,
invalid arguments return `2`, typed query target/request failures return `3`, and
an existing create-only snapshot returns `4`. Operational and analysis failures
return `1`. Human output is concise and is not the automation contract.

## Local MCP server

SourceMesh can expose the pinned snapshot through a read-only MCP server over the
local process pipes:

```sh
node dist/cli.js mcp --root /path/to/repository --snapshot .sourcemesh/snapshots/run-20261028.json
```

Generate the snapshot before configuring or starting MCP. The server only
queries an existing validated snapshot; it does not analyze the repository or
write a snapshot. The installed C# selection, encoding, diagnostic-budget,
create-only, and same-root flow is in the
[installation and MCP guide](docs/csharp-mcp-snapshot-package-guide.md).

The server requires a snapshot explicitly, loads and validates it once before opening `stdio`, constructs one
immutable query service, and registers exactly these bounded tools:
`searchSymbols`, `getSymbol`, `listFileDependencies`, `listFileDependents`,
`listCallers`, and `listCallees`. Query text is limited to 256 UTF-16 code
units, limits are `1..100`, cursors are limited to 4096 bytes, and all tool
objects reject unknown properties. The server has no network listener,
resources, prompts, or write tools. MCP protocol messages exclusively use
stdout; startup, lifecycle, and sanitized error diagnostics use stderr.

Configure an MCP host with the installed Node executable and CLI path from the
[installation and MCP guide](docs/csharp-mcp-snapshot-package-guide.md), an
explicit repository root, and a snapshot path. To hand over to a fresh
analysis, publish a different ID then start a new MCP process with that path; a
running process remains pinned to its original snapshot. SourceMesh sends only
requested bounded graph responses through the local pipe. The connected editor, agent, or model host
may process or transmit tool schemas, arguments, and results under its own
privacy and data-processing policy; local `stdio` is not a guarantee that the
host or its provider remains local.

The CLI prints only approved graph summaries, repository-relative paths, snapshot
metadata, and sanitized diagnostics. It never prints source text, absolute paths,
compiler objects, stacks, secrets, or environment data. Runtime analysis uses
filesystem and TypeScript compiler APIs only; it does not invoke Git, subprocesses,
network APIs, telemetry, or hosted services.

## End-to-end validation

The repository contains one fully synthetic fixture at
`test/fixtures/e2e-project/`. It is copied into test-owned temporary directories;
no real or private repository is indexed or committed. The built-runtime proof is:

```sh
npm run build
npm run e2e:check
```

The proof runs discovery, the project loader, TypeScript/JavaScript extraction,
relationship resolution, snapshot writing and validated loading, all six bounded
query families, CLI JSON, and a local MCP `stdio` client. It starts every
SourceMesh child process with `scripts/deny-network.mjs`, compares repeated and
different-root snapshot bytes, and compares the transport-neutral DTO returned by
each CLI/MCP request pair. It also covers the reserved `generated/` exclusion,
an unresolved call without a guessed edge, a sanitized recoverable syntax-error
variant, and `--limit 1` response bounds.

For the bounded manual observation (not a performance gate), run:

```sh
npm run measure:e2e -- --runs 5
```

The command reports raw analyze, CLI-query, and MCP-call samples together with
Node.js, OS, commit, fixture counts, and snapshot bytes. These measurements are
fixture- and host-specific; they are not production capacity, latency SLOs, or
arbitrary-repository scale claims. The complete validation record and
limitations are in
[the MVP validation record](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/mvp-validation.md).

## Project status

SourceMesh is pre-release. Package publication, releases, hosted processing, and
compatibility changes require separate authorization and issue-backed work.

See
[the contribution workflow](https://github.com/VissotoFlavio/source-mesh/blob/develop/CONTRIBUTING.md),
[the technical baseline](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/decisions/0001-technical-baseline.md),
[the source graph MVP architecture](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/decisions/0002-source-graph-mvp-architecture.md),
and
[the local language-pack architecture](https://github.com/VissotoFlavio/source-mesh/blob/develop/docs/decisions/0005-local-language-pack-architecture.md)
for the development workflow, stack decision, accepted graph/query contracts,
and approved extensibility and isolation model.

## License

Licensed under the [Apache License 2.0](LICENSE).
