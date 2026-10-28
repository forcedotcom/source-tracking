# SDR Findings: STL Use In VS Code Services

## Scope

Consumer inventory from `salesforcedx-vscode-ref` at `develop` commit
`6d54f1dd9`. Services declares `@salesforce/source-tracking` `^8.1.7`.

## Confirmed Status-Bar Path

```text
VS Code file event
  -> FileChangePubSub
  -> 500 ms debounce
  -> status-bar refresh
  -> SourceTrackingService.getStatus({ local: true, remote: true })
  -> STL reread local + remote
  -> STL combined status
  -> STL remote nondelete + delete getChanges
```

References:

- Filesystem watcher: `packages/salesforcedx-vscode-services/src/vscode/fileWatcherService.ts:16-35`
- Status-bar file-event subscription, debounce, poll merge, and suppression:
  `packages/salesforcedx-vscode-metadata/src/statusBar/sourceTrackingStatusBar.ts:110-205`
- Status-bar local+remote status request: `sourceTrackingStatusBar.ts:22-46`
- Services STL refresh/status/extra remote reads:
  `packages/salesforcedx-vscode-services/src/core/sourceTrackingService.ts:178-195,264-341`

## Consequences

- Ordinary workspace edits can trigger full local and remote STL status work
  after debounce; the watcher does not call STL per raw file event.
- File events, 60-second default remote polling, target-org changes, conflict
  detection setting changes, and metadata-operation completion converge on the
  same status-bar refresh stream.
- Status-bar refresh is suppressed while `ActiveMetadataOperationRef` is
  nonzero. It resumes when the active operation drains.
- Services serializes local and remote status categories with separate
  one-permit semaphores. Serialization does not move STL/SDR CPU work off the
  extension-host thread.
- Remote status refresh performs more than one STL call: after
  `tracking.getStatus`, Services requests nondelete and delete remote
  `ChangeResult`s for catalog recording and metadata-description invalidation.

## Other Services Entry Points

| Consumer operation                  | STL work                                           | Trigger                         |
| ----------------------------------- | -------------------------------------------------- | ------------------------------- |
| `getLocalChangesAsComponentSet`     | Local reread + local component resolution          | Deploy set creation             |
| `getConflicts` / `checkConflicts`   | Local + remote reread + conflict evaluation        | Retrieve preflight, conflict UI |
| `getRemoteNonDeletesAsComponentSet` | Remote reread + source-backed component resolution | Retrieve planning               |
| `maybeUpdateTrackingFromRetrieve`   | Retrieve tracking update                           | Merge retrieve completion       |
| `maybeUpdateTrackingFromDeploy`     | Deploy tracking update                             | Deploy completion               |
| `maybeApplyRemoteDeletesToLocal`    | Both rereads + remote-delete reconciliation        | Project retrieve workflow       |

References: `sourceTrackingService.ts:196-260,343-500`; retrieve preflight and
completion: `metadataRetrieveService.ts:264-274,325-327,365-367`; deploy local
component discovery: `metadataDeployService.ts:58-68`.

## Benchmark Requirement

Use the consumer operation, not only bare STL calls:

```text
File-event burst -> debounce -> getStatus({ local: true, remote: true })
```

Measure same-thread heartbeat progress, event-loop delay, STL call counts,
service semaphore wait, wall time, and status correctness. Include decomposed
objects, bundle-heavy source, ordinary remote deltas, name-correction deltas,
and local/remote conflicts.
