# agent-traffic

Traffic control for parallel coding agents on one machine. This Claude Code
plugin checks every `Bash`/`PowerShell` command an agent is about to run and
stops agents from fighting over your machine:

| Guard | Problem | What it does |
|---|---|---|
| **heavy** | Two agents build two APKs at once and the machine freezes | Queues heavy builds machine-wide and runs them at below-normal priority |
| **port** | An agent starts `npm run dev` while the same server, or another project, already holds the port. Vite/Next silently move to the next port and you end up with duplicate servers | Blocks the command and says who holds the port and whether to reuse it or pick another |
| **dedupe** | Two sessions run the same `npm install` or build in the same project. This wastes work and can corrupt `node_modules` | Blocks the second copy while the first is still running |
| **conflict** | Different commands break each other in one project. `npm install` during a build swaps `node_modules` mid-run, `next build` during `next dev` corrupts `.next`, and `dotnet build` fails while the app runs | Blocks the clashing command and says what it is waiting on |
| **git** | Several agents share one working tree, so one agent's `checkout`, `stash`, `reset --hard`, `pull` or `add -A` moves, discards or commits another agent's work | Blocks those commands while another session is active in the same working tree, and suggests a `git worktree` |
| **background** | An agent runs `npm run dev`, a watcher or `tail -f` in the foreground and blocks until the timeout | Moves never-ending commands to a background task |

Light commands are untouched. When a guard blocks a command, the agent gets a
reason it can act on. The agent is told not to override a block on its own. If
you want to override one, tell the agent to prefix the command with
`AGENT_TRAFFIC_ALLOW=1 ` (in PowerShell: `$env:AGENT_TRAFFIC_ALLOW=1; `).

## Install

```
/plugin marketplace add goldyndevs/agent-traffic
/plugin install agent-traffic@agent-traffic
```

Requires `node` on PATH. To try it without installing:
`claude --plugin-dir ./agent-traffic`.

## How it works

Commands that a guard tracks get a gate line put in front of them, for example
`node agent-traffic.js acquire --owner <shell pid> || exit $?`. The original
command stays verbatim and runs in the agent's own shell, so aliases, functions
and `cd` behave exactly as before.

Everything is recorded in a machine-wide registry at `~/.agent-traffic`. Each
record is tied to the pid of the agent's shell, so it disappears within about a
second of that shell exiting, even if the shell crashed or was killed.

### heavy

- Capacity is 4 units. Each command is classified by its text, not by measuring it:

  | Weight | Commands |
  |---|---|
  | 3 | Gradle, `flutter build`, `xcodebuild`, RN/Expo native runs |
  | 2 | web builds (`npm run build`, next/vite/ng/...), `dotnet build/test/publish`, `docker build`, Maven, `cargo`, `go build/test`, `swift build`, `cmake --build`/`make -j`/`ninja`, test runners (`jest`, `vitest`, `npm test`, `playwright test`, `cypress run`, `pytest -n`), `ffmpeg`, `pod install` |
  | 1 | `npm/pnpm/yarn/bun install`, `npm ci`, `tsc --noEmit/-b/-p` |

  So two APK builds never overlap, while two web builds can run together.
- **RAM check:** a job joins jobs that are already running only if at least
  `minFreeMemMB` (2 GB) of RAM is free. A job alone always runs, so a machine
  whose RAM is already eaten by browsers still gets one build at a time.
- Jobs are served first in, first out.
- **Machine busy when the agent runs the command:** the command becomes a
  background task and waits with no time limit. The agent keeps working, and
  Claude Code notifies it when the build finishes.
- **Machine free:** the command runs in the foreground as usual. If another agent
  takes the slot in the meantime, it waits up to `maxWaitSec` (300 s). After that
  it exits with code **75** and prints `agent-traffic: BUSY`.
- Not queued on purpose: emulators, `docker compose up` and dev servers. They
  never finish, so holding a slot would block the builds that need them. The RAM
  check still covers their memory use.

### port

- **Dev servers it recognizes:** Vite, Next, Nuxt, Astro, Angular, CRA, Expo/Metro,
  webpack-dev-server, Storybook, Django, Flask, uvicorn/gunicorn, Rails, Laravel,
  `python -m http.server`, `php -S`, `dotnet run/watch`.
  `npm/pnpm/yarn/bun dev|start|serve|preview` is resolved through `package.json`.
- **How the port is found, first match wins:**
  1. A flag in the command: `--port`, `-p`, `PORT=`, `--urls`, `runserver :N`, and so on.
  2. A flag in the `package.json` script.
  3. `server.port` in `vite.config`.
  4. The framework's default port.

  A leading `cd dir &&` is followed. If the port is unknown, the command is never blocked.
- **If the port is busy, the agent is told who holds it:**
  - The same project's server, started by an agent: reuse it at `http://localhost:N`.
  - Another project's server: keep it running and use the free port suggested.
  - Any other process: its name and pid, from `netstat` or `lsof`.

### dedupe

The command is blocked when the identical command is already running or queued
in the same directory. Only commands that go through a gate are tracked, which
means heavy jobs and dev servers.

### conflict

Each command is classified as `install`, `build`, `test` or `server` within the
node or dotnet ecosystem. It is then compared with what is running in the same
project:
- **node:** the npm, yarn or pnpm workspace root, because an install at the root
  rewrites `node_modules` for every package. Outside a workspace it is the nearest
  `package.json` directory.
- **dotnet:** the directory itself.

| Incoming | Running in the same project | Result |
|---|---|---|
| node install | install, build or test | blocked; wait for it to finish |
| node install | dev server | allowed, with a note to restart the server if needed |
| node build or test | install | blocked; wait for the install |
| `next build` | `next dev` | blocked; both write `.next` |
| `next dev` | `next build` | blocked; wait for the build |
| any dotnet command | `dotnet run` / `watch` | blocked; the running app locks bin/obj |
| any dotnet command | dotnet build or restore | blocked; wait for it |

### git

A session counts as active in a git working tree from its first command or edit
there until it ends, so a session left idle while the user is away is still
protected. Edits are recorded by a `PostToolUse` hook, and the `SessionEnd` hook
forgets the session. A session that crashed without ending stops counting after
4 hours idle (`activeWindowMin`), and its file is deleted after 24 hours.

When another session is active, these commands are blocked:
- `checkout` and `switch`
- `stash` (but not `stash list` or `stash show`)
- `reset --hard`, `clean -f` and `restore`
- `rebase`, `merge`, `pull`, `cherry-pick` and `revert`
- `add -A`, `add .` and `commit -a`

Read-only commands, `fetch`, and staging or committing specific files stay
allowed. A linked worktree is its own working tree, which is the recommended way
to run agents in parallel on one repo.

### background

Commands that never finish on their own become background tasks:
- dev servers: known frameworks, plus `npm run dev`, `serve` and `storybook`
- watch modes: `--watch`, `tsc -w` and `*watch` npm scripts
- `nodemon`
- log follows: `tail -f`, `kubectl logs -f`, `docker logs -f` and `adb logcat`
- `docker compose up` without `-d`
- `flutter run` and `emulator`

`npm start` and `dotnet run` are left alone unless they are clearly a server,
because they are often finite programs.

## Status

```
node <plugin>/bin/agent-traffic.js status
```

This shows running jobs, the queue, dev servers, free capacity, CPU and RAM. To
use the heavy queue from your own terminal or another agent:

```
node <plugin>/bin/agent-traffic.js run -- ./gradlew assembleDebug
```

## Config (optional)

Put a config file at `~/.agent-traffic/config.json`. Every key is optional:

```json
{
  "heavy": {
    "enabled": true,
    "capacity": 4,
    "minFreeMemMB": 2048,
    "maxWaitSec": 300,
    "lowPriority": true,
    "rules": [{ "label": "my-build", "weight": 2, "pattern": "\\bmake\\s+all\\b" }],
    "disableDefaultRules": false,
    "exclude": "\\bsome-light-cmd\\b"
  },
  "port": { "enabled": true },
  "dedupe": { "enabled": true },
  "conflict": { "enabled": true },
  "background": { "enabled": true },
  "git": { "enabled": true, "activeWindowMin": 240 }
}
```

To turn everything off for a session, set `AGENT_TRAFFIC_DISABLE=1`.

## Development

```
bash test/run-tests.sh
```

The suite uses an isolated state dir and runs on Linux, macOS and Windows (Git
Bash). CI runs it on all three (`.github/workflows/test.yml`).
`test/e2e.sh` drives real headless Claude Code sessions in parallel. It takes
about 10 to 15 minutes and uses tokens.
The layout:
- `hooks/pretooluse.js` is the command hook.
- `hooks/activity.js` records edits and session end for the git guard.
- `guards/` holds one file per guard.
- `core/` holds the registry, sessions, config, permissions, and command and
  project parsing.
- `bin/agent-traffic.js` is the CLI.

## Caveats

- **Permissions:** Claude Code checks rules against the gated command, so the
  gate line alone would cost an extra prompt. To avoid that, the hook
  auto-approves a gated command only when your own allow rule already covers the
  original command. It reads the rules in `~/.claude/settings.json` and in the
  project's `.claude/settings.json` and `.claude/settings.local.json`. It is
  deliberately stricter than Claude Code's own matcher:
  - only a single simple command counts, optionally after `cd <dir inside project> &&`;
  - only exact rules and rules with a trailing `:*` or ` *` count;
  - only the default and acceptEdits modes count.

  In every other case you get the normal prompt. Your deny and ask rules always
  apply. Rules passed with `--allowedTools` on the CLI are not visible to the
  hook, so with those you still get the prompt.
- **Not detected:** commands hidden inside quotes (`bash -c "./gradlew build"`)
  and commands backgrounded with `&` inside the command. A `&` job keeps running
  after the shell exits, so its record is dropped early. Quoted text is ignored on
  purpose, so that `git commit -m "..."`, `grep "..."` and heredocs are left alone.
- **Port detection is best effort:** a custom server with its port only in code,
  or a port from `.env`, is not seen. Such a command is registered without a port
  and never blocked.
- **Gradle daemon:** a daemon that was already running is not re-prioritised. You
  can also cap Gradle itself with `org.gradle.workers.max` and `org.gradle.jvmargs`
  in `gradle.properties`.
- **Other agents:** only Claude Code is hooked automatically. Other agents can
  still use the heavy queue through `agent-traffic.js run -- <cmd>`.
- **Tested platforms:** tested end to end on Windows with Git Bash and
  PowerShell. Linux and macOS are covered by the unit suite only.
