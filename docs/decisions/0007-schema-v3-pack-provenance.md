# ADR 0007: Schema v3 pack provenance and relationship evidence

## Status

Accepted for issue #53.

## Decision

Schema v3 is an additive snapshot envelope for graphs produced through local
language packs. It preserves the validated v2 graph identities and containment
rules, while adding a closed `metadata` object. Its required
`verification: "unverified"` marker makes clear that pack and evidence claims
are descriptive local producer data, not signed or authenticated provenance.
Consumers must not use them as an authorization, integrity, or policy input.
Each participating pack has an ID, language, extractor version, and declared
capabilities. The list is UTF-8 ordinal sorted by ID, bounded to 256 entries,
and capped at 8 KiB of canonical metadata. Pack IDs and language labels are
separately capped at 64 UTF-8 bytes because they are repeated in query
responses; metadata text excludes JSON control characters. Extractor versions
are metadata-only, capped at 1 KiB, and remain subject to the aggregate cap.

V3 also bounds every inherited graph field that it returns in a query: node
name, path, qualified name, and location path are each capped at 64 UTF-8
bytes, control characters are rejected, and a node exposes at most one
location. These V3-only admission limits, together with a four-record evidence
prefix per relation counterpart, make a 100-item page safe after MCP serializes
both text and structured content. They do not alter V1 or V2 reader behavior.

Every non-repository v3 node has `packId` and `language`; the pair must match a
pack entry. A non-containment v3 edge has its emitting `packId` and exactly one
evidence level: `semantic`, `syntactic`, or `inferred`. Core-owned containment
edges deliberately have neither field. This keeps structural containment from
being mistaken for language-analysis evidence.

The six query and MCP operations remain unchanged. For v3, search and symbol
results include the snapshot metadata and attributed node summaries. File and
call relation results return a target node plus a deterministic evidence prefix
of at most four records. `relationshipsTotal` and `relationshipsTruncated` make
the bounded result explicit. Existing v1 and v2 response shapes and semantics
remain unchanged.

Readers accept schemas 1, 2, and 3. Unknown integer versions return the
`unsupported_schema` diagnostic with the supported-version list; malformed
versions remain `invalid_snapshot`. Readers do not migrate older snapshots in
memory, so their canonical bytes, identities, cursors, and query results retain
their original interpretation.

## Consequences

V3 encoding is deterministic: nodes and edges retain v2 ordering, packs sort by
ID, capabilities sort ordinally, and relation evidence sorts by edge ID. All
metadata and evidence remain bounded for MCP transport. Future capability or
evidence shapes require a later schema version rather than changing the
meaning of v3 data.
