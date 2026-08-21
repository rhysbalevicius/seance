import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

/**
 * The only module that shells out to the GitHub client.
 *
 * Which client, and whose credentials, belong to the profile: each has its own
 * identity and its own access, and borrowing one profile's token for another
 * profile's repositories is exactly the mistake worth making impossible.
 */
export interface GhContext {
  readonly command: string;
  readonly configDir: string | null;
}

export const DEFAULT_CONTEXT: GhContext = { command: "gh", configDir: null };

function envFor(ctx: GhContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (ctx.configDir !== null) env["GH_CONFIG_DIR"] = ctx.configDir;
  return env;
}

export class GhError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.name = "GhError";
    this.stderr = stderr;
  }
}

async function gh(ctx: GhContext, args: string[], stdin?: string): Promise<unknown> {
  try {
    const child = run(ctx.command, args, { maxBuffer: 64 * 1024 * 1024, env: envFor(ctx) });
    if (stdin !== undefined) {
      child.child.stdin?.end(stdin);
    }
    const { stdout } = await child;
    return stdout.trim() === "" ? null : JSON.parse(stdout);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GhError(e.message ?? "gh failed", e.stderr ?? "");
  }
}

export const GhIssue = z.object({
  number: z.number().int(),
  html_url: z.string(),
  state: z.string(),
  updated_at: z.string(),
  title: z.string(),
  body: z.string().nullable().default(""),
});
export type GhIssue = z.infer<typeof GhIssue>;

export const GhComment = z.object({
  id: z.number().int(),
  user: z.object({ login: z.string() }).nullable(),
  created_at: z.string(),
  body: z.string().nullable().default(""),
});
export type GhComment = z.infer<typeof GhComment>;

export async function authStatus(ctx: GhContext = DEFAULT_CONTEXT): Promise<boolean> {
  try {
    await run(ctx.command, ["auth", "status"], { env: envFor(ctx) });
    return true;
  } catch {
    return false;
  }
}

export async function createIssue(repo: string, payload: unknown, ctx: GhContext = DEFAULT_CONTEXT): Promise<GhIssue> {
  return GhIssue.parse(await gh(ctx, [`api`, `repos/${repo}/issues`, `--method`, `POST`, `--input`, `-`], JSON.stringify(payload)));
}

export async function updateIssue(repo: string, number: number, payload: unknown, ctx: GhContext = DEFAULT_CONTEXT): Promise<GhIssue> {
  return GhIssue.parse(await gh(ctx, [`api`, `repos/${repo}/issues/${number}`, `--method`, `PATCH`, `--input`, `-`], JSON.stringify(payload)));
}

export async function getIssue(repo: string, number: number, ctx: GhContext = DEFAULT_CONTEXT): Promise<GhIssue> {
  return GhIssue.parse(await gh(ctx, [`api`, `repos/${repo}/issues/${number}`]));
}

export async function listComments(repo: string, number: number, ctx: GhContext = DEFAULT_CONTEXT): Promise<GhComment[]> {
  const raw = await gh(ctx, [`api`, `repos/${repo}/issues/${number}/comments`, `--paginate`]);
  return z.array(GhComment).parse(raw ?? []);
}

/**
 * Find an issue whose body carries a marker. This is the orphan guard: a run
 * that dies between creating upstream and recording the number locally would
 * otherwise create a duplicate on the next attempt.
 */
export async function findByMarker(repo: string, marker: string, ctx: GhContext = DEFAULT_CONTEXT): Promise<number | undefined> {
  const q = `repo:${repo} in:body "${marker}"`;
  const raw = await gh(ctx, [`api`, `search/issues`, `-X`, `GET`, `-f`, `q=${q}`]);
  const parsed = z.object({ items: z.array(z.object({ number: z.number().int() })).default([]) }).parse(raw);
  return parsed.items[0]?.number;
}
