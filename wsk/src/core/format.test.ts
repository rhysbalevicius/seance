import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatFile, formatterFor, loadFormatters } from "./format.js";

const dir = mkdtempSync(join(tmpdir(), "wsk-fmt-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const shipped = loadFormatters(
  new URL("../../../config/style/formatters.json", import.meta.url).pathname,
);

test("the shipped formatter set loads and covers the languages in use", () => {
  assert.ok(shipped.length > 0);
  for (const ext of [".ts", ".py", ".go", ".tf", ".sh"]) {
    assert.ok(formatterFor(`x${ext}`, shipped), `no formatter for ${ext}`);
  }
});

test("an unknown file type has no formatter rather than a wrong one", () => {
  assert.equal(formatterFor("notes.txt", shipped), undefined);
});

test("a file with no formatter is skipped, not reported as formatted", async () => {
  const f = join(dir, "notes.txt");
  writeFileSync(f, "hello\n");
  assert.equal((await formatFile(f, shipped)).kind, "no-formatter");
});

test("a missing tool is reported as unavailable, never as a pass", async () => {
  // Silently treating an absent formatter as success is how a convention stops
  // being one without anybody noticing.
  const f = join(dir, "x.zz");
  writeFileSync(f, "content\n");
  const result = await formatFile(f, [
    { id: "nope", extensions: [".zz"], command: ["definitely-not-a-real-binary"] },
  ]);
  assert.equal(result.kind, "unavailable");
  assert.equal(result.kind === "unavailable" && /not installed/.test(result.detail), true);
});

test("a formatter that runs actually rewrites the file", async () => {
  const f = join(dir, "main.tf");
  writeFileSync(f, 'resource  "a"   "b" {\n  x="y"\n}\n');
  const result = await formatFile(f, shipped);
  // terraform may be absent in some environments; only assert when it ran.
  if (result.kind === "formatted") {
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(f, "utf8"), /resource "a" "b"/);
  } else {
    assert.equal(result.kind, "unavailable");
  }
});
