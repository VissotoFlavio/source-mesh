# ADR 0006: Versioned explicit C# project selection

## Status

Accepted as the selection-contract foundation for [#114](https://github.com/VissotoFlavio/source-mesh/issues/114).

Amended on 2026-11-06: `--project` now always creates the exact v1 selection,
including when it is supplied once. The temporary single-project legacy mode
and its alternate `--explicit-project` spelling were removed.

## Context

The existing C# command accepts exactly one `--project` or one `--solution`.
Project discovery presently follows project references, and solution discovery
selects every solution project. Neither behavior can safely implement an
operator-selected project boundary.

## Decision

The next C# selection contract is version `1` and represents an immutable,
explicit set of root-relative `.csproj` paths:

```text
--language csharp --project <relative-project-path> [--project <relative-project-path> ...]
```

The order in which repeatable `--project` options are supplied has no meaning.
Each path is normalized to NFC with `/` separators, must be a relative
`.csproj` path, and the contract stores the paths in UTF-8 ordinal order. An
empty selection, a duplicate after lexical normalization (including slash and
Unicode aliases), a platform path-identity alias, or a selection above the
project limit is invalid. The manifest implementation must additionally reject
physical aliases, reparse points, paths outside the root, and missing files
before it discovers any project.

The modes are mutually exclusive:

- `--solution <relative-solution-path>` preserves solution selection; and
- one or more repeatable `--project <relative-project-path>` options create
  an explicit-project selection, never inferring projects from a solution or
  `ProjectReference`.

## Consequences

- The manifest boundary consumes a canonical ordered selection and owns
  filesystem validation plus the rule that unselected project references are
  external boundaries.
- The explicit-project manifest representation is the sole project-selection
  input to the Roslyn worker.
- The CLI parses every `--project` into the v1 selection before filesystem
  discovery and exposes its versioned diagnostics.

## Rejected alternatives

- Expanding a supplied solution and filtering it later: that still grants the
  solution implicit selection authority.
- Treating project references as selection membership: it silently widens the
  snapshot boundary.
- Enabling repeatable CLI options before the selected-project manifest exists:
  it would create a public interface that can only produce an incomplete or
  ambiguous analysis.
