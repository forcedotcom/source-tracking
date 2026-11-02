# 1. Public API surface = `src/index.ts` re-exports only

Date: 2026-04-30

## Status

Accepted

## Context

`@salesforce/source-tracking` is published as a library. Many internal helpers
live under `src/shared/` and are imported by other internals. Without an explicit
boundary, every named export from any `src/` file risks becoming a de-facto
public API — and refactoring (renaming, removing, changing signatures) becomes
a semver-major change.

## Decision

The public API surface is exactly what `src/index.ts` re-exports. Everything
else is internal and freely mutable across patch and minor releases. Internal
modules may change shape, names, return types, async-ness, or be removed
entirely without warning.

## Consequences

- Refactors of internal helpers (e.g. `populateTypesAndNames`,
  `getDedupedConflictsFromChanges`, the contents of `src/shared/`) do not
  require semver bumps.
- Consumers reaching into deep paths (`@salesforce/source-tracking/lib/shared/...`)
  do so at their own risk.
- Performance work (the impetus for this ADR) can change function signatures,
  return types, and parameter shapes inside `src/shared/` freely.
