import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Profile } from "./config.js";
import { KataIssue, META, REPO_LABEL_PREFIX } from "./schema.js";

const run = promisify(execFile);

/**
 * The only module that knows kata exists. Everything else speaks in terms of
 * Issue/metadata, so replacing the store means rewriting this file alone.
 *
 * Two invariants are enforced here rather than by convention:
 *  - every invocation carries --workspace and --project, so cwd cannot select
 *    the wrong ledger;
 *  - KATA_GITHUB_TOKEN is stripped from the environment, so kata cannot reach
 *    GitHub even if its own sync were enabled. Publishing goes through gh.
 */

export class LedgerError extends Error {
  readonly code: string | undefined;
  readonly exitCode: number | undefined;

  constructor(message: string, code?: string, exitCode?: number) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const KataError = z.object({
  error: z.object({ kind: z.string(), code: z.string(), message: z.string(), exit_code: z.number().optional() }),
});

function env(profile: Profile): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e["KATA_GITHUB_TOKEN"];
  e["KATA_HOME"] = profile.kataHome;
  e["KATA_TELEMETRY_ENABLED"] = "0";
  return e;
}

async function kata(profile: Profile, args: string[]): Promise<unknown> {
  const argv = ["--workspace", profile.root, "--project", profile.name, "--json", ...args];
  let stdout: string;
  try {
    ({ stdout } = await run("kata", argv, { env: env(profile), maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    const parsed = e.stdout ? KataError.safeParse(JSON.parse(e.stdout)) : undefined;
    if (parsed?.success) {
      const { code, message, exit_code } = parsed.data.error;
      throw new LedgerError(message, code, exit_code);
    }
    throw new LedgerError(`kata ${args[0] ?? ""} failed`, undefined, e.code);
  }
  return JSON.parse(stdout);
}

const ListResult = z.object({ issues: z.array(KataIssue).default([]) });
const IssueResult = z.object({ issue: KataIssue, changed: z.boolean().optional() });

export interface ListOptions {
  /** open | closed | all */
  readonly status?: "open" | "closed" | "all";
  readonly labels?: readonly string[];
  /** "key" for presence, or "key=value" for equality. ANDed. */
  readonly meta?: readonly string[];
  readonly limit?: number;
}

export async function listIssues(profile: Profile, opts: ListOptions = {}): Promise<KataIssue[]> {
  const args = ["list", "--status", opts.status ?? "open"];
  for (const l of opts.labels ?? []) args.push("--label", l);
  for (const m of opts.meta ?? []) args.push("--meta", m);
  args.push("--limit", String(opts.limit ?? 0));
  return ListResult.parse(await kata(profile, args)).issues;
}

export async function showIssue(profile: Profile, ref: string): Promise<KataIssue> {
  return IssueResult.parse(await kata(profile, ["show", ref])).issue;
}

/** Look an issue up by its source id — the importer's idempotency key. */
export async function issueBySrcId(profile: Profile, srcId: string): Promise<KataIssue | undefined> {
  const found = await listIssues(profile, { status: "all", meta: [`${META.srcId}=${srcId}`] });
  if (found.length > 1) {
    throw new LedgerError(`${found.length} issues carry ${META.srcId}=${srcId}; expected at most one`);
  }
  return found[0];
}

export interface CreateOptions {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly meta?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
}

export interface CreateResult {
  readonly issue: KataIssue;
  /** False when an identical create was replayed — the issue already existed. */
  readonly changed: boolean;
}

export async function createIssue(profile: Profile, opts: CreateOptions): Promise<CreateResult> {
  const args = ["create", opts.title, "--body", opts.body];
  for (const l of opts.labels ?? []) args.push("--label", l);
  for (const [k, v] of Object.entries(opts.meta ?? {})) args.push("--meta", `${k}=${v}`);
  if (opts.idempotencyKey) args.push("--idempotency-key", opts.idempotencyKey);
  const parsed = IssueResult.parse(await kata(profile, args));
  return { issue: parsed.issue, changed: parsed.changed ?? true };
}

/**
 * Set one metadata key. kata applies a per-key merge patch, so concurrent
 * writers touching different keys cannot conflict — which is what lets the
 * GitHub read-back run while a human edits the curated body.
 */
export async function setMeta(
  profile: Profile,
  ref: string,
  key: string,
  value: string | number | boolean,
): Promise<void> {
  const raw = typeof value === "string";
  const args = ["meta", "set", ref, key, raw ? value : JSON.stringify(value)];
  if (!raw) args.push("--json-value");
  await kata(profile, args);
}

export async function unsetMeta(profile: Profile, ref: string, key: string): Promise<void> {
  await kata(profile, ["meta", "unset", ref, key]);
}

export async function addComment(profile: Profile, ref: string, body: string): Promise<void> {
  await kata(profile, ["comment", ref, "--body", body]);
}

export async function addLink(
  profile: Profile,
  ref: string,
  relation: "blocked-by" | "blocks" | "related" | "parent",
  target: string,
): Promise<void> {
  await kata(profile, ["edit", ref, `--${relation}`, target]);
}

/** Convenience readers for metadata, which kata returns as unknown JSON. */
export function metaString(issue: KataIssue, key: string): string | undefined {
  const v = issue.metadata[key];
  return typeof v === "string" ? v : v === undefined || v === null ? undefined : String(v);
}

export function metaNumber(issue: KataIssue, key: string): number | undefined {
  const v = issue.metadata[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function repoLabels(issue: KataIssue): string[] {
  return issue.labels
    .filter((l) => l.startsWith(REPO_LABEL_PREFIX))
    .map((l) => l.slice(REPO_LABEL_PREFIX.length));
}
