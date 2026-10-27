# Windows x64 local-checkout beta

This guide is for an authorized tester running the SourceMesh beta from a
local checkout on Windows x64. It describes the local-only flow; it does not
publish or install a package.

This beta path targets C#/.NET repositories. For the real Velocy API checkout,
the existing opt-in profile is documented in
[velocy-local-acceptance.md](velocy-local-acceptance.md). The repository also
continues to support TypeScript/JavaScript analysis; that path omits the C#
language and solution selectors described below.

## Prerequisites

- Windows x64.
- Node.js 22.13 or newer within the 22.x line, or Node.js 24.x.
- npm.
- The .NET 10 SDK for the helper build and the .NET 10 runtime for execution.
  The supported framework-dependent runtime host is
  `C:\Program Files\dotnet\dotnet.exe`.

The repository is private (`private: true`) and is not a publishable npm
package. Keep the checkout and the analyzed repository in locations approved
for the test.

For the package contract and exclusions, see
[package-distribution.md](package-distribution.md).

## Prepare the checkout

From the repository root, install the locked Node dependencies without
running lifecycle scripts:

```powershell
npm ci --ignore-scripts
```

Restore the repository-owned Roslyn helper only from the committed offline
feed, then build the Release helper without restoring again:

```powershell
dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config
dotnet build tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --no-restore --configuration Release
```

Build the CLI:

```powershell
npm run build
```

The helper is framework-dependent and uses the repository-built
`tools/sourcemesh-roslyn/bin/Release/net10.0/sourcemesh-roslyn.dll` through the
fixed .NET host above. Do not restore from another feed or compile the helper
during runtime.

## Analyze before starting MCP

Run one create-only C# analysis against the explicitly selected repository
before starting MCP. The existing CLI syntax requires `--language csharp` and
an explicit relative solution or project selector. The documented Velocy
solution is `src/Velocy.API.sln`; use `--project <relative-project-path>` only
when the target is intentionally a single project.

Resolve absolute, quoted paths once so spaces in Windows paths are preserved.
The following command uses the Velocy solution and does not pass `--overwrite`:

```powershell
function Assert-NoReparseAncestors {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] [string]$Label
  )

  $currentPath = [System.IO.Path]::GetFullPath($Path)
  while ($true) {
    $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
    if (($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to continue: $Label or one of its ancestors is a reparse point."
    }
    $parentPath = Split-Path -LiteralPath $currentPath -Parent
    if ([string]::IsNullOrEmpty($parentPath) -or
      [StringComparer]::OrdinalIgnoreCase.Equals($parentPath, $currentPath)) {
      break
    }
    $currentPath = $parentPath
  }
}

$sourceMeshInput = 'C:\path with spaces\source-mesh'
$targetInput = 'C:\path with spaces\Velocy'
Assert-NoReparseAncestors -Path $sourceMeshInput -Label 'SourceMesh root'
Assert-NoReparseAncestors -Path $targetInput -Label 'target root'
$sourceMeshRoot = (Resolve-Path -LiteralPath $sourceMeshInput -ErrorAction Stop).Path
$targetRoot = (Resolve-Path -LiteralPath $targetInput -ErrorAction Stop).Path
$sourceMeshItem = Get-Item -LiteralPath $sourceMeshRoot -Force -ErrorAction Stop
$targetRootItem = Get-Item -LiteralPath $targetRoot -Force -ErrorAction Stop
if (-not $sourceMeshItem.PSIsContainer -or -not $targetRootItem.PSIsContainer) {
  throw 'Refusing to run: SourceMesh and target roots must be directories.'
}
if (($sourceMeshItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
  ($targetRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to run: SourceMesh or target root is a reparse point.'
}
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeItem = Get-Item -LiteralPath $nodeExe -Force -ErrorAction Stop
if ($nodeItem.PSIsContainer -or
  ($nodeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to run: Node executable must be a regular non-reparse file.'
}
$cliPath = Join-Path $sourceMeshRoot 'dist\cli.js'
$cliItem = Get-Item -LiteralPath $cliPath -Force -ErrorAction Stop
if ($cliItem.PSIsContainer -or
  ($cliItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to run: CLI path must be a regular non-reparse file.'
}
Assert-NoReparseAncestors -Path $cliPath -Label 'CLI path'
& $nodeExe $cliPath analyze --root $targetRoot --language csharp --solution 'src/Velocy.API.sln'
if ($LASTEXITCODE -ne 0) {
  throw 'SourceMesh analyze failed; MCP was not started.'
}
```

The default snapshot is `.sourcemesh/graph.json` under the selected root. A
successful analysis creates that snapshot; MCP only serves the validated
snapshot and does not analyze the repository itself. For a TypeScript/JavaScript
target, use the same absolute `$nodeExe` and `$cliPath` variables with
`analyze --root $targetRoot` and no C# selector; the default language remains
TypeScript/JavaScript.

## Configure the local MCP host

Configure the host with absolute paths for the Node executable, `dist/cli.js`,
and the same target repository root used by `analyze`. Replace the placeholders
with paths from the tester’s machine; this guide does not prescribe a
host-specific Node install location. Keep the JSON string quoting and escape
Windows backslashes as shown:

```json
{
  "mcpServers": {
    "sourcemesh": {
      "command": "<absolute-path-to-node.exe>",
      "args": [
        "<absolute-path-to-source-mesh>\\dist\\cli.js",
        "mcp",
        "--root",
        "<absolute-path-to-target-repository>"
      ]
    }
  }
}
```

The equivalent local command, using the same absolute paths and root, is:

```powershell
& $nodeExe $cliPath mcp --root $targetRoot
```

MCP protocol messages use stdout exclusively. Startup, lifecycle, and
sanitized error diagnostics use stderr. Keep stdout connected only to the MCP
transport; do not add logging, wrappers, or other output to that stream.

## Runtime and privacy boundary

The beta runtime is local-only. It has no registry access, auto-update,
remote processing, network listener, telemetry, or hosted service. The CLI
does not print source text, absolute paths, compiler objects, stacks, secrets,
or environment data. It returns bounded graph responses and sanitized
diagnostics.

The `npm ci --ignore-scripts` setup step may use the configured npm registry;
that installation traffic is separate from later repository analysis. The
offline helper restore uses only
`tools/sourcemesh-roslyn/NuGet.offline.config`.

Local stdio does not control the privacy policy of the connected editor,
agent, or model host. That consumer may process or transmit MCP schemas,
arguments, and results, so review its data-processing boundary independently
before selecting a repository.

## Troubleshooting and safety

Analysis is create-only. If `.sourcemesh/graph.json` already exists, the
command leaves the existing snapshot intact. To inspect the exact diagnostic,
repeat the same command with `--output json`:

```powershell
& $nodeExe $cliPath analyze --root $targetRoot --language csharp --solution 'src/Velocy.API.sln' --output json
```

That conflict command writes no stdout, writes this sanitized JSON envelope to
stderr, and exits with code `4`:

```json
{
  "schemaVersion": 1,
  "command": "analyze",
  "error": {
    "code": "snapshot_conflict",
    "message": "The snapshot already exists."
  }
}
```

Without `--output json`, the human diagnostic is `The snapshot already
exists.` on stderr and the exit code is still `4`. Do not delete or overwrite
snapshot or source data in the target repository to clear the conflict.
Instead, create a new disposable directory that is a sibling of the target or
is on an external location, and copy the target while explicitly excluding its
`.sourcemesh` directory. This leaves the original target and its graph
snapshot untouched. Run the copy only while the target and destination are
quiescent, with no concurrent filesystem writers. This procedure is not
race-resistant and does not create an atomic filesystem snapshot. If
quiescence cannot be guaranteed, stop and use an OS-level snapshot or backup
workflow instead:

```powershell
$disposableRoot = 'C:\path with spaces\Velocy-beta-copy'
$targetResolved = (Resolve-Path -LiteralPath $targetRoot -ErrorAction Stop).Path.TrimEnd('\')
$targetItem = Get-Item -LiteralPath $targetResolved -Force -ErrorAction Stop
if (-not $targetItem.PSIsContainer) {
  throw 'Refusing to copy: target root is not a directory.'
}
Assert-NoReparseAncestors -Path $targetResolved -Label 'target root'
$disposableParent = Split-Path -LiteralPath $disposableRoot -Parent
Assert-NoReparseAncestors -Path $disposableParent -Label 'destination parent'
$disposableParentResolved = (Resolve-Path -LiteralPath $disposableParent -ErrorAction Stop).Path.TrimEnd('\')
$disposableResolved = Join-Path $disposableParentResolved (Split-Path -LiteralPath $disposableRoot -Leaf)
$targetPrefix = "$targetResolved\"
if ([StringComparer]::OrdinalIgnoreCase.Equals($disposableResolved, $targetResolved) -or
  $disposableResolved.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to copy: disposable destination is equal to or contained by the target root.'
}
if (Test-Path -LiteralPath $disposableResolved -ErrorAction Stop) {
  throw 'Refusing to copy: disposable destination already exists.'
}
$validatedDestination = [System.IO.Path]::GetFullPath($disposableResolved).TrimEnd('\')
$robocopyExe = (Get-Command robocopy.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -LiteralPath $validatedDestination -ErrorAction Stop | Out-Null
$createdDestination = Get-Item -LiteralPath $validatedDestination -Force -ErrorAction Stop
if (-not $createdDestination.PSIsContainer) {
  throw 'Refusing to copy: disposable destination is not a directory.'
}
if (($createdDestination.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to copy: disposable destination is a reparse point.'
}
$createdCanonical = (Resolve-Path -LiteralPath $validatedDestination -ErrorAction Stop).Path.TrimEnd('\')
Assert-NoReparseAncestors -Path $disposableRoot -Label 'destination'
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($createdCanonical, $validatedDestination)) {
  throw 'Refusing to copy: created destination does not match the validated path.'
}
Assert-NoReparseAncestors -Path $createdCanonical -Label 'destination'
# /XJ prevents recursive traversal through junctions; robocopy codes 0..7 are non-failures.
try {
  $sourceItems = @(Get-ChildItem -LiteralPath $targetResolved -Force -Recurse -ErrorAction Stop)
} catch {
  throw 'Refusing to copy: source tree could not be enumerated safely.'
}
foreach ($sourceItem in $sourceItems) {
  if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Refusing to copy: source tree contains a reparse point.'
  }
}
& $robocopyExe $targetResolved $validatedDestination '/E' '/XJ' '/R:0' '/W:0' '/XD' (Join-Path $targetResolved '.sourcemesh')
$robocopyExitCode = $LASTEXITCODE
if ($null -eq $robocopyExitCode -or $robocopyExitCode -lt 0 -or $robocopyExitCode -gt 7) {
  throw "Refusing to continue: robocopy failed with exit code $robocopyExitCode."
}
try {
  $sourceAfterCanonical = (Resolve-Path -LiteralPath $targetResolved -ErrorAction Stop).Path.TrimEnd('\')
  $destinationAfterCanonical = (Resolve-Path -LiteralPath $validatedDestination -ErrorAction Stop).Path.TrimEnd('\')
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($sourceAfterCanonical, $targetResolved) -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals($destinationAfterCanonical, $createdCanonical)) {
    throw 'Root canonical path changed.'
  }
  Assert-NoReparseAncestors -Path $targetResolved -Label 'target root'
  Assert-NoReparseAncestors -Path $disposableRoot -Label 'destination'
  Assert-NoReparseAncestors -Path $createdCanonical -Label 'destination'
  $sourceAfterItem = Get-Item -LiteralPath $targetResolved -Force -ErrorAction Stop
  $destinationAfterItem = Get-Item -LiteralPath $createdCanonical -Force -ErrorAction Stop
  if (-not $sourceAfterItem.PSIsContainer -or -not $destinationAfterItem.PSIsContainer -or
    ($sourceAfterItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
    ($destinationAfterItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Root was replaced with an unsafe filesystem entry.'
  }
  $createdCanonical = $destinationAfterCanonical
} catch {
  throw 'Refusing to continue: source or destination root changed or became unsafe during copy.'
}
```

The validation resolves the target and destination parent, then fails closed
before creating anything if the destination is equal to or contained by the
target, or if the destination already exists. Confirm that the destination is
a new sibling or external disposable location before running the copy. The
copy command only reads the target, excludes `.sourcemesh`, and never deletes
or writes back to the original. Then analyze and serve that same copy,
preserving the C# selector:

```powershell
& $nodeExe $cliPath analyze --root $createdCanonical --language csharp --solution 'src/Velocy.API.sln'
if ($LASTEXITCODE -ne 0) {
  throw 'SourceMesh analyze failed; MCP was not started.'
}
& $nodeExe $cliPath mcp --root $createdCanonical
```

Do not use a copy command that deletes from the target or writes back to it.
The MCP host configuration must likewise replace its target-root placeholder
with the absolute `$createdCanonical` path when testing the copy.

If MCP starts but the host reports a protocol error, verify that the command
uses the absolute Node and `dist/cli.js` paths above, that `analyze` completed
first for the same absolute `--root`, and that diagnostics are separated from
stdout. If helper startup fails, verify the .NET 10 runtime and the committed
offline restore/build steps without changing the target repository.
