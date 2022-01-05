# Test for duplicate labels using force:source:push:beta

To run:

    sfdx force:source:beta:push -f

Actual Output:

    *** Pushing with SOAP API v53.0 ***
    (node:1152) Warning: The SFDX_MDAPI_TEMP_DIR environment variable is set, which may degrade performance
    SOURCE PROGRESS | ████████████████████████████████████████ | 2/2 Components

    === Component Failures [2]
    Type   Name    Problem
    ─────  ──────  ─────────────────────────────────
    Error  Label1  Duplicate name 'Label1' specified
    Error  Label1  Duplicate name 'Label1' specified

    ERROR running force:source:beta:push:  Push failed.

Expected Output:

    No error as 'pkg2' label overrides 'pkg1' label of same name when using MPD. Tested on fdx-cli/7.125.0 darwin-x64 node-v12.22.7.
