#!/usr/bin/env bash
# Remnic session cleanup for Claude Code.
# Removes private cursor and lock files for the session.
#
# NOTE: Claude Code does not support a Stop/SessionEnd hook event.
# This script is provided for manual cleanup or future hook support.
# Private state files live under ${XDG_STATE_HOME:-$HOME/.local/state}/remnic/hooks.

INPUT="$(cat)"
SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"

echo '{"continue":true}'

case "$SESSION_ID" in
  ""|*[!A-Za-z0-9._-]*)
    exit 0
    ;;
esac

STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"
STATE_DIR="${STATE_HOME}/remnic/hooks"
CURSOR_FILE="${STATE_DIR}/remnic-cursor-${SESSION_ID}"
LOCK_DIR="${STATE_DIR}/remnic-lock-${SESSION_ID}.d"
LEGACY_CURSOR_FILE="${STATE_DIR}/engram-cursor-${SESSION_ID}"
LEGACY_LOCK_DIR="${STATE_DIR}/engram-lock-${SESSION_ID}.d"

if [ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ]; then
  if [ -e "$CURSOR_FILE" ] && [ ! -L "$CURSOR_FILE" ]; then
    rm -f "$CURSOR_FILE" 2>/dev/null
  fi
  rmdir "$LOCK_DIR" 2>/dev/null
  if [ -e "$LEGACY_CURSOR_FILE" ] && [ ! -L "$LEGACY_CURSOR_FILE" ]; then
    rm -f "$LEGACY_CURSOR_FILE" 2>/dev/null
  fi
  rmdir "$LEGACY_LOCK_DIR" 2>/dev/null
fi

exit 0
