# Workspace contract

This file is generated. Edit only inside the manual region at the end; everything
above it is rewritten when the workspace is re-initialised.

This directory is a **workspace**, not a repository. The checkouts beneath it are
independent repositories with independent histories.

## Hard rules

- **Never create files inside a repository working tree** that are not part of that
  repository's own product. Workspace-level state belongs at the workspace root.
- **Never use `cd`.** Use `git -C <dir>`, `npm --prefix <dir>`, and absolute paths.
- **`git push` is denied.** So are destructive git operations. Ask.

## Work items

The ledger at the workspace root is the source of truth. The upstream tracker is a
lossy, curated mirror of it — never the other way round.

- `wsk issues list` / `wsk issues status` — what exists, and what has been published
- `wsk issues publish` — dry run by default; sends only curated text
- `wsk issues pull` — brings replies back as annotations, changing nothing local

An item is publishable only when it has curated public text. Absent that, it is
structurally unpublishable, which is how items that must never leave are handled —
by the same rule as everything else, rather than by a flag someone has to remember.

**Never** run the ledger's own upstream sync, its initialiser, or a bare tracker
command that creates issues. The first would duplicate every item, the second would
write into a repository, and the third bypasses the curation gate entirely.

## Inspecting the ledger

The ledger is an ordinary SQLite database, and reading it directly is supported rather
than merely possible. Open it read-only: a daemon holds it in write-ahead mode, so a
plain read can otherwise miss recent work.

    sqlite3 "file:<workspace>/.kata-home/kata.db?mode=ro" \
      "select json_extract(metadata,'$.\"src.id\"'), title
         from issues where deleted_at is null;"

Deletion is reversible, so deleted rows remain in the table. Filter on `deleted_at is
null` or the counts will disagree with what the tooling reports.

For a complete, format-stable copy — and for the backup worth taking before any upgrade:

    kata export --allow-running-daemon --output ledger.jsonl

That file restores into a fresh database with `kata import --input ledger.jsonl --target
<path> --new-instance`, carrying items, metadata and dependency links. It is the exit
path if this tooling is ever replaced, and it is worth running before it is needed.

## References

Code and commit messages must stand on their own: they outlive this machine, and a
reader elsewhere cannot resolve a local identifier. Do not put work-item ids, ledger
references, or paths into workspace-level working documents in either.

A pull request body is the exception, and the only one: it must carry the upstream
issue reference when the item has been published, and must still carry no internal
reference.

## Commits

Conventional subject (`feat(scope): summary`). Paragraphs are not hard-wrapped. No
co-author trailers. Stage by logical change rather than wholesale, and branch per
feature set.
