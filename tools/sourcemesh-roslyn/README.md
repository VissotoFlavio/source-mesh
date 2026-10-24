# SourceMesh Roslyn helper

This is a local, offline `net10.0` helper. Restore is intentionally not part of
runtime operation. A build operator must use the committed `packages.lock.json`
with locked restore against the committed `packages/` feed. The versioned
`NuGet.offline.config` clears every external source; `NuGet.Config` preserves the
same local-only behavior for default tooling. Runtime only executes the
repository-built `bin/Release/net10.0/sourcemesh-roslyn.dll` through the fixed
Windows `dotnet.exe` host.

The committed feed contains the vetted `Microsoft.CodeAnalysis.CSharp` 5.9.0 package
and its exact Roslyn dependencies: `Microsoft.CodeAnalysis.Common` 5.9.0 and
`Microsoft.CodeAnalysis.Analyzers` 5.9.0-1.26328.17. The reviewed lockfile
records their vetted hashes.

Protocol v1 accepts exactly one bounded UTF-8 JSONL request on stdin and emits one
UTF-8 JSONL response on stdout. Any malformed, oversized, or invalid request exits
nonzero without diagnostic text; normal operation emits no stderr output.
Each project response contains only relative-path declaration candidates and
relationship outcomes. The parent Node process recalculates schema-v2 graph
identities and decides which resolved local outcomes become edges.

The package feed and build output are repository-local, so neither is published
by the private npm package. Build the committed feed without network:

```powershell
dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config
dotnet build tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --no-restore --configuration Release
npm run csharp:offline:check
```

`csharp:offline:check` executes the real helper beneath the repository offline
guard. It verifies platform references such as `Console` and `List<T>`, and proves
that a diagnostic stream exceeding the bounded protocol limit fails closed.
