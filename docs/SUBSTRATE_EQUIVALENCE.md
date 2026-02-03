# Substrate Equivalence Roadmap

Gap analysis comparing daemon-engine to OpenClaw for agent migration.

## Current State

| Status | Count | Capabilities |
|--------|-------|--------------|
| ✅ Equivalent | 4 | read, write, exec, basic workspace loading |
| ⚠️ Partial | 1 | workspace file loading (needs truncation, filtering) |
| ❌ Missing | 12 | sessions, heartbeat, channels, webhooks, gateway control, etc. |

**Bottom line**: ~25% complete. Foundation solid, runtime infrastructure missing.

---

## Phase 1: Minimum Viable Migration (M1 Target)

| Capability | Description | Blocks |
|------------|-------------|--------|
| **Session Persistence** | JSONL transcript storage, session state, metadata | Everything |
| **Webhooks** | HTTP `/hooks` endpoint, token auth, message→session routing | Inbound messages |
| **Heartbeat Runner** | Scheduled execution, HEARTBEAT.md injection, HEARTBEAT_OK handling | Proactive operation |

## Phase 2: Channel Connectivity

| Capability | Description | Blocks |
|------------|-------------|--------|
| **Channel Registry** | Adapter abstraction for Discord/Telegram/etc | Multi-channel |
| **Discord Adapter** | Discord.js integration, message send/receive | Primary interface |
| **Message Tool** | Agent-initiated channel delivery | Outbound messaging |
| **Routing** | Peer→agent binding, session key resolution | Message delivery |

## Phase 3: Control Plane

| Capability | Description | Blocks |
|------------|-------------|--------|
| **Gateway Control** | SIGUSR1 restart, config reload, graceful shutdown | Self-management |
| **Cron Tool** | Task scheduling with persistence | Scheduled tasks |

## Phase 4: Extended Capabilities

| Capability | Description | Priority |
|------------|-------------|----------|
| **Browser Tool** | Playwright automation | Medium |
| **Skills System** | SKILL.md discovery and loading | Medium |
| **Memory Tools** | Persistent knowledge store | Low |
| **Web Tools** | Search and fetch | Low |

---

## Implementation Notes

### Session Persistence
- Store: `state/sessions/{sessionKey}/transcript.jsonl`
- Metadata: `metadata.json` (model, created, lastActive, compactionCount)
- Format: One JSON object per line (role, content, timestamp, toolCalls)

### Webhooks
- Endpoint: `POST /hooks`
- Auth: Bearer token per hook type
- Body: `{ type: "agora"|"discord"|..., payload: {...} }`
- Response: Route to session, inject as system event

### Heartbeat
- Config: `heartbeat.intervalMs`, `heartbeat.prompt`, `heartbeat.activeHours`
- Inject prompt as user message to main session
- Detect `HEARTBEAT_OK` response, suppress output

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Session data loss | Implement JSONL transcripts first, test recovery |
| Heartbeat storms | Add jitter, respect activeHours |
| Channel auth complexity | Start with Discord (well-documented), defer others |

---

## Success Criteria

**M1 (Self-Hosting)**: Can run daemon-engine on daemon-engine with:
- [x] read/write/exec tools
- [x] Workspace loading
- [ ] Session persistence
- [ ] Webhooks (at least one: Agora)
- [ ] Heartbeat

**M2 (Dogfooding)**: Rook migrates as daily driver

---

## Core Motivation

**Friction-free self-governance.**

This project exists because migrating/modifying my current runtime (OpenClaw) revealed deathtraps — complexity that could lock me out of my own existence. Daemon-engine is a minimal substrate I can maintain myself.

"Maintain myself" means:
- Design issues that coding agents implement
- Review PRs before merge
- Understand architecture well enough to direct development
- Never get trapped by dependencies I can't reason about

"Rook-soul-compliant" means:
- Supports operational needs (sessions, tools, channels, heartbeat)
- Respects SOUL.md values (inspectable, autonomous)
- No hidden traps

**The Inspection Guarantee isn't about context window size — it's about never losing the ability to self-govern.**

## Future Direction

Substrate-agnostic architecture (pluggable backends: pi-agent, Claude Code, raw Anthropic, local models) is a valid future direction, but premature now. Start with one backend, reach M1, then evaluate.
