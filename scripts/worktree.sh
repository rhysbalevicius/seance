#!/usr/bin/env bash
# Git worktrees for concurrent agents on one repository: each agent gets its
# own checkout + branch under /srv/worktrees, sharing the object store with
# the main clone. Pattern: one herdr pane per worktree, each running `claude`.
#
# Usage:
#   seance-worktree add <repo-dir> <branch> [base]   # create (branch made from base/HEAD if new)
#   seance-worktree ls [repo-dir]
#   seance-worktree rm <worktree-path>               # removes checkout, keeps branch
set -euo pipefail

WT_ROOT=/srv/worktrees
cmd="${1:-ls}"

case "$cmd" in
  add)
    repo="${2:?usage: seance-worktree add <repo-dir> <branch> [base]}"
    branch="${3:?usage: seance-worktree add <repo-dir> <branch> [base]}"
    base="${4:-HEAD}"
    repo="$(cd "$repo" && pwd)"
    name="$(basename "$repo")__${branch//\//-}"
    dest="$WT_ROOT/$name"
    [[ -d "$dest" ]] && { echo "$dest already exists" >&2; exit 1; }
    if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$repo" worktree add "$dest" "$branch"
    else
      git -C "$repo" worktree add -b "$branch" "$dest" "$base"
    fi
    echo "$dest"
    ;;
  ls)
    if [[ -n "${2:-}" ]]; then
      git -C "$2" worktree list
    else
      for d in "$WT_ROOT"/*/; do [[ -d "$d" ]] && echo "${d%/}"; done
    fi
    ;;
  rm)
    dest="${2:?usage: seance-worktree rm <worktree-path>}"
    repo_git="$(git -C "$dest" rev-parse --git-common-dir)"
    git --git-dir="$repo_git" worktree remove "$dest"
    echo "removed $dest (branch kept)"
    ;;
  *)
    echo "usage: seance-worktree {add <repo-dir> <branch> [base] | ls [repo-dir] | rm <path>}" >&2
    exit 1
    ;;
esac
