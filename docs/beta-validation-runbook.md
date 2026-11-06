# Beta validation runbook

This runbook records the Windows x64 validation gates for a SourceMesh beta.
It is a local validation flow: it does not publish to npm, collect telemetry,
or send repository data to a hosted service.

## Required gates

Run these gates from the SourceMesh checkout after reviewing
[beta-checkout.md](beta-checkout.md):

| Gate                            | Command                                                                                                                                                                        | Proves                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Synthetic/offline Node boundary | `npm run check`                                                                                                                                                                | Formatting, linting, types, tests, built CLI/MCP behavior, package dry-run, and the repository-owned offline guard.          |
| Windows helper boundary         | `dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config`, then `npm run csharp:offline:check` | The helper restores from the committed feed and C# checks run locally.                                                       |
| Package boundary                | `npm run package:check`                                                                                                                                                        | A real package installs into an empty local consumer, analyzes the synthetic C# fixture, and serves an MCP query over stdio. |

The package gate is not a registry publication or a test of an arbitrary
application. Do not restore, build, run, or publish the selected target.

## Optional real C# target

When authorized, validate a real local C# target with the direct CLI and MCP
flow in [the installed-package guide](csharp-mcp-snapshot-package-guide.md) or
[the checkout guide](beta-checkout.md). Before starting:

1. Confirm the target is local, approved, and quiescent.
2. Choose exactly one selection mode: a relative solution or an exact set of
   one or more relative C# projects supplied with repeatable `--project`
   options. Do not combine `--solution` and `--project`, and do not infer
   membership from folders.
3. Choose a new snapshot ID and confirm the derived file does not already
   exist. Never delete or overwrite a snapshot to make a test pass.
4. Start MCP only after `analyze` exits successfully, using the same root and
   exact derived snapshot path.

For a conflict, preserve the existing snapshot and choose a different ID. For
an operational analysis failure, retain only the sanitized error code and stop
the dependent MCP step.

## Evidence limits

Record only date/time, gate name, tool versions, selected generic profile,
exit code, pass/fail/skip outcome, aggregate counts explicitly emitted by the
tool, and sanitized diagnostic codes. Never record source code, absolute paths,
snapshot contents, credentials, secrets, target data, host MCP payloads, or raw
compiler output. A local stdio connection does not make the connected editor,
agent, or model provider local; evaluate that consumer separately.
