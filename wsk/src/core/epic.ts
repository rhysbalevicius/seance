import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile, Repo } from "./config.js";
import { listIssues, metaNumber, metaString, repoLabels, showIssueDetail } from "./ledger.js";
import { toPublicView } from "./publicview.js";
import { scan } from "./style.js";
import { META, type KataIssue } from "./schema.js";

const CONFIG_DIR = process.env["SEANCE_CONFIG_DIR"] ?? "/etc/seance";

export interface EpicChild {
  readonly ref: string;
  readonly srcId: string | undefined;
  readonly title: string;
  readonly body: string;
  /** The curated public text, when the item has any. */
  readonly publicBody: string | undefined;
  readonly publicTitle: string | undefined;
  /** "<owner>/<repo>#<n>" once published; absent otherwise. */
  readonly issueRef: string | undefined;
  /** True when the item has curated text and therefore must be published first. */
  readonly needsPublishing: boolean;
  readonly branch: string;
  readonly repo: Repo;
  readonly order: number;
}

export interface EpicPlan {
  readonly epic: KataIssue;
  readonly repo: Repo;
  readonly children: readonly EpicChild[];
}

export class EpicError extends Error {}

/**
 * A branch name is pushed upstream, so it is a published surface and must not
 * carry an internal identifier. It is derived from the curated title where one
 * exists, and the mapping back to the work item is kept in the ledger.
 */
export function branchName(child: { publicTitle?: string | undefined; title: string }, prefix: string): string {
  const source = child.publicTitle ?? child.title;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${prefix}${slug || "change"}`;
}

/**
 * Children in an order that respects their dependencies.
 *
 * Only edges between children of this epic count: a dependency on work outside
 * the epic constrains when the epic can start, not the order within it.
 */
export function orderChildren(
  refs: readonly string[],
  blockedBy: ReadonlyMap<string, readonly string[]>,
): string[] {
  const inSet = new Set(refs);
  const pending = new Map<string, Set<string>>();
  for (const r of refs) {
    pending.set(r, new Set((blockedBy.get(r) ?? []).filter((d) => inSet.has(d))));
  }

  const ordered: string[] = [];
  while (ordered.length < refs.length) {
    // Stable: take ready items in their original order so the result is
    // reproducible rather than dependent on map iteration.
    const ready = refs.filter((r) => !ordered.includes(r) && (pending.get(r)?.size ?? 0) === 0);
    if (ready.length === 0) {
      const stuck = refs.filter((r) => !ordered.includes(r));
      throw new EpicError(
        `these items block each other, so no order exists: ${stuck.join(", ")}`,
      );
    }
    for (const r of ready) {
      ordered.push(r);
      for (const set of pending.values()) set.delete(r);
    }
  }
  return ordered;
}

export async function planEpic(profile: Profile, epicRef: string): Promise<EpicPlan> {
  const all = await listIssues(profile, { status: "all" });
  const epic = all.find((i) => i.short_id === epicRef || metaString(i, META.srcId) === epicRef);
  if (!epic) throw new EpicError(`no work item matching "${epicRef}"`);

  const detail = await showIssueDetail(profile, epic.short_id);
  void detail;

  // Children are the items whose parent is this epic.
  const children: KataIssue[] = [];
  const blockedBy = new Map<string, readonly string[]>();
  for (const issue of all) {
    if (issue.short_id === epic.short_id) continue;
    const d = await showIssueDetail(profile, issue.short_id);
    blockedBy.set(issue.short_id, d.blockedBy);
    if (d.parent === epic.short_id) children.push(issue);
  }
  if (children.length === 0) {
    throw new EpicError(`${epic.short_id} has no children; an epic is the items beneath it`);
  }

  // A stack lives in one repository. Spanning repositories is a real thing to
  // want, but it is several stacks, not one, and pretending otherwise would
  // produce change requests with impossible bases.
  const repoNames = new Set(children.flatMap((c) => repoLabels(c)));
  if (repoNames.size !== 1) {
    throw new EpicError(
      `an epic must live in one repository; these children name ${repoNames.size || "none"}` +
        (repoNames.size > 1 ? ` (${[...repoNames].join(", ")}). Split it into one epic per repository.` : "."),
    );
  }
  const dir = [...repoNames][0] as string;
  const repo = profile.repos.find((r) => r.dir === dir);
  if (!repo) throw new EpicError(`"${dir}" is not a repository of profile ${profile.name}`);

  const prefix = process.env["WSK_BRANCH_PREFIX"] ?? "feat/";
  const ordered = orderChildren(children.map((c) => c.short_id), blockedBy);

  const planned = ordered.map((ref, index) => {
    const issue = children.find((c) => c.short_id === ref) as KataIssue;
    const view = toPublicView(profile, issue);
    const publicBody = metaString(issue, META.pubBody);
    const publicTitle = metaString(issue, META.pubTitle);
    const number = metaNumber(issue, META.pubNumber);
    const repoSlug = metaString(issue, META.pubRepo) ?? repo.slug;
    return {
      ref,
      srcId: metaString(issue, META.srcId),
      title: issue.title,
      body: issue.body,
      publicBody,
      publicTitle,
      issueRef: number === undefined ? undefined : `${repoSlug}#${number}`,
      // Curated text means the item is meant to be visible upstream, so the
      // issue must exist before a change request can point at it.
      needsPublishing: view.ok && number === undefined,
      branch: metaString(issue, META.epicBranch) ?? branchName({ publicTitle, title: issue.title }, prefix),
      repo,
      order: index + 1,
    } satisfies EpicChild;
  });

  return { epic, repo, children: planned };
}

/* ---------- pull request bodies ---------- */

export function loadTemplate(): string {
  const p = join(CONFIG_DIR, "templates", "pull_request.md");
  return existsSync(p)
    ? readFileSync(p, "utf8")
    : "## What this changes\n\n{{summary}}\n{{#issue}}\n\nCloses {{issue}}\n{{/issue}}\n";
}

/** Minimal renderer: {{key}} and a {{#key}}...{{/key}} block shown only when set. */
export function render(template: string, values: Readonly<Record<string, string | undefined>>): string {
  let out = template;
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, inner: string) =>
    values[key] ? inner : "",
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => values[key] ?? "");
  return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export interface PrBody {
  readonly title: string;
  readonly body: string;
}

/**
 * Build a change request body.
 *
 * Curated text is used when it exists; otherwise the local text is, provided it
 * carries nothing internal. Deleting references from a sentence was tried and
 * rejected: it turns "per <id> the endpoint times out" into "per the endpoint
 * times out", so the reader upstream gets damaged prose instead of an honest
 * one. Refusing costs a minute of curation and says exactly what to do.
 */
export function buildPrBody(child: EpicChild, total: number): PrBody {
  const local = firstParagraph(child.body);
  if (child.publicBody === undefined) {
    const internal = scan(local, "pr-body");
    if (internal.length > 0) {
      throw new EpicError(
        `refusing to submit ${child.branch}: its description mentions ` +
          `${[...new Set(internal.map((f) => f.match))].join(", ")}, which must not appear upstream. ` +
          `Give the item curated text with "wsk issues edit-public".`,
      );
    }
  }
  const summary = child.publicBody ?? local;
  if (summary.trim() === "") {
    throw new EpicError(
      `refusing to submit ${child.branch}: there is nothing to say about it. ` +
        `Give the item a description, or curated text if it should be visible upstream.`,
    );
  }
  const body = render(loadTemplate(), {
    summary,
    why: "",
    verify: "",
    issue: child.issueRef,
    position: `${child.order} of ${total}`,
  });

  const leaks = scan(body, "pr-body");
  if (leaks.length > 0) {
    throw new EpicError(
      `refusing to submit ${child.branch}: the body still carries ${leaks
        .map((l) => l.match)
        .join(", ")}. Give the item curated text instead.`,
    );
  }
  return { title: child.publicTitle ?? child.title, body };
}

function firstParagraph(body: string): string {
  const withoutMeta = body
    .split("\n")
    .filter((l) => !/^\*\*(Repo|Labels|Est|Depends on|Rollback):/.test(l))
    .join("\n");
  const paras = withoutMeta.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");
  return (paras[0] ?? "").replace(/^\*\*\w+\.\*\*\s*/, "");
}

