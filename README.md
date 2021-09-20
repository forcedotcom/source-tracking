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

NUT for tracking file compatibility check logic
pollSourceMembers should better handle aggregated types. ex:

```
DEBUG Could not find 2 SourceMembers (using ebikes): AuraDefinition__pageTemplate_2_7_3/pageTemplate_2_7_3.cmp-meta.xml,[object Object],CustomObject__Account,[object Object]
```

### Enhancements

- for updating ST after deploy/retrieve, we need a quick way for those commands to ask, "is this an ST org?" OR a graceful "ifSupported" wrapper for those methods.
- ensureRemoteTracking could have 2 options in an object
  1. `ensureQueryHasReturned` which will make sure the query has run at least once
  2. `forceQuery` will re-query even if the query already ran (cache-buster typically)

### Cleanup

- review commented code
- review public methods for whether they should be public
- organize any shared types
- export top-level stuff
