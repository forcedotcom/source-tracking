# Source Tracking — domain glossary

Domain language for `@salesforce/source-tracking`. Updated lazily as terms are
resolved during work; entries are meaningful to domain experts (Salesforce
metadata + source tracking), not implementation details.

## .forceignore

A `.forceignore` file lives at the **project root**, alongside `sfdx-project.json`.
It governs which files SDR (source-deploy-retrieve) treats as ignored.

Source tracking treats `.forceignore` as **project-level only**. Per-package-dir
`.forceignore` files are not supported. STL constructs a single `ForceIgnore`
from `this.project.getDefaultPackage().fullPath`
([sourceTracking.ts:765](src/sourceTracking.ts)) and threads it through callees.

Note: SDR's `MetadataResolver`, when given `useFsForceIgnore = true`, will
re-discover a `.forceignore` per resolved file path
([SDR metadataResolver.ts:68](https://github.com/forcedotcom/source-deploy-retrieve/blob/main/src/resolve/metadataResolver.ts)).
That path is not exercised by STL conventions and does not change the contract:
one `.forceignore` per project.

## ChangeResult

The unit STL emits when describing tracked changes. A `ChangeResult` may be
`origin: 'local' | 'remote'`, may have `filenames`, and may have `name` / `type`
if it has been resolved to a metadata component.

## Public API surface

Whatever `src/index.ts` re-exports is the stable public API and bound by semver.
Everything else under `src/` is internal and freely mutable.

## Shadow repo

A per-(project, org) git repository at
`<projectPath>/.sf/orgs/<orgId>/localSourceTracking/`. STL writes commits
here to track which workdir files changed since the last sync. The user
never interacts with it directly; it is hidden under `.sf/` and managed
through `ShadowRepo.getInstance()` ([src/shared/local/localShadowRepo.ts](src/shared/local/localShadowRepo.ts)).

Two implementations exist behind one façade:

- **iso** — backed by `isomorphic-git`. Default until the lite path is
  proven in production.
- **lite** — backed by `src/git/`, an Effect-native rewrite. Selected when
  `SF_SOURCE_TRACKING_USE_LITE_GIT=true`.

_Avoid_: "tracking repo", "metadata repo", "source repo".

## Cold / warm status

`getStatus` decides each tracked path's state by combining (HEAD, index,
workdir).

- **Cold status** — full directory walk + per-file evaluation.
  Authoritative; works on any filesystem. The fallback path.
- **Warm status** — reuses a cached per-directory untracked-file list,
  validated by a `(mtimeMs, size, gitignoreMtimeMs)` fingerprint per
  directory. Requires a filesystem that advances mtime reliably (probed
  once at first `switchTo`; see [src/git/untrProbe.ts](src/git/untrProbe.ts)).
  The cache is reloaded from disk whenever the sidecar's mtime advances,
  which keeps long-lived consumers (e.g. the VS Code extension host)
  correct across cross-process mutations.

The lite path emits warm when the cache is valid and the probe passed,
falls back to cold on any miss. Iso is cold-only.

## UNTR cache

The on-disk artifact backing warm status: per-directory
`(mtimeMs, size, gitignoreMtimeMs)` fingerprint + the basenames _and
resolved `'added' | 'ignored'` status_ of untracked files inside that
directory at the time of last `applyChanges`. Lite uses a JSON sidecar
file at `.git/sftracking/untr.json` encoded via Effect Schema; see
[adr/0004](adr/0004-untr-cache-format-and-location.md).

_Avoid_: "untracked-file cache" (collides with real-git's
`core.untrackedCache` which is the same idea but different bytes),
"dirty cache".

## Sidecar

An auxiliary file living next to a primary file. Source-tracking uses
this pattern for [UNTR cache](#untr-cache): the cache file at
`.git/sftracking/untr.json` is a sidecar to `.git/index`. Sidecars are
regenerable; deleting one only forces one cold rebuild.
