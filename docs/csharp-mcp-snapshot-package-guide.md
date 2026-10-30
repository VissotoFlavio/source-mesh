# Install and operate SourceMesh for a local MCP host

SourceMesh is a local, `stdio`, read-only MCP query server. It never analyzes a
repository or creates a snapshot while it is serving MCP. Create an immutable
snapshot first, then start MCP against that exact snapshot.

Generate the snapshot before configuring or starting MCP.

This guide is included in every official prerelease package. It is for a user
or an AI host that has installed the package and does not have a SourceMesh
checkout.

## Supported environment

- Windows x64.
- Node.js 22.13 or later in the 22.x line, or Node.js 24.x.
- npm.
- The supported default Windows .NET 10 runtime host available locally.

SourceMesh performs repository analysis locally. It has no runtime registry
access, update check, telemetry, network listener, or hosted analysis service.
Downloading a prerelease asset is separate setup traffic. A connected editor,
agent, or model provider has its own data-processing policy and can transmit
MCP arguments or results; assess that host separately before selecting a
repository.

Use an approved regular local repository directory. Do not select a UNC/remote
path or a reparse point, and keep the selected repository quiescent while
creating a snapshot and starting MCP.

## Install an official prerelease

Download exactly the `.tgz` asset and its matching `.tgz.sha256` asset from the
chosen GitHub prerelease. Do not use an arbitrary tarball, npm registry package,
or a package rebuilt from source.

In PowerShell, verify the checksum before installing. Replace `<version>` with
the selected prerelease version:

```powershell
$tarball = '.\vissotoflavio-source-mesh-<version>.tgz'
$checksum = "$tarball.sha256"
$expected = (Get-Content -LiteralPath $checksum -Raw).Trim().Split(' ')[0]
$actual = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'SourceMesh package checksum mismatch.' }
npm install --global --ignore-scripts $tarball
npm list --global --depth=0 @vissotoflavio/source-mesh
sourcemesh --help
```

`npm install --global` replaces the installed version with the selected local
asset. To remove SourceMesh, run:

```powershell
npm uninstall --global @vissotoflavio/source-mesh
```

The package has no install lifecycle script, restore step, compiler step, or
runtime package download. If Node, npm, or the .NET runtime is unavailable,
stop and correct that prerequisite rather than changing the analyzed
repository.

## Create a C# snapshot

Choose exactly one repository-relative selector: a solution or a project. Do
not rely on automatic solution discovery. Choose a fresh lowercase ASCII
snapshot ID (letters, digits, and hyphens; starting with a letter; 1–64
characters).

```powershell
sourcemesh analyze --root <repository-root> --language csharp --solution <relative-solution-path> --snapshot-id csharp-<run-id>
```

For an intentionally single-project target, use `--project` instead:

```powershell
sourcemesh analyze --root <repository-root> --language csharp --project <relative-project-path> --snapshot-id csharp-<run-id>
```

The ID deterministically maps to
`.sourcemesh/snapshots/csharp-<run-id>.json`. Creation is create-only and
`--overwrite` is not supported. If the ID already exists, preserve it and use
a new ID.

UTF-8 is the normal source policy. Use `--source-encoding windows-1252` only
when the target repository has been confirmed to need that compatibility mode;
it is not an automatic fallback. The C# worker defaults to a maximum of 4096
compiler diagnostics. If a target exceeds that budget, select an explicit
`--max-diagnostics` value from `1` to `100000`; do not change the global default
merely for one repository.

## Configure an MCP host

MCP must use the same repository root and the snapshot created above. The MCP
process is read-only: it exposes six bounded graph-query tools and no prompts,
resources, network listener, or write tools.

For a host that accepts a command and argument array, use the Node executable
and installed CLI path explicitly. In PowerShell, resolve those values without
needing a SourceMesh checkout:

```powershell
$node = (Get-Command node.exe -ErrorAction Stop).Source
$cli = Join-Path ((npm root --global).Trim()) '@vissotoflavio\source-mesh\dist\cli.js'
```

Configure the host equivalently to this JSON, replacing the placeholders with
the resolved values and the selected repository:

```json
{
  "command": "<absolute-node-path>",
  "args": [
    "<absolute-installed-cli-path>",
    "mcp",
    "--root",
    "<absolute-repository-root>",
    "--snapshot",
    ".sourcemesh/snapshots/csharp-<run-id>.json"
  ]
}
```

Do not place source text, absolute paths, diagnostics, graph data, secrets, or
MCP payloads in agent instructions, logs, or issue evidence. MCP protocol
messages use stdout only; keep stdout connected only to the MCP transport.

To hand over after a later analysis, create a different snapshot ID and start a
new MCP process with its derived path. A running process remains pinned to the
snapshot it validated at startup. Snapshots are not automatically deleted;
remove one manually only after confirming that no process still references it.
The former `.sourcemesh/graph.json` location is legacy read-only compatibility
and must be supplied explicitly.
