# Isolated development profile (`dev:safe`)

Runs the server, builds and tests against a disposable test root instead of the
real user profile, on a fixed port (`127.0.0.1:3101`). Nothing in it can reach
the real `~/.cloudcli/auth.db`, provider homes (`~/.claude`, `~/.codex`, …) or
the production instance.

The test root defaults to `claudecodeui-custom-test` next to the checkout;
override with `--test-root <dir>` or `CCUI_TEST_WORK_ROOT`.

## Commands

```
npm run build                              # once, and after server changes
npm run dev:safe                           # start on 127.0.0.1:3101 (Ctrl+C stops it)
npm run dev:safe:check                     # prove where the profile resolves, without starting
npm run dev:safe:reset-db                  # delete the disposable test auth.db (server must be stopped)
npm run test:safe                          # server tests under the profile
npm run dev:safe -- exec -- <command...>   # any command under the profile, e.g. `npm run typecheck`
```

Run builds, tests and scripts through `exec` (or `test:safe`). Agent sessions
started by a normal CloudCLI inherit its `DATABASE_PATH`, so a plain `npm test`
from such a session would point at the real database.

## What is forced inside the test root

| Item | Value |
|---|---|
| `HOME`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH` | `<root>/home` (drives `os.homedir()`, so every provider store and `~/.cloudcli`) |
| `APPDATA`, `LOCALAPPDATA` | `<root>/home/AppData/{Roaming,Local}` |
| `TEMP`, `TMP`, `TMPDIR` | `<root>/tmp` |
| `DATABASE_PATH` | `<root>/home/.cloudcli/auth.db` |
| `WORKSPACES_ROOT` | `<root>/workspaces` |
| `SERVER_PORT`/`PORT`, `HOST` | `3101`, `127.0.0.1` |

The child gets an allow-listed environment, not a copy of yours: only OS
essentials such as `PATH` and `SystemRoot` pass through. Add more per run with
`CCUI_DEV_ENV_PASSTHROUGH=NAME1,NAME2`.

## Fail-closed behaviour

- Port 3101 busy: exit with `DEV_PORT_3101_CONFLICT`; no other port is tried. 3001 is refused.
- Test root reached through a link/junction, containing the checkout or the real
  home, or inside a real home dot-directory: refused before anything is created.
- The server re-checks the profile from inside its own process
  (`server/modules/dev-profile`, called from `server/load-env.ts`) whenever
  `CCUI_DEV_PROFILE=1`. It exits instead of applying the default
  `~/.cloudcli/auth.db` if `DATABASE_PATH`/`WORKSPACES_ROOT` are missing, if
  `os.homedir()`/`os.tmpdir()`/`DATABASE_PATH`/`WORKSPACES_ROOT` or a provider
  location variable resolve outside the test root, if the port/host differ, or
  if real-user credentials (`ANTHROPIC_*`, `OPENAI_*`, …) were forwarded.

## Limits

- Only `dev:safe`/`exec` are isolated. `npm run server`, `server:dev` and `dev`
  keep the normal behaviour (real home) by design.
- The profile has no provider credentials and none are copied in, so features
  that need a real Claude/Codex login are not exercisable here.
- A force-killed server leaves a stale `home/.cloudcli/local-server.json` in the
  test root; it is overwritten on the next start.
