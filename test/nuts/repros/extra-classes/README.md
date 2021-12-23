# Test for non-packageDirectory metadata being deployed when using force:source:beta:push

To run:

    sfdx force:source:beta:push -f

Actual Output:

    *** Pushing with SOAP API v53.0 ***
    SOURCE PROGRESS | ████████████████████████████████████████ | 2/2 Components

Expected Output:

Only Base.cls should be deployed, Extra.cls is not in a named package directory. Tested on sfdx-cli/7.131.0 darwin-x64 node-v12.22.7.
