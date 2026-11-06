# C# snapshot runbook for local MCP

SourceMesh MCP serves one existing, validated local snapshot through read-only
queries. It does not run C# analysis, create a snapshot, or replace one.
Generate a snapshot before configuring or starting MCP.

This repository-facing runbook uses a built checkout. For an installed
release package, use
[the installed-package guide](csharp-mcp-snapshot-package-guide.md) instead.

## Create a snapshot

Choose exactly one repository-relative selection mode: a legacy solution, an
intentionally single project, or an explicit set of projects. Do not rely on
automatic solution discovery and do not combine `--solution` with `--project`.

```sh
node dist/cli.js analyze --root <repository-root> --language csharp --solution <relative-solution-path> --snapshot-id csharp-<run-id>
```

For an intentionally single-project target, use `--project` instead:

```sh
node dist/cli.js analyze --root <repository-root> --language csharp --project <relative-project-path> --snapshot-id csharp-<run-id>
```

For an application or other bounded multi-project snapshot, repeat
`--project` for every selected root-relative `.csproj`. Project order has no
meaning. SourceMesh analyzes only this selected set; a reference to an
unselected project remains an external or unresolved boundary.

```sh
node dist/cli.js analyze --root <repository-root> --language csharp --project src/App/App.csproj --project src/Domain/Domain.csproj --snapshot-id csharp-app-<run-id>
```

Create a separate snapshot with its own selected `--project` values and ID for
tests. SourceMesh never infers test membership from directory names or merges
the source sets of separate snapshots.

Each analysis requires a new lowercase ASCII snapshot ID (letters, digits, and
hyphens; starting with a letter; 1–64 characters). It deterministically maps to
`.sourcemesh/snapshots/csharp-<run-id>.json`. Creation is create-only and
`--overwrite` is not supported. If an ID already exists, preserve it and choose
a new ID.

UTF-8 is the normal source policy. Use `--source-encoding windows-1252` only
when the target repository has been confirmed to need that compatibility mode;
it is not an automatic fallback. C# analysis parses the selected source files
locally without restoring packages, compiling the target, or reporting compiler
diagnostics. It records only supported syntactic declarations and conservative
local relationships; external or unresolved targets remain graph diagnostics.

## Start MCP

After analysis succeeds, use the same repository root and snapshot path when
starting MCP:

```sh
node dist/cli.js mcp --root <repository-root> --snapshot .sourcemesh/snapshots/csharp-<run-id>.json
```

For handover, publish a new ID and start a new MCP process with its derived
path. Existing MCP processes remain pinned to their loaded, validated content.
Snapshots are not automatically deleted; clean them up manually only after
confirming no process still references them. The former `.sourcemesh/graph.json`
location is legacy read-only compatibility and must be supplied explicitly.

Do not include a target's source, diagnostics, graph data, absolute paths, or
MCP payloads in agent instructions, logs, or test evidence.
