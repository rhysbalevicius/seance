/**
 * Claude Code hook entry point.
 *
 * Reads a tool-call payload on stdin and exits 0 to allow or 2 to block, with
 * the reason on stderr where the agent will read it. It is deliberately a plain
 * stdin-to-exit-code program with no Claude-specific dependency, so the same
 * checks can be moved to a git hook later without being rewritten.
 */
import { pathToFileURL } from "node:url";
import { checkCommitMessage, checkPrBody, formatFindings, scan } from "../core/style.js";

interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const ALLOW = 0;
const BLOCK = 2;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function deny(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  process.exit(BLOCK);
}

/** Extract a commit message from the several shapes `git commit` can take. */
export function commitMessageFrom(command: string): string | undefined {
  // -m "..." possibly repeated, -F -/<file>, or a heredoc.
  const heredoc = /<<'?(\w+)'?\n([\s\S]*?)\n\1/.exec(command);
  if (heredoc && /-F\s*-|--file[= ]-/.test(command)) return heredoc[2];

  const parts: string[] = [];
  const re = /-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const raw = m[1] ?? m[2] ?? "";
    parts.push(m[1] !== undefined ? raw.replace(/\\(.)/g, "$1") : raw);
  }
  if (parts.length > 0) return parts.join("\n\n");
  if (heredoc) return heredoc[2];
  return undefined;
}

function isCommit(command: string): boolean {
  return /\bgit\b[^|;&]*\bcommit\b/.test(command);
}

function isPrCreate(command: string): boolean {
  return /\bgh\b[^|;&]*\bpr\b[^|;&]*\bcreate\b/.test(command) || /\bgs\b[^|;&]*\bsubmit\b/.test(command);
}

const CODE_SUFFIXES = [
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".sh",
  ".tf", ".sql", ".yaml", ".yml", ".json", ".toml",
];

function looksLikeCode(path: string): boolean {
  return CODE_SUFFIXES.some((s) => path.endsWith(s));
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    // A hook that cannot parse its input must not block work.
    process.exit(ALLOW);
  }

  const tool = input.tool_name ?? "";
  const args = input.tool_input ?? {};

  if (tool === "Bash") {
    const command = typeof args["command"] === "string" ? args["command"] : "";

    if (isCommit(command)) {
      const message = commitMessageFrom(command);
      if (message === undefined) {
        // -F <file> and interactive editors are not visible here; say so rather
        // than pretending the message was checked.
        process.exit(ALLOW);
      }
      const problems = checkCommitMessage(message);
      if (problems.length > 0) {
        deny(
          "This commit message does not meet the repository conventions:\n" +
            problems.map((p) => `  - ${p.detail}`).join("\n") +
            "\n\nRewrite the message and commit again.",
        );
      }
    }

    if (isPrCreate(command)) {
      const body = /--body(?:-file)?[= ]\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(command);
      const text = body?.[1] ?? body?.[2];
      if (text !== undefined) {
        const { problems } = checkPrBody(text, {});
        if (problems.length > 0) {
          deny("This pull request body carries references that must not leave this machine:\n" +
            problems.map((p) => `  - ${p}`).join("\n"));
        }
      }
    }
    process.exit(ALLOW);
  }

  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const path = typeof args["file_path"] === "string" ? args["file_path"] : "";
    const content =
      (typeof args["content"] === "string" ? args["content"] : undefined) ??
      (typeof args["new_string"] === "string" ? args["new_string"] : undefined) ??
      "";
    if (content !== "" && looksLikeCode(path)) {
      const findings = scan(content, "code");
      if (findings.length > 0) {
        deny(
          `${path} would carry references that must not appear in code.\n` +
            formatFindings(findings, "code") +
            "\n\nDescribe the change in the code itself; keep tracking references in the ledger.",
        );
      }
    }
  }

  process.exit(ALLOW);
}

// Only run when executed directly. Importing this module (in tests, or from
// another entry point) must not consume stdin.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
