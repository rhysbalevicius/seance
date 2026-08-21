import assert from "node:assert/strict";
import { test } from "node:test";
import type { Profile } from "./config.js";
import { buildPayload, payloadHash } from "./publish.js";
import { toPublicView } from "./publicview.js";
import { HOLD_LABEL, META, type KataIssue } from "./schema.js";

/** A distinctive string that exists only in private text. */
const PRIVATE_MARKER = "_runtime/observability/logging.py";

const profile: Profile = {
  name: "test",
  githubOwner: "Example",
  ledger: true,
  corpus: null,
  requirePublicTitle: true,
  ghCommand: "gh",
  ghConfigDir: null,
  root: "/tmp/test",
  kataHome: "/tmp/test/.kata-home",
  repos: [{ dir: "alpha", url: "gh-test:Example/alpha.git", path: "/tmp/test/alpha", slug: "Example/alpha" }],
};

function issue(over: Partial<KataIssue> = {}): KataIssue {
  return {
    uid: "01AAA",
    short_id: "aaa1",
    title: "Local title naming " + PRIVATE_MARKER,
    body: "Private detail referencing " + PRIVATE_MARKER,
    status: "open",
    labels: ["repo:alpha", "type:feature"],
    metadata: { [META.srcId]: "DE-002" },
    revision: 1,
    ...over,
  };
}

test("an issue with no curated body is refused", () => {
  const r = toPublicView(profile, issue());
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.refusal.kind, "no-public-body");
});

test("a hold label refuses even when a curated body exists", () => {
  const r = toPublicView(
    profile,
    issue({ labels: ["repo:alpha", HOLD_LABEL], metadata: { [META.pubBody]: "safe" } }),
  );
  assert.equal(r.ok === false && r.refusal.kind, "on-hold");
});

test("a whitespace-only curated body counts as empty", () => {
  const r = toPublicView(profile, issue({ metadata: { [META.pubBody]: "   \n  " } }));
  assert.equal(r.ok === false && r.refusal.kind, "no-public-body");
});

test("routing requires exactly one known repo label", () => {
  assert.equal(
    toPublicView(profile, issue({ labels: [], metadata: { [META.pubBody]: "safe" } })).ok === false,
    true,
  );
  const many = toPublicView(
    profile,
    issue({ labels: ["repo:alpha", "repo:beta"], metadata: { [META.pubBody]: "safe" } }),
  );
  assert.equal(many.ok === false && many.refusal.kind, "many-repo-labels");

  const unknown = toPublicView(
    profile,
    issue({ labels: ["repo:beta"], metadata: { [META.pubBody]: "safe" } }),
  );
  assert.equal(unknown.ok === false && unknown.refusal.kind, "unknown-repo");
});

test("a published issue is never silently re-routed by relabelling", () => {
  const r = toPublicView(
    profile,
    issue({
      labels: ["repo:alpha"],
      metadata: { [META.pubBody]: "safe", [META.pubRepo]: "Example/gamma" },
    }),
  );
  assert.equal(r.ok === false && r.refusal.kind, "repo-changed");
});

test("the payload never carries private text", () => {
  const r = toPublicView(
    profile,
    issue({
      metadata: {
        [META.srcId]: "DE-002",
        [META.pubTitle]: "A safe public title",
        [META.pubBody]: "A safe public summary.",
      },
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const payload = buildPayload(r.view);
  const serialised = JSON.stringify(payload);
  assert.equal(
    serialised.includes(PRIVATE_MARKER),
    false,
    "private text reached the payload",
  );
  assert.match(payload.body, /A safe public summary\./);
  assert.match(payload.body, /<!-- seance:DE-002 -->/);
});

test("an absent curated title is refused by default", () => {
  // The default is strict on purpose: inheriting the local title would send
  // text nobody curated, which is the one leak channel a curated body cannot
  // close on its own.
  const r = toPublicView(profile, issue({ metadata: { [META.pubBody]: "safe" } }));
  assert.equal(r.ok === false && r.refusal.kind, "title-required");
});

test("a profile may opt into inheriting the local title, and it is flagged", () => {
  const lax: Profile = { ...profile, requirePublicTitle: false };
  const r = toPublicView(lax, issue({ metadata: { [META.pubBody]: "safe" } }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.view.titleInherited, true);
  assert.equal(r.view.publicTitle.includes(PRIVATE_MARKER), true);
});

test("the hash is stable across rebuilds and moves with the content", () => {
  const mk = (body: string) => {
    const r = toPublicView(
      profile,
      issue({ metadata: { [META.srcId]: "DE-002", [META.pubTitle]: "t", [META.pubBody]: body } }),
    );
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    return payloadHash(buildPayload(r.view));
  };
  assert.equal(mk("one"), mk("one"));
  assert.notEqual(mk("one"), mk("two"));
});
