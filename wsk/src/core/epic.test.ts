import assert from "node:assert/strict";
import { test } from "node:test";
import type { Repo } from "./config.js";
import { EpicError, branchName, buildPrBody, orderChildren, render } from "./epic.js";
import type { EpicChild } from "./epic.js";

const repo: Repo = { dir: "alpha", url: "gh-x:Co/alpha.git", path: "/tmp/alpha", slug: "Co/alpha" };

test("children are ordered so nothing precedes what it depends on", () => {
  const order = orderChildren(
    ["c", "a", "b"],
    new Map([["c", ["b"]], ["b", ["a"]], ["a", []]]),
  );
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("dependencies outside the epic do not constrain the order within it", () => {
  // "x" is not a child, so depending on it must not stall the ordering.
  const order = orderChildren(["a", "b"], new Map([["a", ["x"]], ["b", ["a"]]]));
  assert.deepEqual(order, ["a", "b"]);
});

test("a cycle is refused rather than resolved arbitrarily", () => {
  assert.throws(
    () => orderChildren(["a", "b"], new Map([["a", ["b"]], ["b", ["a"]]])),
    (e: unknown) => e instanceof EpicError && /block each other/.test((e as Error).message),
  );
});

test("ordering is stable, so the same epic yields the same stack", () => {
  const deps = new Map([["a", []], ["b", []], ["c", []]]);
  assert.deepEqual(orderChildren(["a", "b", "c"], deps), orderChildren(["a", "b", "c"], deps));
});

test("a branch name is derived from curated text, never from an internal id", () => {
  const name = branchName({ publicTitle: "Add paging to the list endpoint", title: "DE-013 internal" }, "feat/");
  assert.equal(name, "feat/add-paging-to-the-list-endpoint");
  assert.equal(/DE-013/.test(name), false);
});

test("a branch name stays usable when the title is awkward", () => {
  assert.equal(branchName({ title: "Fix!! the *thing* (again)" }, "fix/"), "fix/fix-the-thing-again");
  assert.equal(branchName({ title: "!!!" }, "feat/"), "feat/change");
  assert.ok(branchName({ title: "x".repeat(200) }, "feat/").length <= 53);
});

test("a conditional block appears only when its value is present", () => {
  const t = "A\n{{#issue}}\nCloses {{issue}}\n{{/issue}}\n";
  assert.match(render(t, { issue: "Co/alpha#7" }), /Closes Co\/alpha#7/);
  assert.equal(/Closes/.test(render(t, { issue: undefined })), false);
});

function child(over: Partial<EpicChild> = {}): EpicChild {
  return {
    ref: "aaa1",
    srcId: "DE-013",
    title: "Internal title",
    body: "**Problem.** The endpoint returns everything at once.\n\n**Change.** Add paging.",
    publicBody: undefined,
    publicTitle: undefined,
    issueRef: undefined,
    needsPublishing: false,
    branch: "feat/add-paging",
    repo,
    order: 1,
    ...over,
  };
}

test("a published item's change request references its upstream issue", () => {
  const { body } = buildPrBody(
    child({ publicBody: "Adds paging.", publicTitle: "Add paging", issueRef: "Co/alpha#7" }),
    3,
  );
  assert.match(body, /Closes Co\/alpha#7/);
});

test("an unpublished item's change request carries no issue reference at all", () => {
  const { body } = buildPrBody(child({ publicBody: "Adds paging." }), 3);
  assert.equal(/Closes/.test(body), false);
  // And certainly not an internal one.
  assert.equal(/DE-013/.test(body), false);
});

test("local text carrying an internal reference is refused, not edited", () => {
  // Deleting the reference would leave "Per and the endpoint is unpaged",
  // which is worse upstream than an honest refusal.
  assert.throws(
    () => buildPrBody(child({ body: "**Problem.** Per DE-013 the endpoint is unpaged." }), 2),
    (e: unknown) => e instanceof EpicError && /must not appear upstream/.test((e as Error).message),
  );
});

test("clean local text is used as written", () => {
  const { body } = buildPrBody(child({ body: "**Problem.** The endpoint is unpaged." }), 2);
  assert.match(body, /The endpoint is unpaged\./);
});

test("an item with nothing to say is refused rather than given an empty body", () => {
  assert.throws(
    () => buildPrBody(child({ body: "" }), 1),
    (e: unknown) => e instanceof EpicError && /nothing to say/.test((e as Error).message),
  );
});

test("a body that cannot be cleaned is refused rather than sent", () => {
  // A curated body is trusted as written, so if it carries an internal
  // reference the only safe answer is to refuse.
  assert.throws(
    () => buildPrBody(child({ publicBody: "Implements DE-013." }), 1),
    (e: unknown) => e instanceof EpicError && /refusing to submit/.test((e as Error).message),
  );
});
