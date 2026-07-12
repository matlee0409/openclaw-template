# Memory Index

- [OpenClaw CLI flag drift](openclaw-cli-flag-drift.md) — `gateway run` dropped `--workspace`; verify CLI flags against upstream source/docs before trusting old wrapper code, don't assume flags are stable across CalVer releases.
- [Nested git repo breaks git-sync](openclaw-nested-git-repo.md) — OpenClaw creates its own internal `.git` inside `workspace/`, which git treats as a broken gitlink during `git add -A`; strip nested `.git` dirs before staging.
