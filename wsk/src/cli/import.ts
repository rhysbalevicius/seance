import { join } from "node:path";
import type { Profile } from "../core/config.js";
import { parseCorpusFile, type ParsedTicket } from "../core/import.js";
import { addLink, createIssue, issueBySrcId, setMeta, showIssueDetail } from "../core/ledger.js";
import { META } from "../core/schema.js";

/**
 * Stage 6 is a summary table whose dependencies are stated in prose elsewhere.
 * Rather than parse English, the edges are written out once, here, where they
 * can be read and corrected. Ten rows, and honest about what it is.
 */
const STAGE_SIX_EDGES: Readonly<Record<string, readonly string[]>> = {
  "DE-062": ["DE-060"],
  "DE-066": ["DE-050"],
  "DE-067": ["DE-066"],
  "DE-063": ["DE-060"],
  "DE-064": ["DE-063"],
  "DE-065": ["DE-064"],
  "DE-068": ["DE-065"],
  "DE-069": ["DE-068"],
};

export interface ImportOptions {
  readonly dryRun: boolean;
  readonly forceBody: boolean;
}

export async function importCorpus(profile: Profile, opts: ImportOptions): Promise<void> {
  if (profile.corpus === null) {
    process.stdout.write(`profile ${profile.name} declares no corpus; nothing to import\n`);
    return;
  }
  const path = join(profile.root, profile.corpus);
  const { tickets, danglingDependencies } = parseCorpusFile(path);

  if (danglingDependencies.length > 0) {
    const detail = danglingDependencies.map((d) => `${d.from} -> ${d.to}`).join(", ");
    throw new Error(`unresolved dependencies (a parser fault, not data): ${detail}`);
  }
  process.stdout.write(`${tickets.length} tickets parsed from ${profile.corpus}\n`);

  if (opts.dryRun) {
    for (const t of tickets) {
      process.stdout.write(
        `  ${t.id.padEnd(8)} ${t.repos.join(",").padEnd(18)} ${t.labels.join(" ")}  deps=${t.dependsOn.join(",") || "-"}\n`,
      );
    }
    process.stdout.write("\nDRY RUN — nothing written. Re-run without --dry-run to import.\n");
    return;
  }

  // Pass one: create. Titles and bodies are written only on creation, so a
  // re-import never overwrites text a person has since edited.
  const refs = new Map<string, string>();
  let created = 0;
  let drifted = 0;
  for (const t of tickets) {
    const existing = await issueBySrcId(profile, t.id);
    if (existing) {
      refs.set(t.id, existing.short_id);
      if (existing.body.trim() !== t.body.trim()) {
        drifted++;
        if (opts.forceBody) process.stdout.write(`  body drift ${t.id} (left as is; use the ledger to edit)\n`);
      }
      continue;
    }
    const result = await createIssue(profile, {
      title: t.title,
      body: t.body,
      labels: labelsFor(t),
      meta: { [META.srcId]: t.id },
      idempotencyKey: `src:${t.id}`,
    });
    refs.set(t.id, result.issue.short_id);
    if (result.changed) created++;
  }
  process.stdout.write(`created ${created}, already present ${tickets.length - created}\n`);
  if (drifted > 0) {
    process.stdout.write(
      `${drifted} item(s) differ from the corpus. The ledger is the source of truth, so they were left alone.\n`,
    );
  }

  // Pass two: links, once every ticket has a reference to point at.
  let edges = 0;
  for (const t of tickets) {
    const ref = refs.get(t.id);
    if (ref === undefined) continue;
    const wanted = [...new Set([...t.dependsOn, ...(STAGE_SIX_EDGES[t.id] ?? [])])];
    if (wanted.length === 0) continue;
    // The store treats an existing edge as a no-op, so this is safe to repeat;
    // failures are deliberately not swallowed, because a link that silently
    // never lands leaves a dependency graph that lies.
    const { blockedBy } = await showIssueDetail(profile, ref);
    const present = new Set(blockedBy);
    for (const dep of wanted) {
      const target = refs.get(dep);
      if (target === undefined || present.has(target)) continue;
      await addLink(profile, ref, "blocked-by", target);
      edges++;
    }
  }
  process.stdout.write(`linked ${edges} dependency edge(s)\n`);

  // Pass three: metadata. Numbers are written here because a create stores
  // every value as a string.
  for (const t of tickets) {
    const ref = refs.get(t.id);
    if (ref === undefined) continue;
    if (t.estimate !== undefined) await setMeta(profile, ref, META.srcEst, t.estimate);
    if (t.repos.length > 0) await setMeta(profile, ref, META.srcRepos, t.repos.join(","));
    await setMeta(profile, ref, META.srcFile, `${profile.corpus}#L${t.line}`);
  }
  process.stdout.write("metadata written\n");
  process.stdout.write(
    "\nNo item carries public text, so none is publishable yet. Curate each one deliberately.\n",
  );
}

function labelsFor(t: ParsedTicket): string[] {
  const labels = [...t.labels];
  for (const r of t.repos) labels.push(`repo:${r}`);
  if (t.repos.length === 0) labels.push("needs-decision");
  return labels;
}
