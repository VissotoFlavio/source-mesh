# Windows x64 local-checkout beta

This guide is for a maintainer validating SourceMesh from a local checkout on
Windows x64. It is not the installation path for an end user or AI host; use
[the installed-package guide](csharp-mcp-snapshot-package-guide.md) for that
flow.

## Prerequisites

- Windows x64.
- Node.js 22.13 or later in the 22.x line, or Node.js 24.x.
- npm.
- The .NET 10 SDK for the helper build and the .NET 10 runtime for execution.
  The supported framework-dependent runtime host is
  `C:\Program Files\dotnet\dotnet.exe`.

Keep the checkout and the selected target repository in approved local
locations. SourceMesh itself has no runtime network access, but installing
development dependencies can contact the configured npm registry.

Before a real-target run, use regular local directories only: do not use a
UNC/remote path, a reparse point, or a target nested inside the SourceMesh
checkout. Keep the target quiescent through analysis and MCP startup.

## Prepare the checkout

From the repository root, install locked Node dependencies without lifecycle
scripts, restore the helper only from the committed offline feed, and build:

```powershell
npm ci --ignore-scripts
dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config
dotnet build tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --no-restore --configuration Release
npm run build
```

The helper is framework-dependent and uses the repository-built Release
payload. Do not restore from another feed or compile the helper during runtime.

## Analyze before starting MCP

Use an explicit relative solution or project selector and a fresh snapshot ID.
The output is always the create-only
`.sourcemesh/snapshots/<id>.json`; `--overwrite` is not supported.

Node 24 requires a `file:///` URI for an absolute preload path. Resolve it once
instead of passing an absolute Windows path directly to `--import`:

```powershell
$offlineGuardUri = [System.Uri]::new((Resolve-Path -LiteralPath '.\scripts\deny-network.mjs')).AbsoluteUri
node --import $offlineGuardUri .\dist\cli.js analyze --root <repository-root> --language csharp --solution <relative-solution-path> --snapshot-id csharp-<run-id>
```

For an intentionally single-project target, replace `--solution` with
`--project <relative-project-path>`. For a TypeScript/JavaScript target, omit
the C# selector. Use `--source-encoding windows-1252` only when a target is
known to require it, and choose `--max-diagnostics 1..100000` only when the
default diagnostic budget is insufficient.

## Start the local MCP process

Use the same target root and the resulting snapshot path:

```powershell
node --import $offlineGuardUri .\dist\cli.js mcp --root <repository-root> --snapshot .sourcemesh/snapshots/csharp-<run-id>.json
```

The server is local, `stdio`, and read-only. Keep stdout connected exclusively
to the MCP transport. To hand over after another analysis, use a new snapshot
ID and start a new MCP process; a running process never reloads a snapshot.
Do not delete snapshots automatically.

The preload is a checkout validation control. It is not included in the
published package and is not an operating-system network sandbox. The runtime
privacy boundary and the connected host's separate privacy policy are described
in the README.
