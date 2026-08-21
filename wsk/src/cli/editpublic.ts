import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Profile } from "../core/config.js";
import { listIssues, metaString, setMeta } from "../core/ledger.js";
import { scan, formatFindings } from "../core/style.js";
import { META, UserError } from "../core/schema.js";

const run = promisify(execFile);

/**
 * Curating public text by hand is the real cost of publishing anything, and
 * typing multi-line markdown through `meta set` is miserable. This opens an
 * editor seeded with the item's Problem paragraph — the least sensitive part —
 * so the common case is trimming rather than writing from nothing.
 */
export async function editPublic(profile: Profile, ref: string): Promise<void> {
  const issues = await listIssues(profile, { status: "all" });
  const issue = issues.find((i) => i.short_id === ref || metaString(i, META.srcId) === ref);
  if (!issue) throw new UserError(`no work item matching "${ref}"`);

  const seededTitle = metaString(issue, META.pubTitle) ?? issue.title;
  const seededBody = metaString(issue, META.pubBody) ?? firstParagraph(issue.body);

  const draft = [
    seededTitle,
    "",
    seededBody,
    "",
    "# The first line is the public title; everything below it is the public body.",
    "# Both are sent verbatim. Lines beginning with # are removed.",
    "# Save an empty file to leave the item unchanged.",
    "",
    "# For reference, the internal text follows. It is NOT published.",
    ...issue.body.split("\n").map((l) => `# ${l}`),
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "wsk-edit-"));
  const file = join(dir, `${metaString(issue, META.srcId) ?? issue.short_id}.md`);
  writeFileSync(file, draft, "utf8");

  const editor = process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi";
  await run(editor, [file], { stdio: "inherit" } as never).catch(() => {
    throw new UserError(`could not run ${editor}; set $EDITOR`);
  });

  const edited = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();

  if (edited === "") {
    process.stdout.write("nothing written\n");
    return;
  }

  const [title, ...rest] = edited.split("\n");
  const body = rest.join("\n").trim();
  if (body === "") throw new UserError("a public body is required; only a title was given");

  // The same gate publishing applies, applied before the text is stored — a
  // refusal here is far cheaper than one at publish time.
  const findings = [...scan(title ?? "", "pr-body"), ...scan(body, "pr-body")];
  if (findings.length > 0) {
    throw new UserError(
      `this text carries references that must not leave the machine:\n${formatFindings(findings, "pr-body")}`,
    );
  }

  await setMeta(profile, issue.short_id, META.pubTitle, (title ?? "").trim());
  await setMeta(profile, issue.short_id, META.pubBody, body);
  process.stdout.write(`curated ${issue.short_id}; publish it with "wsk issues publish ${issue.short_id} --yes"\n`);
}

function firstParagraph(body: string): string {
  const withoutMeta = body
    .split("\n")
    .filter((l) => !/^\*\*(Repo|Labels|Est|Depends on|Rollback):/.test(l))
    .join("\n");
  const paras = withoutMeta.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");
  return (paras[0] ?? "").replace(/^\*\*\w+\.\*\*\s*/, "");
}
