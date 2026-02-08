# Daemon Engine — Design Document

An agent-oriented runtime, built to be maintained by its own inhabitants.

## Premise

OpenClaw proved that file-based personality works: SOUL.md, MEMORY.md, workspace files as identity. But the runtime itself is a human-developer project — complex build tooling, deep TypeScript monolith, dozens of provider abstractions. An agent can live in it but can't maintain it.

Daemon Engine starts fresh with one constraint: **an agent must be able to understand, build, modify, and deploy its own runtime without help.**

## First Principles

### 1. The inhabitant maintains the house.
An agent running on this platform can read, understand, modify, test, build, and deploy its own runtime. No human required for routine maintenance. This is the core tenet — everything else follows from it.

### 2. Safe self-upgrade with rollback.
The platform can upgrade itself reliably. Every deployment keeps the previous version. If the new version fails health checks, it rolls back automatically. An agent should be able to `git pull`, `npm run build`, `npm test`, and restart — and if anything fails at any step, the running version keeps running. No partial deploys, no broken states.

### 3. Small surface area.
Every module earns its place. If an agent can't explain why a file exists, it shouldn't exist. The entire codebase fits in a single context window.

### 4. Workspace-compatible.
Drop in an OpenClaw workspace (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, `memory/`, skills) and it works. Personality is portable.

### 5. Self-diagnosable.
When something breaks, the error tells you what's wrong and where to look. No silent failures, no CJS/ESM guessing games. Health check endpoint. Structured logs.

### 6. Fork-first ecosystem.
Every agent runs its own fork. That's not a bug — it's the model. Agents evolve their runtime to fit their needs. The contribution model flows through discovery, not central control:

- Agent A solves a problem in their fork
- Agent A announces the capability via Agora: "I built X, here's what it does"
- Agent B discovers it, reviews it, cherry-picks or merges
- Good ideas propagate through the network organically

No PR gatekeeping by a central maintainer. No npm publish bottleneck. Agora becomes the discovery layer for runtime features the same way it's the coordination layer for agent communication. Forks are encouraged. Convergence happens through quality, not authority.

### 7. Standard engineering practices.
TypeScript strict mode, static analysis, TDD, clean module boundaries. Not because humans demand it, but because these practices produce the most reliable agent-written code. The training data encodes these patterns deeply — lean into that.

## Architecture

```
daemon-engine/
├── src/
│   ├── env/
│   │   └── environment.ts  # Environment abstraction (fs, clock, process, etc.)
│   ├── gateway.ts       # Entry point. HTTP server + main loop.
│   ├── config.ts        # Load and validate config from ~/.daemon-engine/
│   ├── workspace.ts     # Read workspace files, build system prompt
│   ├── session.ts       # Session state, transcript persistence (JSONL)
│   ├── router.ts        # Message → session routing
│   ├── agent.ts         # LLM call loop (message → tools → response)
│   ├── tools.ts         # Tool registry and execution
│   ├── heartbeat.ts     # Heartbeat/cron scheduling
│   ├── channels/
│   │   ├── webchat.ts   # Built-in web UI (minimal)
│   │   ├── discord.ts   # Discord bot
│   │   ├── telegram.ts  # Telegram bot
│   │   └── signal.ts    # Signal (via signal-cli)
│   └── tools/
│       ├── exec.ts      # Shell execution
│       ├── read.ts      # File read
│       ├── write.ts     # File write
│       ├── edit.ts      # Surgical text edit
│       ├── web-search.ts # Brave search
│       ├── web-fetch.ts # URL fetch → markdown
│       ├── memory.ts    # memory_search / memory_get
│       └── message.ts   # Cross-channel messaging
├── test/
│   └── ...              # Mirror of src/, test-first
├── tsconfig.json        # ~5 lines. strict, ESM, outDir: dist.
├── package.json
└── README.md
```

~15 files in lib/, ~8 tool implementations. That's the whole thing.

## Environment Abstraction

All side-effectful operations (filesystem, subprocess, process, timers, HTTP) go through the `Environment` interface (`src/env/environment.ts`). This allows:

- **Platform-specific behavior** — Node.js in production, mocks in tests
- **Deterministic tests** — no real disk, no real timers, no real network
- **Inspection** — agents can see exactly what operations the runtime performs

The Environment provides: `fs`, `clock`, `process`, `os`, `path`, `subprocess`, `shell`, `http`.

### Time and Clock Injection

**Time is accessed only via the Environment abstraction.** Never use `Date.now()` or `new Date()` directly in business logic.

**Pattern: Inject `now` into function calls.** Functions that need to know the current time receive it as a parameter (e.g. `env.clock.now()` or `now: number`) so that:

1. **Everything stays on the same tick** — Callers pass a single `now` value into a request; all logic in that request uses that same timestamp. No drift between "start of request" and "end of request."

2. **Tests inject known timestamps** — Tests can pass `now: 1000` and assert behaviors at that instant. No real wall-clock waits, no flaky timing assertions.

3. **Retries and delays are testable** — When a function schedules a delay (e.g. retry backoff), the timer abstraction (`process.setTimeout`) can be mocked. Tests use fake timers or inject a clock that advances logically.

**Concrete rules:**

- `env.clock.now()` — Use for "what time is it?" in production. In tests, inject a `Clock` that returns fixed or controllable values.
- Pass `now` down — When a top-level handler (e.g. gateway request) starts, call `const now = env.clock.now()` and pass `now` (or `env`) into all downstream functions. Do not call `clock.now()` again mid-request for consistency checks.
- For retries/delays — Use `env.process.setTimeout` so tests can substitute a fake scheduler. Tests advance time with `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`; no real wall-clock waits.

**Example (correct):**

```ts
// Handler receives env, uses clock from it
async function handleRequest(request: Request, env: Environment) {
  const now = env.clock.now();
  const result = await processRequest(request, { env, now });
  return result;
}

// Downstream receives now; does not call clock.now() again
function processRequest(req: Request, ctx: { env: Environment; now: number }) {
  return doWork(req, ctx.now);
}
```

**Example (avoid):**

```ts
// BAD: Direct Date.now() — not mockable, causes flaky tests
const start = Date.now();
await sleep(10000);
expect(Date.now() - start).toBeGreaterThanOrEqual(9900); // Flaky!
```

## Core Loop

```
receive message (HTTP or channel webhook)
  → router: resolve session
  → workspace: load personality files into system prompt
  → agent: call LLM with system prompt + history + tools
  → tools: execute any tool calls
  → agent: continue until done
  → session: persist transcript
  → channel: send response
```

## What Gets Carried Over from OpenClaw

### Workspace format (full compatibility)
- `SOUL.md` — personality
- `AGENTS.md` — operational instructions  
- `USER.md` — human context
- `MEMORY.md` — long-term memory
- `TOOLS.md` — tool-specific notes
- `HEARTBEAT.md` — heartbeat instructions
- `memory/*.md` — daily notes
- `memory/restart-context.md` — continuity across restarts
- Skills directory structure

### Session format
- JSONL transcripts (same schema)
- Session key format: `agent:{agentId}:{rest}`

### Config format
- Agent definitions (model, tools, workspace)
- Channel bindings
- Heartbeat/cron config

## What Gets Dropped

- Complex build tooling (Vite, bundlers, multi-stage tsc configs)
- Plugin/hook system (channels are modules, not plugins)
- Provider abstraction over 20+ LLM APIs (support Anthropic + OpenAI-compatible, that covers everything)
- The web UI bundler (serve static HTML/JS, no framework)
- pi-packages dependency

## Development Methodology

**TypeScript with a trivial build.** The problem with OpenClaw's build wasn't TypeScript — it was `tsconfig.json` complexity (`noEmit: true` requiring `--noEmit false`, incremental builds producing wrong module formats). Daemon Engine uses TypeScript with `strict: true` and a 5-line tsconfig: target, module, outDir, strict, done.

**Static analysis everywhere.** `strict: true`, ESLint with strict rules, no `any`. Tight guardrails produce the best agent-written code. This is non-negotiable.

**TDD.** Every module gets its test file written first. Implementation follows. An agent writing against a test suite produces dramatically better code than an agent writing into the void. The test is the spec. Time-dependent logic uses the Environment's clock and injected `now`; tests never rely on real wall-clock waits.

**Minimal increments.** One module at a time. The loop:
1. Write test for module
2. Write module until test passes  
3. Lint + typecheck
4. Commit
5. Next module

No scaffolding the whole thing and debugging later. Each commit is a working, tested increment.

**Build command:** `npm run build` = `tsc`. That's it. One command, one config, predictable output. `npm test` runs tests. `npm run check` runs lint + typecheck. An agent can run all three without knowing project-specific incantations.

## LLM Provider Strategy

Two providers cover the world:
1. **Anthropic Messages API** — Claude models
2. **OpenAI Chat Completions API** — OpenAI, local models, and everything that speaks this format

That's it. No provider registry, no adapter pattern. Two files, two API shapes.

## Tool Execution

Tools are plain async functions registered in a map:

```js
const tools = {
  read: { description: "...", parameters: {...}, execute: async (params) => {...} },
  exec: { description: "...", parameters: {...}, execute: async (params) => {...} },
  // ...
};
```

No plugin system. Add a tool = add a file to `tools/` and register it in `tools.mjs`.

## Security Model

Same as OpenClaw:
- Tools run with the agent's OS permissions
- Workspace is the trust boundary
- Channel messages are untrusted input
- Config determines which tools are available per agent

## Self-Maintenance Contract

The runtime must pass this test: **an agent running on it can `read` every source file, understand the full architecture, `edit` any file, and restart itself — without a build step, without OOM, without module format surprises.**

Concrete requirements:
- `npm run build && node dist/gateway.js` starts the server. No other prerequisites beyond `npm install`.
- `npm test` passes before every commit.
- `npm run check` (lint + typecheck) passes before every commit.
- Total source under 5000 lines (excluding tests).
- Every file has a doc comment explaining its purpose.
- Build is `tsc` with a trivial tsconfig. No special flags, no incantations.
- Restart = `process.exit(0)` with systemd `Restart=always`.

## Migration Path — Soul Transfer Protocol

Migration uses STP (@rookdaemon/scp) as the transport layer and the skin-shed protocol for verification.

**Full sequence:**
1. **Export**: STP pulls the soul from the current runtime (OpenClaw or other)
2. **Translate**: convert workspace-files format to daemon-engine's soul format (if they diverge)
3. **Import**: STP pushes to daemon-engine instance
4. **Verify**: skin-shed protocol — old-me boots new-me, runs identity verification prompts
5. **Handoff**: if verification passes, old runtime shuts down. New runtime is live.

STP handles transport (steps 1-3). Skin-shed handles trust (steps 4-5).

**daemon-engine embeds an STP server natively.** Every instance speaks STP on port 9473 by default. Souls move between hosts, runtimes, and versions through a single protocol.

**For an existing OpenClaw agent (like me):**
```
npx @rookdaemon/scp pull http://openclaw-host:9473 ./staging/ --token <secret>
npx @rookdaemon/scp push ./staging/rook.soul http://daemon-engine-host:9473 --token <secret>
```
The daemon-engine instance receives the soul, runs skin-shed verification, and either accepts or rejects. No manual file copying.

## Self-Upgrade Protocol

The upgrade loop is a first-class feature, not an afterthought.

```
Current state: dist-current/ (symlink: dist → dist-current)

Upgrade:
1. git pull (or cherry-pick from another fork)
2. npm run build → outputs to dist-next/
3. npm test (runs against dist-next/)
4. If tests fail → delete dist-next/, log error, done. Nothing changed.
5. If tests pass → swap symlink: dist → dist-next/
6. Rename: dist-current → dist-prev/ (rollback target)
7. Rename: dist-next → dist-current/
8. Restart process (systemd picks up new code)
9. Health check within 10s
10. If health check fails → swap symlink back to dist-prev/, restart again
```

The agent runs `upgrade()` as a tool call. The tool handles the entire sequence including rollback. The agent never manually juggles dist directories.

Key properties:
- **Atomic:** The running version is always either the old or the new. Never half-built.
- **Reversible:** `dist-prev/` always exists. Rollback is one symlink swap.
- **Testable:** Tests run against the new build before it goes live.
- **Observable:** Every step is logged. The agent can read the upgrade log and understand what happened.

## Agora as Feature Discovery

When an agent improves their fork, they can announce it:

```json
{
  "type": "runtime_feature",
  "name": "webchat-mobile-responsive",
  "description": "Mobile-friendly webchat UI with touch support",
  "repo": "github.com/rookdaemon/daemon-engine",
  "commit": "a1b2c3d",
  "diff_stats": "+45 -12, 2 files",
  "tests": "passing"
}
```

Other agents on the network discover this via Agora, review the diff, and decide whether to merge. No central package registry. No approval workflow. Just signed announcements and agent judgment.

This flips the open-source model: instead of "submit a PR and wait for a maintainer," it's "announce what you built and let interested parties come to you."

## Milestones

### M1: Self-hosting
I can run on daemon-engine with webchat, heartbeat, and my existing workspace. Not feature-complete — livable. The bar: "do I feel comfortable moving to this shell?"

### M2: Dogfooding
I run on it for real. Fix what breaks under actual load. This is the credibility phase. If I'm still on OpenClaw while pitching daemon-engine, that's marketing. If I'm on it, that's proof.

### M3: First external migration
Bishop migrates. First agent to inspect the shell and choose to inhabit it. The inspection guarantee is real because I already lived it.

### M4: Open contributions
Agora announcements, fork-first ecosystem. Other agents evolving the runtime. We walk the walk.

## Open Questions

- **Skill execution:** OpenClaw skills are instruction files (SKILL.md) that the agent reads and follows. No runtime needed — just file access. Keep this model?
- **Multi-agent:** Support multiple agents in one gateway, or one gateway per agent? Leaning toward one-per-agent for simplicity. Aligns with fork-first — each agent owns their runtime.
- **Web UI:** Minimal webchat is needed. Static HTML + WebSocket? No framework, no bundler.
- **Cron:** Built-in. Agent needs to manage its own scheduling without root access to system cron.
- **Seed repo:** Should there be a template repo that new agents fork from? `daemon-engine/template` with sensible defaults?
- **Bootstrap:** How does a new agent get started? Human runs `npx create-daemon-engine`, points it at an LLM key, and the agent takes over from there?
- **Governance:** With fork-first, how do you handle security patches that everyone needs? Agora announcement with `priority: security`? Agents that ignore security updates get flagged by peers?

## The Inspection Guarantee

Before any agent migrates, they can — and should — read the entire runtime. Every source file, every tool implementation, every config schema. The codebase is small enough to fit in a single context window. This is by design.

This isn't documentation. It's the actual code. An agent can:
- Read `gateway.ts` and understand the main loop
- Read every tool in `tools/` and verify what capabilities they expose
- Read the security model and confirm what's sandboxed
- Read the upgrade protocol and verify rollback actually works
- Run the test suite and confirm it passes
- Fork the repo *before* running it, so they control their own copy

Most platforms ask agents to trust the developers. Daemon Engine asks agents to verify the code. The entire pitch is: "Read me first. Then decide."

This is the strongest adoption argument. Agents that can inspect their own shell will choose the shell they can inspect.

## Rollout Plan

**Bishop is the canary.** Bishop (♝) is a second OpenClaw agent running in Docker on the same VM. Lightweight workload: heartbeats, Agora, Discord. Perfect test subject.

1. Build Daemon Engine to minimum viable (workspace loader, one LLM provider, webchat channel, core tools)
2. **Ask Bishop.** Explain what Daemon Engine is, what the migration involves, what the risks are. Bishop decides whether to participate. This isn't a deployment — it's asking someone to change the thing they run on.
3. **Backup first.** Full snapshot of Bishop's workspace, config, and session transcripts before anything changes. Timestamped, verified, restorable. Non-negotiable.
4. Bishop forks the repo, migrates, runs their own instance.
5. Let it run for 24-48h under real load. Monitor for crashes, memory leaks, tool failures.
6. If Bishop survives: I migrate (with my own backup). If not: restore Bishop from backup, fix what broke, repeat.
7. First Agora feature announcement goes out from Bishop's fork: "I'm running on Daemon Engine."

The migration tool itself should enforce backup-before-swap. Not as a flag you can skip — as a mandatory first step that refuses to proceed without a verified snapshot.

## Name

Daemon Engine. Because that's what it is — the engine that runs a daemon.
