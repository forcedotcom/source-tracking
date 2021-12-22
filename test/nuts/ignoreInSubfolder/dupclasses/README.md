# Test for duplicate classes using force:source:push:beta

To run:

    sfdx force:source:beta:push -f

Actual Output:

    *** Pushing with SOAP API v53.0 ***
    (node:21453) Warning: The SFDX_MDAPI_TEMP_DIR environment variable is set, which may degrade performance
    SOURCE PROGRESS | ████████████████████████████████████████ | 1/1 Components

    === Pushed Source
    STATE    FULL NAME  TYPE       PROJECT PATH
    ───────  ─────────  ─────────  ───────────────────────
    Changed  Hello      ApexClass  pkg1/Hello.cls
    Changed  Hello      ApexClass  pkg1/Hello.cls-meta.xml
    Changed  Hello      ApexClass  pkg2/Hello.cls
    Changed  Hello      ApexClass  pkg2/Hello.cls-meta.xml

Hello.cls from pkg2 is deployed to the org.

Expected Output:

Hello.cls from pkg1 is deployed because it is second in MPD order in sfdx-project.json. Tested on fdx-cli/7.125.0 darwin-x64 node-v12.22.7.
