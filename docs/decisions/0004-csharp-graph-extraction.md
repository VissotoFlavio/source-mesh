# ADR 0004: Deterministic C# graph extraction

## Status

Accepted for the first local C# graph integration.

## Decision

The Roslyn helper parses only selected local source files and emits a closed,
relative-path DTO containing syntactic declaration candidates, source locations,
and conservative relationship outcomes. It does not restore packages, create a
compilation, load target references, or execute the target. The Node process owns
schema-v2 identity framing, containment, edge deduplication, ordering, and
diagnostic identity calculation. It never receives compiler objects or source
text from the helper.

The graph uses `repository -> solution? -> project -> file -> module`, followed
by namespace and declaration containment. Project references are emitted from
the approved manifest. Syntactic relationships are accepted only when a unique
local target maps to a valid endpoint and carry `syntactic` evidence in schema
v3; external, unresolved, ambiguous,
dynamic, unsupported, and missing-source cases become sanitized diagnostics.

## Consequences

- Repository roots do not participate in identities or serialized locations.
- Constructors and accessors cannot become graph endpoints.
- Parser recovery keeps the valid local graph available; compiler diagnostics
  are not produced by this analysis mode.
- Overlapping project source files have one deterministic project owner for
  containment; declarations and relationships remain deduplicated by v2 key.
