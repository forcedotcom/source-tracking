# repoLocked

The local source-tracking shadow repo at %s is locked. Another process may be writing to it. Wait %s and try again, or remove the lockfile manually if you are sure no other process is active.

# indexCorrupt

The local source-tracking shadow repo at %s is in an inconsistent state (%s). Delete the .sf/orgs/<orgId>/localSourceTracking directory and re-run to reinitialize.

# objectNotFound

The local source-tracking shadow repo expected to find object %s but it is missing. The shadow repo may be partially deleted; remove .sf/orgs/<orgId>/localSourceTracking and re-run.

# objectCorrupt

The local source-tracking shadow repo could not decode object %s (%s). Remove .sf/orgs/<orgId>/localSourceTracking and re-run.

# repoNotConfigured

Source tracking made an internal call before the shadow repo was configured (%s). This is a programming error; please report it.

# workdirIo

Source tracking failed reading or writing %s: %s.

# invalidPath

Source tracking received an invalid path %s (%s). This is a programming error; please report it.

# refNotFound

The local source-tracking shadow repo could not resolve ref %s. The shadow may be partially deleted; remove .sf/orgs/<orgId>/localSourceTracking and re-run.
