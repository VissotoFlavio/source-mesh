# C# snapshot runbook for local MCP

SourceMesh MCP serves one existing, validated local snapshot through read-only
queries. It does not run C# analysis, create a snapshot, or replace one.
Generate a snapshot before configuring or starting MCP.

This repository-facing runbook uses a built checkout. For an installed
prerelease package, use
[the installed-package guide](csharp-mcp-snapshot-package-guide.md) instead.

## Create a snapshot

Choose exactly one repository-relative selector: a solution or a project. Do
not rely on automatic solution discovery.

```sh
node dist/cli.js analyze --root <repository-root> --language csharp --solution <relative-solution-path> --snapshot-id csharp-<run-id>
```

For an intentionally single-project target, use `--project` instead:

```sh
node dist/cli.js analyze --root <repository-root> --language csharp --project <relative-project-path> --snapshot-id csharp-<run-id>
```

Each analysis requires a new lowercase ASCII snapshot ID (letters, digits, and
hyphens; starting with a letter; 1–64 characters). It deterministically maps to
`.sourcemesh/snapshots/csharp-<run-id>.json`. Creation is create-only and
`--overwrite` is not supported. If an ID already exists, preserve it and choose
a new ID.

UTF-8 is the normal source policy. Use `--source-encoding windows-1252` only
when the target repository has been confirmed to need that compatibility mode;
it is not an automatic fallback. The C# worker defaults to a maximum of 4096
compiler diagnostics. If a target exceeds that budget, select an explicit
`--max-diagnostics` value from `1` to `100000`; do not change the global default
merely for one repository.

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
