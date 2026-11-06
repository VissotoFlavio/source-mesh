---
name: sourcemesh
description: Query an existing SourceMesh MCP snapshot to investigate local code structure and direct relationships without assuming compilation or unproven edges.
---

# SourceMesh MCP queries

Use this skill when a SourceMesh MCP server is already connected and the task is
to inspect the structure of its pinned local snapshot. This skill is optional:
the MCP server works without it, and it does not configure, start, or modify the
server.

## Preconditions and boundary

Confirm that an authorized local workflow has already created the intended
snapshot and started MCP with the intended repository root. The server exposes
only read-only queries for that one immutable snapshot. It cannot analyze a
repository, create or replace a snapshot, compile a target, restore NuGet
packages, resolve external dependencies, or write files.

Treat returned graph data as bounded structural evidence, not a complete model
of runtime behavior. C# relationships are syntactic. Do not infer dynamic calls,
external/package relationships, compiler success, or a relationship that the
snapshot does not return.

Do not copy source text, absolute paths, diagnostics, graph payloads, or secrets
to an external prompt, log, or issue unless the user has separately authorized
that disclosure. The connected MCP host and its provider have their own data
handling boundary.

## Query incrementally

Start with the narrowest question that can answer the task. Request more only
when the prior result makes it necessary.

1. Use `searchSymbols` with a non-empty query. Search is a case-sensitive
   literal substring match over a symbol name or qualified name. Narrow it with
   `kind`, `path`, or `containerId` when appropriate.
2. A search result's `id` is accepted as `nodeId` by `getSymbol`. Alternatively,
   use one explicit selector. `nodeId` and `selector` are mutually exclusive;
   if a selector is ambiguous, refine it rather than choosing a candidate.
3. Use `getSymbol` to inspect one symbol and its bounded children. When its
   `container` is a file, its `id` can be used as `fileId` for a file relation.
4. Use `listFileDependencies` or `listFileDependents` with a returned file ID
   for direct file relationships only.
5. Use `listCallers` or `listCallees` with a function selector. Start with the
   function name and add `qualifiedName`, `path`, `memberRole`, or `containerId`
   to resolve ambiguity.

All tools accept a bounded `limit` from 1 through 100. Treat `continuation` as
an opaque cursor: pass it back only for the same operation and selector/filter
context. Do not construct cursors or substitute offsets.

`allowPartial` is false by default. If the server reports that the snapshot is
partial, either stop and state that a complete answer is unavailable, or opt in
with `allowPartial: true` only when the user accepts a qualified result. Always
identify that limitation in the conclusion.

## Interpret results conservatively

- `not_found` means the pinned snapshot has no matching item; it is not proof
  that the item cannot exist elsewhere.
- `ambiguous` means more selector detail is required. Use the returned bounded
  candidates to refine the next request.
- `entity_type_mismatch` means an ID was supplied to the wrong relation family;
  obtain the matching symbol or file ID from a tool response.
- `partial_not_allowed` requires either a complete snapshot or the explicit,
  qualified `allowPartial` opt-in.

Report what the snapshot directly establishes, the exact query boundary when it
matters, and unresolved or external limits. Do not translate absence of a graph
edge into a broader architectural claim.

## Adoption

Keep this `skills/sourcemesh/` directory with its `SKILL.md` in the host's
separately managed skill location according to that host's installation rules.
Do not add it to a SourceMesh package or MCP configuration: it is guidance for
an agent, not a server dependency.
