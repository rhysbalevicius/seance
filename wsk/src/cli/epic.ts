import type { Profile } from "../core/config.js";
import { EpicError, buildPrBody, planEpic, type EpicChild, type EpicPlan } from "../core/epic.js";
import { setMeta } from "../core/ledger.js";
import { META } from "../core/schema.js";
import * as spice from "../core/spice.js";

export async function epicPlan(profile: Profile, ref: string): Promise<void> {
  const plan = await planEpic(profile, ref);
  header(plan);
  for (const c of plan.children) {
    const gate = c.needsPublishing ? "needs publishing" : c.issueRef ?? "no upstream issue";
    process.stdout.write(`  ${String(c.order).padStart(2)}. ${c.branch.padEnd(52)} ${gate}\n`);
  }
  const blocked = plan.children.filter((c) => c.needsPublishing);
  if (blocked.length > 0) {
    process.stdout.write(
      `\n${blocked.length} item(s) carry curated text but are not published yet, so a change request ` +
        `would reference an issue that does not exist. Publish them first.\n`,
    );
  }
}

export async function epicStart(profile: Profile, ref: string): Promise<void> {
  const plan = await planEpic(profile, ref);
  header(plan);

  const repoPath = plan.repo.path;
  if (await spice.isRebaseInProgress(repoPath)) {
    throw new EpicError(
      `${plan.repo.dir} is mid-rebase. Finish or abort it before changing the stack.`,
    );
  }
  const trunk = await spice.trunkBranch(repoPath);
  if (!(await spice.isTracked(repoPath))) {
    await spice.repoInit(repoPath, trunk);
    process.stdout.write(`  initialised stacking in ${plan.repo.dir} on ${trunk}\n`);
  }

  let base = trunk;
  for (const c of plan.children) {
    if (await spice.branchExists(repoPath, c.branch)) {
      process.stdout.write(`  ${c.branch} already exists\n`);
    } else {
      await spice.branchCreate(repoPath, c.branch, base);
      process.stdout.write(`  created ${c.branch} on ${base}\n`);
    }
    await setMeta(profile, c.ref, META.epicBranch, c.branch);
    await setMeta(profile, c.ref, META.epicOrder, c.order);
    base = c.branch;
  }
  process.stdout.write(`\nStack created bottom to top. Commit each branch's work, then submit.\n`);
}

export async function epicSubmit(
  profile: Profile,
  ref: string,
  opts: { readonly dryRun: boolean; readonly draft: boolean },
): Promise<void> {
  const plan = await planEpic(profile, ref);
  header(plan);

  // Refuse the whole epic rather than submit a partial stack whose upper
  // change requests would point at issues that do not exist.
  const unpublished = plan.children.filter((c) => c.needsPublishing);
  if (unpublished.length > 0) {
    throw new EpicError(
      `these items have curated text but are not published:\n` +
        unpublished.map((c) => `  ${c.ref}  ${c.publicTitle ?? c.title}`).join("\n") +
        `\n\nPublish them first, or clear their curated text if they are not meant to be visible.`,
    );
  }

  if (!opts.dryRun && (await spice.isRebaseInProgress(plan.repo.path))) {
    throw new EpicError(
      `${plan.repo.dir} is mid-rebase, so the branches are not in a state worth publishing. ` +
        `Finish or abort it first.`,
    );
  }

  const total = plan.children.length;
  for (const c of plan.children) {
    const { title, body } = buildPrBody(c, total);
    if (opts.dryRun) {
      process.stdout.write(`\n--- ${c.branch} (${c.order} of ${total}) ---\n${title}\n\n${body}\n`);
      continue;
    }
    await spice.branchSubmit(c.repo.path, { branch: c.branch, title, body, draft: opts.draft, dryRun: false });
    process.stdout.write(`  submitted ${c.branch}\n`);
  }
  if (opts.dryRun) {
    process.stdout.write(`\nDRY RUN — nothing submitted. Re-run with --yes to submit.\n`);
  }
}

export async function epicRestack(profile: Profile, ref: string): Promise<void> {
  const plan = await planEpic(profile, ref);
  header(plan);
  await spice.restack(plan.repo.path);
  process.stdout.write(`  restacked\n\n${await spice.logShort(plan.repo.path)}`);
}

export async function epicStatus(profile: Profile, ref: string): Promise<void> {
  const plan = await planEpic(profile, ref);
  header(plan);
  const tracked = await spice.isTracked(plan.repo.path);
  process.stdout.write(`  stacking ${tracked ? "initialised" : "not initialised"} in ${plan.repo.dir}\n`);
  if (await spice.isRebaseInProgress(plan.repo.path)) {
    process.stdout.write(`  a rebase is in progress; resolve it before submitting\n`);
  }
  process.stdout.write("\n");
  for (const c of plan.children) {
    const exists = await spice.branchExists(plan.repo.path, c.branch);
    process.stdout.write(
      `  ${String(c.order).padStart(2)}. ${c.branch.padEnd(52)} ${exists ? "branch" : "no branch"}  ${c.issueRef ?? "-"}\n`,
    );
  }
  if (tracked) process.stdout.write(`\n${await spice.logShort(plan.repo.path)}`);
}

function header(plan: EpicPlan): void {
  process.stdout.write(
    `${plan.epic.short_id}  ${plan.epic.title}\n  ${plan.children.length} item(s) in ${plan.repo.slug}\n\n`,
  );
}

export function childSummary(c: EpicChild): string {
  return `${c.order}. ${c.branch}`;
}
