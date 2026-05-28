#!/usr/bin/env bash
# PostToolUse hook: mark that an edit occurred in this session.
cat > /dev/null

ROOT=$(git rev-parse --show-toplevel)
MARKER="$ROOT/.claude/.edit-marker"
touch "$MARKER"
exit 0
