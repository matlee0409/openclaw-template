---
name: OpenClaw workspace/ nested git repo breaks GitHub backup sync
description: OpenClaw can initialize its own internal .git directly inside the wrapper's workspace/ directory, which corrupts the wrapper's own git-based GitHub backup.
---

The Railway wrapper's GitHub Backup feature (`gitSyncService.js`) runs
`git init` at `OPENCLAW_HOME` (`/data/.openclaw`) and tracks `workspace/`
inside it. OpenClaw itself sometimes creates its *own* internal `.git`
directory somewhere under `workspace/` (location has drifted across
versions — older releases nested it under `workspace/.openclaw/`, which is
why the wrapper's `.gitignore` explicitly excludes that path; a newer
pinned version was observed creating `workspace/.git` directly at the
workspace root instead).

**Why:** when `git add -A` encounters a directory containing a nested
`.git`, git registers the *entire directory* as a gitlink (submodule
reference, mode 160000) pointing at that nested repo's current commit —
this happens regardless of `.gitignore` rules on paths inside it. If the
nested repo has zero commits (fresh init), the gitlink points at no valid
commit, and every subsequent `git add`/`commit`/checkout in the parent
repo fails with `error: 'workspace/' does not have a commit checked out`.
This surfaced in the wrapper's admin UI as a failing GitHub sync status.

**How to apply:** before staging (`git add -A`) in any code that treats an
agent's workspace/data directory as a plain-file git repo, recursively
strip any nested `.git` directories found inside it first (except the
repo's own root `.git`). Don't rely solely on static `.gitignore`
exclusions for specific known paths — the location of an embedded tool's
internal git state can move between versions.
