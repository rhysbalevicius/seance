import { createHash } from "node:crypto";
import type { Profile } from "./config.js";
import * as gh from "./gh.js";
import type { GhContext } from "./gh.js";
import { addComment, metaNumber, metaString, setMeta } from "./ledger.js";
import { footerFor, markerFor, toPublicView } from "./publicview.js";
import {
  GhIssuePayload,
  META,
  describeRefusal,
  type KataIssue,
  type PublicView,
  type PublicViewRefusal,
} from "./schema.js";

/**
 * The only module that turns a local issue into a GitHub issue.
 *
 * It never reads `issue.body`. Its input is a PublicView, which has no field
 * for private text, so the redaction guarantee is carried by the type system
 * rather than by review.
 */

export function ghContextFor(profile: Profile): GhContext {
  return { command: profile.ghCommand, configDir: profile.ghConfigDir };
}

export function buildPayload(view: PublicView): GhIssuePayload {
  const payload: GhIssuePayload = {
    title: view.publicTitle,
    body: view.publicBody + footerFor(view),
    ...(view.publicLabels.length > 0 ? { labels: [...view.publicLabels] } : {}),
  };
  return GhIssuePayload.parse(payload);
}

export function payloadHash(payload: GhIssuePayload): string {
  // Fixed key order: the payload has exactly three possible fields, so a
  // hand-ordered digest is stable without a general canonicaliser.
  const canonical = JSON.stringify([payload.title, payload.body, payload.labels ?? []]);
  return createHash("sha256").update(canonical).digest("hex");
}

export type PublishOutcome =
  | { kind: "skipped"; refusal: PublicViewRefusal; reason: string }
  | { kind: "unchanged"; repo: string; number: number }
  | { kind: "would-create"; repo: string; payload: GhIssuePayload }
  | { kind: "would-update"; repo: string; number: number; payload: GhIssuePayload }
  | { kind: "created"; repo: string; number: number; url: string }
  | { kind: "adopted"; repo: string; number: number; url: string }
  | { kind: "updated"; repo: string; number: number };

export interface PublishOptions {
  readonly dryRun: boolean;
}

export async function publishIssue(
  profile: Profile,
  issue: KataIssue,
  opts: PublishOptions,
): Promise<PublishOutcome> {
  const result = toPublicView(profile, issue);
  if (!result.ok) {
    return { kind: "skipped", refusal: result.refusal, reason: describeRefusal(result.refusal) };
  }
  const view = result.view;
  const payload = buildPayload(view);
  const hash = payloadHash(payload);

  const existing = metaNumber(issue, META.pubNumber);
  const recordedHash = metaString(issue, META.pubHash);

  if (existing !== undefined && recordedHash === hash) {
    // Nothing to say upstream. This is what makes --all cheap and re-runnable.
    return { kind: "unchanged", repo: view.targetRepo, number: existing };
  }

  if (existing !== undefined) {
    if (opts.dryRun) {
      return { kind: "would-update", repo: view.targetRepo, number: existing, payload };
    }
    await gh.updateIssue(view.targetRepo, existing, payload, ghContextFor(profile));
    await recordPublication(profile, issue.short_id, view, existing, undefined, hash);
    return { kind: "updated", repo: view.targetRepo, number: existing };
  }

  if (opts.dryRun) {
    return { kind: "would-create", repo: view.targetRepo, payload };
  }

  // Adopt an orphan before creating, so a crash between the POST and the
  // metadata write cannot produce a duplicate on the next run.
  const orphan = await gh.findByMarker(view.targetRepo, markerFor(view.srcId), ghContextFor(profile));
  if (orphan !== undefined) {
    const updated = await gh.updateIssue(view.targetRepo, orphan, payload, ghContextFor(profile));
    await recordPublication(profile, issue.short_id, view, orphan, updated.html_url, hash);
    return { kind: "adopted", repo: view.targetRepo, number: orphan, url: updated.html_url };
  }

  const created = await gh.createIssue(view.targetRepo, payload, ghContextFor(profile));
  await recordPublication(profile, issue.short_id, view, created.number, created.html_url, hash);
  return { kind: "created", repo: view.targetRepo, number: created.number, url: created.html_url };
}

/**
 * Write-back order matters: the hash goes last. A crash part way through leaves
 * the hash stale, so the next run re-sends identical content — harmless and
 * convergent. The reverse order would leave an issue looking published while
 * its number was never recorded.
 */
async function recordPublication(
  profile: Profile,
  ref: string,
  view: PublicView,
  number: number,
  url: string | undefined,
  hash: string,
): Promise<void> {
  await setMeta(profile, ref, META.pubNumber, number);
  if (url !== undefined) await setMeta(profile, ref, META.pubUrl, url);
  await setMeta(profile, ref, META.pubRepo, view.targetRepo);
  await setMeta(profile, ref, META.pubAt, new Date().toISOString());
  await setMeta(profile, ref, META.pubHash, hash);
  await addComment(profile, ref, `published to ${view.targetRepo}#${number} (payload ${hash.slice(0, 12)})`);
}

export type PullOutcome =
  | { kind: "not-published" }
  | { kind: "up-to-date"; number: number }
  | { kind: "synced"; number: number; comments: number; state: string; diverged: boolean };

/**
 * Read-back. Writes only `gh.*` metadata and appended comments; it never edits
 * the title, body, labels, links or status. An upstream close is surfaced as a
 * divergence for a human to act on, not applied.
 */
export async function pullIssue(profile: Profile, issue: KataIssue): Promise<PullOutcome> {
  const repo = metaString(issue, META.pubRepo);
  const number = metaNumber(issue, META.pubNumber);
  if (!repo || number === undefined) return { kind: "not-published" };

  const upstream = await gh.getIssue(repo, number, ghContextFor(profile));
  if (metaString(issue, META.ghUpdatedAt) === upstream.updated_at) {
    return { kind: "up-to-date", number };
  }

  const cursor = metaNumber(issue, META.ghCommentCursor) ?? 0;
  const comments = (await gh.listComments(repo, number, ghContextFor(profile))).filter((c) => c.id > cursor);

  for (const c of comments) {
    const who = c.user?.login ?? "unknown";
    const quoted = (c.body ?? "").split("\n").map((l) => `> ${l}`).join("\n");
    await addComment(
      profile,
      issue.short_id,
      `[github] ${repo}#${number} comment ${c.id} by @${who} at ${c.created_at}\n${quoted}`,
    );
    // Advance after each comment, so the mirror is exactly-once across a crash.
    await setMeta(profile, issue.short_id, META.ghCommentCursor, c.id);
  }

  await setMeta(profile, issue.short_id, META.ghState, upstream.state);
  await setMeta(profile, issue.short_id, META.ghStateAt, new Date().toISOString());
  await setMeta(profile, issue.short_id, META.ghUpdatedAt, upstream.updated_at);

  return {
    kind: "synced",
    number,
    comments: comments.length,
    state: upstream.state,
    diverged: upstream.state === "closed" && issue.status === "open",
  };
}
