#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConfigError, loadProfiles, profileByName, resolveProfile, type Profile } from "../core/config.js";
import { EpicError } from "../core/epic.js";
import { SpiceError } from "../core/spice.js";
import * as ghc from "../core/gh.js";
import { LedgerError, listIssues, metaNumber, metaString } from "../core/ledger.js";
import { ghContextFor, publishIssue, pullIssue } from "../core/publish.js";
import { toPublicView } from "../core/publicview.js";
import { META, UserError, describeRefusal } from "../core/schema.js";

const run = promisify(execFile);

const USAGE = `wsk — work items for a seance profile

  wsk install                          fetch and verify the helper binaries
  wsk fmt <file>...                    format files with each repository's own tools
  wsk init [<profile>]                 bring a workspace up: ledger, contract, settings
  wsk doctor [--profile <name>]        check the tooling is wired correctly
  wsk issues import [--write]          load the profile corpus (dry run unless --write)
  wsk issues list   [--all]            list work items
  wsk issues status [--stale]          local versus published state
  wsk issues publish <ref>... | --all  publish curated items (dry run unless --yes)
  wsk issues pull   [<ref>... | --all] read replies and upstream state back
  wsk epic plan   <ref>                children in dependency order
  wsk epic start  <ref>                one branch per child, stacked
  wsk epic submit <ref> [--yes]        one change request per child (dry run by default)
  wsk epic restack <ref>               rebase the stack after a change below
  wsk epic status <ref>                branches and change requests versus the ledger

  wsk guard                            hook entry point; reads a tool call on stdin

Global:
  --profile <name>   override the profile inferred from the working directory
  --json             machine-readable output
`;

function fail(message: string, code = 1): never {
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  process.exit(code);
}

function takeFlag(argv: string[], name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

function takeOption(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}

function pickProfile(argv: string[]): Profile {
  const named = takeOption(argv, "--profile");
  return named !== undefined ? profileByName(named) : resolveProfile();
}

async function doctor(argv: string[]): Promise<void> {
  const rows: [string, string][] = [];
  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      rows.push([label, await fn()]);
    } catch (err) {
      rows.push([label, `FAIL — ${(err as Error).message}`]);
    }
  };

  await check("kata", async () => (await run("kata", ["version"])).stdout.trim().split("\n")[0] ?? "?");
  await check("git-spice", async () => (await run("gs", ["--version"])).stdout.trim().split("\n")[0] ?? "?");

  let profiles: Profile[] = [];
  await check("profiles", async () => {
    profiles = loadProfiles();
    return profiles.map((p) => `${p.name} (${p.repos.length} repos, ${p.githubOwner})`).join("; ") || "none";
  });

  // Credentials are per profile, so they are reported per profile.
  for (const p of profiles) {
    await check(`github:${p.name}`, async () => {
      const ctx = ghContextFor(p);
      const version = await run(ctx.command, ["--version"]).then((r) => r.stdout.trim().split("\n")[0] ?? "?");
      const authed = await ghc.authStatus(ctx);
      return `${ctx.command} ${version.replace(/^gh version /, "")} — ${authed ? "authenticated" : "NOT authenticated"}`;
    });
  }

  for (const p of profiles.filter((x) => x.ledger)) {
    await check(`ledger:${p.name}`, async () => {
      const issues = await listIssues(p, { status: "all" });
      const publishable = issues.filter((i) => toPublicView(p, i).ok).length;
      return `${issues.length} items, ${publishable} publishable`;
    });
  }

  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) process.stdout.write(`${k.padEnd(width)}  ${v}\n`);
  if (rows.some(([, v]) => v.startsWith("FAIL") || v.includes("NOT authenticated"))) process.exit(1);
}

async function issuesList(profile: Profile, argv: string[]): Promise<void> {
  const all = takeFlag(argv, "--all");
  const json = takeFlag(argv, "--json");
  const issues = await listIssues(profile, { status: all ? "all" : "open" });
  if (json) {
    process.stdout.write(JSON.stringify(issues, null, 2) + "\n");
    return;
  }
  for (const i of issues) {
    const src = metaString(i, META.srcId) ?? "";
    const num = metaNumber(i, META.pubNumber);
    process.stdout.write(
      `${i.short_id}  ${(src || "-").padEnd(8)} ${i.status.padEnd(6)} ${num ? `#${num}`.padEnd(6) : "-".padEnd(6)} ${i.title}\n`,
    );
  }
}

async function issuesStatus(profile: Profile, argv: string[]): Promise<void> {
  const json = takeFlag(argv, "--json");
  const issues = await listIssues(profile, { status: "all" });
  const rows = issues.map((i) => {
    const view = toPublicView(profile, i);
    const number = metaNumber(i, META.pubNumber);
    const ghState = metaString(i, META.ghState);
    let state: string;
    if (!view.ok) state = describeRefusal(view.refusal);
    else if (number === undefined) state = "ready to publish";
    else state = metaString(i, META.pubHash) === undefined ? "published" : "published";
    return {
      ref: i.short_id,
      src: metaString(i, META.srcId) ?? null,
      number: number ?? null,
      titleInherited: view.ok ? view.view.titleInherited : null,
      diverged: ghState === "closed" && i.status === "open",
      state,
    };
  });
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  for (const r of rows) {
    const flags = [r.titleInherited ? "T" : " ", r.diverged ? "!" : " "].join("");
    process.stdout.write(`${r.ref}  ${(r.src ?? "-").padEnd(8)} ${flags} ${r.number ? `#${r.number}`.padEnd(6) : "-".padEnd(6)} ${r.state}\n`);
  }
  const diverged = rows.filter((r) => r.diverged).length;
  if (diverged > 0) {
    process.stdout.write(`\n${diverged} closed upstream but open locally — resolve deliberately, nothing was changed for you.\n`);
  }
}

async function issuesPublish(profile: Profile, argv: string[]): Promise<void> {
  const all = takeFlag(argv, "--all");
  const yes = takeFlag(argv, "--yes");
  const repo = takeOption(argv, "--repo");
  const refs = argv.filter((a) => !a.startsWith("-"));

  if (!all && refs.length === 0 && repo === undefined) {
    fail("nothing selected: name refs, or pass --repo <name> or --all");
  }

  let issues = await listIssues(profile, { status: "all" });
  if (repo !== undefined) issues = issues.filter((i) => i.labels.includes(`repo:${repo}`));
  if (refs.length > 0) {
    issues = issues.filter((i) => refs.includes(i.short_id) || refs.includes(metaString(i, META.srcId) ?? ""));
  }

  const dryRun = !yes;
  if (dryRun) {
    process.stdout.write("DRY RUN — nothing will be sent. Re-run with --yes to publish.\n\n");
  }

  let sent = 0;
  for (const issue of issues) {
    const outcome = await publishIssue(profile, issue, { dryRun });
    switch (outcome.kind) {
      case "skipped":
        process.stdout.write(`skip     ${issue.short_id}  ${outcome.reason}\n`);
        break;
      case "unchanged":
        process.stdout.write(`unchanged ${issue.short_id}  ${outcome.repo}#${outcome.number} (no request made)\n`);
        break;
      case "would-create":
        process.stdout.write(`create   ${issue.short_id} -> ${outcome.repo}\n${indent(JSON.stringify(outcome.payload, null, 2))}\n`);
        break;
      case "would-update":
        process.stdout.write(`update   ${issue.short_id} -> ${outcome.repo}#${outcome.number}\n${indent(JSON.stringify(outcome.payload, null, 2))}\n`);
        break;
      case "created":
        sent++;
        process.stdout.write(`created  ${issue.short_id} -> ${outcome.url}\n`);
        break;
      case "adopted":
        sent++;
        process.stdout.write(`adopted  ${issue.short_id} -> ${outcome.url} (existing upstream item reused)\n`);
        break;
      case "updated":
        sent++;
        process.stdout.write(`updated  ${issue.short_id} -> ${outcome.repo}#${outcome.number}\n`);
        break;
    }
  }
  if (!dryRun) process.stdout.write(`\n${sent} item(s) sent to ${profile.githubOwner}.\n`);
}

function indent(s: string): string {
  return s.split("\n").map((l) => "         " + l).join("\n");
}

async function issuesPull(profile: Profile, argv: string[]): Promise<void> {
  const refs = argv.filter((a) => !a.startsWith("-"));
  let issues = await listIssues(profile, { status: "all", meta: [META.pubNumber] });
  if (refs.length > 0) issues = issues.filter((i) => refs.includes(i.short_id));

  for (const issue of issues) {
    const outcome = await pullIssue(profile, issue);
    if (outcome.kind === "not-published") continue;
    if (outcome.kind === "up-to-date") {
      process.stdout.write(`current  ${issue.short_id}  #${outcome.number}\n`);
      continue;
    }
    const note = outcome.diverged ? "  [closed upstream, open locally]" : "";
    process.stdout.write(`synced   ${issue.short_id}  #${outcome.number}  ${outcome.comments} new comment(s)${note}\n`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.shift();

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "guard") {
    await import("../hooks/guard.js").then((m) => m.runGuard());
    return;
  }

  if (command === "format-hook") {
    await import("../hooks/guard.js").then((m) => m.runFormatHook());
    return;
  }

  if (command === "install") {
    const { installPins } = await import("./install.js");
    return installPins();
  }

  if (command === "init") {
    const { initAll } = await import("./init.js");
    const named = takeOption(argv, "--profile") ?? argv.shift();
    return initAll(named);
  }

  if (command === "fmt") {
    const { formatFile, describeFormat } = await import("../core/format.js");
    const files = argv.filter((a) => !a.startsWith("-"));
    if (files.length === 0) fail("name the files to format");
    let bad = 0;
    for (const f of files) {
      const r = await formatFile(f);
      if (r.kind === "failed" || r.kind === "unavailable") bad++;
      process.stdout.write(describeFormat(f, r) + "\n");
    }
    if (bad > 0) process.exit(1);
    return;
  }

  if (command === "doctor") return doctor(argv);

  if (command === "epic") {
    const sub = argv.shift();
    const profile = pickProfile(argv);
    const e = await import("./epic.js");
    const ref = argv.find((a) => !a.startsWith("-"));
    if (ref === undefined) fail("name the epic: wsk epic " + (sub ?? "plan") + " <ref>");
    switch (sub) {
      case "plan": return e.epicPlan(profile, ref);
      case "start": return e.epicStart(profile, ref);
      case "submit": return e.epicSubmit(profile, ref, { dryRun: !takeFlag(argv, "--yes"), draft: takeFlag(argv, "--draft") });
      case "restack": return e.epicRestack(profile, ref);
      case "status": return e.epicStatus(profile, ref);
      default: fail(`unknown: wsk epic ${sub ?? ""}\n\n${USAGE}`);
    }
  }

  if (command === "issues") {
    const sub = argv.shift();
    const profile = pickProfile(argv);
    switch (sub) {
      case "import": {
        const { importCorpus } = await import("./import.js");
        return importCorpus(profile, { dryRun: !takeFlag(argv, "--write"), forceBody: takeFlag(argv, "--force-body") });
      }
      case "edit-public": {
        const { editPublic } = await import("./editpublic.js");
        const ref = argv.find((a) => !a.startsWith("-"));
        if (ref === undefined) fail("name the item: wsk issues edit-public <ref>");
        return editPublic(profile, ref);
      }
      case "list": return issuesList(profile, argv);
      case "status": return issuesStatus(profile, argv);
      case "publish": return issuesPublish(profile, argv);
      case "pull": return issuesPull(profile, argv);
      default: fail(`unknown: wsk issues ${sub ?? ""}\n\n${USAGE}`);
    }
  }

  fail(`unknown command: ${command}\n\n${USAGE}`);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) fail(`configuration: ${err.message}`);
  if (err instanceof LedgerError) fail(`ledger: ${err.message}`, err.exitCode ?? 1);
  if (err instanceof UserError) fail(err.message, 2);
  if (err instanceof EpicError) fail(err.message, 2);
  if (err instanceof SpiceError) {
    const detail = err.stderr
      .split("\n")
      .filter((l) => /^(ERR|FTL)/.test(l))
      .slice(0, 6)
      .join("\n");
    fail(`stacking: ${err.message}${detail ? `\n${detail}` : ""}`, 2);
  }
  fail((err as Error).stack ?? String(err));
});
