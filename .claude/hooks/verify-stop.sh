#!/usr/bin/env bash
# Stop hook: run compile, lint, unit test when edits were made this session.
# On first failure, block with reason for agent to fix. Wireit cache hits = success.
# stderr → Hooks output channel
set -e

INPUT=$(cat)
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then
  echo "[verify-stop] stop_hook_active=true, allowing stop" >&2
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-.}"
cd "$ROOT"
echo "[verify-stop] starting" >&2

fail() {
  local step="$1"
  local out="$2"
  local err
  err=$(printf '%s' "$out" | head -c 500 | tr -d '\000-\037\177' | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  echo "[verify-stop] failed: $step" >&2
  echo "{\"decision\": \"block\", \"reason\": \"Verification failed: $step — $err. Fix the errors and try again.\"}"
  exit 0
}

run_step() {
  local step="$1"
  local cmd="$2"
  local out
  out=$(eval "$cmd" 2>&1) || fail "$step" "$out"
}

SESSION_MARKER="$ROOT/.claude/.edit-marker"

if [ ! -f "$SESSION_MARKER" ]; then
  echo "[verify-stop] no edits in this session, skipping verification" >&2
  exit 0
fi

echo "[verify-stop] edits detected in session, running verification" >&2
rm -f "$SESSION_MARKER"

run_step "compile" "yarn compile" && echo "[verify-stop] compile ok" >&2
run_step "lint" "yarn lint" && echo "[verify-stop] lint ok" >&2
run_step "test" "yarn test:only" && echo "[verify-stop] test ok" >&2
run_step "knip" "npx knip --include exports,types,nsExports,nsTypes --no-config-hints" && echo "[verify-stop] knip ok" >&2
echo "[verify-stop] all passed" >&2
