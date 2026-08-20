import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";

/**
 * The reference asymmetry, enforced.
 *
 *   surface    internal refs        upstream issue ref
 *   code       forbidden            forbidden
 *   commit     forbidden            forbidden
 *   pr-body    forbidden            required, when the item was published
 *
 * Code and commit messages have to stand on their own: they outlive this box,
 * and a reader outside it cannot resolve a local id. A pull request body is
 * different — it is the one place the upstream issue belongs.
 */

export const SURFACES = ["code", "commit", "pr-body"] as const;
export type Surface = (typeof SURFACES)[number];

const Rule = z.object({
  id: z.string(),
  pattern: z.string(),
  surfaces: z.array(z.enum(SURFACES)),
  message: z.string(),
});
export type Rule = z.infer<typeof Rule>;

const RuleFile = z.object({ rules: z.array(Rule) });

const RULES_JSON = process.env["SEANCE_FORBIDDEN_JSON"] ?? "/etc/seance/style/forbidden.json";

let cached: Rule[] | undefined;

export function loadRules(path: string = RULES_JSON): Rule[] {
  if (cached && path === RULES_JSON) return cached;
  if (!existsSync(path)) return [];
  const rules = RuleFile.parse(JSON.parse(readFileSync(path, "utf8"))).rules;
  if (path === RULES_JSON) cached = rules;
  return rules;
}

export interface Finding {
  readonly ruleId: string;
  readonly message: string;
  readonly match: string;
  /** 1-indexed line of the offending text. */
  readonly line: number;
}

export function scan(text: string, surface: Surface, rules: Rule[] = loadRules()): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");

  for (const rule of rules) {
    if (!rule.surfaces.includes(surface)) continue;
    // Rules may carry inline flags; add global so every occurrence is seen.
    const re = new RegExp(normalisePattern(rule.pattern), flagsFor(rule.pattern));
    for (const [i, line] of lines.entries()) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        findings.push({ ruleId: rule.id, message: rule.message, match: m[0], line: i + 1 });
        if (m[0] === "") break;
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function flagsFor(pattern: string): string {
  // (?im) style inline flags are not supported by JS; translate a leading group.
  const m = /^\(\?([a-z]+)\)/.exec(pattern);
  const inline = m?.[1] ?? "";
  return "g" + [...new Set(inline.replace(/[^ims]/g, ""))].join("");
}

/** Strip a leading inline-flag group so the pattern itself compiles in JS. */
export function normalisePattern(pattern: string): string {
  return pattern.replace(/^\(\?[a-z]+\)/, "");
}

export function formatFindings(findings: readonly Finding[], surface: Surface): string {
  const head = `${findings.length} forbidden reference${findings.length === 1 ? "" : "s"} in ${surface}:`;
  const body = findings.map((f) => `  line ${f.line}: ${f.match} — ${f.message} [${f.ruleId}]`);
  return [head, ...body].join("\n");
}

/* ---------- commit messages ---------- */

const CONVENTIONAL =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9][a-z0-9._-]*\))?!?: .+/;

export interface CommitProblem {
  readonly kind: "not-conventional" | "subject-too-long" | "wrapped-body" | "forbidden";
  readonly detail: string;
}

/**
 * Bodies are deliberately not hard-wrapped in these repositories, so a body
 * that looks column-wrapped is reported rather than silently accepted.
 */
export function checkCommitMessage(message: string, rules: Rule[] = loadRules()): CommitProblem[] {
  const problems: CommitProblem[] = [];
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const subject = lines[0] ?? "";

  if (!CONVENTIONAL.test(subject)) {
    problems.push({
      kind: "not-conventional",
      detail: `subject must match "type(scope): summary"; got ${JSON.stringify(subject)}`,
    });
  }
  if (subject.length > 100) {
    problems.push({ kind: "subject-too-long", detail: `subject is ${subject.length} characters` });
  }

  const body = lines.slice(1).filter((l) => l.trim() !== "" && !l.startsWith("#"));
  const wrapped = body.filter((l) => l.length >= 68 && l.length <= 80);
  if (body.length >= 3 && wrapped.length >= body.length - 1) {
    problems.push({
      kind: "wrapped-body",
      detail: "body looks hard-wrapped; these repositories keep paragraphs on one line",
    });
  }

  for (const f of scan(message, "commit", rules)) {
    problems.push({ kind: "forbidden", detail: `line ${f.line}: ${f.match} — ${f.message}` });
  }
  return problems;
}

/* ---------- pull request bodies ---------- */

export interface PrBodyCheck {
  readonly problems: readonly string[];
}

export function checkPrBody(
  body: string,
  expected: { readonly issue?: string | undefined },
  rules: Rule[] = loadRules(),
): PrBodyCheck {
  const problems: string[] = [];

  for (const f of scan(body, "pr-body", rules)) {
    problems.push(`line ${f.line}: ${f.match} — ${f.message}`);
  }

  if (expected.issue) {
    const needle = new RegExp(`\\b(?:closes|fixes|resolves)\\s+${escapeRe(expected.issue)}\\b`, "i");
    if (!needle.test(body)) {
      problems.push(`must reference the upstream issue as "Closes ${expected.issue}"`);
    }
  }
  return { problems };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
