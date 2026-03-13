# Repro: Metadata files with ampersand in source tracking (#3504)

Reproduces [forcedotcom/cli#3504](https://github.com/forcedotcom/cli/issues/3504): Layouts (and other metadata) with `&` in the name don't get properly updated in source tracking.

## Setup

1. Authorize a sandbox org from this folder:
   ```bash
   cd test/nuts/repros/ampersand-layout
   sf org login web --alias ampersand-repro
   ```

2. Deploy the layout:
   ```bash
   sf project deploy start --source-dir force-app
   ```

3. Run retrieve — the layout will keep appearing as "needs retrieve" even when unchanged:
   ```bash
   sf project retrieve start
   ```

## Expected vs Actual

- **Expected**: Layout only retrieved when metadata changed
- **Actual**: Layout is always retrieved; `lastRetrievedFromServer` never updates due to `&` vs `%26` key mismatch in source tracking

## Root cause

- Local filesystem: `Account-Legal %26 Compliance Layout.layout-meta.xml` (URL-encoded)
- maxRevision.json: `Layout__Account-Legal & Compliance Layout` (literal ampersand)
- Remote API: `Layout###Account-Legal %26 Compliance Layout`
- Keys don't match → no revision sync
