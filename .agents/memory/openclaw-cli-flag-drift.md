---
name: OpenClaw CLI flag drift across versions
description: The openclaw CLI (npm package `openclaw`) renames/removes flags between CalVer releases; wrapper code that shells out to it can silently break on a version bump.
---

`openclaw gateway run` does not accept a `--workspace` flag in current versions
(confirmed against upstream `src/cli/gateway-cli/run.ts` — `GatewayRunOpts` has
no `workspace` key). The gateway resolves its state/workspace location from
`openclaw.json` (written by `openclaw onboard`) and the `OPENCLAW_STATE_DIR`
env var instead. `openclaw onboard` still accepts `--workspace` as its own
flag (separate parser) — only `gateway run` dropped it.

**Why:** the wrapper project (Railway-based OpenClaw admin/setup UI) hard-coded
`--workspace <dir>` into the `gateway run` invocation, matching an older
openclaw CLI shape. When the Docker image installs a newer pinned
`OPENCLAW_VERSION`, the gateway process fails immediately with
`OpenClaw does not recognize option "--workspace"` in a retry loop.

**How to apply:** when a wrapper/integration shells out to a fast-moving CLI
(especially CalVer-versioned tools that don't promise flag stability), don't
trust old flag lists from memory or older code — check the flags actually
supported by the *pinned* version, e.g. by reading the tool's own `--help`
output, its GitHub source for the relevant subcommand, or its docs site,
before diagnosing "unrecognized option" errors as something else.
