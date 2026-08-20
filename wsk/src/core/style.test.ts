import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommitMessage, checkPrBody, loadRules, scan } from "./style.js";

const rules = loadRules(new URL("../../../config/style/forbidden.json", import.meta.url).pathname);

test("the shipped rules all compile", () => {
  assert.ok(rules.length > 0, "no rules loaded");
  // Patterns may carry inline flags, which JavaScript cannot parse directly;
  // this fails loudly if the translation regresses.
  assert.doesNotThrow(() => scan("probe", "commit", rules));
  assert.doesNotThrow(() => scan("probe", "code", rules));
});

test("code may not carry internal references", () => {
  const found = scan('// see DE-013 and extra/durable-execution/04-ISSUES.md\n', "code", rules);
  const ids = found.map((f) => f.ruleId);
  assert.ok(ids.includes("ledger-id"), "ledger id not caught");
  assert.ok(ids.includes("working-docs-path"), "working docs path not caught");
});

test("a conventional subject with no internal references passes", () => {
  assert.deepEqual(checkCommitMessage("feat(auth): accept service tokens", rules), []);
});

test("a non-conventional subject is rejected", () => {
  const p = checkCommitMessage("added some stuff", rules);
  assert.ok(p.some((x) => x.kind === "not-conventional"));
});

test("a co-author trailer is rejected", () => {
  const p = checkCommitMessage("feat(x): y\n\nbody\n\nCo-Authored-By: Someone <a@b.c>", rules);
  assert.ok(p.some((x) => x.kind === "forbidden"), JSON.stringify(p));
});

test("an internal id in a commit message is rejected", () => {
  const p = checkCommitMessage("fix(api): correct paging\n\nCloses DE-013.", rules);
  assert.ok(p.some((x) => x.kind === "forbidden"));
});

test("a hard-wrapped body is reported", () => {
  const wrapped = [
    "feat(x): y",
    "",
    "This paragraph has been hard wrapped at roughly seventy two columns which",
    "is the convention this repository deliberately does not use for its own",
    "commit message bodies, so the check should notice and say so plainly now.",
  ].join("\n");
  const p = checkCommitMessage(wrapped, rules);
  assert.ok(p.some((x) => x.kind === "wrapped-body"), JSON.stringify(p));
});

test("a pull request body must reference its upstream issue", () => {
  const missing = checkPrBody("Adds paging to the list endpoint.", { issue: "Example/alpha#42" }, rules);
  assert.equal(missing.problems.length, 1);

  const present = checkPrBody(
    "Adds paging to the list endpoint.\n\nCloses Example/alpha#42",
    { issue: "Example/alpha#42" },
    rules,
  );
  assert.deepEqual(present.problems, []);
});

test("an upstream reference is allowed where an internal one is not", () => {
  // This is the asymmetry itself: the same body is fine upstream-referenced
  // and rejected when it names an internal id.
  const ok = checkPrBody("Closes Example/alpha#42", { issue: "Example/alpha#42" }, rules);
  assert.deepEqual(ok.problems, []);

  const bad = checkPrBody("Closes Example/alpha#42, implements DE-013", { issue: "Example/alpha#42" }, rules);
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0] as string, /DE-013/);
});
