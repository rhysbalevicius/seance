import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const CONFIG_DIR = process.env["SEANCE_CONFIG_DIR"] ?? "/etc/seance";

/**
 * Formatting is dispatched by file type to whatever the repository already
 * uses, rather than imposing one configuration across repositories that each
 * carry their own. Applying a shared configuration wholesale would rewrite
 * every file in fifteen repositories in a single change, which buries real
 * work and is the opposite of a readable history.
 */

const Formatter = z.object({
  id: z.string(),
  extensions: z.array(z.string()),
  command: z.array(z.string()).min(1),
});
export type Formatter = z.infer<typeof Formatter>;

const FormatterFile = z.object({ formatters: z.array(Formatter) });

export function loadFormatters(path = join(CONFIG_DIR, "style", "formatters.json")): Formatter[] {
  if (!existsSync(path)) return [];
  return FormatterFile.parse(JSON.parse(readFileSync(path, "utf8"))).formatters;
}

export function formatterFor(file: string, formatters = loadFormatters()): Formatter | undefined {
  const ext = extname(file);
  return formatters.find((f) => f.extensions.includes(ext));
}

export type FormatResult =
  | { kind: "formatted"; id: string }
  | { kind: "no-formatter" }
  | { kind: "unavailable"; id: string; detail: string }
  | { kind: "failed"; id: string; detail: string };

export async function formatFile(file: string, formatters = loadFormatters()): Promise<FormatResult> {
  const formatter = formatterFor(file, formatters);
  if (!formatter) return { kind: "no-formatter" };

  const [bin, ...args] = formatter.command as [string, ...string[]];
  try {
    await run(bin, [...args, file], { cwd: dirname(file) });
    return { kind: "formatted", id: formatter.id };
  } catch (err) {
    const e = err as { code?: string | number; stderr?: string; message?: string };
    // A missing tool is not a passing file. Saying so is the difference between
    // a convention that holds and one that quietly stopped applying.
    if (e.code === "ENOENT") {
      return { kind: "unavailable", id: formatter.id, detail: `${bin} is not installed` };
    }
    return { kind: "failed", id: formatter.id, detail: (e.stderr || e.message || "").trim().split("\n")[0] ?? "" };
  }
}

export function describeFormat(file: string, r: FormatResult): string {
  switch (r.kind) {
    case "formatted": return `formatted  ${file} (${r.id})`;
    case "no-formatter": return `skipped    ${file} — no formatter for this type`;
    case "unavailable": return `unavailable ${file} — ${r.detail}`;
    case "failed": return `failed     ${file} — ${r.detail}`;
  }
}
