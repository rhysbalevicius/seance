import assert from "node:assert/strict";
import { test } from "node:test";
import { commitMessageFrom } from "./guard.js";

test("a single quoted message is read", () => {
  assert.equal(commitMessageFrom('git commit -m "feat(x): y"'), "feat(x): y");
});

test("repeated -m becomes subject and body", () => {
  assert.equal(commitMessageFrom(`git commit -m "feat(x): y" -m "body text"`), "feat(x): y\n\nbody text");
});

test("single quotes are read", () => {
  assert.equal(commitMessageFrom("git commit -m 'fix(a): b'"), "fix(a): b");
});

test("escaped quotes inside a message survive", () => {
  assert.equal(commitMessageFrom('git commit -m "feat(x): say \\"hi\\""'), 'feat(x): say "hi"');
});

test("a heredoc piped to -F is read", () => {
  const cmd = "git commit -q -F - <<'EOF'\nfeat(x): y\n\nbody\nEOF";
  assert.equal(commitMessageFrom(cmd), "feat(x): y\n\nbody");
});

test("a message this hook cannot see is reported as absent, not as empty", () => {
  // -F <file> and an interactive editor are invisible here. Returning undefined
  // lets the caller allow the commit rather than pretend it was checked.
  assert.equal(commitMessageFrom("git commit -F /tmp/msg.txt"), undefined);
  assert.equal(commitMessageFrom("git commit"), undefined);
});
