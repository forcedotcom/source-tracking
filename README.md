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

Push can have partial successes and needs a proper status code ex:

```json
{
  "checkOnly": false,
  "completedDate": "2021-08-14T18:03:37.000Z",
  "createdBy": "005R0000009HFrL",
  "createdByName": "User User",
  "createdDate": "2021-08-14T18:03:34.000Z",
  "details": {
    "componentFailures": {
      "changed": "false",
      "componentType": "Profile",
      "created": "false",
      "createdDate": "2021-08-14T18:03:36.000Z",
      "deleted": "false",
      "fileName": "profiles/Admin.profile",
      "fullName": "Admin",
      "problem": "In field: field - no CustomField named Account.test__c found",
      "problemType": "Error",
      "success": "false"
    },
    "componentSuccesses": [
      {
        "changed": "true",
        "componentType": "ApexClass",
        "created": "true",
        "createdDate": "2021-08-14T18:03:35.000Z",
        "deleted": "false",
        "fileName": "classes/test2.cls",
        "fullName": "test2",
        "id": "01pR000000DVwPqIAL",
        "success": "true"
      },
      {
        "changed": "true",
        "componentType": "ApexClass",
        "created": "true",
        "createdDate": "2021-08-14T18:03:35.000Z",
        "deleted": "false",
        "fileName": "classes/test.cls",
        "fullName": "test",
        "id": "01pR000000DVwPpIAL",
        "success": "true"
      },
      {
        "changed": "true",
        "componentType": "",
        "created": "false",
        "createdDate": "2021-08-14T18:03:36.000Z",
        "deleted": "false",
        "fileName": "package.xml",
        "fullName": "package.xml",
        "success": "true"
      }
    ],
    "runTestResult": {
      "numFailures": "0",
      "numTestsRun": "0",
      "totalTime": "0.0"
    }
  },
  "done": true,
  "id": "0AfR000001SjwjQKAR",
  "ignoreWarnings": false,
  "lastModifiedDate": "2021-08-14T18:03:37.000Z",
  "numberComponentErrors": 1,
  "numberComponentsDeployed": 2,
  "numberComponentsTotal": 3,
  "numberTestErrors": 0,
  "numberTestsCompleted": 0,
  "numberTestsTotal": 0,
  "rollbackOnError": true,
  "runTestsEnabled": false,
  "startDate": "2021-08-14T18:03:34.000Z",
  "status": "Failed",
  "success": false
}
```

- push: ignoreWarnings logic? What is this actually doing originally?
- push/pull throw proper error for conflicts (with label!)
- polling for source tracking to complete (use it, w/ rewrite)
- RSTS: don't use trackSourceMembers with empty sourceMembers array (equivalent of sync all)
- push/pull proper table output

- SDR sets all retrieve FileResponse as `Changed` even if it didn't exist locally. That's going to yield slightly different json output on a `pull` than toolbelt did. See `remoteChanges.nut.ts > remote changes:add > can pull the add`. Fixing in pull is less optimal than fixing in SDR (because source:retrieve is also currently reporting those as `Changed` instead of `Created`)

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
