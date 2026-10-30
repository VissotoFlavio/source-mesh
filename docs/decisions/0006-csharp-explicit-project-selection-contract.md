# ADR 0006: Versioned explicit C# project selection

## Status

Accepted as the selection-contract foundation for [#114](https://github.com/VissotoFlavio/source-mesh/issues/114).

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

- the legacy `--solution <relative-solution-path>` retains its current
  solution behavior;
- one legacy `--project <relative-project-path>` retains its current
  single-project behavior; and
- explicit-project selection has no `--solution` and never infers projects
  from a solution or `ProjectReference`.

This change only publishes the versioned in-process selection value. The CLI
does not yet accept repeated `--project` values, and the existing discovery
function does not accept this new value. Until the canonical selected-project
manifest is implemented, preserving that rejection is intentional: no new CLI
spelling can partially discover or analyze a multiple-project selection.

## Consequences

- The later manifest boundary consumes a canonical ordered selection and owns
  filesystem validation plus the rule that unselected project references are
  external boundaries.
- Existing one-project and solution callers retain their exact parser and
  discovery behavior during the transition.
- A future CLI implementation must parse repeatable options into the v1 value
  before filesystem discovery and expose versioned diagnostics from this
  contract; it must not add an alternate implicit selection mode.

## Rejected alternatives

- Expanding a supplied solution and filtering it later: that still grants the
  solution implicit selection authority.
- Treating project references as selection membership: it silently widens the
  snapshot boundary.
- Enabling repeatable CLI options before the selected-project manifest exists:
  it would create a public interface that can only produce an incomplete or
  ambiguous analysis.
