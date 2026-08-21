import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The only module that drives git-spice.
 *
 * git-spice owns the genuinely hard part — keeping a stack rebased when a
 * branch below it changes. What it cannot know is which body belongs on which
 * change request, so branches are submitted one at a time rather than as a
 * stack: only the per-branch command accepts a title and body, and controlling
 * the body is the whole point.
 *
 * Every call passes -C so nothing depends on the working directory.
 */

export class SpiceError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.name = "SpiceError";
    this.stderr = stderr;
  }
}

async function gs(repo: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await run("gs", ["-C", repo, "--no-prompt", ...args], {
      env: env ?? process.env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new SpiceError(e.message ?? `gs ${args[0] ?? ""} failed`, e.stderr ?? "");
  }
}

export async function isTracked(repo: string): Promise<boolean> {
  try {
    await gs(repo, ["log", "short"]);
    return true;
  } catch {
    return false;
  }
}

export async function repoInit(repo: string, trunk: string, remote = "origin"): Promise<void> {
  await gs(repo, ["repo", "init", "--trunk", trunk, "--remote", remote]);
}

/** Create a branch stacked on `target`, with no commit of its own yet. */
export async function branchCreate(repo: string, name: string, target: string): Promise<void> {
  await gs(repo, ["branch", "create", name, "--target", target, "--no-commit"]);
}

export async function branchExists(repo: string, name: string): Promise<boolean> {
  try {
    await run("git", ["-C", repo, "rev-parse", "--verify", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export interface SubmitOptions {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly dryRun: boolean;
}

export async function branchSubmit(repo: string, opts: SubmitOptions): Promise<string> {
  const args = [
    "branch", "submit",
    "--branch", opts.branch,
    "--title", opts.title,
    "--body", opts.body,
    opts.draft ? "--draft" : "--no-draft",
  ];
  if (opts.dryRun) args.push("--dry-run");
  return gs(repo, args);
}

/**
 * True when a rebase is half-finished. git-spice stops on a conflict and leaves
 * the working tree mid-rebase, which is the right behaviour but an alarming
 * state to be dropped into without being told.
 */
export async function isRebaseInProgress(repo: string): Promise<boolean> {
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    try {
      const { stdout } = await run("git", ["-C", repo, "rev-parse", "--git-path", marker]);
      // git reports this relative to the repository, not to our own working
      // directory, so it must be resolved against the repository or the check
      // silently answers "no" and every guard built on it stops working.
      if (existsSync(resolve(repo, stdout.trim()))) return true;
    } catch {
      // Fall through: an unreadable repository is reported by the caller.
    }
  }
  return false;
}

export async function restack(repo: string): Promise<void> {
  if (await isRebaseInProgress(repo)) {
    throw new SpiceError(
      "a rebase is already in progress here; finish it with 'gs rebase continue' or 'gs rebase abort' first",
    );
  }
  try {
    await gs(repo, ["stack", "restack"]);
  } catch (err) {
    if (await isRebaseInProgress(repo)) {
      throw new SpiceError(
        "restacking stopped on a conflict. Resolve the conflicted files, 'git add' them, " +
          "then run 'gs rebase continue' — or 'gs rebase abort' to undo. " +
          "Nothing was pushed, and the stack is unchanged upstream.",
        (err as SpiceError).stderr,
      );
    }
    throw err;
  }
}

export async function logShort(repo: string): Promise<string> {
  return gs(repo, ["log", "short"]);
}

export async function currentBranch(repo: string): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

export async function trunkBranch(repo: string): Promise<string> {
  // The remote's default branch, falling back to whatever is checked out.
  try {
    const { stdout } = await run("git", ["-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD"]);
    return stdout.trim().replace("refs/remotes/origin/", "");
  } catch {
    return currentBranch(repo);
  }
}
