# Test for .gitignore file causing metadata to be ignore when using force:source:push:beta

To run:

    sfdx force:source:beta:push -f

Actual Output:

    No results found

Expected Output:

Ignored.cls should be deployed, if you remove classes/.gitignore it will be. Tested on sfdx-cli/7.131.0 darwin-x64 node-v12.22.7.
