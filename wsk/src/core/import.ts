import { readFileSync } from "node:fs";

/**
 * Parse a ticket corpus into work items.
 *
 * The corpus is prose that already carries structure: a heading per ticket, one
 * metadata line, and named sections. Parsing it is a mapping rather than a
 * rewrite, and the parser is deliberately strict — an unresolved dependency is
 * a parser bug, not data, and is reported rather than dropped.
 */

export interface ParsedTicket {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly repos: readonly string[];
  readonly labels: readonly string[];
  /** Absent when the estimate is not a number, e.g. "unknown — spike first". */
  readonly estimate: number | undefined;
  readonly dependsOn: readonly string[];
  readonly line: number;
}

export interface ParseReport {
  readonly tickets: readonly ParsedTicket[];
  readonly danglingDependencies: readonly { readonly from: string; readonly to: string }[];
}

// Identifiers are not decimal: DE-01F occurs, so the class must be hexadecimal.
const HEADING = /^## ((?:DE|BUG|RD)-[0-9A-F]+)\s+—\s+(.+?)\s*$/;
const ID_TOKEN = /\b(?:DE|BUG|RD)-[0-9A-F]+\b/g;
// The separator is U+00B7, and the estimate is free text.
const META_LINE =
  /^\*\*Repo:\*\*\s*(?<repo>.+?)\s*·\s*\*\*Labels:\*\*\s*(?<labels>.+?)\s*·\s*\*\*Est:\*\*\s*(?<est>.+?)\s*$/;
const DEPENDS = /\*\*Depends on:\*\*\s*(?<deps>[^*]+)/;
// Stage 6 is a summary table rather than headings; its rows still carry work.
const TABLE_ROW = /^\|\s*\*\*((?:DE|BUG|RD)-[0-9A-F]+)\*\*\s*\|\s*(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/;

function backticked(s: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] as string);
  return out;
}

/** Map the corpus's own labels onto the four-dimension scheme, keeping the originals. */
export function mapLabels(raw: readonly string[]): string[] {
  const out = new Set<string>();
  let typed = false;

  for (const label of raw) {
    out.add(label);
    const stage = /^stage-(\d+|rd)$/.exec(label);
    if (stage) {
      out.delete(label);
      out.add(`stage:${stage[1]}`);
      continue;
    }
    switch (label) {
      case "bug":
        out.add("type:bug"); typed = true; break;
      case "spike":
        out.add("type:spike"); typed = true; break;
      case "cleanup": case "deps": case "refactor": case "release": case "test": case "ci":
        out.add("type:chore"); typed = true; break;
      case "wontfix":
        out.add("superseded"); break;
      default:
        break;
    }
  }
  if (!typed) out.add("type:feature");
  return [...out].sort();
}

export function parseCorpus(text: string): ParseReport {
  const lines = text.split("\n");
  const tickets: ParsedTicket[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    const table = TABLE_ROW.exec(line);
    if (table) {
      const [, id, cell, est] = table as unknown as [string, string, string, string];
      const title = (cell.split(/[.;—]/)[0] ?? cell).trim();
      tickets.push({
        id,
        title,
        body: cell.trim(),
        repos: [],
        labels: mapLabels([]),
        estimate: Number(est),
        dependsOn: [...new Set(cell.match(ID_TOKEN) ?? [])].filter((d) => d !== id),
        line: i + 1,
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (!heading) continue;
    const id = heading[1] as string;
    const title = (heading[2] as string).replace(/\s*🔴\s*$/, "").trim();

    // Body runs to the next ticket, section, or rule.
    let j = i + 1;
    const bodyLines: string[] = [];
    for (; j < lines.length; j++) {
      const l = lines[j] as string;
      if (/^## /.test(l) || /^# /.test(l) || /^---$/.test(l)) break;
      bodyLines.push(l);
    }
    const body = bodyLines.join("\n").trim();

    const metaLine = bodyLines.find((l) => META_LINE.test(l));
    const meta = metaLine ? META_LINE.exec(metaLine)?.groups : undefined;
    const repoField = meta?.["repo"] ?? "";
    const repos = backticked(repoField);
    const labels = mapLabels(backticked(meta?.["labels"] ?? ""));
    const estRaw = (meta?.["est"] ?? "").trim();
    const estimate = /^\d+(\.\d+)?$/.test(estRaw) ? Number(estRaw) : undefined;

    const dependsMatch = DEPENDS.exec(body);
    const dependsOn = dependsMatch
      ? [...new Set(dependsMatch.groups?.["deps"]?.match(ID_TOKEN) ?? [])].filter((d) => d !== id)
      : [];

    tickets.push({ id, title, body, repos, labels, estimate, dependsOn, line: i + 1 });
    i = j - 1;
  }

  const known = new Set(tickets.map((t) => t.id));
  const danglingDependencies = tickets.flatMap((t) =>
    t.dependsOn.filter((d) => !known.has(d)).map((d) => ({ from: t.id, to: d })),
  );

  return { tickets, danglingDependencies };
}

export function parseCorpusFile(path: string): ParseReport {
  return parseCorpus(readFileSync(path, "utf8"));
}
