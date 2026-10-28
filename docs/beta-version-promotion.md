# Beta versioning and promotion

This document defines the governed procedure for preparing a private
SourceMesh beta candidate. It is a release procedure, not an authorization to
create a release branch, merge a release, create a tag, publish a package, or
create a GitHub Release. Those actions require separate explicit approval.

The current repository remains pre-release. This documentation does not change
`package.json`, does not select a final release version, and does not remove
`private: true`.

## Version policy

SourceMesh uses [Semantic Versioning](https://semver.org/) for release
identifiers. The recommended first private beta is:

```text
0.1.0-beta.1
```

The parts mean:

- `0` is the major version;
- `1` is the minor version; and
- `0` is the patch version. The `-beta.1` suffix is the prerelease identifier
  and its numeric component identifies the candidate sequence.

While the candidate has not been promoted, subsequent beta candidates for the
same public version increment only the numeric prerelease identifier:
`0.1.0-beta.2`, `0.1.0-beta.3`, and so on. A stable promotion removes the
prerelease suffix and uses `0.1.0` only after the release owner has explicitly
chosen that stable version and all required gates have passed.

The recommendation is not a decision. If the release owner chooses another
valid SemVer value, the release PR must record the chosen value and the reason
for the deviation. Do not invent a version in a feature or documentation PR.

### Candidate immutability

A beta version identifies one exact candidate content. The same version may be
reused only to retry the same candidate without any content, dependency,
configuration, or generated-artifact change. Any change after CI or review, or
any material change in candidate content, requires a new prerelease identifier
such as `0.1.0-beta.2`. Never reuse a version that has already been tagged or
published, even if the replacement content is intended to fix that candidate.

## Exact update point

Feature and maintenance work keeps the version fields unchanged and records
user-visible changes under `Unreleased`; it does not create a candidate version
heading. The version fields and changelog transition are updated together only
after all candidate work has been reviewed and merged into `develop`, and
immediately before preparing the release PR.

The authorized release operator performs these updates on the candidate's
`release/<version>` branch, created from the reviewed tip of `develop`:

1. Confirm the exact chosen version, normally `0.1.0-beta.1`, before editing
   any file.
2. Change `package.json#version` to that chosen value and change both
   corresponding lockfile roots in the same release-preparation change:
   `package-lock.json#version` and
   `package-lock.json#packages[""].version`. Keep `package.json#private` set
   to `true`. A beta version is metadata; it does not make the package
   publishable.
3. Validate that all three version fields are equal before opening the release
   PR. For example:

   ```powershell
   node --input-type=module -e "import fs from 'node:fs'; const packageJson = JSON.parse(fs.readFileSync('package.json')); const lock = JSON.parse(fs.readFileSync('package-lock.json')); const versions = [packageJson.version, lock.version, lock.packages?.['']?.version]; if (versions.some((version) => version !== packageJson.version)) { throw new Error('package.json and package-lock.json root versions differ'); } if (packageJson.private !== true) { throw new Error('package.json must remain private'); } console.log(versions[0]);"
   ```

4. Treat the current state of this issue as a non-release state: `package.json`
   is still `0.0.0`, `package-lock.json#version` and
   `package-lock.json#packages[""].version` are also `0.0.0`, and
   `package.json#private` is still `true`.
5. Move the completed `Unreleased` entries into a dated heading such as
   `## [0.1.0-beta.1] - 2026-10-27`, preserving the Keep a Changelog
   categories and issue references. The current changelog state for this issue
   remains only `## [Unreleased]`; do not create the candidate heading now.
6. Leave a new empty `## [Unreleased]` section above the dated candidate
   section for work that follows the candidate.
7. Do not add a version comparison link while the tag or comparison is not
   authorized and available. After that separate authorization, add only the
   exact link that resolves to the created tag or approved comparison; leaving
   the link absent beforehand avoids dead links.
8. Inspect the combined diff and verify that the only release metadata changes
   are the chosen version in all three fields and the corresponding changelog
   transition.

The version fields and changelog must be changed together in the same
release-preparation change. A feature PR must not preemptively bump either
manifest, and a changelog entry must not claim a version that has not been
selected.

## Promotion sequence and gates

Promotion is a controlled sequence. Stop at the first failed gate and do not
merge or publish a candidate with an unresolved failure.

### 1. Establish the candidate

- Confirm that the release scope is already merged to `develop` through
  issue-backed pull requests.
- Confirm that no unrelated work is included in the candidate tip.
- Confirm the selected SemVer value and the intended candidate date with the
  release owner.
- Confirm that the local beta installation and validation procedures are
  available in [beta-checkout.md](beta-checkout.md) and
  [beta-validation-runbook.md](beta-validation-runbook.md).

### 2. Run the technical gates

Run the repository's normal gate from the reviewed `develop` tip:

```powershell
npm run check
```

For the supported Windows x64 distribution, also run the documented offline
helper and package gates when their prerequisites are available:

```powershell
dotnet restore tools/sourcemesh-roslyn/sourcemesh-roslyn.csproj --locked-mode --configfile tools/sourcemesh-roslyn/NuGet.offline.config
npm run csharp:offline:check
npm run package:check
```

The beta runbook remains the authority for the opt-in real-application profile.
Do not substitute a real repository for the synthetic fixture in the normal
gate, and do not send source or graph data to an external service.

### 3. Review the release candidate

Before opening the release PR, record reviews for:

- scope: the candidate contains only already reviewed work;
- versioning: the selected value is valid SemVer and matches the PR title,
  `package.json`, and changelog heading;
- privacy and packaging: `private: true` remains present, package contents and
  offline boundaries are unchanged unless explicitly included in the release;
- compatibility: supported Node.js and Windows x64 distribution gates passed;
- recovery: the rollback path below is understood and recorded.

The release PR is a promotion of reviewed work, not a place to add feature
code. Address all actionable review findings before requesting authorization to
merge. Pull requests targeting `develop` use squash merge; the release PR
targets `master` under the repository's release workflow and must not close an
artificial release issue.

### 4. Authorize and merge

The release PR may be merged only after its required checks and reviews pass
and the release owner gives explicit merge authorization. Record the PR URL,
review outcome, check results, selected version, and merge commit. A release PR
does not use `Closes #<issue>` to close an artificial release issue.

### 5. Reconcile `develop` after the release merge

After a release PR merges into `master`, verify the automatic backport PR
created by `.github/workflows/backport-master-to-develop.yml`:

1. Confirm that the PR targets `develop`, uses the deterministic branch
   `backport/release-<version>`, and identifies the release PR's exact merge
   SHA.
2. Confirm that the generated backport PR has the expected source repository,
   source branch, changed files, required checks, and review outcome. If the
   workflow did not create the expected PR or the references do not match,
   stop and investigate; do not commit directly to `develop`.
3. After the review and checks pass, merge the backport PR to `develop` with
   squash merge, as required for merges targeting `develop`.
4. Record the backport PR URL and its squash merge SHA alongside the release
   PR evidence.

The backport is a reconciliation of the already merged release; it does not
authorize a new release, tag, package publication, or deployment.

### 6. Handle publication separately

Creating a tag, creating a GitHub Release, publishing the npm package,
publishing binaries, changing CI or secrets, and deploying are separate
operations. Each requires its own explicit authorization and evidence. The
presence of a merged release PR is not permission for any of them. In
particular, `private: true` must remain until package publication has been
separately designed, reviewed, and authorized.

## Evidence to retain

The release record should contain sanitized, reproducible evidence:

- source branch and base commit SHA;
- exact chosen version and the before/after values of `package.json#version`;
- equality of `package.json#version`, `package-lock.json#version`, and
  `package-lock.json#packages[""].version`;
- confirmation that `package.json#private` is still `true`;
- changelog heading, date, retained issue references, and comparison-link
  changes;
- commands, tool versions, operating system, and pass/fail result for each
  required gate;
- PR URL, changed-file list, review decisions, approval authorization, and
  merge SHA;
- automatic backport PR URL, its review/check results, and squash merge SHA to
  `develop`;
- separately authorized tag, GitHub Release, package publication, or deploy
  identifiers, if those later occur; and
- any known limitation, skipped optional gate, or follow-up issue.

Do not attach source code, snapshots, repository contents, credentials,
secrets, absolute private paths, raw MCP payloads, or unredacted command output
to the release record. The evidence proves the procedure without widening the
privacy boundary.

## Rollback and recovery

### Before the release PR merges

If a gate or review fails before the release PR is merged, stop promotion. Do
not merge the candidate, publish it, or create a tag. The same beta version may
be retried only when the candidate content is unchanged. If the candidate is
corrected or changes materially, choose and record a new incremented
prerelease version and rerun the applicable gates and reviews.

### Merged to `master`, but not tagged or published

If the release PR has merged to `master` and a material defect is found before
any tag or publication, do not reuse the affected version for replacement
content. Recovery follows the governed hotfix path:

1. create an issue-backed `hotfix/<issue-id>-<slug>` branch from `master`;
2. implement and review the minimal correction there;
3. open the hotfix PR to `master` and merge only with explicit authorization;
4. backport the correction to `develop` through the repository's governed
   backport process; and
5. prepare any replacement beta with a new, explicitly chosen prerelease
   identifier and record the affected release, hotfix PR, backport, and
   validation.

### Tagged or published

If the candidate has already been tagged or published, quarantine or withdraw
the affected artifact only through a separate, explicitly authorized incident
or publication procedure. That procedure must define the package or release
removal/withdrawal behavior, preserve the audit trail, and choose a new version
for corrected content. It is outside the scope of issue #74. Never silently
rewrite a published tag or replace published package contents in place.

## Authorization limits

This document and issue #74 authorize documentation work only. They do not
authorize:

- creating `release/<version>` or `hotfix/<issue>-<slug>` branches;
- changing `package.json` or `package-lock.json`, removing `private: true`, or
  selecting a final release version;
- opening or merging a release or hotfix PR;
- creating tags or GitHub Releases;
- publishing npm packages or binaries;
- changing CI, repository settings, credentials, or secrets; or
- deploying or changing infrastructure.

Those actions require the specific authority described by the repository
workflow and the release owner.
