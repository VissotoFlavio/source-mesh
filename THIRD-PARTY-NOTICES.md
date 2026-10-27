# Third-party notices

The SourceMesh package bundles the following production Node.js dependencies.
Versions, licenses, and integrity values are copied from the committed
`package-lock.json`; the package contains no development dependencies.

| Package                        | Version | License    | npm integrity                                                                                     |
| ------------------------------ | ------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/core`   | 2.3.1   | Apache-2.0 | `sha512-laVmIhPGpWi7rG9q+0UigblRN0Hws/Yjlb6qLFtVqryXVLkc4h+yN8z731POD2LnAGQlFe7/tXhUm7Bi0YB91g==` |
| `@modelcontextprotocol/server` | 2.3.1   | Apache-2.0 | `sha512-e59MfWuSssj6DoQ96JCTqdW1AXT5/XtnTl0WWd6MU1Ka434fFUGGosCLJbGNySDhHGvxQWoRWK137FXYFkYNWw==` |
| `typescript`                   | 6.0.3   | Apache-2.0 | `sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==` |
| `zod`                          | 4.6.7   | MIT        | `sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==` |

The package also bundles the framework-dependent Windows x64 Roslyn helper for
.NET 10. It is built from the committed offline feed and lock file. The feed
contains these MIT-licensed packages:

| Package                            | Version          | Lock-file content hash                                                                     |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `Microsoft.CodeAnalysis.CSharp`    | 5.9.0            | `7JGDA0UT1+h7k9ZcA3rF4eFC8+QPq1xyYaXxag4p8r/zzPurEJxvdi7aM+MRL/SfP7XADXpWF/pl/eUYXOq/ww==` |
| `Microsoft.CodeAnalysis.Common`    | 5.9.0            | `IYaIaUWdIx539AReKZOBEqTskFusZfCh/wFSPilDvCn5Say8MegLw2LONcSIcVy+v3Gzv53qYBspgvBGSErfbQ==` |
| `Microsoft.CodeAnalysis.Analyzers` | 5.9.0-1.26328.17 | `HP9NNk8ZjOSI2hgOyXnQg+kv7/X837Vr2nAlXiGAtqtYnYKjRRa1UmQFr8KFs5ynGYKqfbb8zB9APoWjiAGdMg==` |

## Roslyn notices included in the tarball

The distributed Roslyn assemblies include the following notices from the
committed NuGet packages. The .NET Compiler Platform components are from the
.NET Foundation and Contributors and are distributed under the MIT License:

```text
The MIT License (MIT)

Copyright (c) .NET Foundation and Contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Microsoft.CodeAnalysis.Analyzers package also carries the .NET Compiler
Platform notices under the Apache License, Version 2.0, and these MIT-licensed
attributions from its embedded `ThirdPartyNotices.txt`:

- Humanizer, copyright Mehdi Khalili (2012–2014).
- Inflector, copyright Scott Kirkland (2013).
- ByteSize, copyright Omar Khudeira (2013–2014).

The Apache License, Version 2.0 is available at
<https://www.apache.org/licenses/LICENSE-2.0>. The complete source notices are
retained in the committed `.nupkg` feed under
`tools/sourcemesh-roslyn/packages`; this section preserves the attribution and
license terms needed by the distributed object code. The helper payload is the
Release `net10.0` output only: 17,092,239 uncompressed bytes, with each file
checked against the generated tarball integrity manifest and the reviewed
dependencies also checked against `scripts/package-manifest.json`. Its
compressed npm tarball is bounded to 25 MiB by the package verification script.

SourceMesh does not bundle the .NET runtime, NuGet feed, helper sources, PDB,
native executable, snapshots, or development Node dependencies. The supported
consumer is Windows x64 with .NET 10 already installed.
