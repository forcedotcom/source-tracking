# V8 Shared Event-Loop Responsiveness

## Status

Accepted

## Context

`@salesforce/source-tracking` is consumed directly by the VS Code extension
host. It shares that Node.js event loop with extension-host callbacks; a
source-tracking operation therefore must avoid unrelated synchronous project
crawls where possible.

Released v8 calls `correctSourceMemberNames()` for every remote change request.
Before correcting any change, that helper crawls all package directories through
`ComponentSet.fromSource()`. The crawl is only used to correct SourceMember
names for `NavigationMenu` and `Audience`, as defined by
`TYPES_WITH_SOURCEMEMBER_NAME_MISMATCH`.

For all other metadata types, the existing mapping returns each change
unchanged after the crawl. A same-process heartbeat experiment uses a generated
decomposed custom-object project, not flat Apex: 100 objects with 50 fields
each (5,100 metadata files). It measures that difference:

| Remote change    | Wall time | Longest heartbeat gap | Event-loop max delay |
| ---------------- | --------: | --------------------: | -------------------: |
| `CustomField`    |   0.12 ms |               1.32 ms |              1.32 ms |
| `NavigationMenu` |  10.91 ms |              12.11 ms |             11.00 ms |

The SourceMember name-correction crawl has incidental behavior: it can surface
local source-resolution errors and warm SDR resolver, ignore, and registry
caches. Those effects are not inputs to the returned remote changes.

A direct same-fixture before/after run establishes the interruption removed by
this decision. Temporarily removing the fast path caused an ordinary
`CustomField` remote change to crawl the 5,100-file workspace and produced a
12.72 ms wall time, 13.94 ms longest heartbeat gap, and 13.94 ms maximum
event-loop delay. Restoring the fast path produced 0.10 ms wall time, 1.27 ms
longest heartbeat gap, and 1.27 ms maximum delay.

This proves an avoidable shared-event-loop interruption in this helper. It does
not by itself prove a general claim that all v8 STL operations materially hog
the extension-host event loop; that requires the broader workload matrix.

## Decision

When a remote change set contains no `NavigationMenu` or `Audience` entries,
`correctSourceMemberNames()` returns equivalent changes without crawling local
source.

This intentionally removes incidental local-source validation from remote
status-only requests that cannot require name correction. It does not remove
the explicit source resolution required by path-bearing remote output formats;
those paths continue to resolve source later through `populateFilePaths()` or
their existing component-set conversion.

The fast path returns a fresh array containing the original change objects,
matching the previous helper's successful result shape. Array identity is not a
public API contract, but retaining that shape avoids an unnecessary observable
behavior change.

## Consequences

- Empty or ordinary remote deltas no longer synchronously crawl unrelated local
  package source merely to produce `ChangeResult` output.
- A malformed or missing local package directory no longer causes a
  status-only remote request without mismatch-capable types to fail at this
  helper. Callers requiring file paths retain their explicit resolution and
  errors.
- `NavigationMenu` and `Audience` retain the existing local-name lookup,
  ambiguity behavior, and corrections.
- This decision does not assert that the two-type allowlist is globally
  exhaustive. Other documented name transformations remain owned by their
  existing dedicated paths.

## Validation

- Unit test: a non-allowlisted remote change with a nonexistent package path
  returns equivalent changes without invoking source resolution.
- Existing unit coverage retains unique and ambiguous `NavigationMenu` behavior,
  matching-name pass-through, and `Audience` correction.
- `test/perf/sharedEventLoop.ts` uses a same-thread timer heartbeat plus
  `monitorEventLoopDelay()`; its unit test verifies that a deliberate 100 ms
  synchronous block is detected.
- `yarn experiment:remote-name-crawl` creates a local fixture and reports the
  direct shared-event-loop measurements above.
