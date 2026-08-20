import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadProfiles, type Profile } from "../core/config.js";

const run = promisify(execFile);

const CONFIG_DIR = process.env["SEANCE_CONFIG_DIR"] ?? "/etc/seance";
const MANUAL_OPEN = "<!-- seance:manual -->";
const MANUAL_CLOSE = "<!-- /seance:manual -->";

/**
 * Bring a workspace up: its ledger, its generated contract, and the agent
 * settings that enforce the conventions. Idempotent, so provisioning can run it
 * unconditionally and a person can re-run it after changing the registry.
 */
export async function initProfile(profile: Profile): Promise<string[]> {
  const done: string[] = [];

  if (profile.ledger) {
    mkdirSync(profile.kataHome, { recursive: true });
    await kata(profile, ["daemon", "start"]).catch(() => undefined);
    const existing = await kata(profile, ["projects", "list", "--json"]).catch(() => "");
    if (!existing.includes(`"${profile.name}"`)) {
      await kata(profile, ["projects", "create", profile.name]);
      done.push(`created ledger project ${profile.name}`);
    } else {
      done.push(`ledger project ${profile.name} already present`);
    }
  }

  const claudeMd = join(profile.root, "CLAUDE.md");
  writeFileSync(claudeMd, renderClaudeMd(profile, readManualRegion(claudeMd)), "utf8");
  done.push(`wrote ${claudeMd}`);

  const settingsPath = join(profile.root, ".claude", "settings.json");
  mergeSettings(settingsPath);
  done.push(`merged ${settingsPath}`);

  return done;
}

async function kata(profile: Profile, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env["KATA_HOME"] = profile.kataHome;
  env["KATA_TELEMETRY_ENABLED"] = "0";
  delete env["KATA_GITHUB_TOKEN"];
  const { stdout } = await run("kata", ["--workspace", profile.root, ...args], { env });
  return stdout;
}

/** Preserve anything a person wrote between the manual markers. */
export function readManualRegion(path: string): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(MANUAL_OPEN);
  const end = text.indexOf(MANUAL_CLOSE);
  if (start === -1 || end === -1 || end < start) return "";
  return text.slice(start + MANUAL_OPEN.length, end).trim();
}

export function renderClaudeMd(profile: Profile, manual: string): string {
  const basePath = join(CONFIG_DIR, "claude", "CLAUDE.base.md");
  const base = existsSync(basePath) ? readFileSync(basePath, "utf8") : "# Workspace contract\n";

  const registry = [
    "",
    "## Repositories in this workspace",
    "",
    `Owner: \`${profile.githubOwner}\`. Route a work item with a single \`repo:<name>\` label.`,
    "",
    "| Directory | Publishes to |",
    "|---|---|",
    ...profile.repos.map((r) => `| \`${r.dir}\` | \`${r.slug}\` |`),
    "",
  ].join("\n");

  return [
    base.trimEnd(),
    registry,
    MANUAL_OPEN,
    manual === "" ? "\nNotes kept by hand go here; re-initialising preserves them.\n" : `\n${manual}\n`,
    MANUAL_CLOSE,
    "",
  ].join("\n");
}

/** Merge the shipped fragment into a workspace's settings without discarding what is there. */
export function mergeSettings(path: string): void {
  const fragmentPath = join(CONFIG_DIR, "claude", "settings.fragment.json");
  if (!existsSync(fragmentPath)) return;
  const fragment = JSON.parse(readFileSync(fragmentPath, "utf8")) as Record<string, unknown>;

  let current: Record<string, unknown> = {};
  if (existsSync(path)) current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

  const merged = { ...current };

  const perms = (current["permissions"] ?? {}) as Record<string, string[]>;
  const fperms = (fragment["permissions"] ?? {}) as Record<string, string[]>;
  merged["permissions"] = {
    ...perms,
    allow: unique([...(perms["allow"] ?? []), ...(fperms["allow"] ?? [])]),
    deny: unique([...(perms["deny"] ?? []), ...(fperms["deny"] ?? [])]),
  };

  const hooks = (current["hooks"] ?? {}) as Record<string, unknown[]>;
  const fhooks = (fragment["hooks"] ?? {}) as Record<string, unknown[]>;
  const mergedHooks: Record<string, unknown[]> = { ...hooks };
  for (const [event, entries] of Object.entries(fhooks)) {
    const existing = mergedHooks[event] ?? [];
    const seen = new Set(existing.map((e) => JSON.stringify(e)));
    mergedHooks[event] = [...existing, ...entries.filter((e) => !seen.has(JSON.stringify(e)))];
  }
  merged["hooks"] = mergedHooks;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

export async function initAll(name?: string): Promise<void> {
  const profiles = loadProfiles().filter((p) => name === undefined || p.name === name);
  if (profiles.length === 0) throw new Error(name ? `no profile named "${name}"` : "no profiles configured");
  for (const p of profiles) {
    process.stdout.write(`\n${p.name} (${p.root})\n`);
    for (const line of await initProfile(p)) process.stdout.write(`  ${line}\n`);
  }
}
