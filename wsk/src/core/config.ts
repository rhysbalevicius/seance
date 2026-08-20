import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";

/**
 * seance already owns the workspace registry: /etc/seance/projects.json is
 * rendered from tfvars and maps every checkout to a `profile`, which resolves
 * to /srv/projects/<profile>/<dir> and selects the gh-<profile> SSH alias.
 * We read that rather than inventing a second registry, and add only the
 * tooling-specific fields in a sibling profiles.json.
 */

const ProjectEntry = z.object({
  profile: z.string().min(1),
  url: z.string().min(1),
  dir: z.string().min(1),
  ref: z.string().nullable().optional(),
  setup_hint: z.string().nullable().optional(),
});

const ProfileEntry = z.object({
  name: z.string().min(1),
  github_owner: z.string().min(1),
  ledger: z.boolean().default(true),
  /** Path, relative to the profile root, of a ticket corpus to import. */
  corpus: z.string().nullable().optional(),
  /**
   * Default true: an absent curated title would otherwise send the local one,
   * which is an accidental leak channel. A profile may opt into inheritance.
   */
  require_public_title: z.boolean().default(true),
});

export interface Repo {
  readonly dir: string;
  readonly url: string;
  readonly path: string;
  /** "<owner>/<repo>" — the publish target. */
  readonly slug: string;
}

export interface Profile {
  readonly name: string;
  readonly githubOwner: string;
  readonly ledger: boolean;
  readonly corpus: string | null;
  readonly requirePublicTitle: boolean;
  readonly root: string;
  readonly kataHome: string;
  readonly repos: readonly Repo[];
}

const PROJECTS_ROOT = process.env["SEANCE_PROJECTS_ROOT"] ?? "/srv/projects";
const PROJECTS_JSON = process.env["SEANCE_PROJECTS_JSON"] ?? "/etc/seance/projects.json";
const PROFILES_JSON = process.env["SEANCE_PROFILES_JSON"] ?? "/etc/seance/profiles.json";

function readJson(path: string): unknown {
  if (!existsSync(path)) throw new ConfigError(`missing ${path}; is this box provisioned by seance?`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new ConfigError(`${path} is not valid JSON`, { cause });
  }
}

export class ConfigError extends Error {}

export function loadProfiles(): Profile[] {
  const projects = z.array(ProjectEntry).parse(readJson(PROJECTS_JSON));
  const profiles = z.array(ProfileEntry).parse(readJson(PROFILES_JSON));

  return profiles.map((p) => {
    const root = resolve(PROJECTS_ROOT, p.name);
    const repos = projects
      .filter((q) => q.profile === p.name)
      .map((q) => ({
        dir: q.dir,
        url: q.url,
        path: resolve(root, q.dir),
        slug: `${p.github_owner}/${q.dir}`,
      }));
    return {
      name: p.name,
      githubOwner: p.github_owner,
      ledger: p.ledger,
      corpus: p.corpus ?? null,
      requirePublicTitle: p.require_public_title,
      root,
      kataHome: resolve(root, ".kata-home"),
      repos,
    };
  });
}

export function profileByName(name: string): Profile {
  const found = loadProfiles().find((p) => p.name === name);
  if (!found) throw new ConfigError(`no profile named "${name}" in ${PROFILES_JSON}`);
  return found;
}

/**
 * Resolve the profile from a directory by walking up to the profile root.
 *
 * Unlike kata's own discovery this deliberately does *not* stop at a git root:
 * the whole point is that a session started inside a repo still resolves to the
 * one ledger that spans that profile's repos.
 */
export function resolveProfile(from: string = process.cwd()): Profile {
  const profiles = loadProfiles();
  let dir = resolve(from);
  for (;;) {
    const hit = profiles.find((p) => p.root === dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError(
    `${from} is not inside a known profile (looked for ${profiles.map((p) => p.root).join(", ") || "none"}${sep === "/" ? "" : ""})`,
  );
}

/** Which repo of the profile a path belongs to, if any. */
export function repoForPath(profile: Profile, path: string): Repo | undefined {
  const target = resolve(path);
  return profile.repos.find((r) => target === r.path || target.startsWith(r.path + sep));
}
