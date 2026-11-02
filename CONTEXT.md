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
through `createShadowRepo()` ([src/shared/local/localShadowRepo.ts](src/shared/local/localShadowRepo.ts)).

The implementation is in `src/git/`, an Effect-native rewrite.

_Avoid_: "tracking repo", "metadata repo", "source repo".

## Status

`getStatus` decides each tracked path's state by combining (HEAD, index,
workdir).

The status scan walks each package root with [src/git/dirWalk.ts](src/git/dirWalk.ts)
and evaluates nested
`.gitignore` files through the chained matcher in
[src/git/ignoreChain.ts](src/git/ignoreChain.ts). The chain starts from
`.git/info/exclude` and accumulates as the walk descends. `.forceignore`
is unrelated and sits at the project root.
