# Local package distribution

Issue #69 distributes one complete local npm tarball. The supported consumer
contract is Windows x64 with the .NET 10 runtime already installed. The helper
is framework-dependent and is invoked through the fixed
`C:\Program Files\dotnet\dotnet.exe` host. The package does not contain a .NET
runtime and does not support macOS or Linux.

## Build and validate

The build operator must restore the helper once from the committed local feed,
then build it without restore:

```powershell
dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config
npm run csharp:offline:check
npm run package:check
```

`package:check` runs `npm pack` to create a real tarball, verifies its payload,
and installs it into a fresh consumer directory with an empty npm cache using
`npm install --offline --ignore-scripts`. The installed binary then analyzes
`test/fixtures/csharp-project`, writes a schema-v2 create-only snapshot, and
serves one MCP stdio query. The analysis and MCP child process accept only the
fixed installed helper invocation under `scripts/deny-network.mjs`; no other
network or subprocess path is permitted by the check.

The package contains:

- compiled `dist` output;
- the allowlisted Release `net10.0` helper DLL, Roslyn DLLs, dependency/runtime
  metadata, and satellite resource DLLs;
- bundled production dependencies from `package-lock.json`;
- the package license and [third-party inventory](../THIRD-PARTY-NOTICES.md).

The uncompressed helper payload is 17,092,239 bytes. The generated tarball is
limited to 25 MiB. `scripts/check-package.mjs` rejects missing, extra,
symlinked, malformed, or hash-mismatched helper artifacts before packing. It
also rejects install lifecycle scripts, undeclared bundled packages, incomplete
license inventory, and absolute paths in helper metadata. The E2E check proves
the missing, extra, and malformed cases fail closed.

The tarball does not contain helper sources, the offline NuGet feed, `obj`,
PDBs, the native helper executable, snapshots, analyzed source files,
credentials, or development dependencies. There is no `postinstall`, restore,
runtime compilation, registry publication, auto-update, self-contained runtime,
remote analysis, or schema-v2/MCP contract change.
