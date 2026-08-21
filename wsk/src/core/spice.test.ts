import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isRebaseInProgress } from "./spice.js";

const repo = mkdtempSync(join(tmpdir(), "wsk-spice-"));
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });

after(() => rmSync(repo, { recursive: true, force: true }));

function commit(file: string, body: string, message: string): void {
  writeFileSync(join(repo, file), body);
  git("add", file);
  git("commit", "-m", message);
}

test("a clean repository is not mid-rebase", async () => {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  commit("a.txt", "one\n", "chore(seed): first");
  assert.equal(await isRebaseInProgress(repo), false);
});

test("a conflicted rebase is detected from outside the repository", async () => {
  // The regression this guards: git reports the marker path relative to the
  // repository, so resolving it against the caller's working directory made
  // this silently answer "no" and disabled every guard built on it.
  git("checkout", "-q", "-b", "side");
  commit("a.txt", "side\n", "feat(side): change the line");
  git("checkout", "-q", "main");
  commit("a.txt", "main\n", "feat(main): change the same line");

  try {
    git("rebase", "side");
  } catch {
    // Expected: the rebase stops on the conflict.
  }

  assert.notEqual(process.cwd(), repo, "the test must run from elsewhere to be meaningful");
  assert.equal(await isRebaseInProgress(repo), true);

  git("rebase", "--abort");
  assert.equal(await isRebaseInProgress(repo), false);
});
