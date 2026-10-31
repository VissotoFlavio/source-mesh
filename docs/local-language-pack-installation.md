# Local language-pack installation

Language packs are installed explicitly before analysis. Analysis never scans
the repository for packs, reads a pack path from repository metadata, imports a
user-selected module, downloads a pack or package, contacts a registry, restores an
SDK, or looks for updates. A pack update is an operator action: install and
verify the new local artifact, change the exact version in the local
configuration, run the local validation, then start a new analysis.

## Trust and layout model

Core is shipped with a source-owned candidate list. Bundled packs are imported
by Core code; separately distributed packs must be installed into the same
trusted local application distribution and added by a source-owned bootstrap
adapter. The installation configuration is data only: it identifies an exact
candidate already supplied by that adapter. It contains no path, URL, command,
module specifier, registry name, or package-manager instruction.

Do not place this configuration in the repository being analyzed. Store it with
the operator's SourceMesh installation or another operator-controlled local
configuration location. A repository cannot enable, replace, or update a pack.

## Closed configuration

The Core API validates this closed JSON shape before registration. Extra fields,
duplicate pack IDs, unknown configuration versions, malformed values, and
unknown Core contract versions are rejected.

```json
{
  "version": 1,
  "core": { "packContractVersion": 1 },
  "packs": [
    { "id": "typescript", "version": "1.0.0", "enabled": true },
    {
      "id": "csharp",
      "version": "1.0.0",
      "enabled": true,
      "workerProtocolVersion": 1
    }
  ]
}
```

`resolveLocalPackInstallation(configuration, installedPacks)` is a pure
resolver. The caller passes only its source-owned, preinstalled candidates;
the resolver has no filesystem, network, dynamic-import, process, or package
manager API. Register its accepted `packs` with `LanguagePackRegistry`, then
call `registry.configure(result.selection)`. Only entries with `enabled: true`
participate in discovery. An installed but disabled pack remains registered so
an attempted analysis receives the existing `pack_disabled` diagnostic.

## Compatibility matrix

| Boundary                            | Required local rule                                                                                               | Failure outcome                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Core and installation configuration | `version` and `core.packContractVersion` must be the Core-supported values.                                       | `pack_installation_invalid`                       |
| Manifest and Core pack contract     | The candidate manifest has the exact supported `contractVersion` and closed manifest shape.                       | `pack_incompatible`                               |
| Configured pack and installed pack  | `id` and `version` must select exactly one preinstalled candidate; versions are exact, never ranges.              | `pack_unavailable` or `pack_incompatible`         |
| Local-worker protocol               | `local-worker` and `hybrid` manifests and configuration must declare the exact supported worker protocol version. | `pack_incompatible`                               |
| Enablement                          | Only explicit `enabled: true` entries are passed to registry discovery.                                           | `pack_disabled` on an attempted disabled analysis |

An incompatible or unavailable candidate is never returned by the resolver,
therefore it cannot receive approved source metadata. A configuration error also
returns an empty selection. The registry continues to validate each accepted
manifest and analysis response at the Core boundary.

## Offline update and validation procedure

1. Obtain the separately distributed pack through an approved operator process;
   verify its published integrity evidence before making it available to the
   SourceMesh bootstrap. This is an installation step, never an analysis step.
2. Add the exact pack version to the operator-controlled configuration. Keep the
   previous artifact and configuration until the replacement passes validation,
   so rollback is an explicit configuration change.
3. Run the pack's conformance suite and the Core validation locally. For this
   repository, run `npm test`, `npm run typecheck`, and
   `npm run offline:check`. The offline check denies network access to runtime
   analysis and is the required regression proof for a pack update.
4. Resolve the configuration against the local candidate list and inspect any
   `pack_installation_invalid`, `pack_unavailable`, or `pack_incompatible`
   diagnostic before enabling the update. Do not retry through a network
   fallback.

The configuration format intentionally does not implement package publication,
remote registries, automatic download, automatic update, or arbitrary runtime
loading. Those operations require separate authorization and a separately
versioned security design.
