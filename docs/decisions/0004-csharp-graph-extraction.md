# ADR 0004: Deterministic C# graph extraction

## Status

Accepted for the first local C# graph integration.

## Decision

The Roslyn helper emits only a closed, relative-path DTO containing declaration
candidates, source locations, and relationship outcomes. The Node process owns
schema-v2 identity framing, containment, edge deduplication, ordering, and
diagnostic identity calculation. It never receives compiler objects or source
text from the helper.

The graph uses `repository -> solution? -> project -> file -> module`, followed
by namespace and declaration containment. Project references are emitted from
the approved manifest. Roslyn relationships are accepted only when a unique
local target maps to a valid v2 endpoint; external, unresolved, ambiguous,
dynamic, unsupported, and missing-source cases become sanitized diagnostics.

## Consequences

- Repository roots do not participate in identities or serialized locations.
- Constructors and accessors cannot become graph endpoints.
- Partial Roslyn diagnostics produce a partial snapshot while preserving the
  valid local graph.
- Overlapping project source files have one deterministic project owner for
  containment; declarations and relationships remain deduplicated by v2 key.
