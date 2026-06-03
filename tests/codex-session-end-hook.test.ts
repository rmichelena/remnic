import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sessionEndHook = "packages/plugin-codex/hooks/bin/session-end.sh";

test("Codex session-end hook falls back to private legacy engram cursor files", async () => {
  const content = await readFile(sessionEndHook, "utf8");

  assert.match(content, /LEGACY_CURSOR_FILE="\$\{STATE_DIR\}\/engram-cursor-\$\{SESSION_ID\}"/);
  assert.match(content, /CURSOR_FILE="\$\{STATE_DIR\}\/remnic-cursor-\$\{SESSION_ID\}"/);
  assert.match(content, /if \[ "\$SESSION_ID_SAFE" -eq 1 \] && \[ ! -f "\$CURSOR_FILE" \]/);
  assert.match(content, /CURSOR_FILE="\$LEGACY_CURSOR_FILE"/);
  assert.match(
    content,
    /for TMP_CURSOR_FILE in "\/tmp\/remnic-cursor-\$\{SESSION_ID\}" "\/tmp\/engram-cursor-\$\{SESSION_ID\}"; do/
  );
});

test("Codex session-end hook retries legacy engram tokens when remnic token parsing fails", async () => {
  const content = await readFile(sessionEndHook, "utf8");

  assert.match(
    content,
    /for TOKEN_FILE in "\$\{HOME\}\/\.remnic\/tokens\.json" "\$\{HOME\}\/\.engram\/tokens\.json"; do/
  );
  assert.match(content, /\[ ! -f "\$TOKEN_FILE" \] && continue/);
  assert.match(content, /JSON\.parse\(fs\.readFileSync\(tokenFile, 'utf8'\)\)/);
  assert.match(content, /\[ -n "\$REMNIC_TOKEN" \] && break/);
});
