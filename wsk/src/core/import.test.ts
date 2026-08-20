import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLabels, parseCorpus } from "./import.js";

// Fixture covering the shapes the real corpus actually contains, so the test
// does not depend on a file that exists on only one machine.
const CORPUS = [
  "# Stage 0",
  "",
  "## DE-001 — Provision the system database",
  "",
  "**Repo:** `aether`, `epsilon` · **Labels:** `infra`, `terraform`, `stage-0` · **Est:** 2",
  "",
  "**Problem.** Something is missing.",
  "",
  "**Depends on:** nothing. **Rollback:** drop it.",
  "",
  "---",
  "",
  "## DE-01F — An identifier that is not decimal",
  "",
  "**Repo:** `epsilon` · **Labels:** `bug`, `stage-1` · **Est:** 0.5",
  "",
  "**Depends on:** DE-001 (for the ordering).",
  "",
  "---",
  "",
  "## BUG-003 — A defect with a severity marker 🔴",
  "",
  "**Repo:** `kronos` · **Labels:** `correctness` · **Est:** unknown — spike first",
  "",
  "**Depends on:** nothing.",
  "",
  "---",
  "",
  "# Stage 6",
  "",
  "| Ticket | Summary | Est |",
  "|---|---|---|",
  "| **DE-060** | Retire the legacy path; see the migration note | 3 |",
].join("\n");

test("every ticket shape in the corpus is recovered", () => {
  const { tickets, danglingDependencies } = parseCorpus(CORPUS);
  assert.equal(tickets.length, 4);
  assert.deepEqual(danglingDependencies, []);
  assert.deepEqual(tickets.map((t) => t.id), ["DE-001", "DE-01F", "BUG-003", "DE-060"]);
});

test("a hexadecimal identifier is not mistaken for a decimal one", () => {
  const t = parseCorpus(CORPUS).tickets.find((x) => x.id === "DE-01F");
  assert.ok(t, "DE-01F was not parsed");
  assert.deepEqual(t.dependsOn, ["DE-001"]);
});

test("a severity marker is stripped from the title", () => {
  const t = parseCorpus(CORPUS).tickets.find((x) => x.id === "BUG-003");
  assert.equal(t?.title, "A defect with a severity marker");
});

test("a non-numeric estimate is absent rather than wrong", () => {
  const t = parseCorpus(CORPUS).tickets.find((x) => x.id === "BUG-003");
  assert.equal(t?.estimate, undefined);
  const n = parseCorpus(CORPUS).tickets.find((x) => x.id === "DE-01F");
  assert.equal(n?.estimate, 0.5);
});

test("multiple repositories are kept for the record", () => {
  const t = parseCorpus(CORPUS).tickets.find((x) => x.id === "DE-001");
  assert.deepEqual(t?.repos, ["aether", "epsilon"]);
});

test("a summary table still yields work items", () => {
  const t = parseCorpus(CORPUS).tickets.find((x) => x.id === "DE-060");
  assert.ok(t);
  assert.equal(t.estimate, 3);
  assert.equal(t.repos.length, 0);
});

test("an unresolved dependency is reported, never dropped", () => {
  const broken = CORPUS.replace("**Depends on:** DE-001 (for the ordering).", "**Depends on:** DE-999.");
  const { danglingDependencies } = parseCorpus(broken);
  assert.deepEqual(danglingDependencies, [{ from: "DE-01F", to: "DE-999" }]);
});

test("labels are mapped to the scheme without discarding the originals", () => {
  assert.deepEqual(mapLabels(["infra", "stage-0"]), ["infra", "stage:0", "type:feature"]);
  assert.ok(mapLabels(["bug"]).includes("type:bug"));
  assert.ok(!mapLabels(["bug"]).includes("type:feature"));
  assert.ok(mapLabels(["wontfix"]).includes("superseded"));
});
