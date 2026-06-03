#!/usr/bin/env bash
# Remnic PostToolUse hook for Claude Code.
# Observes file edits (Write/Edit/MultiEdit) by sending transcript
# delta to the observe endpoint. Runs in background, never blocks.

set -euo pipefail

ensure_migrated() {
  if [ -f "${HOME}/.remnic/.migrated-from-engram" ]; then
    return 0
  fi
  if [ ! -d "${HOME}/.engram" ] && [ ! -f "${HOME}/.config/engram/config.json" ]; then
    return 0
  fi
  if command -v remnic >/dev/null 2>&1; then
    remnic migrate >/dev/null 2>&1 || true
  elif command -v engram >/dev/null 2>&1; then
    engram migrate >/dev/null 2>&1 || true
  fi
}

ensure_migrated

REMNIC_HOST="${REMNIC_HOST:-${ENGRAM_HOST:-127.0.0.1}}"
REMNIC_PORT="${REMNIC_PORT:-${ENGRAM_PORT:-4318}}"
REMNIC_URL="http://${REMNIC_HOST}:${REMNIC_PORT}/engram/v1/observe"

LOG="${HOME}/.remnic/logs/remnic-post-tool-observe.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [post-tool] $*" >> "$LOG"; }

# Read token
REMNIC_TOKEN=""
for TOKEN_FILE in "${HOME}/.remnic/tokens.json" "${HOME}/.engram/tokens.json"; do
  [ ! -f "$TOKEN_FILE" ] && continue
  REMNIC_TOKEN="$(node -e "
    const fs = require('fs');
    const tokenFile = process.argv[1];
    const store = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const tokens = store.tokens || [];
    const cc = tokens.find(t => t.connector === 'claude-code');
    const oc = tokens.find(t => t.connector === 'openclaw');
    let tok = (cc && cc.token) || (oc && oc.token) || '';
    if (!tok) { tok = store['claude-code'] || store['openclaw'] || ''; }
    process.stdout.write(tok);
  " "$TOKEN_FILE" 2>/dev/null || echo "")"
  [ -n "$REMNIC_TOKEN" ] && break
done
[ -z "$REMNIC_TOKEN" ] && REMNIC_TOKEN="${OPENCLAW_REMNIC_ACCESS_TOKEN:-${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}}"

INPUT="$(cat)"

# Return immediately — never block the tool
echo '{"continue":true}'

[ -z "$REMNIC_TOKEN" ] && exit 0

SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
TRANSCRIPT_PATH="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.transcript_path||'')" "$INPUT" 2>/dev/null || echo "")"
CWD="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.cwd||'')" "$INPUT" 2>/dev/null || echo "")"
TOOL_NAME="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.tool_name||'')" "$INPUT" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

case "$SESSION_ID" in
  ""|*[!A-Za-z0-9._-]*)
    log "invalid session id: $SESSION_ID"
    exit 0
    ;;
esac
{ [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; } && exit 0

STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"
STATE_DIR="${STATE_HOME}/remnic/hooks"

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
if ! node - "$STATE_DIR" <<'NODE'
const fs = require('fs');
const stateDir = process.argv[2];
try {
  const info = fs.lstatSync(stateDir);
  if (info.isSymbolicLink() || !info.isDirectory()) process.exit(1);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) process.exit(1);
  if ((info.mode & 0o077) !== 0) fs.chmodSync(stateDir, 0o700);
} catch {
  process.exit(1);
}
NODE
then
  log "unsafe state directory $STATE_DIR"
  exit 0
fi

CURSOR_FILE="${STATE_DIR}/remnic-cursor-${SESSION_ID}"
LOCK_DIR="${STATE_DIR}/remnic-lock-${SESSION_ID}.d"
LEGACY_CURSOR_FILE="${STATE_DIR}/engram-cursor-${SESSION_ID}"
LEGACY_LOCK_DIR="${STATE_DIR}/engram-lock-${SESSION_ID}.d"

if [ ! -f "$CURSOR_FILE" ] && { [ -f "$LEGACY_CURSOR_FILE" ] || [ -d "$LEGACY_LOCK_DIR" ]; }; then
  CURSOR_FILE="$LEGACY_CURSOR_FILE"
  LOCK_DIR="$LEGACY_LOCK_DIR"
fi

validate_cursor_file() {
  node - "$CURSOR_FILE" <<'NODE'
const fs = require('fs');
const cursorFile = process.argv[2];
try {
  const info = fs.lstatSync(cursorFile);
  if (info.isSymbolicLink() || !info.isFile()) process.exit(1);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) process.exit(1);
} catch (error) {
  if (error && error.code === 'ENOENT') process.exit(0);
  process.exit(1);
}
NODE
}

read_cursor_file() {
  validate_cursor_file || {
    log "unsafe cursor file $CURSOR_FILE"
    return 1
  }
  [ -f "$CURSOR_FILE" ] && cat "$CURSOR_FILE" 2>/dev/null || echo 0
}

write_cursor_file() {
  NEW_CURSOR_VALUE="$1"
  validate_cursor_file || {
    log "refusing unsafe cursor file $CURSOR_FILE"
    return 1
  }
  TEMP_CURSOR="$(mktemp "${CURSOR_FILE}.tmp.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '%s\n' "$NEW_CURSOR_VALUE" > "$TEMP_CURSOR"; then
    rm -f "$TEMP_CURSOR"
    return 1
  fi
  chmod 600 "$TEMP_CURSOR" 2>/dev/null || true
  mv -f "$TEMP_CURSOR" "$CURSOR_FILE"
}

migrate_tmp_cursor_file() {
  for TMP_CURSOR_FILE in "/tmp/remnic-cursor-${SESSION_ID}" "/tmp/engram-cursor-${SESSION_ID}"; do
    [ ! -e "$TMP_CURSOR_FILE" ] && continue
    TMP_CURSOR_VALUE="$(node - "$TMP_CURSOR_FILE" <<'NODE'
const fs = require('fs');
const cursorFile = process.argv[2];
try {
  const info = fs.lstatSync(cursorFile);
  if (info.isSymbolicLink() || !info.isFile()) process.exit(1);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) process.exit(1);
  const value = fs.readFileSync(cursorFile, 'utf8').trim();
  if (!/^\d+$/.test(value)) process.exit(1);
  process.stdout.write(value);
} catch {
  process.exit(1);
}
NODE
    )" || continue
    CURRENT_CURSOR_VALUE=""
    if validate_cursor_file; then
      CURRENT_CURSOR_VALUE="$([ -f "$CURSOR_FILE" ] && cat "$CURSOR_FILE" 2>/dev/null || echo "")"
    fi
    case "$CURRENT_CURSOR_VALUE" in
      ""|*[!0-9]*) CURRENT_CURSOR_VALUE="-1" ;;
    esac
    if [ "$TMP_CURSOR_VALUE" -gt "$CURRENT_CURSOR_VALUE" ]; then
      write_cursor_file "$TMP_CURSOR_VALUE" || continue
    fi
    rm -f "$TMP_CURSOR_FILE" 2>/dev/null
  done
}

remove_stale_lock_dir() {
  node - "$LOCK_DIR" <<'NODE'
const fs = require('fs');
const lockDir = process.argv[2];
try {
  const info = fs.lstatSync(lockDir);
  if (info.isSymbolicLink() || !info.isDirectory()) process.exit(1);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) process.exit(1);
  if (Date.now() - info.mtimeMs < 10 * 60 * 1000) process.exit(0);
  fs.rmSync(lockDir, { recursive: true, force: true });
} catch (error) {
  if (error && error.code === 'ENOENT') process.exit(0);
  process.exit(1);
}
NODE
}

(
  # Acquire exclusive lock
  ACQUIRED=0
  for _i in $(seq 1 50); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then ACQUIRED=1; break; fi
    [ "$_i" -eq 1 ] && remove_stale_lock_dir >/dev/null 2>&1
    sleep 0.1
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT INT TERM
  [ "$ACQUIRED" -eq 0 ] && exit 0

  migrate_tmp_cursor_file

  LAST_COUNT=0
  LAST_COUNT="$(read_cursor_file)" || exit 0

  PAYLOAD="$(node -e "
    const fs = require('fs');
    const path = process.argv[1];
    const sessionId = process.argv[2];
    const lastCount = parseInt(process.argv[3], 10) || 0;

    const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;
        let text = '';
        if (typeof msg.content === 'string') text = msg.content.trim();
        else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text.trim())
            .join('\n').trim();
        }
        if (text) messages.push({ role, content: text });
      } catch {}
    }

    const newMessages = messages.slice(lastCount);
    if (!newMessages.length) {
      process.stdout.write('CURSOR:' + messages.length);
    } else {
      process.stdout.write(JSON.stringify({
        sessionKey: sessionId,
        messages: newMessages,
        __total__: messages.length
      }));
    }
  " "$TRANSCRIPT_PATH" "$SESSION_ID" "$LAST_COUNT" 2>/dev/null)"

  [ -z "$PAYLOAD" ] && { log "parse failed for $SESSION_ID"; exit 0; }

  if echo "$PAYLOAD" | grep -q "^CURSOR:"; then
    write_cursor_file "${PAYLOAD#CURSOR:}" || log "cursor write failed for $SESSION_ID"
    exit 0
  fi

  TOTAL="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(String(d.__total__||0))" "$PAYLOAD" 2>/dev/null || echo 0)"
  MSG_COUNT="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(String((d.messages||[]).length))" "$PAYLOAD" 2>/dev/null || echo "?")"
  CLEAN="$(node -e "const d=JSON.parse(process.argv[1]); delete d.__total__; process.stdout.write(JSON.stringify(d))" "$PAYLOAD" 2>/dev/null)"

  [ -z "$CLEAN" ] && exit 0

  log "observing $MSG_COUNT new messages (cursor $LAST_COUNT->$TOTAL) project=$PROJECT_NAME tool=$TOOL_NAME"

  RAW="$(curl -s -w "\n%{http_code}" --max-time 120 \
    -X POST "$REMNIC_URL" \
    -H "Authorization: Bearer ${REMNIC_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "X-Engram-Client-Id: claude-code" \
    -d "$CLEAN" 2>/dev/null)"
  CURL_EXIT=$?
  HTTP_STATUS="$(echo "$RAW" | tail -1)"

  if [ $CURL_EXIT -eq 0 ] && [[ "$HTTP_STATUS" =~ ^2 ]]; then
    log "observe OK for $SESSION_ID"
    write_cursor_file "$TOTAL" || log "cursor write failed for $SESSION_ID"
  else
    log "observe failed (curl=$CURL_EXIT http=$HTTP_STATUS) — cursor not advanced"
  fi
) >> "$LOG" 2>&1 &

disown $!
exit 0
