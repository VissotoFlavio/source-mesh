# ADR 0003: Additive schema v2 for local C# graph snapshots

## Status

Accepted for the C#/.NET local-analysis work.

## Decision

Schema v2 extends the validated snapshot contract without migrating or
rewriting schema-v1 data. A reader accepts exactly versions 1 and 2; an unknown
integer version is reported as `unsupported_schema`, while a missing, noninteger,
or malformed version is `invalid_snapshot`. The MCP bootstrap validates and
decodes the snapshot before constructing its stdio transport.

Schema v2 retains the v1 envelope and adds these closed kinds:

- nodes: `solution`, `project`, and `namespace`;
- edges: `references` and `uses`.

The canonical containment is `repository -> solution -> project -> file ->
module -> namespace`, with nested namespaces and the existing declaration
containment rules below a namespace. A project may be directly contained by the
repository when no solution file is available. `references` is only
`project -> project`; `uses` is only `module -> namespace` or `module -> module`.
The existing v1 edge kinds and endpoint rules remain valid in v2.

Solution, project, and namespace nodes use the same closed descriptive shape as
other non-file nodes: `id`, `kind`, `name`, `path`, `qualifiedName`,
`memberRole`, and optional `locations`. Container nodes always use
`memberRole: "none"`. Paths are repository-relative canonical paths; qualified
names and names are NFC-normalized. A v2 project without a solution is directly
contained by the repository. A v2 snapshot may still contain the existing
TypeScript node kinds, but v2 identities are never recomputed with v1 formulas.

V2 identity domains are distinct (`sourcemesh-*-v2`, schema string `2`) for
repository, file, node, edge, and diagnostic identities. Inputs are limited to
relative paths, semantic parent identities, kinds, names, qualified names, and
member roles. Absolute paths, machine data, traversal segments, source offsets,
timestamps, and traversal order are not identity inputs.

The six existing query operations remain the only transport surface. They bind
to the loaded snapshot version and return the corresponding `schemaVersion` in
pages and `getSymbol` responses. V2 container nodes are searchable and may be
selected by `getSymbol`; file and call relation operations retain their v1
projection semantics. MCP schemas advertise the closed v1/v2 response union,
while clients cannot provide a snapshot version or filesystem authority in
tool input. The local CLI uses the same loaded-version binding for its query
filters and JSON envelopes, so a v2 result or query error is never labelled as
v1.

## Consequences

V1 canonical bytes, identities, query DTOs, cursors, and behavior remain
unchanged. V2 snapshots are canonicalized independently and use version-bound
cursors. `references` and `uses` are persisted for later C# query projections;
this issue does not add new MCP tools or infer unresolved relationships.

## Rejected alternatives

- Migrating v1 snapshots in memory: this would reinterpret stable identities and
  violate v1 compatibility.
- Reusing v1 identity domains: this would make semantically different graphs
  collide.
- Adding MCP tools for every new edge kind: the bounded six-operation surface
  remains stable; new projections require a separate contract decision.
