---
name: wireit
description: Author and use Wireit scripts for npm. Use when working with Wireit configuration, npm scripts, build pipelines, or when the user mentions Wireit.
---

# Wireit

## Documentation

Full documentation: https://github.com/google/wireit

## Authoring Wireit Scripts

- Wireit is very static, list dependencies explicitly (it won't infer them).
- if something needs to go (ex: compile) before another thing goes (ex: bundle) that's a dependency
- envs: see https://github.com/google/wireit?tab=readme-ov-file#environment-variables
  - declare an external env var so its value participates in the cache key:
    ```jsonc
    "env": { "SF_FOO": { "external": true, "default": "" } }
    ```
    different values of `SF_FOO` produce separate cache entries.
- caching: if you specify `files` and `output` (even `[]`) you'll get caching (skips when neither have changed)
- you can have a wireit script without it being an npm script (it can run as a dep of another wireit script that can start from `npm run`)
- don't make circular references

## Using Wireit Scripts

- run commands with `WIREIT_CACHE=none` to bypass the cache for one invocation
- agents should not run these (they won't exit):
  - any script with `--watch`
  - any script with `service: true`
- wireit can't follow stuff outside `files`
  - manually changing code in `node_modules` then running compile or bundle
  - npm-link'd packages (symlinks to libraries locally modified)

## Extra Arguments (passing CLI flags through wireit)

ref: https://github.com/google/wireit?tab=readme-ov-file#extra-arguments

- `npm run {script} -- {script args}` — single `--` forwards args to the underlying command
- ex: `npm run build -- --verbose` passes `--verbose` to the command in `wireit.build.command`

## Errors

If you see "Unknown error thrown: Error: Did not expect..." or "Internal error!" from wireit — another process was running the same scripts. Re-run the command yourself to confirm it passes. DO NOT clear `.wireit` to solve this.
