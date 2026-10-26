# Velocy API local acceptance

The Velocy API profile is an explicit, manual acceptance check for the first
real C#/.NET target. It is intentionally excluded from CI, synthetic fixtures,
`npm run check`, and every versioned artifact.

## Prerequisites

- Windows with the repository-owned Roslyn helper already available at
  `tools/sourcemesh-roslyn/bin/Release/net10.0/sourcemesh-roslyn.dll`.
- A local Velocy checkout containing `src/Velocy.API.sln`.
- The helper may be prepared with the Windows-only instructions in
  [CONTRIBUTING.md](../CONTRIBUTING.md); the acceptance profile itself never
  runs restore, build, or run commands.

## Run the opt-in profile

In PowerShell, provide an absolute local root and an explicit confirmation:

```powershell
$env:SM_VELOCY_ROOT = 'C:\path\to\Velocy'
$env:SM_VELOCY_CONFIRM = '1'
npm run accept:velocy
Remove-Item Env:SM_VELOCY_ROOT
Remove-Item Env:SM_VELOCY_CONFIRM
```

The profile selects only `src/Velocy.API.sln`. It validates the contained
solution, project-reference closure, approved C# files, and the local Roslyn
analysis boundary. It does not search for a Velocy checkout. When
`SM_VELOCY_ROOT` is absent, the command exits successfully without inspecting
any path outside the SourceMesh checkout.

The profile uses an explicit Windows-1252 compatibility policy for source files
without an encoding marker. UTF-8 is always attempted first; Windows-1252 is
used only for the explicitly approved Velocy profile, never as an implicit
fallback for general C# analysis.

The profile also uses an explicit higher diagnostic budget because the solution
has many external-reference diagnostics without restore. Diagnostics remain
bounded and are persisted in private chunks; the ordinary C# worker keeps its
default lower limit.

The profile does not read `NuGet.Config` to restore dependencies, invoke
`dotnet restore`, `dotnet build`, or `dotnet run`, follow links outside the
selected root, or transmit target data. The offline guard rejects network
access from the Node.js profile and arbitrary subprocesses; its only permitted
child is the fixed, repository-owned Roslyn helper, which receives staged local
inputs through the bounded protocol. This guard is not an OS-level network
sandbox for that helper, so do not substitute an untrusted helper or runtime.

## Output and cleanup

On success, stdout contains only the schema, completeness, aggregate project,
file, node, edge, and diagnostic counts, plus sanitized diagnostic codes. It
does not print the target root, source text, symbol names, compiler messages,
or snapshot contents.

The only target-repository write is the create-only snapshot
`.sourcemesh/velocy-api.json`. If that file already exists, the profile fails
closed without replacing it. After reviewing the local result, remove that
snapshot manually when it is no longer needed. Do not commit it or copy it to
SourceMesh, GitHub, CI artifacts, logs, or an issue.
