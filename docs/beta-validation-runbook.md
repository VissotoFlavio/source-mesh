# Beta validation runbook

This runbook is the operational record for the Windows x64 local-checkout beta.
It composes the preparation and safe-target procedures in
[beta-checkout.md](beta-checkout.md) with the opt-in real-application profile in
[velocy-local-acceptance.md](velocy-local-acceptance.md). It is a local
validation flow: it does not publish a registry package, collect telemetry, run
CI against Velocy, or send target data to a hosted service.

## What the gates prove

Run the gates in this order after reviewing the prerequisites in
[beta-checkout.md](beta-checkout.md):

| Gate                            | Command or profile                                                                                                                                                             | Proves                                                                                                                                                                                                              | Does not prove                                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic/offline Node boundary | `npm run check`                                                                                                                                                                | The repository's formatting, lint, types, tests, build, synthetic fixture flow, offline Node guard, CLI/MCP behavior, and package dry-run are passing together.                                                     | It does not prove the Windows helper is restored, that the packaged tarball installs correctly, or that a real Velocy checkout can be analyzed.                                                                                                                |
| Windows helper boundary         | `dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config`, then `npm run csharp:offline:check` | The repository-owned .NET helper can be built from the committed offline feed and the C# offline checks pass without network access.                                                                                | It does not prove package installation, MCP operation from the installed tarball, or compatibility with an arbitrary C# solution.                                                                                                                              |
| Package boundary                | `npm run package:check`                                                                                                                                                        | A real local tarball can be assembled and installed with `npm install --offline --ignore-scripts`; the installed package analyzes the repository-owned C# fixture and exercises the installed MCP over local stdio. | It does not publish the tarball, test a registry install, or validate a real Velocy application.                                                                                                                                                               |
| Real application profile        | With `SM_VELOCY_ROOT` and `SM_VELOCY_CONFIRM=1`, `npm run accept:velocy`                                                                                                       | The selected `src/Velocy.API.sln` in the explicitly supplied local root passes the contained real C# acceptance profile and produces only aggregate counts plus sanitized diagnostic codes.                         | It does not restore, build, run, or publish Velocy; it does not prove production behavior, application tests, or host privacy beyond SourceMesh's local boundary. Its wrapper reports profile failures on stderr and exits `1`, including `snapshot_conflict`. |

`npm run check` is the synthetic/offline Node boundary, not a substitute for
the helper, package, or real-application gates. The helper restore must use
`tools/sourcemesh-roslyn/NuGet.offline.config`; do not substitute another feed.
The package gate is local and offline after its inputs are present. The Velocy
profile is opt-in and excluded from CI; when `SM_VELOCY_ROOT` is absent,
`npm run accept:velocy` succeeds without inspecting a path outside this
checkout.

## Preflight and safe execution order

1. Use Windows x64 with Node.js 22.13 or newer in the 22.x line, or Node.js
   24.x, npm, and the .NET 10 SDK/runtime. Confirm that the helper host is
   `C:\Program Files\dotnet\dotnet.exe` as described in
   [beta-checkout.md](beta-checkout.md). Keep the SourceMesh checkout and any
   target in approved local locations.

2. From the SourceMesh repository root, prepare dependencies and the Node
   build. The `npm ci` step can use the configured npm registry; it is setup
   traffic, not runtime analysis traffic:

   ```powershell
   npm ci --ignore-scripts
   npm run build
   ```

3. Run the synthetic/offline Node gate:

   ```powershell
   npm run check
   ```

4. Prepare and validate the repository-owned helper from the committed offline
   feed:

   ```powershell
   dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config
   npm run csharp:offline:check
   ```

   `csharp:offline:check` performs the Release `--no-restore` helper build and
   its offline C# checks. Do not restore or build the target application.

5. Validate the installed package boundary:

   ```powershell
   npm run package:check
   ```

   This is the repository-owned C# fixture and installed-MCP proof. It is not a
   registry publication or a replacement for the real-application profile.

6. Choose one target profile. Direct CLI `analyze` followed by MCP and
   `npm run accept:velocy` are alternative profiles for a target, not
   sequential steps on the same checkout. If both are required, use separate
   disposable roots exclusively; the shown commands do not document custom
   `--snapshot` wiring for MCP. Never let one profile consume, replace, or
   remove the other profile's snapshot. For the direct CLI + MCP profile, follow
   the path, reparse-point,
   and absolute-path safeguards in [beta-checkout.md](beta-checkout.md).
   Before running it, perform this canonical-root separation check using the
   `Assert-NoReparseAncestors` helper from [beta-checkout.md](beta-checkout.md):

   ```powershell
   Assert-NoReparseAncestors -Path $sourceMeshInput -Label 'SourceMesh input'
   Assert-NoReparseAncestors -Path $targetInput -Label 'target input'
   $sourceMeshRoot = (Resolve-Path -LiteralPath $sourceMeshInput -ErrorAction Stop).Path.TrimEnd('\')
   $targetRoot = (Resolve-Path -LiteralPath $targetInput -ErrorAction Stop).Path.TrimEnd('\')
   Assert-NoReparseAncestors -Path $sourceMeshRoot -Label 'SourceMesh root'
   Assert-NoReparseAncestors -Path $targetRoot -Label 'target root'
   $sourceMeshItem = Get-Item -LiteralPath $sourceMeshRoot -Force -ErrorAction Stop
   $targetItem = Get-Item -LiteralPath $targetRoot -Force -ErrorAction Stop
   if (-not $sourceMeshItem.PSIsContainer -or -not $targetItem.PSIsContainer -or
     ($sourceMeshItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
     ($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
     throw 'Refusing to continue: SourceMesh and target roots must be regular directories.'
   }
   $sourceMeshPrefix = "$sourceMeshRoot\"
   $targetPrefix = "$targetRoot\"
   if ([StringComparer]::OrdinalIgnoreCase.Equals($sourceMeshRoot, $targetRoot) -or
     $sourceMeshRoot.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase) -or
     $targetRoot.StartsWith($sourceMeshPrefix, [StringComparison]::OrdinalIgnoreCase)) {
     throw 'Refusing to continue: SourceMesh checkout and target must be distinct, non-containing roots.'
   }
   ```

   Fail closed for the same canonical root, a parent/child relationship, or
   any reparse/junction case. Keep the resolved `$sourceMeshRoot`, `$targetRoot`,
   `$nodeExe`, and `$cliPath` absolute for the commands below. The imported
   offline guard must be the validated regular non-reparse file below; it
   preserves the fixed repository-owned helper allowance, and no other child
   process is permitted.
   This is a tester-run operational preflight; runtime enforcement of
   SourceMesh/target separation would be separate code work and is outside
   this runbook.

   ```powershell
   $offlineGuard = Join-Path $sourceMeshRoot 'scripts\deny-network.mjs'
   $offlineGuardItem = Get-Item -LiteralPath $offlineGuard -Force -ErrorAction Stop
   if ($offlineGuardItem.PSIsContainer -or
     ($offlineGuardItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
     throw 'Refusing to continue: offline guard must be a regular non-reparse file.'
   }
   Assert-NoReparseAncestors -Path $offlineGuard -Label 'offline guard'
   ```

   Analyze once, with the explicit C# selector when applicable, before
   starting MCP. For the Velocy solution, the create-only command is:

   ```powershell
   & $nodeExe --import $offlineGuard $cliPath analyze --root $targetRoot --language csharp --solution 'src/Velocy.API.sln'
   ```

   Do not add `--overwrite`. MCP must use the same root and only start after
   analysis succeeds. Its equivalent local command is:

   ```powershell
   & $nodeExe --import $offlineGuard $cliPath mcp --root $targetRoot
   ```

   Before running `analyze`, confirm that `.sourcemesh/graph.json` did not
   exist under the selected root. If it exists or ownership is uncertain, do
   not delete or overwrite it; use the disposable-copy or OS-snapshot path in
   step 7. Keep the target and any disposable destination quiescent, with no
   concurrent filesystem writers, through analysis, MCP, and cleanup. After
   the run, remove only `.sourcemesh/graph.json` created by the current test,
   and only when its pre-run absence was confirmed. Preserve the file whenever
   its prior absence or ownership is uncertain.

7. If the target already contains the selected snapshot, or the target cannot
   safely receive the create-only write, do not delete or overwrite anything.
   Use a new sibling or external disposable copy, explicitly excluding the
   target's `.sourcemesh` directory, as shown in [beta-checkout.md](beta-checkout.md).
   The target and destination must be quiescent with no concurrent filesystem
   writers for the entire copy, analysis, and cleanup boundary. This copy
   procedure is not race-resistant and is not an atomic filesystem snapshot.
   If quiescence cannot be guaranteed, stop and use an OS-level snapshot or
   approved backup workflow instead. Analyze and serve only the disposable
   copy.

8. As the alternative target profile, and only when real Velocy validation is
   authorized, run the opt-in profile from
   [velocy-local-acceptance.md](velocy-local-acceptance.md):

   Before setting `SM_VELOCY_ROOT`, run this self-contained preflight using the
   `Assert-NoReparseAncestors` helper from [beta-checkout.md](beta-checkout.md):

   ```powershell
   $sourceMeshInput = 'C:\path with spaces\source-mesh'
   $velocyInput = 'C:\path\to\Velocy'
   Assert-NoReparseAncestors -Path $sourceMeshInput -Label 'SourceMesh input'
   Assert-NoReparseAncestors -Path $velocyInput -Label 'Velocy input'
   $sourceMeshRoot = (Resolve-Path -LiteralPath $sourceMeshInput -ErrorAction Stop).Path.TrimEnd('\')
   $velocyRoot = (Resolve-Path -LiteralPath $velocyInput -ErrorAction Stop).Path.TrimEnd('\')
   Assert-NoReparseAncestors -Path $sourceMeshRoot -Label 'SourceMesh root'
   Assert-NoReparseAncestors -Path $velocyRoot -Label 'Velocy root'
   $sourceMeshItem = Get-Item -LiteralPath $sourceMeshRoot -Force -ErrorAction Stop
   $velocyItem = Get-Item -LiteralPath $velocyRoot -Force -ErrorAction Stop
   if (-not $sourceMeshItem.PSIsContainer -or -not $velocyItem.PSIsContainer -or
     ($sourceMeshItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
     ($velocyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
     throw 'Refusing to continue: SourceMesh and Velocy roots must be regular directories.'
   }
   $sourceMeshPrefix = "$sourceMeshRoot\"
   $velocyPrefix = "$velocyRoot\"
   if ([StringComparer]::OrdinalIgnoreCase.Equals($sourceMeshRoot, $velocyRoot) -or
     $sourceMeshRoot.StartsWith($velocyPrefix, [StringComparison]::OrdinalIgnoreCase) -or
     $velocyRoot.StartsWith($sourceMeshPrefix, [StringComparison]::OrdinalIgnoreCase)) {
     throw 'Refusing to continue: SourceMesh checkout and Velocy root must be distinct, non-containing roots.'
   }

   $env:SM_VELOCY_ROOT = $velocyRoot
   $env:SM_VELOCY_CONFIRM = '1'
   npm run accept:velocy
   Remove-Item Env:SM_VELOCY_ROOT
   Remove-Item Env:SM_VELOCY_CONFIRM
   ```

   Do not run this profile after the direct CLI + MCP profile on the same
   checkout. It selects only `src/Velocy.API.sln`, writes the create-only
   `.sourcemesh/velocy-api.json` under the target, and never restores, builds,
   or runs Velocy. The target and this snapshot path must be quiescent, with no
   concurrent filesystem writers, from the pre-run check through analysis and
   cleanup. Before the run, confirm whether that exact file already exists. If
   its pre-run absence or ownership by the current test cannot be guaranteed,
   preserve the file and do not remove it; use a separate disposable root or
   an OS-level snapshot instead. After the run, only the
   `.sourcemesh/velocy-api.json` created by the current test may be removed,
   and only when it was confirmed absent before the run. Never remove a
   pre-existing snapshot or any other target data. Do not commit, copy, or
   attach the snapshot.

## Outcomes and failure handling

Record the process exit code and a pass/fail result for each gate. Distinguish
the direct CLI contract from the `accept:velocy` wrapper:

- Direct `analyze` succeeds with `0`.
- Direct `analyze` returns `4` with `snapshot_conflict` when the create-only
  snapshot already exists. Preserve it and use the disposable-copy or
  OS-snapshot path above.
- To reproduce or inspect that direct CLI conflict, preserve the existing
  snapshot, apply the same canonical-root separation check above, and run:

  ```powershell
  & $nodeExe --import $offlineGuard $cliPath analyze --root $targetRoot --language csharp --solution 'src/Velocy.API.sln' --output json
  ```

  It must remain create-only; do not delete or overwrite the snapshot to make
  the reproduction pass.

- Direct `analyze` returns `2` for invalid arguments or an invalid command
  invocation. Correct the command or selector; do not retry by adding
  `--overwrite`.
- Direct `analyze` returns `1` for an operational or analysis failure. Stop the
  dependent step, keep the target unchanged, and inspect the sanitized
  diagnostic code/message.
- `npm run accept:velocy` returns `0` for a completed profile or the intentional
  skipped result when `SM_VELOCY_ROOT` is not set. The wrapper returns `1` for
  both `snapshot_conflict` and other operational/profile failures, and writes
  this sanitized message to stderr:

  ```text
  Velocy local acceptance failed (snapshot_conflict).
  ```

  For a wrapper failure, record the wrapper exit code together with its
  sanitized diagnostic code. For the intentional skipped result, record
  `skip`, exit `0`, and no diagnostic code. For a Velocy `snapshot_conflict`,
  use the same disposable-copy or OS-snapshot recovery path; the wrapper's `1`
  does not change the create-only rule.

Other bounded typed query failures may use the CLI's documented code `3`; they
are not a successful beta analysis outcome. A failing npm or PowerShell wrapper
should be reported with its nonzero exit code and the failing gate, without
guessing a different outcome.

Failure handling is sanitized: retain only the gate, the applicable direct CLI
or wrapper exit code, pass/fail status, aggregate counts when explicitly
emitted, and diagnostic codes. Do not paste raw stdout/stderr, stack traces,
compiler messages, paths, snapshot data, environment values, or MCP payloads
into a ticket, log, or test report. Do not delete or replace target data to
make a gate pass.

## Tester evidence checklist

The tester record may contain only:

- date/time and gate name;
- Node.js, npm, .NET SDK/runtime, and SourceMesh/package tool versions;
- selected profile (`synthetic`, `helper-offline`, `package-fixture`, or
  `velocy-csharp`);
- pass/fail/skip outcome and process exit code; for direct `analyze`, record its
  CLI exit code, and for `npm run accept:velocy`, record the wrapper exit code;
  for the intentional Velocy skipped result, record `skip`, exit `0`, and no
  diagnostic code;
- aggregate project/file/node/edge/diagnostic counts when the profile emits
  them; and
- for failures, the sanitized diagnostic code only.

Never record or attach source code, absolute paths, snapshot files or snapshot
content, secrets, target data, or host MCP payloads. Do not collect telemetry,
enable registry publication, run CI against Velocy, or add host-specific MCP
configuration to the repository. MCP protocol frames belong on stdout only;
startup, lifecycle, and sanitized diagnostics belong on stderr. A local stdio
pipe does not make the connected editor, agent, or model host private: that
host may process or transmit schemas, arguments, and results under its own
policy. Review that external boundary independently and keep host output out
of the evidence record.
