# source-tracking

JavaScript library for tracking local and remote Salesforce metadata changes.

**_ UNDER DEVELOPMENT _**

You should use the class named sourceTracking.

### Use cases:

1. push => `deployLocalChanges()`
1. pull => `retrieveRemoteChanges()`
1. push,pull,status: `getConflicts()`
1. retrieve/retrieve: `updateLocalTracking()`,`updateRemoteTracking`

## TODO

pollSourceMembers should better handle aggregated types

```
DEBUG Could not find 2 SourceMembers: AuraDefinition__pageTemplate_2_7_3/pageTemplate_2_7_3.cmp-meta.xml,[object Object],CustomObject__Account,[object Object]
```

ensureRemoteTracking should have 2 options in an object

1. `ensureQueryHasReturned` which will make sure the query has run at least once
2. `forceQuery` will re-query even if the query already ran (cache-buster typically)

- push/pull proper table output (exists over in plugin-source so why redo it here?)

- SDR sets all retrieve FileResponse as `Changed` even if it didn't exist locally. That's going to yield slightly different json output on a `pull` than toolbelt did. See `remoteChanges.nut.ts > remote changes:add > can pull the add`. Fixing in pull is less optimal than fixing in SDR (because source:retrieve is also currently reporting those as `Changed` instead of `Created`)
  work around our gitignore stash trick...sometimes it gets in the incomplete state. What if there is no gitignore? All kinds of error handling issues around that

### Test

- create a NUT For non-ST org (ex: the dev hub)
- failing UT on remoteTrackingService for non-ST orgs

### Migration

- can migrate maxRevision.json to its new home

### Enhancements

- status can "mark ignores"
- why does push take so long?
- for updating ST after deploy/retrieve, we need a quick way for those commands to ask, "is this an ST org?" OR a graceful "ifSupported" wrapper for those methods.

### Cleanup

- review commented code
- review public methods for whether they should be public
- organize any shared types
- export top-level stuff
