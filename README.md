# SourceMesh

SourceMesh is an experimental, local-first project for building a deterministic structural graph of source code. Its goal is to give developers and software agents a compact view of code structure and relationships without sending repository data to a hosted service.

The local CLI can analyze an explicitly selected TypeScript/JavaScript or C#/.NET repository into a contained snapshot and query symbols, files, and direct call relationships without a hosted service.

## Privacy boundary

SourceMesh repository analysis is required to run locally and without runtime network access. SourceMesh itself must not transmit source code, file paths, graph data, derived metadata, prompts, or analysis results through telemetry, logging, analytics, tracing, error reporting, hosted language models, or visualization services.

Installing development dependencies can contact the npm registry. That installation traffic is separate from future repository analysis. Any future SourceMesh feature that requires network access must be opt-in and approved through a separate, documented decision before implementation.

These requirements cover SourceMesh itself. An editor, agent, model provider, script, or other external consumer of SourceMesh output has its own data-processing and network boundary. Review that consumer independently before giving it repository information or generated graph data.

## Local development

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

## Install an official prerelease

The supported installed package is a Windows x64 prerelease asset for a machine
with the .NET 10 runtime already installed. Download the selected GitHub
prerelease tarball and its SHA-256 checksum, verify it, install it globally,
and configure an MCP host without requiring a SourceMesh checkout. The complete
user and AI-host procedure is in the packaged
[installation and MCP guide](docs/csharp-mcp-snapshot-package-guide.md).

The package is private and is not installed from the npm registry. Installation
is a local `npm install --global --ignore-scripts <downloaded-tarball>` step;
runtime analysis does not restore, compile, download dependencies, update
itself, or contact a registry.

## Verify package distribution from a checkout

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
[scripts/package-manifest.json](scripts/package-manifest.json). The package
build writes a per-tarball integrity manifest for the compiled helper DLL.
Third-party license and integrity inventory is in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). See
[docs/package-distribution.md](docs/package-distribution.md) for the supported
contract and exclusions.

For checkout-only Windows x64 beta validation, see
[docs/beta-checkout.md](docs/beta-checkout.md).

For the ordered beta gates, safe execution rules, outcomes, and tester evidence
limits, see the [beta validation runbook](docs/beta-validation-runbook.md).

For SemVer beta candidates, release metadata timing, promotion gates, evidence,
rollback, and authorization limits, see the
[beta versioning and promotion policy](docs/beta-version-promotion.md).

For the authorized GitHub workflow that turns an eligible release pull request
into an immutable private package candidate, see
[immutable package candidates](docs/package-candidate-recovery.md).

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
arbitrary-repository scale claims. The complete validation record and limitations
are in [docs/mvp-validation.md](docs/mvp-validation.md).

## Project status

SourceMesh is pre-release. Package publication, releases, hosted processing, and
compatibility changes require separate authorization and issue-backed work.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, [the technical baseline](docs/decisions/0001-technical-baseline.md) for the current stack decision, [the source graph MVP architecture](docs/decisions/0002-source-graph-mvp-architecture.md) for the accepted graph and query contracts, and [the local language-pack architecture](docs/decisions/0005-local-language-pack-architecture.md) for the approved extensibility and isolation model.

## License

Licensed under the [Apache License 2.0](LICENSE).
