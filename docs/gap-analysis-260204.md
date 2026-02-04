# Gap Analysis: daemon-engine vs openclaw — Substrate Equivalence

**Date:** 2026-02-04
**Purpose:** Identify every deviation between `daemon-engine` and `openclaw` in what memory/config files are loaded, from where, how they are concatenated into a prompt, and how the prompt is executed. The goal is to ensure `daemon-engine` can be a drop-in replacement for `openclaw`.

---

## 1. Workspace Files Loaded

### openclaw (reference)

Loads **8 files** from the workspace directory, in this order:

| # | Filename | Constant |
|---|----------|----------|
| 1 | `AGENTS.md` | `DEFAULT_AGENTS_FILENAME` |
| 2 | `SOUL.md` | `DEFAULT_SOUL_FILENAME` |
| 3 | `TOOLS.md` | `DEFAULT_TOOLS_FILENAME` |
| 4 | `IDENTITY.md` | `DEFAULT_IDENTITY_FILENAME` |
| 5 | `USER.md` | `DEFAULT_USER_FILENAME` |
| 6 | `HEARTBEAT.md` | `DEFAULT_HEARTBEAT_FILENAME` |
| 7 | `BOOTSTRAP.md` | `DEFAULT_BOOTSTRAP_FILENAME` |
| 8 | `MEMORY.md` *or* `memory.md` | `DEFAULT_MEMORY_FILENAME` / `DEFAULT_MEMORY_ALT_FILENAME` |

**Source:** `openclaw/src/agents/workspace.ts:243-274`

Additionally, openclaw's memory system scans `memory/*.md` (a subdirectory) for additional memory files indexed into a SQLite vector database and searchable via `memory_search`/`memory_get` tools at runtime.

### daemon-engine (current)

Loads **6 files** from the workspace directory, in this order:

| # | Filename |
|---|----------|
| 1 | `SOUL.md` |
| 2 | `AGENTS.md` |
| 3 | `USER.md` |
| 4 | `MEMORY.md` |
| 5 | `TOOLS.md` |
| 6 | `HEARTBEAT.md` |

**Source:** `daemon-engine/src/workspace.ts:13-20`

### GAPS

| Gap | Severity | Detail |
|-----|----------|--------|
| **IDENTITY.md not loaded** | CRITICAL | openclaw loads `IDENTITY.md` — daemon-engine does not. Any identity/persona content in this file is silently dropped. |
| **BOOTSTRAP.md not loaded** | CRITICAL | openclaw loads `BOOTSTRAP.md` — daemon-engine does not. This file is the primary injected-context mechanism. |
| **Lowercase `memory.md` fallback missing** | MODERATE | openclaw falls back to `memory.md` if `MEMORY.md` is absent. daemon-engine only checks `MEMORY.md`. |
| **File ordering differs** | LOW-MODERATE | openclaw order: AGENTS → SOUL → TOOLS → IDENTITY → USER → HEARTBEAT → BOOTSTRAP → MEMORY. daemon-engine order: SOUL → AGENTS → USER → MEMORY → TOOLS → HEARTBEAT. Depending on model behavior, ordering can affect attention/priority. |
| **`memory/*.md` subdirectory not scanned** | MODERATE | openclaw indexes all `.md` files under `memory/` into a vector database for semantic search. daemon-engine has no equivalent. |

---

## 2. Config and Memory File Locations

### openclaw (reference)

**State directory resolution** (`openclaw/src/config/paths.ts`):

```
Priority:
1. $OPENCLAW_STATE_DIR          (env var override)
2. $CLAWDBOT_STATE_DIR          (legacy env var)
3. ~/.openclaw                  (default)
4. ~/.clawdbot, ~/.moltbot, ~/.moldbot  (legacy fallbacks)
```

**Config file resolution:**

```
Priority:
1. $OPENCLAW_CONFIG_PATH        (env var override)
2. $CLAWDBOT_CONFIG_PATH        (legacy)
3. $STATE_DIR/openclaw.json     (default — JSON5 format)
4. $STATE_DIR/clawdbot.json     (legacy)
```

**Workspace directory:**
- Default: `~/.openclaw/workspace/`
- With profile: `~/.openclaw/workspace-{OPENCLAW_PROFILE}/`

**Session files:**
- Metadata store: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transcripts: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

**Auth profiles:**
- `~/.openclaw/agents/<agentId>/auth/profiles.json`

**Memory index:**
- `~/.openclaw/agents/<agentId>/memory.db` (SQLite with vector embeddings)

### daemon-engine (current)

**Config file resolution** (`daemon-engine/src/main.ts:233-251`):

```
Priority:
1. --config CLI flag             (explicit path)
2. ./daemon.yaml                 (cwd)
3. ./daemon.json                 (cwd)
4. ~/.config/daemon-engine/daemon.yaml
5. ~/.config/daemon-engine/daemon.json
```

**Config format:** YAML or JSON (plain, not JSON5). Supports `${ENV_VAR}` interpolation.

**Workspace directory:**
- Configured via `workspace:` key in daemon config. No default — must be specified.

**Session files:**
- Configured via `sessions.storeDir` in config. No default path convention matching openclaw.
- Transcripts: `{storeDir}/{safeSessionKey}/transcript.jsonl`
- Metadata: `{storeDir}/{safeSessionKey}/metadata.json`

### GAPS

| Gap | Severity | Detail |
|-----|----------|--------|
| **Config location mismatch** | HIGH | openclaw reads `~/.openclaw/openclaw.json` (JSON5). daemon-engine reads `./daemon.yaml` or `~/.config/daemon-engine/daemon.yaml` (YAML/JSON). A user migrating must either symlink/copy or point daemon-engine at the openclaw config. |
| **No OPENCLAW_STATE_DIR support** | HIGH | daemon-engine does not respect `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, or any legacy env vars. If the user's setup relies on these, daemon-engine will not find files. |
| **No default workspace path** | MODERATE | openclaw defaults to `~/.openclaw/workspace/`. daemon-engine requires an explicit `workspace:` key. If omitted, startup fails instead of falling back. |
| **Session storage path diverges** | MODERATE | openclaw stores sessions under `~/.openclaw/agents/<agentId>/sessions/`. daemon-engine stores under an arbitrary `sessions.storeDir`. These are not interchangeable without explicit configuration. |
| **No auth profile support** | HIGH | openclaw manages per-agent auth profiles under `~/.openclaw/agents/<agentId>/auth/`. daemon-engine has no auth profile system — it delegates auth entirely to the `claude` CLI subprocess. |
| **No memory.db / vector index** | MODERATE | openclaw maintains a SQLite vector database for semantic memory search. daemon-engine has no equivalent. |
| **No JSON5 config support** | LOW | openclaw uses JSON5 (comments, trailing commas). daemon-engine uses plain JSON or YAML. Existing openclaw JSON5 configs will fail to parse in daemon-engine. |
| **No profile-aware workspace** | LOW | openclaw supports `OPENCLAW_PROFILE` env var for workspace switching (`workspace-{profile}`). daemon-engine has no profile concept. |

---

## 3. How Files Are Concatenated into a Prompt

### openclaw (reference)

**Source:** `openclaw/src/agents/system-prompt.ts:164-591` and `openclaw/src/agents/pi-embedded-helpers/bootstrap.ts`

The system prompt is built from **many sections**, in this order:

1. **Identity line** — `"You are Claude, created by Anthropic."`
2. **Skills section** — lists available workspace skills with `SKILL.md` pointers
3. **Memory Recall guidance** — instructions for `memory_search`/`memory_get` tools
4. **User Identity** — owner phone numbers/contact info
5. **Current Date & Time** — user timezone, instruction to use `session_status` tool
6. **Safety** — constitutional AI guidelines, no self-preservation, no deception
7. **Reply Tags** — `[[reply_to_current]]`, `[[reply_to:<id>]]` syntax
8. **Messaging** — channel routing, `sessions_send()`, inline buttons
9. **Voice (TTS)** — text-to-speech hint (if enabled)
10. **Workspace Notes** — additional context notes
11. **Documentation** — links to docs, GitHub, Discord
12. **Tooling** — tool summaries and descriptions
13. **Runtime Info** — agent ID, hostname, OS, Node version, model, channel, capabilities
14. **Extra System Prompt** — custom instructions
15. **`# Project Context`** header, then for each workspace file:
    - `## {filename}` header
    - File content (trimmed)
    - If SOUL.md present, special instruction: "embody its persona and tone"

**Truncation:**
- Per-file max: **20,000 characters** (configurable via `agents.defaults.bootstrapMaxChars`)
- Strategy: 70% head + 20% tail + truncation marker in between
- Marker: `[...truncated, read {filename} for full content...]`

**Session filtering:**
- Subagent sessions only receive `AGENTS.md` + `TOOLS.md`; all other files are filtered out

**Bootstrap hooks:**
- Plugin hooks (`agent:bootstrap`) can modify the file list before injection

### daemon-engine (current)

**Source:** `daemon-engine/src/workspace.ts:36-56`

The system prompt is built from **workspace files only**:

1. For each file in `WORKSPACE_FILES` (6 files):
   - Read from `{workspaceDir}/{filename}`
   - Skip if missing or empty
   - Add `## {filename}\n{content}`
2. Join all sections with `\n\n`
3. Return as a single string

That's it. The assembled string is passed as `--system-prompt` to the `claude` CLI.

### GAPS

| Gap | Severity | Detail |
|-----|----------|--------|
| **No identity/safety/messaging/etc. sections** | HIGH | openclaw injects ~14 structured sections (identity, safety, messaging, skills, date/time, runtime info, etc.) before the workspace files. daemon-engine injects zero structured sections — only raw workspace file contents. The `claude` CLI may add its own system prompt sections, but these are not equivalent to openclaw's custom sections. |
| **No `# Project Context` wrapper** | LOW | openclaw wraps workspace files under `# Project Context` with a preamble about SOUL.md persona. daemon-engine uses bare `## filename` headers. |
| **No per-file truncation** | MODERATE | openclaw truncates each file to 20k chars with head/tail strategy. daemon-engine loads files fully with no size limit. This could cause context overflow for large files, or conversely, daemon-engine may include more content than openclaw would. |
| **No session-based filtering** | MODERATE | openclaw filters bootstrap files for subagent sessions (only AGENTS.md + TOOLS.md). daemon-engine has no subagent concept and always loads all files. |
| **No bootstrap hooks** | LOW | openclaw supports plugin hooks that can modify the bootstrap file list. daemon-engine has no hook system. |
| **No skills prompt** | MODERATE | openclaw scans for SKILL.md files in skill directories and includes them as tool guidance. daemon-engine has no skills system. |
| **No memory recall guidance** | MODERATE | openclaw includes instructions for `memory_search`/`memory_get` tools in the system prompt. daemon-engine has no memory tool guidance. |
| **No date/time injection** | LOW | openclaw injects current date, time, and timezone. daemon-engine does not (though `claude` CLI may add its own). |
| **No runtime info** | LOW | openclaw injects agent ID, hostname, OS, model info. daemon-engine does not. |

---

## 4. How the Prompt Is Executed

### openclaw (reference)

**Source:** `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`

1. **Auth resolution:** Loads per-agent auth profiles from `~/.openclaw/agents/<agentId>/auth/`. Resolves API keys per provider (Anthropic, OpenAI, Gemini, etc.).
2. **Session management:** Opens JSONL transcript via `SessionManager` from `@mariozechner/pi-coding-agent`. Applies session write lock for exclusive access.
3. **History sanitization:** Validates and sanitizes message history for model-specific ordering. Limits history turns based on DM constraints.
4. **Image detection:** Scans prompt for image references, loads them as base64/URL for vision models.
5. **API call:** Uses `streamSimple()` from `@mariozechner/pi-ai` to call model APIs directly over HTTP (Anthropic, OpenAI, Gemini, Bedrock, etc.).
6. **Streaming:** Response streams in real-time. Tool calls are extracted and executed in a loop.
7. **Tool execution loop:** Built-in tools + custom/workspace tools are registered. Tool calls are extracted from the streaming response, executed, and results fed back.
8. **Transcript persistence:** All messages (user, assistant, tool calls, tool results) are appended to the JSONL transcript via `SessionManager`.

**Key characteristics:**
- Direct HTTP API calls to model providers
- Streaming responses
- Native tool use protocol (Anthropic/OpenAI tool_use format)
- Multi-provider support with provider-specific adapters
- History is structured message arrays, not text concatenation

### daemon-engine (current)

**Source:** `daemon-engine/src/providers/claude-cli.ts:71-246` and `daemon-engine/src/gateway.ts:281-343`

1. **History loading:** Reads JSONL transcript from `{storeDir}/{safeName}/transcript.jsonl`.
2. **History concatenation:** Converts message array to **plain text**:
   ```
   User: {content}
   Assistant: {content}
   Tool Result: {content}
   ```
3. **Prompt assembly:** Prepends text history to the new user message:
   ```
   {historyText}\nUser: {message}
   ```
4. **Claude CLI invocation:** Spawns `claude -p --output-format json --system-prompt "{systemPrompt}"` as a subprocess.
5. **Prompt delivery:** Writes the full text prompt to the subprocess's stdin, then closes stdin.
6. **Response parsing:** Reads JSON from stdout. Extracts `result`, `session_id`, `usage`.
7. **Transcript persistence:** Appends user message and assistant response to the JSONL file.

**Key characteristics:**
- Subprocess invocation of `claude` CLI (not direct API)
- No streaming — waits for full response
- History is **text-concatenated**, not structured message arrays
- Tool execution is delegated to the `claude` CLI process itself (via `--dangerously-skip-permissions`)
- No multi-provider support — only whatever the local `claude` CLI is configured for

### GAPS

| Gap | Severity | Detail |
|-----|----------|--------|
| **Text history vs structured messages** | CRITICAL | openclaw sends structured message arrays (`[{role, content}, ...]`) to the API. daemon-engine concatenates history as plain text (`"User: ...\nAssistant: ..."`) and sends it as a single user prompt. This fundamentally changes how the model perceives conversation structure, role boundaries, and tool call context. |
| **No streaming** | MODERATE | openclaw streams responses in real-time. daemon-engine waits for the entire response before returning. |
| **Subprocess vs direct API** | HIGH | openclaw calls model APIs directly via HTTP. daemon-engine delegates to the `claude` CLI. This means: (a) daemon-engine inherits whatever system prompt `claude` CLI adds, (b) tool behavior is controlled by `claude` CLI, not daemon-engine, (c) auth is handled by `claude` CLI's own config, not openclaw's auth profiles. |
| **No native tool use protocol** | HIGH | openclaw uses the Anthropic/OpenAI tool_use format for structured tool calls. daemon-engine's text-concatenated history loses tool call structure — tool calls become `[tool calls]` text and tool results become `Tool Result: {text}`. |
| **No history sanitization/limiting** | MODERATE | openclaw sanitizes history for model-specific requirements and limits turns. daemon-engine loads all history without limits, which can exceed context windows. |
| **No image support** | LOW | openclaw detects and loads images for vision models. daemon-engine has no image handling. |
| **No session write locks** | LOW | openclaw uses file locks for exclusive session access. daemon-engine has no locking — concurrent writes could corrupt transcripts. |
| **No multi-provider support** | MODERATE | openclaw supports Anthropic, OpenAI, Gemini, Bedrock, etc. daemon-engine only supports whatever model the local `claude` CLI provides. |
| **Double system prompt** | MODERATE | daemon-engine passes `--system-prompt` to the `claude` CLI, but `claude` CLI also has its own built-in system prompt. The workspace content may be injected twice or in conflict with `claude` CLI's own prompt structure. |

---

## 5. Summary of All Gaps by Severity

### CRITICAL (will cause incorrect behavior or data loss)

1. **IDENTITY.md not loaded** — identity/persona content silently dropped
2. **BOOTSTRAP.md not loaded** — primary injected-context file silently dropped
3. **Text history vs structured messages** — conversation structure is fundamentally different; model loses role boundaries and tool call context

### HIGH (significant functional divergence)

4. **No identity/safety/messaging sections in system prompt** — 14 structured sections missing
5. **Config location mismatch** — will not find existing openclaw configs
6. **No OPENCLAW_STATE_DIR support** — env-var-based setups will break
7. **Subprocess vs direct API** — execution model is architecturally different
8. **No native tool use protocol** — tool interactions are degraded to text
9. **No auth profile support** — per-agent credential management absent

### MODERATE (functional gaps that may or may not matter depending on use case)

10. **Lowercase `memory.md` fallback missing**
11. **No default workspace path**
12. **Session storage path diverges**
13. **No memory.db / vector index**
14. **No per-file truncation**
15. **No session-based filtering for subagents**
16. **No skills prompt**
17. **No memory recall guidance in system prompt**
18. **No streaming**
19. **No history sanitization/limiting**
20. **No multi-provider support**
21. **Double system prompt risk** (daemon-engine's `--system-prompt` + `claude` CLI's built-in)
22. **`memory/*.md` subdirectory not scanned**

### LOW (cosmetic or edge-case differences)

23. **File ordering differs**
24. **No `# Project Context` wrapper**
25. **No bootstrap hooks**
26. **No date/time injection**
27. **No runtime info injection**
28. **No JSON5 config support**
29. **No profile-aware workspace**
30. **No image support**
31. **No session write locks**

---

## 6. Recommended Remediation Priority

To achieve substrate equivalence, address gaps in this order:

### Phase 1 — File Parity (blocks everything else)

- [ ] Add `IDENTITY.md` to `WORKSPACE_FILES` list
- [ ] Add `BOOTSTRAP.md` to `WORKSPACE_FILES` list
- [ ] Add lowercase `memory.md` fallback
- [ ] Match openclaw's file ordering: AGENTS → SOUL → TOOLS → IDENTITY → USER → HEARTBEAT → BOOTSTRAP → MEMORY

### Phase 2 — Prompt Structure Parity

- [ ] Wrap workspace files in `# Project Context` section header
- [ ] Add SOUL.md persona instruction ("embody its persona and tone")
- [ ] Implement per-file truncation (20k chars, 70% head + 20% tail)
- [ ] Consider whether to inject identity/safety/messaging sections or rely on `claude` CLI's built-in prompt

### Phase 3 — Execution Parity

- [ ] Evaluate whether text-concatenated history is acceptable or if structured message passing is required
- [ ] If structured messages are needed: switch from `claude -p` (pipe mode) to `claude` CLI's `--continue` session mode, or call the Anthropic API directly
- [ ] Implement history limiting to prevent context overflow
- [ ] Address double-system-prompt issue (daemon-engine's `--system-prompt` overlapping with `claude` CLI's own)

### Phase 4 — Config and Path Parity

- [ ] Support reading from `~/.openclaw/openclaw.json` as a config source
- [ ] Respect `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` env vars
- [ ] Default workspace to `~/.openclaw/workspace/` when not explicitly configured
- [ ] Support JSON5 config parsing (or document the limitation)

### Phase 5 — Advanced Features

- [ ] Memory search (memory/*.md scanning + vector index)
- [ ] Skills system (SKILL.md scanning)
- [ ] Streaming responses
- [ ] Multi-provider support
- [ ] Session write locking
- [ ] Image support
