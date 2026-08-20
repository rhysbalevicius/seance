import { z } from "zod";

/**
 * Metadata keys. Namespaced and flat, with one writer per family:
 *   src.*   the importer, from the source corpus
 *   pub.*   a human (the curated text) and the publisher (the resulting link)
 *   gh.*    the read-back, and nothing else
 *   epic.*  the epic/stack tooling
 *
 * kata stores every `create --meta` value as a JSON string, so numeric fields
 * are written afterwards with `meta set --json-value`.
 */
export const META = {
  srcId: "src.id",
  srcEst: "src.est",
  srcRepos: "src.repos",
  srcFile: "src.file",

  pubTitle: "pub.title",
  pubBody: "pub.body",
  pubLabels: "pub.labels",
  pubRepo: "pub.repo",
  pubNumber: "pub.number",
  pubUrl: "pub.url",
  pubHash: "pub.hash",
  pubAt: "pub.at",

  ghState: "gh.state",
  ghStateAt: "gh.state_at",
  ghUpdatedAt: "gh.updated_at",
  ghCommentCursor: "gh.comment_cursor",

  epicBranch: "epic.branch",
  epicPr: "epic.pr",
  epicOrder: "epic.order",
} as const;

/** Exactly one `repo:<name>` label routes an issue to its GitHub repository. */
export const REPO_LABEL_PREFIX = "repo:";
/** Blocks publication outright, whatever else is set. */
export const HOLD_LABEL = "publish:hold";

export const IssueRef = z.string().min(1).describe("kata short id, qualified short id, or ULID");

/** An issue exactly as kata returns it. Carries the private body. */
export const KataIssue = z.object({
  uid: z.string(),
  short_id: z.string(),
  qualified_id: z.string().optional(),
  title: z.string(),
  body: z.string().default(""),
  status: z.enum(["open", "closed"]),
  labels: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  revision: z.number().int(),
});
export type KataIssue = z.infer<typeof KataIssue>;

/**
 * The only shape `publish` accepts.
 *
 * It deliberately has no field for the private body: sending internal text is
 * not a mistake to remember not to make, it is a type error. `toPublicView` is
 * the single constructor, and it refuses anything ineligible.
 */
export interface PublicView {
  readonly srcId: string;
  readonly ref: string;
  readonly publicTitle: string;
  /** True when `pub.title` was absent and the local title is being used. */
  readonly titleInherited: boolean;
  readonly publicBody: string;
  readonly publicLabels: readonly string[];
  /** "<owner>/<repo>", already resolved and validated. */
  readonly targetRepo: string;
}

export type PublicViewRefusal =
  | { kind: "no-public-body" }
  | { kind: "on-hold" }
  | { kind: "no-repo-label" }
  | { kind: "many-repo-labels"; labels: string[] }
  | { kind: "unknown-repo"; repo: string }
  | { kind: "repo-changed"; recorded: string; now: string }
  | { kind: "title-required" };

export type PublicViewResult =
  | { ok: true; view: PublicView }
  | { ok: false; refusal: PublicViewRefusal };

export function describeRefusal(r: PublicViewRefusal): string {
  switch (r.kind) {
    case "no-public-body":
      return `not publishable: ${META.pubBody} is empty`;
    case "on-hold":
      return `not publishable: labelled ${HOLD_LABEL}`;
    case "no-repo-label":
      return `not publishable: no ${REPO_LABEL_PREFIX}* label`;
    case "many-repo-labels":
      return `not publishable: ${r.labels.length} ${REPO_LABEL_PREFIX}* labels (${r.labels.join(", ")}); exactly one is required`;
    case "unknown-repo":
      return `not publishable: ${r.repo} is not a repository of this profile`;
    case "repo-changed":
      return `refusing to re-route: published to ${r.recorded}, but the label now says ${r.now}`;
    case "title-required":
      return `not publishable: ${META.pubTitle} is required by this profile and is empty`;
  }
}

/** The GitHub issue payload. Three fields, and no way to add a fourth by accident. */
export const GhIssuePayload = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  labels: z.array(z.string()).optional(),
}).strict();
export type GhIssuePayload = z.infer<typeof GhIssuePayload>;
