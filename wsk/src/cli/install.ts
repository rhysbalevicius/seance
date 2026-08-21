import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Fetch the helper binaries this tool drives.
 *
 * Deliberately not a piped installer: each artefact is downloaded, checked
 * against the digest published with the release, and only then moved into
 * place. That pins identity across time. It is not provenance — the digest
 * comes from the same party as the binary — so the surrounding controls matter
 * more: nothing runs as root, and the ledger is never given a network
 * credential of its own.
 */

export interface Pin {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  /** Path of the executable inside the archive. */
  readonly member: string;
}

export const PINS: readonly Pin[] = [
  {
    name: "kata",
    version: "0.15.1",
    url: "https://github.com/kenn-io/kata/releases/download/v0.15.1/kata_0.15.1_linux_amd64.tar.gz",
    sha256: "931c8cde1ceb05b0cfbed3689a4210f4ce8a5dc5c3f6496f56c89a6bcf260a61",
    member: "kata",
  },
  {
    name: "gs",
    version: "0.31.2",
    url: "https://github.com/abhinav/git-spice/releases/download/v0.31.2/git-spice.Linux-x86_64.tar.gz",
    sha256: "4fbaffe8b6f69d1effce3bc3050083748ee8765b71fd928a966ad480b2d5d4f0",
    // The archive names the binary after the project; it is installed short.
    member: "git-spice",
  },
];

const BIN_DIR = process.env["WSK_BIN_DIR"] ?? join(homedir(), ".local", "bin");

export async function installPins(pins: readonly Pin[] = PINS): Promise<void> {
  mkdirSync(BIN_DIR, { recursive: true });
  const tmp = join(BIN_DIR, ".wsk-install");
  mkdirSync(tmp, { recursive: true });

  for (const pin of pins) {
    const target = join(BIN_DIR, pin.name);
    if (existsSync(target) && (await versionMatches(target, pin.version))) {
      process.stdout.write(`${pin.name} ${pin.version} already installed\n`);
      continue;
    }

    process.stdout.write(`fetching ${pin.name} ${pin.version}\n`);
    const res = await fetch(pin.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${pin.name}: ${res.status} from ${pin.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== pin.sha256) {
      throw new Error(
        `${pin.name}: digest mismatch\n  expected ${pin.sha256}\n  actual   ${actual}\nRefusing to install.`,
      );
    }

    const archive = join(tmp, `${pin.name}.tar.gz`);
    writeFileSync(archive, bytes);
    await run("tar", ["-xzf", archive, "-C", tmp, pin.member]);
    const extracted = join(tmp, pin.member);
    chmodSync(extracted, 0o755);
    renameSync(extracted, target);
    void 0;
    process.stdout.write(`installed ${target}\n`);
  }
}

async function versionMatches(bin: string, version: string): Promise<boolean> {
  try {
    const { stdout } = await run(bin, ["version"]);
    return stdout.includes(version);
  } catch {
    return false;
  }
}

/** Record what is pinned, so an upgrade is a deliberate edit with a new digest. */
export function pinsAsText(pins: readonly Pin[] = PINS): string {
  return pins.map((p) => `${p.name} ${p.version} sha256:${p.sha256}`).join("\n") + "\n";
}

export function readPinnedVersions(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
