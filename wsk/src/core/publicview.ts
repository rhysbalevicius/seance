import type { Profile } from "./config.js";
import { metaString, repoLabels } from "./ledger.js";
import {
  HOLD_LABEL,
  META,
  type KataIssue,
  type PublicView,
  type PublicViewResult,
} from "./schema.js";

/**
 * The single constructor for a PublicView, and therefore the single gate on
 * publication. Everything it refuses is a refusal with a reason, never a
 * partially-populated view.
 *
 * Note what it does NOT read: `issue.body`. The curated text is the only text
 * that can reach GitHub, and that is a property of this function plus the
 * shape of PublicView, not of anyone's discipline downstream.
 */
export function toPublicView(profile: Profile, issue: KataIssue): PublicViewResult {
  if (issue.labels.includes(HOLD_LABEL)) {
    return { ok: false, refusal: { kind: "on-hold" } };
  }

  const publicBody = (metaString(issue, META.pubBody) ?? "").trim();
  if (publicBody === "") {
    return { ok: false, refusal: { kind: "no-public-body" } };
  }

  const repos = repoLabels(issue);
  if (repos.length === 0) return { ok: false, refusal: { kind: "no-repo-label" } };
  if (repos.length > 1) return { ok: false, refusal: { kind: "many-repo-labels", labels: repos } };

  const dir = repos[0] as string;
  const known = profile.repos.find((r) => r.dir === dir);
  if (!known) return { ok: false, refusal: { kind: "unknown-repo", repo: dir } };

  // Once published, the recorded target wins: relabelling must never silently
  // re-route an issue that already exists upstream.
  const recorded = metaString(issue, META.pubRepo);
  if (recorded && recorded !== known.slug) {
    return { ok: false, refusal: { kind: "repo-changed", recorded, now: known.slug } };
  }

  const curatedTitle = (metaString(issue, META.pubTitle) ?? "").trim();
  if (curatedTitle === "" && profile.requirePublicTitle) {
    return { ok: false, refusal: { kind: "title-required" } };
  }

  const rawLabels = (metaString(issue, META.pubLabels) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  return {
    ok: true,
    view: {
      srcId: metaString(issue, META.srcId) ?? issue.short_id,
      ref: issue.short_id,
      publicTitle: curatedTitle === "" ? issue.title : curatedTitle,
      titleInherited: curatedTitle === "",
      publicBody,
      publicLabels: rawLabels,
      targetRepo: known.slug,
    },
  };
}

/**
 * The marker appended to every published body. It renders as nothing, and it
 * makes a create idempotent across a crash: before creating we search for it,
 * and adopt an orphan left by a run that died before recording the number.
 */
export function footerFor(view: PublicView): string {
  return `\n\n<!-- seance:${view.srcId} -->`;
}

export function markerFor(srcId: string): string {
  return `<!-- seance:${srcId} -->`;
}
