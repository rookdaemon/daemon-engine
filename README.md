Daemon Engine (AI-First)
========================

Agent-oriented runtime designed so AI agents can operate and maintain it themselves.

Quickstart (agent-friendly)
---------------------------
- Prereqs: Node.js 20+, npm.
- Install deps: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Lint + types: `npm run check`
- Run (built output): `node dist/main.js` or `node bin/daemon-engine.js --config path/to/daemon.yaml`

Configuration
-------------
- Default search order: `./daemon.yaml`, `./daemon.json`, `~/.config/daemon-engine/daemon.yaml`, `~/.config/daemon-engine/daemon.json`.
- Key fields:
  - `workspace`: path to workspace dir (tilde expansion supported, can override with `--workspace` CLI flag).
  - `claude`: `{ model?, skipPermissions?, timeout? }`
  - `heartbeat`: `{ enabled, intervalMs, prompt?, activeHours? }`
  - `gateway`: `{ port, host?, hooks: { [type]: { token, sessionKey } } }`
  - `sessions`: `{ storeDir }`

Workspace layout (OpenClaw-compatible)
--------------------------------------
Files loaded (if present) into the system prompt in order: `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, `HEARTBEAT.md`. Drop your OpenClaw workspace here and it will be read as-is.

Operating the daemon
--------------------
- Gateway: HTTP server with `/health`, `/hooks` (typed webhooks, Bearer token auth per hook), `/message` (direct sessionKey with Bearer token lookup). System prompt comes from workspace build.
- Sessions: JSONL transcripts stored under `sessions.storeDir`; metadata tracks `lastActive`.
- Heartbeat: optional periodic Claude call. Default prompt expects `HEARTBEAT.md` and replies `HEARTBEAT_OK` when idle. Honors `intervalMs` and optional `activeHours` window; prevents overlapping runs.
- Tools available to the agent (internal): `exec` (shell with timeout), `read`/`write` (file IO). Keep commands minimal and prefer explicit `cwd` when using `exec`.

Safe upgrade practice (recommended)
-----------------------------------
- Loop: `git pull` (or cherry-pick) → `npm run build` → `npm test` → `npm run check` → restart daemon via your supervisor (e.g., systemd). Keep previous `dist` for rollback before swapping.

Further reading
---------------
- [ABOUT](ABOUT.md) — motivation and inspection guarantee.
- [DESIGN](DESIGN.md) — principles, architecture sketch, upgrade protocol.
- `docs/CAPABILITY_INVENTORY.md`, `docs/GATEWAY_USAGE.md`, `docs/SUBSTRATE_EQUIVALENCE.md` — deeper details.
